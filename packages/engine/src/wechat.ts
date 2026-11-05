// WeChat's bot channel (iLink): a contact on the owner's own account that they can message
// and send files to. It can't read or post in other chats, so it carries instructions and
// results, not work conversations. Tencent only ships this as an OpenClaw plugin; this talks
// to the same endpoints directly, so it can change or stop working without notice.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChannelLogin, ChannelStatus } from "@shu/protocol";
import { describeNetworkError } from "./net.ts";
import type { Adapter, AdapterConversation, AdapterHandlers, InboundAttachment, OutboundText } from "./types.ts";

export const WECHAT_CHANNEL_ID = "wechat";

const DEFAULT_API = "https://ilinkai.weixin.qq.com/";
const DEFAULT_CDN = "https://novac2c.cdn.weixin.qq.com/c2c";
const PROTOCOL_VERSION = "2.4.10";
const BASE_INFO = { channel_version: PROTOCOL_VERSION, bot_agent: "Shu/0.1" };
const LONG_POLL_MS = 35_000;
const POLL_GRACE_MS = 5000;
const REQUEST_TIMEOUT_MS = 15_000;
const STALE_TOKEN = -14;
const MAX_TEXT_CHARS = 4000;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_BACKOFF_MS = 30_000;
const MAX_QR_REFRESHES = 3;
const SEND_ATTEMPTS = 3;
const SEEN_LIMIT = 2000;
// Tolerance for the phone's clock when skipping what was sent before this run began.
const START_GRACE_MS = 5000;

const ItemType = { Text: 1, Image: 2, Voice: 3, File: 4, Video: 5 } as const;
const UploadMediaType = { File: 3 } as const;

type CdnMedia = { encrypt_query_param?: string; aes_key?: string; full_url?: string };

type WeixinItem = {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string };
  image_item?: { media?: CdnMedia; aeskey?: string };
  file_item?: { media?: CdnMedia; file_name?: string };
  ref_msg?: { title?: string; message_item?: WeixinItem };
};

type WeixinMessage = {
  message_id?: string;
  from_user_id?: string;
  message_type?: number;
  create_time_ms?: number;
  context_token?: string;
  item_list?: WeixinItem[];
};

export type WeChatSession = { botToken: string; userId: string; baseUrl?: string };

export type SessionStore = {
  load(): WeChatSession | null;
  save(session: WeChatSession): void;
  clear(): void;
};

export function fileSessionStore(path: string): SessionStore {
  return {
    load: () => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as WeChatSession) : null),
    save: (session) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(session), { mode: 0o600 });
    },
    clear: () => rmSync(path, { force: true }),
  };
}

export class WeChatApiError extends Error {
  // Worth another try, as opposed to something the platform refused outright.
  readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.retryable = retryable;
  }
}

// Message IDs are 64-bit integers, which JSON.parse would silently round.
function parseJson(text: string): any {
  return JSON.parse(text.replace(/(?<!\\)"(message_id|msg_id|svr_id)"\s*:\s*(\d+)/g, '"$1":"$2"'));
}

