// Watches the WeChat session list for "someone @ me". A marker stays on screen until its chat is
// opened, so what's new is worked out by remembering what has already been seen. A mention in a
// group the owner has allowed gets opened and read, which marks that chat as read. Any other chat
// is left exactly as it was.
import type { WorkbenchStatus } from "@shu/protocol";
import type { ScreenMention, ScreenScan, SendOutcome, WeChatScreen } from "./wx-screen.ts";

// Where the owner forwards a chat record to have it read. It's the owner's own chat with themself,
// so its content is theirs to send.
export const FILE_TRANSFER = "文件传输助手";

// One scan can miss a marker that's still there, and that mustn't count as a new @ afterwards.
const SCANS_BEFORE_GONE = 3;
// A name that can't be read now often can be on the next scan, and only then can it be acted on.
const SCANS_BEFORE_UNREADABLE = 3;
// With WeChat in front, the owner is using it unless they've left it alone for this long. Reading a
// long message involves no input, and opening a chat would take it away from them.
const IN_USE_IDLE_MS = 3 * 60_000;
// Enough for the conversation around a mention. Four wheel messages move about 250 px of a message
// area of about 470, which leaves plenty of overlap for the model to line pages up by.
const READ_PAGES = 3;
const POSTS_PER_PAGE = 4;
// The owner asked for a record to be read, maybe from WeChat on this computer, so a few seconds
// away from the keyboard is enough. Opening a chat while they type would put their typing in it.
const ASKED_IDLE_MS = 5_000;
const ASKED_WAITS = 5;
const ASKED_WAIT_MS = 3_000;

export type WorkbenchMention = {
  // As read from the screen, which can be wrong unless it matched an allowed group.
  group: string | null;
  allowed: boolean;
};

// OCR gives text with no spaces and with full-width symbols folded, so a name typed in the console
// has to be in the same form before the two can be compared.
export function normalizeGroupName(name: string): string {
  return name.normalize("NFKC").replace(/\s/g, "");
}

export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min((current[j - 1] as number) + 1, (previous[j] as number) + 1, (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length] as number;
}

// Names this close can be misread as each other, and one of them might be a group that must not
// be touched, so they can't both be allowed.
export function confusableGroup(name: string, allowed: string[]): string | undefined {
  return allowed.find((other) => other !== name && editDistance(name, other) <= 1);
}

// The list cuts a long name short with an ellipsis, so all there is to compare is the start.
const TRUNCATED = /\.{3}$/;
const MIN_TRUNCATED_CHARS = 4;

function readsAs(candidate: string, allowed: string): boolean {
  if (candidate === allowed) return true;
  if (!TRUNCATED.test(candidate)) return false;
  const start = candidate.replace(TRUNCATED, "");
  return start.length >= MIN_TRUNCATED_CHARS && allowed.startsWith(start);
}

// Allowed only when what was read can be just one of the allowed groups. Two that fit means it
// can't be told which, and treating that as neither is the safe way to be wrong.
export function identifyGroup(candidates: string[], allowedGroups: string[]): WorkbenchMention {
  const names = candidates.map(normalizeGroupName).filter(Boolean);
  const fits = allowedGroups.filter((allowed) => names.some((name) => readsAs(name, normalizeGroupName(allowed))));
  if (fits.length === 1) return { group: fits[0] as string, allowed: true };
  return { group: mostCommon(names), allowed: false };
}

// What decides whether a screen's content may leave this computer, so it has to be exact. The
// header can show a group's member count after its name, unlike the session list.
export function titleMatches(titles: string[], group: string): boolean {
  const wanted = normalizeGroupName(group);
  return titles.map(normalizeGroupName).some((title) => title === wanted || title.replace(/\(\d+\)$/, "") === wanted);
}

function mostCommon(names: string[]): string | null {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  let best: string | null = null;
  for (const [name, count] of counts) {
    if (best === null || count > (counts.get(best) as number) || (count === counts.get(best) && name.length > best.length)) best = name;
  }
  return best;
}

type Tracked = { group: string | null; missed: number; sightings: number; reported: boolean };

