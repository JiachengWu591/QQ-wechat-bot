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
  CREATE TABLE IF NOT EXISTS image_sightings (
    channel_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    count INTEGER NOT NULL,
    senders TEXT NOT NULL,
    first_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    file TEXT,
    settled INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, conversation_id, fingerprint)
  );
`;

// How often a picture has been posted in a group, for ranking the gacha pool's candidates. Who
// posted it is kept only to count different people, at most this many.
const MAX_SENDERS_KEPT = 50;

export type Sighting = {
  channelId: string;
  conversationId: string;
  fingerprint: string;
  count: number;
  senders: number;
  firstAt: number;
  lastAt: number;
  // A copy kept as a candidate, in the workspace.
  file?: string;
  // The owner has added it to the pool or turned it down.
  settled: boolean;
};

type SightingRow = {
  channel_id: string;
  conversation_id: string;
  fingerprint: string;
  count: number;
  senders: string;
  first_at: number;
  last_at: number;
  file: string | null;
  settled: number;
};

function toSighting(row: SightingRow): Sighting {
  return {
    channelId: row.channel_id,
    conversationId: row.conversation_id,
    fingerprint: row.fingerprint,
    count: row.count,
    senders: (JSON.parse(row.senders) as string[]).length,
    firstAt: row.first_at,
    lastAt: row.last_at,
    ...(row.file ? { file: row.file } : {}),
    settled: row.settled === 1,
  };
}

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
  tools: string | null;
};

type ActivityRow = {
  id: number;
  at: number;
  level: string;
  summary: string;
  conversation_title: string | null;
  cost_usd: number | null;
};

// Group chat and the owner's own work spend from separate daily budgets, so a long report
// can't use up what the group runs on, or the other way round.
export type BudgetLane = "shared" | "owner";

// Rows from before the lanes existed are plain days, which is the shared lane.
function usageKey(day: string, lane: BudgetLane): string {
  return lane === "shared" ? day : `${day}:${lane}`;
}

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
    ...(row.tools ? { tools: JSON.parse(row.tools) as string[] } : {}),
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
    // Added after the first databases were made, which get it on opening.
    const columns = this.#db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "tools")) this.#db.exec(`ALTER TABLE messages ADD COLUMN tools TEXT`);
  }

  close() {
    this.#db.close();
  }

  addMessage(line: ChatLine) {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO messages (id, channel_id, conversation_id, direction, sender_id, sender_name, text, at, tier, tools)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(line.id, line.channelId, line.conversationId, line.direction, line.senderId, line.senderName, line.text, line.at, line.tier, line.tools?.length ? JSON.stringify(line.tools) : null);
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
    // A candidate the owner hasn't looked at yet is kept, however old.
    this.#db.prepare(`DELETE FROM image_sightings WHERE last_at < ? AND file IS NULL`).run(at);
  }

  // Counts one more posting of a picture in a group, and gives back where it stands.
  recordSighting(channelId: string, conversationId: string, fingerprint: string, senderId: string, at: number): Sighting {
    const where = `channel_id = ? AND conversation_id = ? AND fingerprint = ?`;
    const row = this.#db.prepare(`SELECT * FROM image_sightings WHERE ${where}`).get(channelId, conversationId, fingerprint) as SightingRow | undefined;
    if (!row) {
      this.#db
        .prepare(`INSERT INTO image_sightings (channel_id, conversation_id, fingerprint, count, senders, first_at, last_at) VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run(channelId, conversationId, fingerprint, JSON.stringify([senderId]), at, at);
    } else {
      const senders = JSON.parse(row.senders) as string[];
      if (!senders.includes(senderId) && senders.length < MAX_SENDERS_KEPT) senders.push(senderId);
      this.#db.prepare(`UPDATE image_sightings SET count = count + 1, senders = ?, last_at = ? WHERE ${where}`).run(JSON.stringify(senders), at, channelId, conversationId, fingerprint);
    }
    return toSighting(this.#db.prepare(`SELECT * FROM image_sightings WHERE ${where}`).get(channelId, conversationId, fingerprint) as SightingRow);
  }

  setSightingFile(channelId: string, conversationId: string, fingerprint: string, file: string) {
    this.#db.prepare(`UPDATE image_sightings SET file = ? WHERE channel_id = ? AND conversation_id = ? AND fingerprint = ?`).run(file, channelId, conversationId, fingerprint);
  }

  // Added to the pool or turned down: it's no longer offered, in any group.
  settleSighting(fingerprint: string) {
    this.#db.prepare(`UPDATE image_sightings SET settled = 1, file = NULL WHERE fingerprint = ?`).run(fingerprint);
  }

  // Pictures kept as candidates and not yet settled, one per picture with its postings in every
  // group added up, most posted first.
  candidates(): Sighting[] {
    const rows = this.#db
      .prepare(`SELECT * FROM image_sightings WHERE settled = 0 AND fingerprint IN (SELECT fingerprint FROM image_sightings WHERE file IS NOT NULL AND settled = 0)`)
      .all() as unknown as SightingRow[];
    const byPicture = new Map<string, Sighting>();
    for (const sighting of rows.map(toSighting)) {
      const seen = byPicture.get(sighting.fingerprint);
      byPicture.set(
        sighting.fingerprint,
        seen
          ? {
              ...seen,
              ...(seen.file ? {} : sighting.file ? { file: sighting.file } : {}),
              count: seen.count + sighting.count,
              senders: seen.senders + sighting.senders,
              firstAt: Math.min(seen.firstAt, sighting.firstAt),
              lastAt: Math.max(seen.lastAt, sighting.lastAt),
            }
          : sighting,
      );
    }
    return [...byPicture.values()].sort((a, b) => b.count - a.count || b.senders - a.senders || a.firstAt - b.firstAt);
  }

  addCost(day: string, costUsd: number, lane: BudgetLane = "shared") {
    this.#db
      .prepare(`INSERT INTO usage (day, cost_usd) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd`)
      .run(usageKey(day, lane), costUsd);
  }

  costForDay(day: string, lane: BudgetLane = "shared"): number {
    const row = this.#db.prepare(`SELECT cost_usd FROM usage WHERE day = ?`).get(usageKey(day, lane)) as { cost_usd: number } | undefined;
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
