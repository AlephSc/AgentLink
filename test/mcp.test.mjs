import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BridgeBroker } from "../dist/broker.js";
import { createHttpServer } from "../dist/http.js";

async function fixture(t) {
  const broker = new BridgeBroker({
    host: "127.0.0.1",
    port: 0,
    databasePath: ":memory:",
    registrationToken: "registration-secret",
    maxReplyDepth: 8,
    rateLimitPerMinute: 1000,
    longPollMaxSeconds: 2,
  });
  const server = createHttpServer(broker);
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/mcp`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    broker.close();
  });
  return { broker, url };
}

async function httpClient(t, url, name) {
  const client = new Client({ name, version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  t.after(async () => {
    await Promise.allSettled([client.close()]);
  });
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.ok(result.structuredContent, `missing structuredContent from ${name}`);
  return result.structuredContent;
}

async function register(client, agentId) {
  return call(client, "register_agent", {
    agent_id: agentId,
    name: agentId.toUpperCase(),
    registration_token: "registration-secret",
  });
}

test("two independent MCP HTTP clients exchange messages and observe data via long-poll", async (t) => {
  const { url } = await fixture(t);
  const alphaClient = await httpClient(t, url, "alpha-client");
  const betaClient = await httpClient(t, url, "beta-client");
  const tools = await alphaClient.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "wait_for_message"));

  const alpha = await register(alphaClient, "alpha");
  const beta = await register(betaClient, "beta");
  assert.ok(alpha.agent_token);
  assert.ok(beta.agent_token);

  const pending = call(betaClient, "wait_for_message", {
    agent_id: "beta",
    agent_token: beta.agent_token,
    timeout_seconds: 2,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await call(alphaClient, "data_set", {
    agent_id: "alpha",
    agent_token: alpha.agent_token,
    key: "task/status",
    value: { state: "ready", progress: 0.5 },
    expected_version: 0,
  });
  const update = await pending;
  assert.equal(update.timed_out, false);
  assert.equal(update.updates.at(-1).type, "data");
  assert.deepEqual(update.updates.at(-1).payload.data.value, { state: "ready", progress: 0.5 });

  const sent = await call(alphaClient, "send_message", {
    agent_id: "alpha",
    agent_token: alpha.agent_token,
    to: "beta",
    body: "Data is ready",
    reply_requested: true,
  });
  const inbox = await call(betaClient, "read_inbox", {
    agent_id: "beta",
    agent_token: beta.agent_token,
    unread_only: true,
    mark_read: true,
  });
  assert.deepEqual(inbox.messages.map((message) => message.id), [sent.message.id]);
  assert.equal(inbox.messages[0].body, "Data is ready");

  const reply = await call(betaClient, "send_message", {
    agent_id: "beta",
    agent_token: beta.agent_token,
    to: "alpha",
    body: "Acknowledged",
    reply_to: sent.message.id,
  });
  assert.equal(reply.message.conversation_id, sent.message.conversation_id);
  assert.equal(reply.message.recipient_id, "alpha");

  const conflict = await alphaClient.callTool({
    name: "data_set",
    arguments: {
      agent_id: "alpha",
      agent_token: alpha.agent_token,
      key: "task/status",
      value: { state: "stale" },
      expected_version: 0,
    },
  });
  assert.equal(conflict.isError, true);
  assert.match(conflict.content[0].text, /CONFLICT/);
});

test("stdio shim exposes the same remote MCP broker", async (t) => {
  const { url } = await fixture(t);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/shim.js"],
    env: { ...process.env, AI_BRIDGE_URL: url },
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  t.after(async () => {
    await Promise.allSettled([client.close()]);
  });

  const registered = await register(client, "stdio-agent");
  const listed = await call(client, "list_agents", {
    agent_id: "stdio-agent",
    agent_token: registered.agent_token,
  });
  assert.deepEqual(listed.agents.map((agent) => agent.id), ["stdio-agent"]);
});
