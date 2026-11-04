// Local SQLite store. Chat text stays on this machine.
import { DatabaseSync } from "node:sqlite";
import type { ActivityEntry, ActivityLevel, ChatLine, PendingReply, Tier } from "@shu/protocol";

const schema = `
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    text TEXT NOT NULL,
    at INTEGER NOT NULL,
    tier TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (channel_id, conversation_id, at);
  CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    level TEXT NOT NULL,
    summary TEXT NOT NULL,
    conversation_title TEXT,
    cost_usd REAL
  );
  CREATE TABLE IF NOT EXISTS usage (
    day TEXT PRIMARY KEY,
    cost_usd REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pending (
    id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

type MessageRow = {
  id: string;
  channel_id: string;
  conversation_id: string;
  direction: string;
  sender_id: string;
  sender_name: string;
  text: string;
  at: number;
  tier: string;
};

type ActivityRow = {
  id: number;
  at: number;
  level: string;
  summary: string;
  conversation_title: string | null;
  cost_usd: number | null;
};

function toLine(row: MessageRow): ChatLine {
  return {
    id: row.id,
    channelId: row.channel_id,
    conversationId: row.conversation_id,
    direction: row.direction as ChatLine["direction"],
    senderId: row.sender_id,
    senderName: row.sender_name,
    text: row.text,
    at: row.at,
    tier: row.tier as Tier,
  };
}

function toActivity(row: ActivityRow): ActivityEntry {
  return {
    id: row.id,
    at: row.at,
    level: row.level as ActivityLevel,
    summary: row.summary,
    ...(row.conversation_title ? { conversationTitle: row.conversation_title } : {}),
    ...(row.cost_usd === null ? {} : { costUsd: row.cost_usd }),
  };
}

export class Store {
  #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(schema);
  }

  close() {
    this.#db.close();
  }

  addMessage(line: ChatLine) {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO messages (id, channel_id, conversation_id, direction, sender_id, sender_name, text, at, tier)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(line.id, line.channelId, line.conversationId, line.direction, line.senderId, line.senderName, line.text, line.at, line.tier);
  }

  // Oldest first.
  recentMessages(channelId: string, conversationId: string, limit: number): ChatLine[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM messages WHERE channel_id = ? AND conversation_id = ?
         ORDER BY at DESC, rowid DESC LIMIT ?`,
      )
      .all(channelId, conversationId, limit) as unknown as MessageRow[];
    return rows.reverse().map(toLine);
  }

  recentChat(limit: number): ChatLine[] {
    const rows = this.#db.prepare(`SELECT * FROM messages ORDER BY at DESC, rowid DESC LIMIT ?`).all(limit) as unknown as MessageRow[];
    return rows.reverse().map(toLine);
  }

  addActivity(entry: Omit<ActivityEntry, "id">): ActivityEntry {
    const result = this.#db
      .prepare(`INSERT INTO activity (at, level, summary, conversation_title, cost_usd) VALUES (?, ?, ?, ?, ?)`)
      .run(entry.at, entry.level, entry.summary, entry.conversationTitle ?? null, entry.costUsd ?? null);
    return { ...entry, id: Number(result.lastInsertRowid) };
  }

  // Newest first.
  recentActivity(limit: number): ActivityEntry[] {
    const rows = this.#db.prepare(`SELECT * FROM activity ORDER BY id DESC LIMIT ?`).all(limit) as unknown as ActivityRow[];
    return rows.map(toActivity);
  }

  // Old chat text isn't needed for context, and keeping it forever only adds risk.
  purgeBefore(at: number) {
    this.#db.prepare(`DELETE FROM messages WHERE at < ?`).run(at);
    this.#db.prepare(`DELETE FROM activity WHERE at < ?`).run(at);
  }

  addCost(day: string, costUsd: number) {
    this.#db
      .prepare(`INSERT INTO usage (day, cost_usd) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd`)
      .run(day, costUsd);
  }

  costForDay(day: string): number {
    const row = this.#db.prepare(`SELECT cost_usd FROM usage WHERE day = ?`).get(day) as { cost_usd: number } | undefined;
    return row?.cost_usd ?? 0;
  }

  addPending(reply: PendingReply) {
    this.#db.prepare(`INSERT INTO pending (id, body, created_at) VALUES (?, ?, ?)`).run(reply.id, JSON.stringify(reply), reply.createdAt);
  }

  listPending(): PendingReply[] {
    const rows = this.#db.prepare(`SELECT body FROM pending ORDER BY created_at`).all() as { body: string }[];
    return rows.map((row) => JSON.parse(row.body) as PendingReply);
  }

  removePending(id: string) {
    this.#db.prepare(`DELETE FROM pending WHERE id = ?`).run(id);
  }

  getSetting<T>(key: string): T | undefined {
    const row = this.#db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setSetting(key: string, value: unknown) {
    this.#db
      .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
      .run(key, JSON.stringify(value));
  }
}