export type ChatReading = { group: string; images: Buffer[]; reachedTop: boolean; signal: AbortSignal };

export type RecordReading = { title: string; images: Buffer[]; pages: number; complete: boolean; uncertain: boolean };

const UNAVAILABLE: Record<string, string> = {
  missing: "没找到微信主窗口。",
  minimized: "微信被最小化了，恢复窗口后再试，盖在别的窗口后面没关系。",
  blank: "微信窗口截出来是空白的，稍后再试。",
};

const RECORD_PROBLEMS: Record<string, string> = {
  "wrong-chat": `打开的聊天不是“${FILE_TRANSFER}”，没有读。`,
  "no-record": `${FILE_TRANSFER}里没看到聊天记录。把聊天记录合并转发到${FILE_TRANSFER}，让它显示在最下面，再让我读。`,
  "not-opened": "点了聊天记录，但没有打开记录窗口。如果已经开着一个聊天记录窗口，先关掉再试。",
  "not-record": "打开的窗口不像聊天记录，没有读，也没有关掉它，请看一下。",
};

export class Workbench {
  #screen: WeChatScreen;
  #intervalMs: number;
  #allowedGroups: () => string[];
  #onMention: (mention: WorkbenchMention) => boolean;
  #onRead: (reading: ChatReading) => Promise<void>;
  #onReadFailed: (group: string, reason: string) => void;
  #onDropped: (group: string) => void;
  #onExisting: (count: number) => void;
  #onStatus: (status: WorkbenchStatus) => void;

  #running = false;
  // Bumped by each stop, so that a scan still under way can't report into the next run.
  #run = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #tracked: Tracked[] = [];
  #firstScan = true;
  // Allowed groups with a mention that hasn't been read yet.
  #toRead = new Set<string>();
  #reading: AbortController | null = null;
  #readFinished: Promise<void> = Promise.resolve();
  #recordFinished: Promise<void> = Promise.resolve();
  // While set, nothing else may click or scroll in the window.
  #sending = false;
  // The helper answers one request at a time, and a record takes it a minute or more, which a scan
  // waiting behind it would take for a helper that's stuck. So the two never overlap.
  #screenLock: Promise<unknown> = Promise.resolve();
  #holders = 0;
  #askedWaitMs: number;

  constructor(options: {
    screen: WeChatScreen;
    intervalMs: number;
    allowedGroups(): string[];
    // True to have this mention's chat opened and read.
    onMention(mention: WorkbenchMention): boolean;
    onRead(reading: ChatReading): Promise<void>;
    onReadFailed(group: string, reason: string): void;
    // The marker went away before it could be read, so the owner has opened that chat themselves.
    onDropped(group: string): void;
    onExisting(count: number): void;
    onStatus(status: WorkbenchStatus): void;
    // How long to wait each time for the owner to stop using WeChat before opening a chat they asked for.
    askedWaitMs?: number;
  }) {
    this.#askedWaitMs = options.askedWaitMs ?? ASKED_WAIT_MS;
    this.#screen = options.screen;
    this.#intervalMs = options.intervalMs;
    this.#allowedGroups = options.allowedGroups;
    this.#onMention = options.onMention;
    this.#onRead = options.onRead;
    this.#onReadFailed = options.onReadFailed;
    this.#onDropped = options.onDropped;
    this.#onExisting = options.onExisting;
    this.#onStatus = options.onStatus;
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#tracked = [];
    this.#toRead.clear();
    this.#firstScan = true;
    this.#onStatus({ state: "scanning" });
    void this.#scan(this.#run);
  }

