// The official QQ bot platform: a gateway WebSocket for events and HTTP for sending.
import type { ChannelStatus, ConversationKind } from "@shu/protocol";
import { describeNetworkError, networkErrorCode } from "./net.ts";
import { createHash } from "node:crypto";
import type { Adapter, AdapterConversation, AdapterHandlers, AdapterMessage, ChatImage, InboundAttachment, OutboundTarget, OutboundText, SeenImage, SettingsStore } from "./types.ts";

export const QQ_CHANNEL_ID = "qq";

const DEFAULT_API = "https://api.bot.qq.com";
const GROUP_AND_C2C_EVENT = 1 << 25;
const REQUEST_TIMEOUT_MS = 15_000;
const SEND_ATTEMPTS = 3;
const MAX_CONTENT_CHARS = 1800;
const MAX_BACKOFF_MS = 30_000;
const SEEN_LIMIT = 2000;
// A resume after a long outage can replay old messages. Too late to answer those.
const MAX_MESSAGE_AGE_MS = 10 * 60_000;
const MAX_DOWNLOAD_BYTES = 30 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;
// QQ names a picture after its content's MD5: checked against a picture the owner sent.
const IMAGE_FINGERPRINT = /^([0-9a-f]{32})\.(png|jpe?g|gif|webp)$/i;
const IMAGE_EXTENSIONS: Record<string, string> = { "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp" };

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

