// The official QQ bot platform: a gateway WebSocket for events and HTTP for sending.
import type { ChannelStatus, ConversationKind, InboundMessage } from "@shu/protocol";
import type { Adapter, AdapterConversation, AdapterHandlers, OutboundText } from "./types.ts";

export const QQ_CHANNEL_ID = "qq";

const DEFAULT_API = "https://api.bot.qq.com";
const GROUP_AND_C2C_EVENT = 1 << 25;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_CONTENT_CHARS = 1800;
const MAX_BACKOFF_MS = 30_000;
const SEEN_LIMIT = 2000;
// A resume after a long outage can replay old messages. Too late to answer those.
const MAX_MESSAGE_AGE_MS = 10 * 60_000;

// How long a message can be replied to, and how many times. Past either, a reply goes
// out as an ordinary message instead, which has its own platform quota.
const PASSIVE_REPLY: Record<ConversationKind, { windowMs: number; limit: number }> = {
  group: { windowMs: 5 * 60_000, limit: 5 },
  dm: { windowMs: 60 * 60_000, limit: 4 },
};

// Retrying won't help with these: bad configuration, a missing permission, a ban.
const FATAL_CLOSE_CODES = new Set([4010, 4011, 4012, 4013, 4014, 4914, 4915]);
// The session is gone, so the next connection has to identify from scratch.
const SESSION_LOST_CLOSE_CODES = new Set([4006, 4007, 4009]);

const Op = { Dispatch: 0, Heartbeat: 1, Identify: 2, Resume: 6, Reconnect: 7, InvalidSession: 9, Hello: 10, HeartbeatAck: 11 } as const;

type GatewayFrame = { op: number; d?: any; s?: number; t?: string };

type QqUser = {
  id?: string;
  username?: string;
  bot?: boolean;
  member_openid?: string;
  user_openid?: string;
  is_you?: boolean;
};

type QqAttachment = { content_type?: string; filename?: string };

type QqMessage = {
  id: string;
  content?: string;
  timestamp?: string;
  group_openid?: string;
  author?: QqUser;
  mentions?: QqUser[];
  attachments?: QqAttachment[];
};

export class QqApiError extends Error {
  readonly status: number;
  readonly code: number | undefined;

  constructor(status: number, code: number | undefined, message: string | undefined) {
    super(`QQ 接口错误 ${status}${code === undefined ? "" : ` / ${code}`}${message ? `：${message}` : ""}`);
    this.status = status;
    this.code = code;
  }
}

// Unreported links get a message rejected outright (304003), so links never go out.
const LINK = /\b(?:https?:\/\/|www\.)[^\s，。！？、）)\]】]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|cn|net|org|io|ai|dev|app|co|gov|edu|top|xyz|info)(?:\/[^\s，。！？、）)\]】]*)?/gi;

export function prepareContent(text: string): string {
  const withoutLinks = text.replace(LINK, "（链接已省略）").trim();
  return withoutLinks.length > MAX_CONTENT_CHARS ? `${withoutLinks.slice(0, MAX_CONTENT_CHARS)}…（内容过长，已截断）` : withoutLinks;
}

export class QqAdapter implements Adapter {
  readonly id = QQ_CHANNEL_ID;
  readonly name = "QQ";
  readonly promptHint = "不要在回复里写网址，QQ 会拦截带网址的消息。要说明来源，就说网站的名字。";

  #appId: string;
  #appSecret: string;
  #api: string;
  #baseBackoffMs: number;

  #handlers: AdapterHandlers | null = null;
  #stopped = true;
  #ws: WebSocket | null = null;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #reconnect: ReturnType<typeof setTimeout> | undefined;
  #backoffMs: number;

  #accessToken = "";
  #tokenExpiresAt = 0;
  #sessionId: string | null = null;
  #lastSeq: number | null = null;
  #self: QqUser = {};

  #seen = new Set<string>();
  #replyable = new Map<string, { kind: ConversationKind; receivedAt: number; replies: number }>();

  constructor(options: { appId: string; appSecret: string; apiBase?: string; backoffMs?: number }) {
    this.#appId = options.appId;
    this.#appSecret = options.appSecret;
    this.#api = options.apiBase ?? DEFAULT_API;
    this.#baseBackoffMs = options.backoffMs ?? 1000;
    this.#backoffMs = this.#baseBackoffMs;
  }

  conversations(): AdapterConversation[] {
    return [];
  }

  botName() {
    return this.#self.username;
  }

  async start(handlers: AdapterHandlers) {
    this.#handlers = handlers;
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.#connect();
  }

