import test from "node:test";
import assert from "node:assert/strict";
import { BridgeBroker } from "../dist/broker.js";

function makeBroker(overrides = {}) {
  return new BridgeBroker({
    host: "127.0.0.1",
    port: 0,
    databasePath: ":memory:",
    maxReplyDepth: 2,
    rateLimitPerMinute: 1000,
    longPollMaxSeconds: 2,
    ...overrides,
  });
}

function registeredPair(broker) {
  const alice = broker.registerAgent("alice", "Alice", "registration-secret");
  const bob = broker.registerAgent("bob", "Bob", "registration-secret");
  return { alice, bob };
}

test("registration, authentication, direct messages, broadcasts, and read state", (t) => {
  const broker = makeBroker({ registrationToken: "registration-secret" });
  t.after(() => broker.close());
  const { alice, bob } = registeredPair(broker);

  assert.throws(() => broker.registerAgent("alice", "Duplicate", "registration-secret"), /already registered/);
  assert.throws(() => broker.authenticate("alice", "wrong-token"), /Invalid agent_id/);
  assert.equal(broker.authenticate("alice", alice.token).name, "Alice");
  assert.equal(broker.store.listAgents().length, 2);
  assert.equal("token_hash" in broker.store.listAgents()[0], false);

  const direct = broker.sendMessage({
    senderId: "alice",
    recipientId: "bob",
    body: "Hello Bob",
    replyRequested: true,
  });
  const broadcast = broker.sendMessage({ senderId: "alice", body: "Hello everyone" });

  const inbox = broker.readInbox("bob", {});
  assert.deepEqual(inbox.map((message) => message.id), [broadcast.id, direct.id]);
  assert.equal(inbox.every((message) => !message.is_read), true);
  assert.equal(broker.readInbox("alice", {}).length, 0, "own broadcast is not an inbox message");
  assert.equal(broker.store.markMessagesRead("bob", [direct.id]), 1);

  const unread = broker.readInbox("bob", { unreadOnly: true });
  assert.deepEqual(unread.map((message) => message.id), [broadcast.id]);
});

test("device metadata links same-machine agents and exposes absolute paths", (t) => {
  const broker = makeBroker({ registrationToken: "registration-secret" });
  t.after(() => broker.close());

  const alice = broker.registerAgent("alice", "Alice", "registration-secret", {
    id: "device-alpha",
    name: "Laptop A",
    platform: "windows",
    workspacePath: "C:\\work\\project",
    homePath: "C:\\Users\\alice",
  });
  broker.registerAgent("bob", "Bob", "registration-secret", {
    id: "device-alpha",
    name: "Laptop A",
    platform: "windows",
    workspacePath: "C:\\work\\other",
    homePath: "C:\\Users\\bob",
  });
  const carol = broker.registerAgent("carol", "Carol", "registration-secret", {
    id: "device-beta",
    platform: "linux",
    workspacePath: "/srv/project",
    homePath: "/home/carol",
  });

  assert.equal(alice.agent.device.id, "device-alpha");
  assert.equal(alice.agent.device.workspace_path, "C:\\work\\project");
  assert.equal("token_hash" in alice.agent, false);

  const listed = broker.store.listAgents("alice");
  const byId = Object.fromEntries(listed.map((agent) => [agent.id, agent]));
  assert.equal(byId.alice.same_device, true);
  assert.equal(byId.bob.same_device, true);
  assert.equal(byId.carol.same_device, false);
  assert.equal(byId.carol.device.workspace_path, "/srv/project");
  assert.equal(byId.alice.device.name, "Laptop A");

  const updated = broker.setAgentContext("carol", {
    id: "device-beta",
    workspacePath: "/srv/renamed",
    platform: "linux",
  });
  assert.equal(updated.device.workspace_path, "/srv/renamed");
  assert.equal(updated.device.home_path, "/home/carol", "omitted fields are preserved");
  assert.equal(carol.agent.device.home_path, "/home/carol");

  assert.throws(
    () =>
      broker.registerAgent("dave", "Dave", "registration-secret", {
        id: "device-gamma",
        workspacePath: "relative/path",
      }),
    /absolute path/,
  );
  assert.throws(
    () => broker.registerAgent("eve", "Eve", "registration-secret", { id: "bad id" }),
    /device.id/,
  );
});