  async stop() {
    this.#running = false;
    this.#run += 1;
    clearTimeout(this.#timer);
    this.#reading?.abort();
    this.#onStatus({ state: "off" });
    await this.#screen.stop();
  }

  // Waits for any read to finish, and keeps new ones from starting, since both work in the window.
  async sendDraft(group: string, text: string, mention?: string): Promise<SendOutcome> {
    this.#sending = true;
    try {
      await this.#readFinished;
      await this.#recordFinished;
      return await this.#screen.sendText(group, text, mention);
    } finally {
      this.#sending = false;
    }
  }

  // The newest chat record the owner forwarded to File Transfer Assistant, opening that chat first if
  // it isn't open. Only ever because the owner asked for it.
  readRecord(): Promise<RecordReading> {
    if (!this.#running) return Promise.reject(new Error("微信工作群读取没有打开，在控制台打开后再试。"));
    const run = this.#run;
    const reading = this.#exclusive(async () => {
      if (run !== this.#run) throw new Error("已停止读取微信窗口。");
      if (this.#sending) throw new Error("正在往群里发消息，发完再试。");
      await this.#openChat(FILE_TRANSFER, run);
      if (run !== this.#run) throw new Error("已停止读取微信窗口。");
      const capture = await this.#screen.captureRecord(FILE_TRANSFER);
      if (run !== this.#run) throw new Error("已停止读取微信窗口。");
      if (capture.state !== "ok") throw new Error(UNAVAILABLE[capture.state] ?? RECORD_PROBLEMS[capture.state] ?? "没有读到聊天记录。");
      const { title, slices, pages, complete, uncertain } = capture;
      if (!slices.length) throw new Error("没有读到聊天记录。");
      return { title, images: slices, pages, complete, uncertain };
    });
    this.#recordFinished = reading.then(
      () => {},
      () => {},
    );
    return reading;
  }

  // The list's read of a name only picks the row to click. The title decides whether it's the chat.
  async #openChat(name: string, run: number) {
    for (let waited = 0; ; waited++) {
      // Asking the helper anything would start it again after a stop.
      if (run !== this.#run) throw new Error("已停止读取微信窗口。");
      const located = await this.#screen.locateChat(name);
      if (run !== this.#run) throw new Error("已停止读取微信窗口。");
      if (located.state !== "ok") throw new Error(UNAVAILABLE[located.state]);
      if (titleMatches(located.titles, name)) return;
      if (located.foreground && located.idleMs < ASKED_IDLE_MS) {
        if (waited >= ASKED_WAITS) throw new Error(`你一直在用微信，没有点开“${name}”。停下几秒后再让我读。`);
        await new Promise((resolve) => setTimeout(resolve, this.#askedWaitMs));
        continue;
      }
      const row = located.rows[0];
      if (row === undefined) throw new Error(`微信左栏里没看到“${name}”。先在微信里点开它，或者往里面发一条，再让我读。`);
      const opened = await this.#screen.openRow(row);
      if (run !== this.#run) throw new Error("已停止读取微信窗口。");
      if (opened.state !== "ok") throw new Error(UNAVAILABLE[opened.state]);
      if (!titleMatches(opened.titles, name)) throw new Error(`点开后标题不是“${name}”，可能点错了聊天，没有读内容。`);
      return;
    }
  }

  // Starts at once when nothing else holds the helper, so a scan begins the moment reading is turned on.
  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const done = this.#holders === 0 ? work() : this.#screenLock.then(work);
    this.#holders += 1;
    this.#screenLock = done.then(
      () => void (this.#holders -= 1),
      () => void (this.#holders -= 1),
    );
    return done;
  }

  async #scan(run: number) {
    if (!(await this.#exclusive(() => this.#scanOnce(run)))) return;
    this.#timer = setTimeout(() => void this.#scan(run), this.#intervalMs);
    this.#timer.unref();
  }

  // False once this run has been stopped, so nothing more is scheduled.
  async #scanOnce(run: number): Promise<boolean> {
    const stale = () => run !== this.#run;
    if (stale()) return false;
    try {
      const result = await this.#screen.scan();
      if (stale()) return false;
      if (result.state === "ok") {
        this.#observe(result.mentions);
        const next = this.#sending ? null : this.#nextToRead(result);
        if (next && result.foreground && result.idleMs < IN_USE_IDLE_MS) {
          this.#onStatus({ state: "scanning", detail: `你正在用微信，等你停下来再读“${next.group}”。` });
        } else {
          this.#onStatus({ state: "scanning" });
          // One at a time. Rows can move during a read, so the next one waits for a new scan.
          if (next) {
            this.#toRead.delete(next.group);
            this.#readFinished = this.#read(next.group, next.y, run);
            await this.#readFinished;
            if (stale()) return false;
          }
        }
      } else if (result.state === "minimized") {
        this.#onStatus({ state: "paused", detail: "微信被最小化了，恢复窗口后继续读取。盖在别的窗口后面没关系。" });
      } else if (result.state === "missing") {
        this.#onStatus({ state: "paused", detail: "没找到微信主窗口，打开后继续读取。" });
      } else {
        this.#onStatus({ state: "paused", detail: "微信窗口截出来是空白的，稍后再试。" });
      }
    } catch (error) {
      if (stale()) return false;
      this.#onStatus({ state: "error", detail: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  #observe(mentions: ScreenMention[]) {
    const allowed = this.#allowedGroups();
    const seenNow = new Set<Tracked>();
    const fresh: WorkbenchMention[] = [];
    for (const { names } of mentions) {
      const mention = identifyGroup(names, allowed);
      const known = this.#tracked.find((tracked) => !seenNow.has(tracked) && sameGroup(tracked.group, mention.group));
      const tracked = known ?? { group: mention.group, missed: 0, sightings: 0, reported: false };
      if (!known) this.#tracked.push(tracked);
      tracked.missed = 0;
      tracked.sightings += 1;
      seenNow.add(tracked);
      if (!tracked.reported && (mention.group !== null || this.#firstScan || tracked.sightings >= SCANS_BEFORE_UNREADABLE)) {
        tracked.reported = true;
        fresh.push(mention);
      }
    }
    for (const tracked of this.#tracked) if (!seenNow.has(tracked)) tracked.missed += 1;
    for (const { group, missed } of this.#tracked) {
      if (missed >= SCANS_BEFORE_GONE && group !== null && this.#toRead.delete(group)) this.#onDropped(group);
    }
    this.#tracked = this.#tracked.filter((tracked) => tracked.missed < SCANS_BEFORE_GONE);

    // Already there when reading began, like messages that arrive while the switch is off.
    if (this.#firstScan) {
      this.#firstScan = false;
      if (fresh.length) this.#onExisting(fresh.length);
      return;
    }
    for (const mention of fresh) {
      if (this.#onMention(mention) && mention.group !== null) this.#toRead.add(mention.group);
    }
  }

  #nextToRead(scan: Extract<ScreenScan, { state: "ok" }>): { group: string; y: number } | null {
    const allowed = this.#allowedGroups();
    for (const group of this.#toRead) {
      const row = scan.mentions.find(({ names }) => {
        const mention = identifyGroup(names, allowed);
        return mention.allowed && mention.group === group;
      });
      if (row) return { group, y: row.y };
    }
    return null;
  }

  async #read(group: string, y: number, run: number) {
    const stale = () => run !== this.#run;
    const controller = new AbortController();
    this.#reading = controller;
    try {
      const opened = await this.#screen.openRow(y);
      if (stale()) return;
      if (opened.state !== "ok") return this.#onReadFailed(group, "微信窗口读不到了，没有读内容。");
      if (!titleMatches(opened.titles, group)) return this.#onReadFailed(group, "点开后标题对不上，可能点错了聊天，内容没有发给 Claude。");

      const capture = await this.#screen.captureChat({ pages: READ_PAGES, postsPerPage: POSTS_PER_PAGE });
      if (stale()) return;
      if (capture.state !== "ok") return this.#onReadFailed(group, "微信窗口读不到了，没有读内容。");
      if (!capture.pages.length) return this.#onReadFailed(group, "你回到了微信，这次没有读内容。");
      // Each image's own title decides, since the chat could have changed while it was scrolling.
      if (!capture.pages.every((page) => titleMatches(page.titles, group))) return this.#onReadFailed(group, "读的时候聊天变了，内容没有发给 Claude。");

      await this.#onRead({ group, images: capture.pages.map((page) => page.image), reachedTop: capture.reachedTop, signal: controller.signal });
    } catch (error) {
      if (stale()) return;
      this.#onReadFailed(group, `读内容时出错：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (this.#reading === controller) this.#reading = null;
    }
  }
}

// A read can come out a character different from one scan to the next.
function sameGroup(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return editDistance(a, b) <= 1;
}