  async stop() {
    this.#stopped = true;
    clearTimeout(this.#reconnect);
    // Resuming later would replay whatever arrived while switched off, and nothing sent
    // during that time should be answered.
    this.#sessionId = null;
    this.#lastSeq = null;
    this.#closeSocket();
    this.#setStatus({ state: "stopped" });
  }

  async send(message: OutboundText) {
    const content = prepareContent(message.text);
    if (!content) return;
    const base = message.conversationKind === "group" ? `/v2/groups/${message.conversationId}/messages` : `/v2/users/${message.conversationId}/messages`;
    await this.#request("POST", base, { content, msg_type: 0, ...this.#passiveFields(message.replyToId) });
  }

  #passiveFields(replyToId: string | undefined): { msg_id: string; msg_seq: number } | Record<string, never> {
    const entry = replyToId ? this.#replyable.get(replyToId) : undefined;
    if (!replyToId || !entry) return {};
    const { windowMs, limit } = PASSIVE_REPLY[entry.kind];
    if (Date.now() - entry.receivedAt > windowMs || entry.replies >= limit) return {};
    entry.replies += 1;
    return { msg_id: replyToId, msg_seq: entry.replies };
  }

  async #connect() {
    if (this.#stopped) return;
    this.#setStatus({ state: "connecting" });
    let url: string;
    try {
      await this.#ensureToken();
      const gateway = (await this.#request("GET", "/gateway/bot")) as { url?: string };
      if (!gateway.url) throw new Error("没有拿到网关地址");
      url = gateway.url;
    } catch (error) {
      return this.#scheduleReconnect(error instanceof Error ? error.message : String(error));
    }
    if (this.#stopped) return;

    const ws = new WebSocket(url);
    this.#ws = ws;
    ws.addEventListener("message", (event) => {
      if (ws === this.#ws) void this.#onFrame(ws, JSON.parse(String(event.data)) as GatewayFrame);
    });
    ws.addEventListener("close", (event) => {
      if (ws !== this.#ws) return;
      this.#closeSocket();
      this.#onClosed(event.code, event.reason);
    });
    ws.addEventListener("error", () => {});
  }

  async #onFrame(ws: WebSocket, frame: GatewayFrame) {
    if (typeof frame.s === "number") this.#lastSeq = frame.s;
    switch (frame.op) {
      case Op.Hello: {
        this.#startHeartbeat(ws, Number(frame.d?.heartbeat_interval));
        const token = `QQBot ${await this.#ensureToken()}`;
        if (ws !== this.#ws) return;
        ws.send(
          JSON.stringify(
            this.#sessionId
              ? { op: Op.Resume, d: { token, session_id: this.#sessionId, seq: this.#lastSeq } }
              : { op: Op.Identify, d: { token, intents: GROUP_AND_C2C_EVENT, shard: [0, 1], properties: {} } },
          ),
        );
        return;
      }
      case Op.HeartbeatAck:
        this.#heartbeatAcked = true;
        return;
      case Op.Reconnect:
        return this.#dropAndReconnect("网关要求重连");
      case Op.InvalidSession:
        this.#sessionId = null;
        this.#lastSeq = null;
        return this.#dropAndReconnect("会话已失效");
      case Op.Dispatch:
        return this.#onDispatch(frame.t, frame.d);
    }
  }

  #heartbeatAcked = true;

  #startHeartbeat(ws: WebSocket, intervalMs: number) {
    clearInterval(this.#heartbeat);
    this.#heartbeatAcked = true;
    this.#heartbeat = setInterval(() => {
      // A silently dead connection never closes on its own. A missed ack is how it shows.
      if (!this.#heartbeatAcked) return this.#dropAndReconnect("心跳没有响应");
      this.#heartbeatAcked = false;
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: Op.Heartbeat, d: this.#lastSeq }));
    }, intervalMs);
    this.#heartbeat.unref();
  }

  #onDispatch(type: string | undefined, data: any) {
    switch (type) {
      case "READY":
        this.#sessionId = data?.session_id ?? null;
        this.#self = data?.user ?? {};
        return this.#onConnected();
      case "RESUMED":
        return this.#onConnected();
      case "GROUP_AT_MESSAGE_CREATE":
        return this.#onGroupMessage(data as QqMessage, true);
      case "GROUP_MESSAGE_CREATE":
        return this.#onGroupMessage(data as QqMessage, false);
      case "C2C_MESSAGE_CREATE":
        return this.#onPrivateMessage(data as QqMessage);
    }
  }

  #onConnected() {
    clearTimeout(this.#reconnect);
    this.#backoffMs = this.#baseBackoffMs;
    this.#setStatus({ state: "connected", ...(this.#self.username ? { detail: `机器人：${this.#self.username}` } : {}) });
  }

  #onGroupMessage(message: QqMessage, alwaysMentioned: boolean) {
    const author = message.author ?? {};
    const senderId = author.member_openid ?? author.id;
    if (!senderId || !message.group_openid || !this.#firstSighting(message.id) || this.#isStale(message)) return;
    if (author.bot || (this.#self.id && senderId === this.#self.id)) return;

    this.#remember(message.id, "group");
    this.#deliver({
      id: message.id,
      channelId: this.id,
      conversationId: message.group_openid,
      conversationKind: "group",
      conversationTitle: `QQ 群 ${message.group_openid.slice(0, 6)}`,
      senderId,
      senderName: author.username || "群成员",
      text: this.#cleanText(message),
      mentionsBot: alwaysMentioned || (message.mentions ?? []).some((user) => this.#isSelf(user)),
      at: Date.now(),
    });
  }

  #onPrivateMessage(message: QqMessage) {
    const author = message.author ?? {};
    const senderId = author.user_openid ?? author.id;
    if (!senderId || !this.#firstSighting(message.id) || this.#isStale(message)) return;

    this.#remember(message.id, "dm");
    const senderName = author.username || "QQ 用户";
    this.#deliver({
      id: message.id,
      channelId: this.id,
      conversationId: senderId,
      conversationKind: "dm",
      conversationTitle: `和 ${senderName} 的私聊`,
      senderId,
      senderName,
      text: this.#cleanText(message),
      mentionsBot: true,
      at: Date.now(),
    });
  }

  #isStale(message: QqMessage): boolean {
    const sentAt = message.timestamp ? Date.parse(message.timestamp) : Number.NaN;
    return !Number.isNaN(sentAt) && Date.now() - sentAt > MAX_MESSAGE_AGE_MS;
  }

  #isSelf(user: QqUser): boolean {
    if (user.is_you) return true;
    const id = user.member_openid ?? user.id;
    return Boolean(this.#self.id && id === this.#self.id);
  }

  // Raw IDs in the text are noise to the model, so mentions become names.
  #cleanText(message: QqMessage): string {
    const mentions = message.mentions ?? [];
    const text = (message.content ?? "")
      .replace(/<@!?([^>\s]+)>/g, (_, id: string) => {
        if (id === "all") return "@全体成员";
        const user = mentions.find((entry) => entry.member_openid === id || entry.id === id);
        if ((user && this.#isSelf(user)) || id === this.#self.id) return "";
        return `@${user?.username || "某人"}`;
      })
      .trim();
    const attachments = (message.attachments ?? []).map((file) => (file.content_type?.startsWith("image/") ? "[图片]" : `[文件 ${file.filename ?? ""}]`.replace(" ]", "]")));
    return [text, ...attachments].filter(Boolean).join(" ");
  }

  #deliver(message: InboundMessage) {
    if (!message.text) return;
    this.#handlers?.onMessage(message);
  }

  // The gateway can deliver the same event again, notably after a resume.
  #firstSighting(id: string): boolean {
    if (this.#seen.has(id)) return false;
    this.#seen.add(id);
    if (this.#seen.size > SEEN_LIMIT) this.#seen.delete(this.#seen.values().next().value as string);
    return true;
  }

  #remember(id: string, kind: ConversationKind) {
    this.#replyable.set(id, { kind, receivedAt: Date.now(), replies: 0 });
    if (this.#replyable.size > SEEN_LIMIT) this.#replyable.delete(this.#replyable.keys().next().value as string);
  }

  #onClosed(code: number, reason: string) {
    if (this.#stopped) return;
    if (FATAL_CLOSE_CODES.has(code)) {
      this.#setStatus({ state: "error", detail: `连接被拒绝（${code}${reason ? ` ${reason}` : ""}），不会自动重试` });
      return;
    }
    if (SESSION_LOST_CLOSE_CODES.has(code) || (code >= 4900 && code <= 4913)) {
      this.#sessionId = null;
      this.#lastSeq = null;
    }
    if (code === 4004) this.#tokenExpiresAt = 0;
    this.#scheduleReconnect(`连接断开（${code}）`);
  }

  #dropAndReconnect(reason: string) {
    this.#closeSocket();
    this.#scheduleReconnect(reason);
  }

  #closeSocket() {
    clearInterval(this.#heartbeat);
    const ws = this.#ws;
    this.#ws = null;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      try {
        ws.close(1000);
      } catch {
        // Already closing.
      }
    }
  }