test("direct replies inherit the conversation and enforce reply depth and participants", (t) => {
  const broker = makeBroker({ registrationToken: "registration-secret" });
  t.after(() => broker.close());
  const { alice } = registeredPair(broker);
  broker.registerAgent("mallory", "Mallory", "registration-secret");

  const root = broker.sendMessage({ senderId: "alice", recipientId: "bob", body: "Root" });
  const first = broker.sendMessage({ senderId: "bob", body: "Reply 1", replyToId: root.id });
  assert.equal(first.recipient_id, "alice");
  assert.equal(first.conversation_id, root.conversation_id);
  const second = broker.sendMessage({ senderId: "alice", body: "Reply 2", replyToId: first.id });
  assert.equal(second.reply_depth, 2);
  assert.throws(
    () => broker.sendMessage({ senderId: "bob", body: "Too deep", replyToId: second.id }),
    /Reply depth limit/,
  );
  assert.throws(
    () => broker.sendMessage({ senderId: "mallory", body: "Inject", replyToId: root.id }),
    /not found or not accessible/,
  );
});

test("shared data uses versions and literal prefixes", (t) => {
  const broker = makeBroker({ registrationToken: "registration-secret" });
  t.after(() => broker.close());
  const { alice } = registeredPair(broker);

  const first = broker.setData("alice", "project/status", { phase: 1 }, 0);
  assert.equal(first.version, 1);
  const second = broker.setData("alice", "project/status", { phase: 2 }, first.version);
  assert.equal(second.version, 2);
  assert.equal(broker.store.getData("project/status").value.phase, 2);
  assert.throws(() => broker.setData("alice", "project/status", { phase: 3 }, 1), /Version conflict/);

  broker.setData("alice", "project/100%", "literal");
  broker.setData("alice", "projectX/other", "not a match");
  assert.deepEqual(
    broker.store.listData("project/", 100).map((record) => record.key),
    ["project/100%", "project/status"],
  );
});

test("update cursors expose only public events and direct messages to their participants", (t) => {
  const broker = makeBroker({ registrationToken: "registration-secret" });
  t.after(() => broker.close());
  registeredPair(broker);
  broker.registerAgent("charlie", "Charlie", "registration-secret");

  const privateMessage = broker.sendMessage({ senderId: "alice", recipientId: "bob", body: "secret" });
  const publicMessage = broker.sendMessage({ senderId: "alice", body: "public" });
  broker.setData("alice", "shared", 42);

  const bobUpdates = broker.getUpdates("bob", 0, 100).updates;
  assert.equal(bobUpdates.some((event) => event.entity_id === String(privateMessage.id)), true);
  const charlieUpdates = broker.getUpdates("charlie", 0, 100).updates;
  assert.equal(charlieUpdates.some((event) => event.entity_id === String(privateMessage.id)), false);
  assert.equal(charlieUpdates.some((event) => event.entity_id === String(publicMessage.id)), true);
  assert.equal(charlieUpdates.some((event) => event.entity_id === "shared"), true);

  const page = broker.getUpdates("charlie", 0, 1);
  assert.equal(page.updates.length, 1);
  assert.equal(page.has_more, true);
  assert.equal(page.next_cursor, page.updates[0].id);
});

test("long polling wakes for a new event and preserves the cursor on timeout", async (t) => {
  const broker = makeBroker({ registrationToken: "registration-secret" });
  t.after(() => broker.close());
  registeredPair(broker);
  const cursor = broker.store.currentEventId();

  const waiting = broker.waitForUpdates("bob", cursor, 1);
  const timer = setTimeout(() => {
    broker.sendMessage({ senderId: "alice", recipientId: "bob", body: "wake up" });
  }, 20);
  const awakened = await waiting;
  clearTimeout(timer);
  assert.equal(awakened.timed_out, false);
  assert.equal(awakened.updates.at(-1).payload.message.body, "wake up");
  assert.equal(awakened.next_cursor, awakened.updates.at(-1).id);

  const timedOut = await broker.waitForUpdates("bob", awakened.next_cursor, 0);
  assert.equal(timedOut.timed_out, true);
  assert.equal(timedOut.updates.length, 0);
  assert.equal(timedOut.next_cursor, awakened.next_cursor);
});
