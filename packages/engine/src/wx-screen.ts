// Runs wx-helper.ps1, the only part of the engine that can see the WeChat window. It stays
// running between scans because loading the Windows OCR types takes a couple of seconds.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_SCRIPT = fileURLToPath(new URL("./wx-helper.ps1", import.meta.url));
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_STDERR_CHARS = 300;

export type ScreenMention = { y: number; names: string[] };

type Unavailable = { state: "missing" | "minimized" | "blank" };

export type ScreenScan = Unavailable | { state: "ok"; mentions: ScreenMention[]; foreground: boolean; idleMs: number };

export type OpenedRow = Unavailable | { state: "ok"; titles: string[] };

// The titles were read from the same capture as the image, so they say what that image shows.
export type ChatPage = { image: Buffer; titles: string[] };

export type ChatCapture = Unavailable | { state: "ok"; pages: ChatPage[]; reachedTop: boolean; interrupted: boolean };

export interface WeChatScreen {
  scan(): Promise<ScreenScan>;
  // Opens the session list's row at this height. Opening a chat marks it as read.
  openRow(y: number): Promise<OpenedRow>;
  // The open chat, oldest page first.
  captureChat(options: { pages: number; postsPerPage: number }): Promise<ChatCapture>;
  stop(): Promise<void>;
}

type Waiting = { resolve(reply: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

const HELPER_ERRORS: Record<string, string> = { "no-chinese-ocr": "这台电脑没有装中文 OCR 语言包。" };

// It reads a screen, so it has no use for the API key and platform secrets in the engine's own
// environment.
function withoutSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.toUpperCase().startsWith("SHU_")));
}

export class WxHelperScreen implements WeChatScreen {
  #script: string;
  #timeoutMs: number;
  #child: ChildProcessWithoutNullStreams | null = null;
  #waiting = new Map<number, Waiting>();
  #nextId = 0;

  constructor(options: { script?: string; timeoutMs?: number } = {}) {
    this.#script = options.script ?? DEFAULT_SCRIPT;
    this.#timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  scan(): Promise<ScreenScan> {
    return this.#request("scan");
  }

  openRow(y: number): Promise<OpenedRow> {
    return this.#request("openRow", { y });
  }

  async captureChat(options: { pages: number; postsPerPage: number }): Promise<ChatCapture> {
    type Raw = Unavailable | { state: "ok"; pages: { image: string; titles: string[] }[]; reachedTop: boolean; interrupted: boolean };
    const raw = await this.#request<Raw>("captureChat", options);
    if (raw.state !== "ok") return raw;
    // It captures while scrolling up, so the newest page comes first.
    const pages = raw.pages.map((page) => ({ image: Buffer.from(page.image, "base64"), titles: page.titles })).reverse();
    return { state: "ok", pages, reachedTop: raw.reachedTop, interrupted: raw.interrupted };
  }

  selfTest(): Promise<ScreenScan> {
    return this.#request("selftest");
  }

  selfTestRows(): Promise<ScreenScan> {
    return this.#request("selftestRows");
  }

  selfTestChat(): Promise<{ width: number; expectedWidth: number; height: number; expectedHeight: number; listVisible: boolean; titles: string[] }> {
    return this.#request("selftestChat");
  }

  async stop() {
    this.#end(new Error("已停止读取微信窗口。"));
  }

  #request<T>(command: string, args: Record<string, number> = {}): Promise<T> {
    const child = this.#child ?? this.#launch();
    const id = ++this.#nextId;
    return new Promise<T>((resolve, reject) => {
      // A stuck helper would never answer anything again, so this ends it rather than just this
      // request. The next one starts a fresh helper.
      const timer = setTimeout(() => this.#end(new Error("读取微信窗口超时。")), this.#timeoutMs);
      this.#waiting.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ ...args, id, command })}\n`);
    });
  }

  #launch(): ChildProcessWithoutNullStreams {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.#script], {
      windowsHide: true,
      env: withoutSecrets(process.env),
    });
    this.#child = child;

    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) this.#onReply(child, line);
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
    });

    // Only ever a helper that has already died, which the exit event reports.
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      if (child === this.#child) this.#end(new Error(`无法启动读取程序：${error.message}`));
    });
    child.on("exit", (code) => {
      if (child === this.#child) this.#end(new Error(`读取程序退出了（${code}）${stderr ? `：${stderr.trim()}` : ""}`));
    });
    return child;
  }

  #onReply(child: ChildProcessWithoutNullStreams, line: string) {
    if (child !== this.#child) return;
    let reply: { id?: number; error?: string };
    try {
      reply = JSON.parse(line);
    } catch {
      return this.#end(new Error("读取程序返回了看不懂的内容。"));
    }
    const waiting = this.#waiting.get(reply.id ?? 0);
    if (!waiting) return;
    this.#waiting.delete(reply.id as number);
    clearTimeout(waiting.timer);
    if (reply.error !== undefined) waiting.reject(new Error(HELPER_ERRORS[reply.error] ?? `读取微信窗口出错：${reply.error}`));
    else waiting.resolve(reply);
  }

  #end(error: Error) {
    const child = this.#child;
    this.#child = null;
    child?.kill();
    for (const waiting of this.#waiting.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.#waiting.clear();
  }
}
