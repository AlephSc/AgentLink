import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BridgeError } from "./errors.js";

export interface AgentRow {
  id: string;
  name: string;
  token_hash: string;
  created_at: string;
  last_seen_at: string;
}

export interface MessageRow {
  id: number;
  sender_id: string;
  recipient_id: string | null;
  body: string;
  conversation_id: string;
  reply_to_id: number | null;
  reply_depth: number;
  reply_requested: number;
  created_at: string;
}

export interface EventRow {
  id: number;
  event_type: "agent" | "message" | "data";
  actor_id: string;
  target_id: string | null;
  entity_id: string;
  payload_json: string;
  created_at: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sameHash(stored: string, candidate: string): boolean {
  const left = Buffer.from(stored, "hex");
  const right = Buffer.from(hashToken(candidate), "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function publicAgent(row: AgentRow) {
  return {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
  };
}

function publicMessage(row: MessageRow, isRead?: boolean) {
  return {
    id: Number(row.id),
    sender_id: row.sender_id,
    recipient_id: row.recipient_id,
    kind: row.recipient_id === null ? "broadcast" : "direct",
    body: row.body,
    conversation_id: row.conversation_id,
    reply_to_id: row.reply_to_id === null ? null : Number(row.reply_to_id),
    reply_depth: Number(row.reply_depth),
    reply_requested: Boolean(row.reply_requested),
    created_at: row.created_at,
    ...(isRead === undefined ? {} : { is_read: isRead }),
  };
}

function publicEvent(row: EventRow) {
  return {
    id: Number(row.id),
    type: row.event_type,
    actor_id: row.actor_id,
    target_id: row.target_id,
    entity_id: row.entity_id,
    payload: JSON.parse(row.payload_json) as unknown,
    created_at: row.created_at,
  };
}

export interface ReadInboxOptions {
  unreadOnly?: boolean;
  beforeId?: number;
  limit?: number;
  markRead?: boolean;
}

export interface SendMessageInput {
  senderId: string;
  recipientId?: string;
  body: string;
  replyToId?: number;
  replyRequested?: boolean;
  maxReplyDepth: number;
}

export class BridgeStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      const absolutePath = resolve(databasePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      databasePath = absolutePath;
    }
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (databasePath !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id TEXT NOT NULL REFERENCES agents(id),
        recipient_id TEXT REFERENCES agents(id),
        body TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        reply_to_id INTEGER REFERENCES messages(id),
        reply_depth INTEGER NOT NULL DEFAULT 0,
        reply_requested INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_inbox_idx
        ON messages(recipient_id, id);
      CREATE INDEX IF NOT EXISTS messages_conversation_idx
        ON messages(conversation_id, id);
      CREATE TABLE IF NOT EXISTS message_reads (
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        read_at TEXT NOT NULL,
        PRIMARY KEY(message_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS shared_data (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_by TEXT NOT NULL REFERENCES agents(id),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL CHECK(event_type IN ('agent', 'message', 'data')),
        actor_id TEXT NOT NULL REFERENCES agents(id),
        target_id TEXT REFERENCES agents(id),
        entity_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_cursor_idx ON events(id);
    `);
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  registerAgent(id: string, name: string): { agent: ReturnType<typeof publicAgent>; token: string } {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id)) {
      throw new BridgeError(
        "agent_id must be 1-64 characters: letters, numbers, '.', '_' or '-'",
        "INVALID_INPUT",
      );
    }
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 200) {
      throw new BridgeError("name must contain 1-200 characters", "INVALID_INPUT");
    }
    const token = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM agents WHERE id = ?").get(id)) {
        throw new BridgeError(`Agent '${id}' is already registered`, "CONFLICT");
      }
      this.db
        .prepare(
          "INSERT INTO agents(id, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(id, cleanName, hashToken(token), now, now);
      const agent = this.getAgent(id)!;
      this.insertEvent("agent", id, null, id, JSON.stringify({ agent }), now);
      return { agent, token };
    });
  }

  getAgent(id: string): ReturnType<typeof publicAgent> | undefined {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as
      | AgentRow
      | undefined;
    return row ? publicAgent(row) : undefined;
  }

  authenticate(id: string, token: string): ReturnType<typeof publicAgent> {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as
      | AgentRow
      | undefined;
    if (!row || !sameHash(row.token_hash, token)) {
      throw new BridgeError("Invalid agent_id or agent_token", "UNAUTHORIZED");
    }
    const now = new Date().toISOString();
    this.db.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(now, id);
    return { ...publicAgent(row), last_seen_at: now };
  }

  listAgents(): ReturnType<typeof publicAgent>[] {
    const rows = this.db.prepare("SELECT * FROM agents ORDER BY id").all() as unknown as AgentRow[];
    return rows.map(publicAgent);
  }

  private insertEvent(
    type: EventRow["event_type"],
    actorId: string,
    targetId: string | null,
    entityId: string,
    payloadJson: string,
    createdAt: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO events(event_type, actor_id, target_id, entity_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(type, actorId, targetId, entityId, payloadJson, createdAt);
  }

  sendMessage(input: SendMessageInput): ReturnType<typeof publicMessage> {
    const body = input.body.trim();
    if (!body || body.length > 100_000) {
      throw new BridgeError("body must contain 1-100000 characters", "INVALID_INPUT");
    }
    return this.transaction(() => {
      let recipientId = input.recipientId;
      let conversationId: string = randomUUID();
      let replyDepth = 0;
      let replyToId: number | null = null;

      if (input.replyToId !== undefined) {
        const parent = this.db
          .prepare("SELECT * FROM messages WHERE id = ?")
          .get(input.replyToId) as MessageRow | undefined;
        if (!parent) throw new BridgeError("Parent message not found", "NOT_FOUND");
        const isParticipant =
          parent.recipient_id === null ||
          parent.sender_id === input.senderId ||
          parent.recipient_id === input.senderId;
        if (!isParticipant) {
          throw new BridgeError("Parent message not found or not accessible", "NOT_FOUND");
        }
        if (parent.recipient_id !== null) {
          const expectedRecipient =
            parent.sender_id === input.senderId ? parent.recipient_id : parent.sender_id;
          if (recipientId !== undefined && recipientId !== expectedRecipient) {
            throw new BridgeError(
              "A direct reply can only be sent to the other conversation participant",
              "INVALID_INPUT",
            );
          }
          recipientId = expectedRecipient;
        }
        replyDepth = Number(parent.reply_depth) + 1;
        if (replyDepth > input.maxReplyDepth) {
          throw new BridgeError(
            `Reply depth limit (${input.maxReplyDepth}) reached; start a new conversation with an explicit user decision`,
            "REPLY_LIMIT",
          );
        }
        conversationId = parent.conversation_id;
        replyToId = Number(parent.id);
      }

      if (recipientId !== undefined && !this.getAgent(recipientId)) {
        throw new BridgeError(`Recipient agent '${recipientId}' not found`, "NOT_FOUND");
      }
      const now = new Date().toISOString();
      const result = this.db
        .prepare(
          `INSERT INTO messages(
            sender_id, recipient_id, body, conversation_id, reply_to_id,
            reply_depth, reply_requested, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.senderId,
          recipientId ?? null,
          body,
          conversationId,
          replyToId,
          replyDepth,
          input.replyRequested ? 1 : 0,
          now,
        );
      const id = Number(result.lastInsertRowid);
      const row = this.db
        .prepare("SELECT * FROM messages WHERE id = ?")
        .get(id) as unknown as MessageRow;
      const message = publicMessage(row);
      this.insertEvent(
        "message",
        input.senderId,
        recipientId ?? null,
        String(id),
        JSON.stringify({ message }),
        now,
      );
      return message;
    });
  }

  readInbox(agentId: string, options: ReadInboxOptions = {}): ReturnType<typeof publicMessage>[] {
    const limit = options.limit ?? 50;
    const beforeId = options.beforeId ?? Number.MAX_SAFE_INTEGER;
    const unreadClause = options.unreadOnly
      ? "AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.agent_id = ?)"
      : "";
    const rows = this.db
      .prepare(
        `SELECT m.*, EXISTS(
          SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.agent_id = ?
        ) AS is_read
        FROM messages m
        WHERE (m.recipient_id = ? OR (m.recipient_id IS NULL AND m.sender_id <> ?))
          AND m.id < ? ${unreadClause}
        ORDER BY m.id DESC LIMIT ?`,
      )
      .all(
        ...(options.unreadOnly
          ? [agentId, agentId, agentId, beforeId, agentId, limit]
          : [agentId, agentId, agentId, beforeId, limit]),
      ) as unknown as (MessageRow & { is_read: number })[];
    if (options.markRead && rows.length > 0) {
      this.markMessagesRead(agentId, rows.map((row) => Number(row.id)));
    }
    return rows.map((row) => publicMessage(row, options.markRead ? true : Boolean(row.is_read)));
  }

  markMessagesRead(agentId: string, messageIds: number[]): number {
    if (messageIds.length === 0) return 0;
    const uniqueIds = [...new Set(messageIds.map(Number))];
    const placeholders = uniqueIds.map(() => "?").join(",");
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO message_reads(message_id, agent_id, read_at)
        SELECT m.id, ?, ? FROM messages m
        WHERE m.id IN (${placeholders})
          AND (m.recipient_id = ? OR (m.recipient_id IS NULL AND m.sender_id <> ?))`,
      )
      .run(agentId, now, ...uniqueIds, agentId, agentId);
    return Number(result.changes);
  }

  setData(
    agentId: string,
    key: string,
    value: unknown,
    expectedVersion?: number,
  ): { key: string; value: unknown; version: number; updated_by: string; updated_at: string } {
    const cleanKey = key.trim();
    if (!cleanKey || cleanKey.length > 256) {
      throw new BridgeError("key must contain 1-256 characters", "INVALID_INPUT");
    }
    const valueJson = JSON.stringify(value);
    if (valueJson === undefined || Buffer.byteLength(valueJson, "utf8") > 512_000) {
      throw new BridgeError("value must be JSON and at most 512000 UTF-8 bytes", "INVALID_INPUT");
    }
    return this.transaction(() => {
      const current = this.db
        .prepare("SELECT * FROM shared_data WHERE key = ?")
        .get(cleanKey) as
        | { value_json: string; version: number; updated_by: string; updated_at: string }
        | undefined;
      const currentVersion = current ? Number(current.version) : 0;
      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        throw new BridgeError(
          `Version conflict for '${cleanKey}': current version is ${currentVersion}`,
          "CONFLICT",
        );
      }
      const version = currentVersion + 1;
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO shared_data(key, value_json, version, updated_by, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
            version = excluded.version, updated_by = excluded.updated_by,
            updated_at = excluded.updated_at`,
        )
        .run(cleanKey, valueJson, version, agentId, now);
      const record = {
        key: cleanKey,
        value: JSON.parse(valueJson) as unknown,
        version,
        updated_by: agentId,
        updated_at: now,
      };
      this.insertEvent("data", agentId, null, cleanKey, JSON.stringify({ data: record }), now);
      return record;
    });
  }

  getData(key: string): { key: string; value: unknown; version: number; updated_by: string; updated_at: string } | undefined {
    const row = this.db.prepare("SELECT * FROM shared_data WHERE key = ?").get(key) as
      | { key: string; value_json: string; version: number; updated_by: string; updated_at: string }
      | undefined;
    return row
      ? {
          key: row.key,
          value: JSON.parse(row.value_json) as unknown,
          version: Number(row.version),
          updated_by: row.updated_by,
          updated_at: row.updated_at,
        }
      : undefined;
  }

  listData(prefix = "", limit = 100): ReturnType<BridgeStore["getData"]>[] {
    const escapedPrefix = prefix.replace(/[\\%_]/g, "\\$&");
    const rows = this.db
      .prepare(
        "SELECT * FROM shared_data WHERE key LIKE ? ESCAPE '\\' ORDER BY key LIMIT ?",
      )
      .all(`${escapedPrefix}%`, limit) as unknown as {
      key: string;
      value_json: string;
      version: number;
      updated_by: string;
      updated_at: string;
    }[];
    return rows.map((row) => ({
      key: row.key,
      value: JSON.parse(row.value_json) as unknown,
      version: Number(row.version),
      updated_by: row.updated_by,
      updated_at: row.updated_at,
    }));
  }

  currentEventId(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events").get() as {
      id: number;
    };
    return Number(row.id);
  }

  getUpdates(agentId: string, sinceEventId = 0, limit = 100): {
    updates: ReturnType<typeof publicEvent>[];
    next_cursor: number;
    has_more: boolean;
  } {
    const scanLimit = limit + 1;
    const rows = this.db
      .prepare(
        `SELECT * FROM events
        WHERE id > ? AND (target_id IS NULL OR target_id = ? OR actor_id = ?)
        ORDER BY id LIMIT ?`,
      )
      .all(sinceEventId, agentId, agentId, scanLimit) as unknown as EventRow[];
    const hasMore = rows.length > limit;
    const visibleRows = hasMore ? rows.slice(0, limit) : rows;
    return {
      updates: visibleRows.map(publicEvent),
      next_cursor:
        visibleRows.length > 0 ? Number(visibleRows[visibleRows.length - 1]!.id) : this.currentEventId(),
      has_more: hasMore,
    };
  }
}
