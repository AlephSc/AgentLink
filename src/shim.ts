import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const url = process.env.AI_BRIDGE_URL || "http://127.0.0.1:8787/mcp";
const client = new Client(
  { name: "ai-bridge-stdio-shim", version: "0.1.0" },
  { capabilities: {} },
);
const server = new Server(
  { name: "universal-ai-bridge-stdio", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => client.listTools());
server.setRequestHandler(CallToolRequestSchema, async (request) =>
  client.callTool({
    name: request.params.name,
    arguments: request.params.arguments ?? {},
  }),
);

try {
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(
    `Could not connect stdio shim to ${url}: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(1);
}

const shutdown = async () => {
  await Promise.allSettled([server.close(), client.close()]);
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