  #scheduleReconnect(reason: string) {
    if (this.#stopped) return;
    this.#setStatus({ state: "connecting", detail: `${reason}，正在重连` });
    clearTimeout(this.#reconnect);
    this.#reconnect = setTimeout(() => void this.#connect(), this.#backoffMs);
    this.#reconnect.unref();
    this.#backoffMs = Math.min(this.#backoffMs * 2, MAX_BACKOFF_MS);
  }

  async #ensureToken(): Promise<string> {
    if (this.#accessToken && Date.now() < this.#tokenExpiresAt - 60_000) return this.#accessToken;
    const response = await fetch(`${this.#api}/app/getAppAccessToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: this.#appId, clientSecret: this.#appSecret }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: string | number; code?: number; message?: string };
    if (!body.access_token) throw new QqApiError(response.status, body.code, body.message ?? "无法获取访问令牌");
    this.#accessToken = body.access_token;
    this.#tokenExpiresAt = Date.now() + Number(body.expires_in ?? 0) * 1000;
    return this.#accessToken;
  }

  async #request(method: string, path: string, payload?: unknown, retried = false): Promise<unknown> {
    const token = await this.#ensureToken();
    const response = await fetch(`${this.#api}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as { code?: number; message?: string } | null;
    if (response.status === 401 && !retried) {
      this.#tokenExpiresAt = 0;
      return this.#request(method, path, payload, true);
    }
    if (!response.ok) throw new QqApiError(response.status, body?.code, body?.message);
    return body;
  }

  #setStatus(status: ChannelStatus) {
    this.#handlers?.onStatus(status);
  }
}