// The platform's answer to a msg_id and msg_seq it has already accepted.
const ALREADY_SENT = 40054005;
// Its documented "try again later", for groups and private chats respectively.
const TRY_AGAIN_LATER = new Set([50055001, 50055002]);
// These fail before a request leaves this computer, so it can't have arrived.
const NEVER_ARRIVED = new Set(["UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);

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

// As the platform's own SDK reads them. The official docs don't list these fields.
type QqAttachment = { content_type?: string; filename?: string; url?: string; size?: number };

const isImage = (file: QqAttachment) => Boolean(file.content_type?.startsWith("image") || (file.filename && IMAGE_FILE.test(file.filename)));

// Other clients have seen these links both with and without a scheme. Only web links are fetched.
export function attachmentUrl(raw: string | undefined): URL | null {
  const link = raw?.trim();
  if (!link) return null;
  const withScheme = link.startsWith("//") ? `https:${link}` : /^[a-z][a-z0-9+.-]*:/i.test(link) ? link : `https://${link}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

// A QQ face arrives as markup, with what it says, if anything, as base64 JSON.
function faceText(ext: string): string {
  try {
    const text = (JSON.parse(Buffer.from(ext, "base64").toString("utf8")) as { text?: unknown }).text;
    return typeof text === "string" && text.trim() ? text.trim() : "[表情]";
  } catch {
    return "[表情]";
  }
}

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

// A reply can always go again, because the platform refuses a second copy of the same msg_id
// and msg_seq. Nothing protects an ordinary message, so that only goes again if the first try
// can't have arrived.
function worthRetrying(error: unknown, isReply: boolean): boolean {
  if (error instanceof QqApiError) return TRY_AGAIN_LATER.has(error.code ?? 0) || (isReply && error.status >= 500);
  return isReply || NEVER_ARRIVED.has(networkErrorCode(error) ?? "");
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
  // The owner chats with the bot here; work goes through WeChat.
  readonly personaInOwnerChat = true;

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

  // Keeps uploaded pictures that are the same every time, since the platform holds only so many.
  #cache: SettingsStore | null;

  constructor(options: { appId: string; appSecret: string; apiBase?: string; backoffMs?: number; cache?: SettingsStore }) {
    this.#appId = options.appId;
    this.#appSecret = options.appSecret;
    this.#api = options.apiBase ?? DEFAULT_API;
    this.#baseBackoffMs = options.backoffMs ?? 1000;
    this.#backoffMs = this.#baseBackoffMs;
    this.#cache = options.cache ?? null;
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
    await this.#post(message, { content, msg_type: 0 });
  }

  // Free-form Markdown, which the platform opened to every bot for groups and private chats.
  async sendCard(target: OutboundTarget, markdown: string) {
    const content = prepareContent(markdown);
    if (!content) return;
    await this.#post(target, { msg_type: 2, markdown: { content } });
  }

  // A picture made for this message alone goes up as rich media, which takes PNG and has no cap on
  // how many. Pictures that are the same every time, and animated ones, go up once as materials,
  // which take GIF and are shown in a Markdown message; a bot can only keep 100 of those.
  async sendImages(target: OutboundTarget, images: ChatImage[], caption?: string) {
    const text = caption ? prepareContent(caption) : "";
    const [only] = images;
    if (images.length === 1 && only && !only.reuseKey && only.mediaType === "image/png") {
      const fileInfo = await this.#uploadMedia(target, only);
      await this.#post(target, { msg_type: 7, media: { file_info: fileInfo }, content: text || " " });
      return;
    }
    if (images.some((image) => !image.reuseKey)) throw new Error("这张图不能作为素材上传。");
    const shown: string[] = [];
    for (const image of images) {
      const reference = await this.#material(image);
      shown.push(`![${image.alt.replace(/[[\]]/g, "")} #${image.width}px #${image.height}px](${reference})`);
    }
    await this.#post(target, { msg_type: 2, markdown: { content: [shown.join(""), text].filter(Boolean).join("\n\n") } });
  }

  async #uploadMedia(target: OutboundTarget, image: ChatImage): Promise<string> {
    const base = target.conversationKind === "group" ? `/v2/groups/${target.conversationId}/files` : `/v2/users/${target.conversationId}/files`;
    // Uploaded without sending, so the message that shows it can still be a reply.
    const uploaded = (await this.#request("POST", base, {
      file_type: 1,
      file_name: `${image.alt.replace(/[\\/:*?"<>|\s]/g, "") || "image"}.png`,
      file_data: image.data.toString("base64"),
      srv_send_msg: false,
    })) as { file_info?: string } | null;
    if (!uploaded?.file_info) throw new Error("QQ 没有返回上传的图片。");
    return uploaded.file_info;
  }

  // Uploaded once and then reused, for as long as the platform keeps it. Each use extends that.
  async #material(image: ChatImage): Promise<string> {
    const key = `qq:material:${image.reuseKey}`;
    const saved = this.#cache?.getSetting<{ url: string; expiresAt: number; ttlMs: number }>(key);
    if (saved && saved.expiresAt - Date.now() > 24 * 60 * 60_000) {
      this.#cache?.setSetting(key, { ...saved, expiresAt: Date.now() + saved.ttlMs });
      return saved.url;
    }
    const md5 = createHash("md5").update(image.data).digest("hex");
    const prepared = (await this.#request("POST", "/v2/media-images/prepare", {
      // The platform wants the extension to match the declared type.
      file_name: `${image.reuseKey}.${{ "image/gif": "gif", "image/jpeg": "jpg", "image/png": "png" }[image.mediaType]}`,
      file_size: image.data.length,
      content_type: image.mediaType,
      md5,
      sha1: createHash("sha1").update(image.data).digest("hex"),
    })) as { upload_id?: string; presigned_url?: string } | null;
    if (!prepared?.upload_id || !prepared.presigned_url) throw new Error("QQ 没有给出上传地址。");
    const put = await fetch(prepared.presigned_url, {
      method: "PUT",
      headers: { "Content-Type": image.mediaType },
      body: new Uint8Array(image.data),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2),
    });
    if (!put.ok) throw new Error(`QQ 图片上传失败（HTTP ${put.status}）`);
    const etag = put.headers.get("etag")?.replace(/"/g, "") || md5;
    const completed = (await this.#request("POST", "/v2/media-images/complete", { upload_id: prepared.upload_id, md5: etag })) as { url?: string; ttl?: number } | null;
    if (!completed?.url) throw new Error("QQ 没有返回素材地址。");
    const ttlMs = (completed.ttl ?? 90 * 24 * 60 * 60) * 1000;
    this.#cache?.setSetting(key, { url: completed.url, expiresAt: Date.now() + ttlMs, ttlMs });
    return completed.url;
  }

  // Every try carries the same msg_seq, so it counts as one reply and can't arrive twice.
  async #post(target: OutboundTarget, body: Record<string, unknown>) {
    const base = target.conversationKind === "group" ? `/v2/groups/${target.conversationId}/messages` : `/v2/users/${target.conversationId}/messages`;
    const passive = this.#passiveFields(target.replyToId);
    const isReply = "msg_id" in passive;

    let lastError: unknown;
    for (let attempt = 0; attempt < SEND_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.#baseBackoffMs * attempt));
        // Switched off during the wait, so this must not go out any more.
        if (this.#stopped) break;
      }
      try {
        await this.#request("POST", base, { ...body, ...passive });
        return;
      } catch (error) {
        // An earlier try got through after all, and only its answer was lost.
        if (attempt > 0 && error instanceof QqApiError && error.code === ALREADY_SENT) return;
        lastError = error;
        if (!worthRetrying(error, isReply)) break;
      }
    }
    throw lastError instanceof QqApiError ? lastError : new Error(describeNetworkError(lastError, "QQ"), { cause: lastError });
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
    let ws: WebSocket;
    try {
      await this.#ensureToken();
      const gateway = (await this.#request("GET", "/gateway/bot")) as { url?: string };
      if (!gateway.url) throw new Error("没有拿到网关地址");
      if (this.#stopped) return;
      ws = new WebSocket(gateway.url);
    } catch (error) {
      return this.#scheduleReconnect(describeNetworkError(error, "QQ"));
    }

    this.#ws = ws;
    ws.addEventListener("message", (event) => {
      if (ws !== this.#ws) return;
      // Nothing else is waiting on this, and a rejection nobody catches would end the whole engine.
      this.#onFrame(ws, String(event.data)).catch((error: unknown) => {
        if (ws === this.#ws) this.#dropAndReconnect(describeNetworkError(error, "QQ"));
      });
    });
    ws.addEventListener("close", (event) => {
      if (ws !== this.#ws) return;
      this.#closeSocket();
      this.#onClosed(event.code, event.reason);
    });
    ws.addEventListener("error", () => {});
  }

  async #onFrame(ws: WebSocket, raw: string) {
    const frame = JSON.parse(raw) as GatewayFrame;
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
    const seenImages = this.#seenImages(message);
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
      ...(seenImages.length ? { seenImages } : {}),
    });
  }

  // Pictures in a group message, by fingerprint, with the link kept for fetching later. The link
  // isn't followed here.
  #seenImages(message: QqMessage): SeenImage[] {
    return (message.attachments ?? []).flatMap((file) => {
      const fingerprint = IMAGE_FINGERPRINT.exec(file.filename ?? "")?.[1];
      const url = attachmentUrl(file.url);
      return isImage(file) && fingerprint && url ? [{ fingerprint: fingerprint.toUpperCase(), fetch: () => this.#download(url) }] : [];
    });
  }

  #onPrivateMessage(message: QqMessage) {
    const author = message.author ?? {};
    const senderId = author.user_openid ?? author.id;
    if (!senderId || !this.#firstSighting(message.id) || this.#isStale(message)) return;

    this.#remember(message.id, "dm");
    const senderName = author.username || "QQ 用户";
    // Handed over to be fetched, which the engine only does for the owner. One without a usable
    // link is still mentioned in the text, so the model knows something was sent.
    const files = message.attachments ?? [];
    const fetchable = files.filter((file) => attachmentUrl(file.url));
    const attachments = fetchable.map((file, index) => this.#attachment(file, message.id, index));
    this.#deliver({
      id: message.id,
      channelId: this.id,
      conversationId: senderId,
      conversationKind: "dm",
      conversationTitle: `和 ${senderName} 的私聊`,
      senderId,
      senderName,
      text: this.#cleanText(message, files.filter((file) => !fetchable.includes(file))),
      mentionsBot: true,
      at: Date.now(),
      ...(attachments.length ? { attachments } : {}),
    });
  }

  #attachment(file: QqAttachment, messageId: string, index: number): InboundAttachment {
    const url = attachmentUrl(file.url) as URL;
    const fallback = `${isImage(file) ? "图片" : "文件"}-${messageId.slice(-8)}${index ? `-${index + 1}` : ""}${isImage(file) ? (IMAGE_EXTENSIONS[file.content_type ?? ""] ?? ".jpg") : ""}`;
    return { name: file.filename?.trim() || fallback, download: () => this.#download(url) };
  }

  async #download(url: URL): Promise<Buffer> {
    const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`QQ 文件下载失败（HTTP ${response.status}）`);
    if (Number(response.headers.get("content-length") ?? 0) > MAX_DOWNLOAD_BYTES) throw new Error("文件太大，超过 30 MB。");
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_DOWNLOAD_BYTES) throw new Error("文件太大，超过 30 MB。");
    return data;
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

  // Raw IDs and markup in the text are noise to the model, so mentions become names and faces words.
  // Attachments that aren't handed over are described instead.
  #cleanText(message: QqMessage, described: QqAttachment[] = message.attachments ?? []): string {
    const mentions = message.mentions ?? [];
    const text = (message.content ?? "")
      .replace(/<faceType=\d+,faceId="[^"]*",ext="([^"]*)">/g, (_, ext: string) => faceText(ext))
      .replace(/<@!?([^>\s]+)>/g, (_, id: string) => {
        if (id === "all") return "@全体成员";
        const user = mentions.find((entry) => entry.member_openid === id || entry.id === id);
        if ((user && this.#isSelf(user)) || id === this.#self.id) return "";
        return `@${user?.username || "某人"}`;
      })
      .trim();
    const attachments = described.map((file) => (isImage(file) ? "[图片]" : `[文件 ${file.filename ?? ""}]`.replace(" ]", "]")));
    return [text, ...attachments].filter(Boolean).join(" ");
  }

  #deliver(message: AdapterMessage) {
    if (!message.text && !message.attachments?.length) return;
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
