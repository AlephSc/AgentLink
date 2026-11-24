import express, { type ErrorRequestHandler } from "express";
import type { Server as HttpServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { BridgeBroker } from "./broker.js";
import { createMcpServer } from "./mcp.js";

export function createHttpServer(broker: BridgeBroker): HttpServer {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb", strict: true }));

  app.get("/health", (_request, response) => {
    response.json({ ok: true, service: "universal-ai-bridge", version: "0.1.0" });
  });

  app.post("/mcp", async (request, response) => {
    const server = createMcpServer(broker);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error("MCP request failed:", error instanceof Error ? error.message : "unknown error");
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.all("/mcp", (_request, response) => {
    response.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed: this broker uses stateless MCP POST" },
      id: null,
    });
  });

  const jsonErrorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    const isBodyError = typeof error === "object" && error !== null && "status" in error;
    response.status(isBodyError ? Number(error.status) : 500).json({
      jsonrpc: "2.0",
      error: {
        code: isBodyError ? -32700 : -32603,
        message: isBodyError ? "Invalid or oversized JSON body" : "Internal server error",
      },
      id: null,
    });
  };
  app.use(jsonErrorHandler);

  return app.listen(broker.config.port, broker.config.host, () => {
    const address = broker.config.host.includes(":") ? `[${broker.config.host}]` : broker.config.host;
    console.log(`AI Bridge MCP listening on http://${address}:${broker.config.port}/mcp`);
    console.log(`Health check: http://${address}:${broker.config.port}/health`);
  });
}
