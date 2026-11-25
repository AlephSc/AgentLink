import { timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import type { BridgeConfig } from "./config.js";
import { BridgeError } from "./errors.js";
import {
  BridgeStore,
  type AgentDeviceInput,
  type ReadInboxOptions,
  type SendMessageInput,
} from "./store.js";

class SlidingWindowRateLimiter {
  private readonly calls = new Map<string, number[]>();

  constructor(private readonly maximumPerMinute: number) {}

  consume(agentId: string): void {
    const cutoff = Date.now() - 60_000;
    const recent = (this.calls.get(agentId) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= this.maximumPerMinute) {
      throw new BridgeError("Agent rate limit exceeded; retry in under one minute", "RATE_LIMITED");
    }
    recent.push(Date.now());
    this.calls.set(agentId, recent);
  }
}

export class BridgeBroker {
  readonly store: BridgeStore;
  private readonly changes = new EventEmitter();
  private readonly limiter: SlidingWindowRateLimiter;

  constructor(readonly config: BridgeConfig) {
    this.store = new BridgeStore(config.databasePath);
    this.limiter = new SlidingWindowRateLimiter(config.rateLimitPerMinute);
    this.changes.setMaxListeners(0);
  }

  close(): void {
    this.changes.removeAllListeners();
    this.store.close();
  }

  registerAgent(
    agentId: string,
    name: string,
    registrationToken?: string,
    device?: AgentDeviceInput,
  ) {
    if (this.config.registrationToken) {
      const expected = Buffer.from(this.config.registrationToken);
      const actual = Buffer.from(registrationToken ?? "");
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        throw new BridgeError("Invalid registration_token", "UNAUTHORIZED");
      }
    }
    const result = this.store.registerAgent(agentId, name, device);
    this.changes.emit("change");
    return result;
  }

  setAgentContext(agentId: string, device: AgentDeviceInput) {
    const result = this.store.setAgentContext(agentId, device);
    this.changes.emit("change");
    return result;
  }

  authenticate(agentId: string, agentToken: string) {
    this.limiter.consume(agentId);
    return this.store.authenticate(agentId, agentToken);
  }

  sendMessage(input: Omit<SendMessageInput, "maxReplyDepth">) {
    const result = this.store.sendMessage({ ...input, maxReplyDepth: this.config.maxReplyDepth });
    this.changes.emit("change");
    return result;
  }

  setData(agentId: string, key: string, value: unknown, expectedVersion?: number) {
    const result = this.store.setData(agentId, key, value, expectedVersion);
    this.changes.emit("change");
    return result;
  }

  readInbox(agentId: string, options: ReadInboxOptions) {
    return this.store.readInbox(agentId, options);
  }

  getUpdates(agentId: string, sinceEventId: number, limit: number) {
    return this.store.getUpdates(agentId, sinceEventId, limit);
  }

  async waitForUpdates(
    agentId: string,
    sinceEventId: number | undefined,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<ReturnType<BridgeStore["getUpdates"]> & { timed_out: boolean }> {
    const initialCursor = sinceEventId ?? this.store.currentEventId();
    const boundedTimeout = Math.min(timeoutSeconds, this.config.longPollMaxSeconds);

    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let settled = false;

      const cleanup = () => {
        this.changes.off("change", check);
        signal?.removeEventListener("abort", onAbort);
        if (timer) clearTimeout(timer);
      };
      const finish = (timedOut: boolean) => {
        if (settled) return;
        settled = true;
        cleanup();
        const result = this.store.getUpdates(agentId, initialCursor, 100);
        resolve({ ...result, timed_out: timedOut });
      };
      const check = () => {
        if (settled) return;
        if (this.store.getUpdates(agentId, initialCursor, 1).updates.length > 0) finish(false);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new BridgeError("The long-poll request was cancelled", "INVALID_INPUT"));
      };

      this.changes.on("change", check);
      signal?.addEventListener("abort", onAbort, { once: true });
      // Keep the timer referenced: it resolves a promise the caller awaits, and an
      // unref'd timer lets Node 22 drain the event loop before the promise settles.
      timer = setTimeout(() => finish(true), boundedTimeout * 1000);
      // Register the listener before checking so a change cannot fall into a gap.
      check();
    });
  }
}