function encrypt(plain: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

function decrypt(data: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

// Keys arrive as base64 of the raw bytes for images, and as base64 of a hex string for files.
function parseKey(base64: string): Buffer {
  const decoded = Buffer.from(base64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-f]{32}$/i.test(decoded.toString("ascii"))) return Buffer.from(decoded.toString("ascii"), "hex");
  throw new WeChatApiError("文件密钥格式不对。");
}

export class WeChatAdapter implements Adapter {
  readonly id = WECHAT_CHANNEL_ID;
  readonly name = "微信";
  readonly promptHint = "这是主人的微信私聊。微信不显示 Markdown，用纯文本回复。";

  #store: SessionStore;
  #api: string;
  #cdn: string;
  #baseBackoffMs: number;
  #requestTimeoutMs: number;
  #pollTimeoutMs: number;

  #handlers: AdapterHandlers | null = null;
  #session: WeChatSession | null;
  #running = false;
  // Stays false until the first stop, so sending doesn't depend on the channel having started.
  #stopped = false;
  #polling: AbortController | null = null;
  #login: AbortController | null = null;
  #verifyCode: ((code: string) => void) | null = null;
  #startedAt = 0;
  #seen = new Set<string>();
  #contextTokens = new Map<string, string>();

  constructor(options: { sessionStore: SessionStore; apiBase?: string; cdnBase?: string; backoffMs?: number; requestTimeoutMs?: number; pollTimeoutMs?: number }) {
    this.#store = options.sessionStore;
    this.#api = options.apiBase ?? DEFAULT_API;
    this.#cdn = options.cdnBase ?? DEFAULT_CDN;
    this.#baseBackoffMs = options.backoffMs ?? 1000;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.#pollTimeoutMs = options.pollTimeoutMs ?? LONG_POLL_MS + POLL_GRACE_MS;
    this.#session = this.#store.load();
  }

  conversations(): AdapterConversation[] {
    return [];
  }

  // The account that scanned the QR code in the console is the owner.
  ownerId() {
    return this.#session?.userId;
  }

  async start(handlers: AdapterHandlers) {
    this.#handlers = handlers;
    this.#running = true;
    this.#stopped = false;
    this.#startedAt = Date.now();
    if (this.#session) this.#startPolling();
    else this.#setStatus({ state: "needs-login", detail: "还没有登录，请扫码" });
  }

  async stop() {
    this.#running = false;
    this.#stopped = true;
    this.#login?.abort();
    this.#login = null;
    this.#verifyCode = null;
    this.#polling?.abort();
    this.#polling = null;
    this.#setLogin(null);
    this.#setStatus({ state: "stopped" });
  }

  async logout() {
    this.#polling?.abort();
    this.#polling = null;
    this.#session = null;
    this.#store.clear();
    this.#setStatus({ state: "needs-login", detail: "已退出，请重新扫码" });
  }

  async beginLogin() {
    if (!this.#running) throw new WeChatApiError("先打开总闸。");
    this.#login?.abort();
    const controller = new AbortController();
    this.#login = controller;
    void this.#runLogin(controller.signal).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      this.#setLogin({ state: "failed", message: error instanceof Error ? error.message : String(error) });
    });
  }

  submitLoginCode(code: string) {
    this.#verifyCode?.(code);
  }

  async #runLogin(signal: AbortSignal) {
    let base = this.#api;
    for (let refresh = 0; refresh < MAX_QR_REFRESHES; refresh++) {
      const qr = await this.#call(base, "POST", "ilink/bot/get_bot_qrcode?bot_type=3", { local_token_list: [] }, { signal, timeoutMs: REQUEST_TIMEOUT_MS });
      if (!qr.qrcode_img_content || !qr.qrcode) throw new WeChatApiError("没有拿到登录二维码。");
      this.#setLogin({ state: "qr", qrContent: qr.qrcode_img_content });

      let code = "";
      for (;;) {
        signal.throwIfAborted();
        const query = `qrcode=${encodeURIComponent(qr.qrcode)}${code ? `&verify_code=${encodeURIComponent(code)}` : ""}`;
        let status;
        try {
          status = await this.#call(base, "GET", `ilink/bot/get_qrcode_status?${query}`, undefined, { signal, timeoutMs: LONG_POLL_MS + POLL_GRACE_MS });
        } catch (error) {
          if (error instanceof Error && error.name === "TimeoutError") continue;
          throw error;
        }

        if (status.status === "confirmed") {
          if (!status.bot_token || !status.ilink_user_id) throw new WeChatApiError("登录结果不完整。");
          this.#session = { botToken: status.bot_token, userId: status.ilink_user_id, ...(status.baseurl ? { baseUrl: status.baseurl } : {}) };
          this.#store.save(this.#session);
          this.#setLogin(null);
          this.#login = null;
          this.#startPolling();
          return;
        }
        if (status.status === "need_verifycode") {
          this.#setLogin({ state: "verify" });
          code = await new Promise<string>((resolve, reject) => {
            this.#verifyCode = resolve;
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          this.#verifyCode = null;
          continue;
        }
        if (status.status === "scaned") {
          code = "";
          this.#setLogin({ state: "scanned" });
          continue;
        }
        if (status.status === "scaned_but_redirect" && status.redirect_host) {
          base = `https://${status.redirect_host}/`;
          continue;
        }
        if (status.status === "expired" || status.status === "verify_code_blocked") break;
        if (status.status === "binded_redirect") throw new WeChatApiError("这个微信已经绑定在别的地方了。");
      }
    }
    throw new WeChatApiError("二维码多次过期，请重新开始。");
  }

  #startPolling() {
    this.#polling?.abort();
    const controller = new AbortController();
    this.#polling = controller;
    this.#setStatus({ state: "connecting" });
    void this.#poll(controller.signal);
  }

  async #poll(signal: AbortSignal) {
    let cursor = "";
    let backoff = this.#baseBackoffMs;
    let connected = false;
    let timeoutMs = this.#pollTimeoutMs;
    const reachedServer = () => {
      backoff = this.#baseBackoffMs;
      if (connected) return;
      connected = true;
      this.#setStatus({ state: "connected", detail: "只听你自己的微信" });
    };

    while (!signal.aborted && this.#session) {
      try {
        const response = await this.#call(this.#base(), "POST", "ilink/bot/getupdates", { get_updates_buf: cursor }, { signal, timeoutMs, token: this.#session.botToken });
        // Stops calling instead of retrying, as Tencent's plugin does. The token stays saved
        // because this code isn't always permanent: restarting tries it once more.
        if (response.ret === STALE_TOKEN || response.errcode === STALE_TOKEN) {
          this.#setStatus({ state: "needs-login", detail: "微信登录已失效，请重新扫码" });
          return;
        }
        if (response.ret || response.errcode) throw new WeChatApiError(`微信接口错误 ${response.errcode ?? response.ret}${response.errmsg ? `：${response.errmsg}` : ""}`);

        reachedServer();
        if (response.longpolling_timeout_ms > 0) timeoutMs = response.longpolling_timeout_ms + POLL_GRACE_MS;
        if (response.get_updates_buf) cursor = response.get_updates_buf;
        for (const message of (response.msgs ?? []) as WeixinMessage[]) this.#onMessage(message);
      } catch (error) {
        if (signal.aborted) return;
        // With nothing to report, a long poll can just run out of time. A connection that
        // failed gives a different error, so this one means the server is holding the request.
        if (error instanceof Error && error.name === "TimeoutError") {
          reachedServer();
          continue;
        }
        connected = false;
        this.#setStatus({ state: "connecting", detail: `${describeError(error)}，正在重连` });
        await new Promise((resolve) => setTimeout(resolve, backoff));
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  #onMessage(message: WeixinMessage) {
    if (message.message_type !== 1 || !message.from_user_id) return;
    const id = message.message_id ?? `${message.from_user_id}:${message.create_time_ms}`;
    if (this.#seen.has(id)) return;
    this.#seen.add(id);
    if (this.#seen.size > SEEN_LIMIT) this.#seen.delete(this.#seen.values().next().value as string);
    if (message.context_token) this.#contextTokens.set(message.from_user_id, message.context_token);

    // Each run starts without a saved position, so anything older is from before it began.
    const sentAt = message.create_time_ms ?? Date.now();
    if (sentAt < this.#startedAt - START_GRACE_MS) return;

    const isOwner = message.from_user_id === this.#session?.userId;
    const parts: string[] = [];
    const attachments: InboundAttachment[] = [];
    for (const item of message.item_list ?? []) {
      const quoted = item.ref_msg?.message_item?.text_item?.text ?? item.ref_msg?.title;
      if (quoted) parts.push(`（引用：${quoted}）`);
      if (item.type === ItemType.Text && item.text_item?.text) parts.push(item.text_item.text);
      else if (item.type === ItemType.Voice) parts.push(item.voice_item?.text ?? "[语音，没有转成文字]");
      else if (item.type === ItemType.File && item.file_item?.media) attachments.push(this.#attachment(item.file_item.file_name ?? "文件", item.file_item.media));
      else if (item.type === ItemType.Image && item.image_item?.media) {
        const key = item.image_item.aeskey ? Buffer.from(item.image_item.aeskey, "hex").toString("base64") : item.image_item.media.aes_key;
        attachments.push(this.#attachment(`图片-${id.slice(-8)}.jpg`, { ...item.image_item.media, ...(key ? { aes_key: key } : {}) }));
      } else if (item.type === ItemType.Video) parts.push("[视频，暂时看不了]");
    }
    if (!parts.length && !attachments.length) return;

    this.#handlers?.onMessage({
      id,
      channelId: this.id,
      conversationId: message.from_user_id,
      conversationKind: "dm",
      conversationTitle: isOwner ? "我的微信" : "微信私聊",
      senderId: message.from_user_id,
      senderName: isOwner ? "主人" : "微信用户",
      text: parts.join(" "),
      mentionsBot: true,
      at: Date.now(),
      ...(attachments.length ? { attachments } : {}),
    });
  }

  #attachment(name: string, media: CdnMedia): InboundAttachment {
    return { name, download: () => this.#download(media) };
  }

  async #download(media: CdnMedia): Promise<Buffer> {
    const url = media.full_url ?? `${this.#cdn}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param ?? "")}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new WeChatApiError(`下载文件失败（${response.status}）`);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_DOWNLOAD_BYTES) throw new WeChatApiError("文件太大。");
    return media.aes_key ? decrypt(data, parseKey(media.aes_key)) : data;
  }

  async send(message: OutboundText) {
    for (const part of splitText(message.text, MAX_TEXT_CHARS)) {
      await this.#sendItems(message.conversationId, [{ type: ItemType.Text, text_item: { text: part } }]);
    }
  }

  async sendFile(conversationId: string, absolutePath: string, fileName: string) {
    if (!this.#session) throw new WeChatApiError("微信还没有登录。");
    const plain = await readFile(absolutePath);
    const key = randomBytes(16);
    const hexKey = key.toString("hex");
    const fileKey = randomBytes(16).toString("hex");
    const cipher = encrypt(plain, key);

    const { botToken } = this.#session;
    const upload = await this.#withRetry(() =>
      this.#call(
        this.#base(),
        "POST",
        "ilink/bot/getuploadurl",
        {
          filekey: fileKey,
          media_type: UploadMediaType.File,
          to_user_id: conversationId,
          rawsize: plain.length,
          rawfilemd5: createHash("md5").update(plain).digest("hex"),
          filesize: cipher.length,
          no_need_thumb: true,
          aeskey: hexKey,
        },
        { timeoutMs: this.#requestTimeoutMs, token: botToken },
      ),
    );
    const uploadUrl: string | undefined =
      upload.upload_full_url?.trim() ||
      (upload.upload_param ? `${this.#cdn}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${encodeURIComponent(fileKey)}` : undefined);
    if (!uploadUrl) throw new WeChatApiError("没有拿到上传地址。");

    const downloadParam = await this.#upload(uploadUrl, cipher);
    await this.#sendItems(conversationId, [
      {
        type: ItemType.File,
        file_item: {
          media: { encrypt_query_param: downloadParam, aes_key: Buffer.from(hexKey).toString("base64"), encrypt_type: 1 },
          file_name: fileName,
          len: String(plain.length),
        },
      },
    ]);
  }

  // By the time something is sent it has usually been paid for, and a send really did time out
  // once in real use, so a network blip shouldn't lose it. Stops trying once the channel stops.
  async #withRetry<T>(action: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < SEND_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.#baseBackoffMs * attempt));
        if (this.#stopped) break;
      }
      try {
        return await action();
      } catch (error) {
        if (error instanceof WeChatApiError && !error.retryable) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof WeChatApiError ? lastError : new WeChatApiError(describeError(lastError));
  }

  // Returns the parameter a recipient needs to download the file.
  #upload(url: string, cipher: Buffer): Promise<string> {
    return this.#withRetry(async () => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(cipher),
        signal: AbortSignal.timeout(120_000),
      });
      const param = response.headers.get("x-encrypted-param");
      if (response.ok && param) return param;
      throw new WeChatApiError(`上传文件失败（${response.status}）`, response.status >= 500);
    });
  }

  async #sendItems(to: string, items: unknown[]) {
    if (!this.#session) throw new WeChatApiError("微信还没有登录。");
    const { botToken } = this.#session;
    const contextToken = this.#contextTokens.get(to);
    // The same ID on every attempt, in case one that timed out actually got through.
    const clientId = `shu-${randomUUID()}`;
    await this.#withRetry(async () => {
      const response = await this.#call(
        this.#base(),
        "POST",
        "ilink/bot/sendmessage",
        {
          msg: {
            from_user_id: "",
            to_user_id: to,
            client_id: clientId,
            message_type: 2,
            message_state: 2,
            item_list: items,
            ...(contextToken ? { context_token: contextToken } : {}),
          },
        },
        { timeoutMs: this.#requestTimeoutMs, token: botToken },
      );
      if (response.ret || response.errcode) throw new WeChatApiError(`微信接口错误 ${response.errcode ?? response.ret}${response.errmsg ? `：${response.errmsg}` : ""}`);
    });
  }

  #base(): string {
    const base = this.#session?.baseUrl || this.#api;
    return base.endsWith("/") ? base : `${base}/`;
  }

  async #call(base: string, method: "GET" | "POST", path: string, body: object | undefined, options: { signal?: AbortSignal; timeoutMs: number; token?: string }): Promise<any> {
    const signals = [AbortSignal.timeout(options.timeoutMs), ...(options.signal ? [options.signal] : [])];
    const [major, minor, patch] = PROTOCOL_VERSION.split(".").map(Number) as [number, number, number];
    const response = await fetch(new URL(path, base), {
      method,
      headers: {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString("base64"),
        "iLink-App-Id": "bot",
        "iLink-App-ClientVersion": String((major << 16) | (minor << 8) | patch),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      ...(body ? { body: JSON.stringify({ ...body, base_info: BASE_INFO }) } : {}),
      signal: AbortSignal.any(signals),
    });
    const text = await response.text();
    if (!response.ok) throw new WeChatApiError(`微信接口错误（HTTP ${response.status}）`, response.status >= 500);
    return text ? parseJson(text) : {};
  }

  #setStatus(status: ChannelStatus) {
    this.#handlers?.onStatus(status);
  }

  #setLogin(login: ChannelLogin | null) {
    this.#handlers?.onLogin?.(login);
  }
}

// Never cuts an emoji or other two-unit character in half.
export function splitText(text: string, size: number): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    const lastUnit = text.charCodeAt(end - 1);
    if (end < text.length && lastUnit >= 0xd800 && lastUnit <= 0xdbff) end -= 1;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

function describeError(error: unknown): string {
  return describeNetworkError(error, "微信");
}
