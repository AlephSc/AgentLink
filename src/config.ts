import { resolve } from "node:path";

function integerFromEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export interface BridgeConfig {
  host: string;
  port: number;
  databasePath: string;
  registrationToken?: string;
  maxReplyDepth: number;
  rateLimitPerMinute: number;
  longPollMaxSeconds: number;
}

export function loadConfig(): BridgeConfig {
  const host = process.env.AI_BRIDGE_HOST?.trim() || "127.0.0.1";
  const registrationToken = process.env.AI_BRIDGE_REGISTRATION_TOKEN?.trim() || undefined;
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!isLoopback && !registrationToken) {
    throw new Error(
      "AI_BRIDGE_REGISTRATION_TOKEN is required when binding to a non-loopback host",
    );
  }

  return {
    host,
    port: integerFromEnv("AI_BRIDGE_PORT", 8787, 0, 65535),
    databasePath: resolve(process.env.AI_BRIDGE_DB || "./data/ai-bridge.db"),
    registrationToken,
    maxReplyDepth: integerFromEnv("AI_BRIDGE_MAX_REPLY_DEPTH", 16, 1, 100),
    rateLimitPerMinute: integerFromEnv(
      "AI_BRIDGE_RATE_LIMIT_PER_MINUTE",
      120,
      1,
      100_000,
    ),
    longPollMaxSeconds: integerFromEnv("AI_BRIDGE_LONG_POLL_MAX_SECONDS", 30, 1, 120),
  };
}
