import { BridgeBroker } from "./broker.js";
import { loadConfig } from "./config.js";
import { createHttpServer } from "./http.js";

try {
  const config = loadConfig();
  const broker = new BridgeBroker(config);
  const server = createHttpServer(broker);

  const shutdown = () => {
    server.close(() => {
      broker.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
