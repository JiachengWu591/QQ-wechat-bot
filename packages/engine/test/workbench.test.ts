import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { WorkbenchStatus } from "@shu/protocol";
import { confusableGroup, editDistance, FILE_TRANSFER, identifyGroup, normalizeGroupName, titleMatches, Workbench, type ChatReading, type WorkbenchMention } from "../src/workbench.ts";
import type { ChatCapture, LocatedChat, OpenedRow, RecordCapture, ScreenScan, SendOutcome, WeChatScreen } from "../src/wx-screen.ts";

// Scripted answers, one per scan. Once they run out it keeps repeating the last one.
class FakeScreen implements WeChatScreen {
  plan: Array<ScreenScan | Error | Promise<ScreenScan>> = [];
  scans = 0;
  stops = 0;
  opened: number[] = [];
  openAnswer: OpenedRow | Error | Promise<OpenedRow> = { state: "ok", titles: ["项目周会群(3)"] };
  captures = 0;
  captureAnswer: ChatCapture | Error | Promise<ChatCapture> = { state: "ok", pages: [page("项目周会群(3)"), page("项目周会群(3)")], reachedTop: false, interrupted: false };

  async scan(): Promise<ScreenScan> {
    this.scans++;
    if (this.recording) this.overlapped++;
    const next = this.plan.length > 1 ? this.plan.shift() : this.plan[0];
    if (next === undefined) return nothing;
    if (next instanceof Error) throw next;
    return next;
  }

  async openRow(y: number): Promise<OpenedRow> {
    this.opened.push(y);
    if (this.openAnswer instanceof Error) throw this.openAnswer;
    return this.openAnswer;
  }

  async captureChat(): Promise<ChatCapture> {
    this.captures++;
    if (this.captureAnswer instanceof Error) throw this.captureAnswer;
    return this.captureAnswer;
  }

  sends: string[] = [];
  sendAnswer: SendOutcome | Promise<SendOutcome> = { state: "sent" };

  async sendText(group: string, text: string, mention?: string): Promise<SendOutcome> {
    this.sends.push(`${group}: ${mention ? `@${mention} ` : ""}${text}`);
    return this.sendAnswer;
  }

  // One answer per look at the session list. Once they run out it keeps repeating the last one.
  locatePlan: LocatedChat[] = [located({ open: true })];
  located: string[] = [];

  async locateChat(name: string): Promise<LocatedChat> {
    this.located.push(name);
    return (this.locatePlan.length > 1 ? this.locatePlan.shift() : this.locatePlan[0]) as LocatedChat;
  }

  recorded: string[] = [];
  recordAnswer: RecordCapture | Promise<RecordCapture> = { state: "ok", title: "群聊的聊天记录", slices: [Buffer.from("top"), Buffer.from("end")], pages: 5, complete: true, uncertain: false };
  // Set while a record is being read, to show what else happens meanwhile.
  recording = false;
  overlapped = 0;

  async captureRecord(chat: string): Promise<RecordCapture> {
    this.recorded.push(chat);
    this.recording = true;
    try {
      return await this.recordAnswer;
    } finally {
      this.recording = false;
    }
  }

  async stop() {
    this.stops++;
  }
}

function located({ open = false, rows = [300], foreground = false, idleMs = 60_000 }: { open?: boolean; rows?: number[]; foreground?: boolean; idleMs?: number } = {}): LocatedChat {
  return { state: "ok", titles: open ? ["文牛传输助手", FILE_TRANSFER] : ["项目周会群(3)"], rows, foreground, idleMs };
}

function page(...titles: string[]) {
  return { image: Buffer.from("png"), titles };
}

const seen = (...rows: string[][]): ScreenScan => ({ state: "ok", foreground: false, idleMs: 0, mentions: rows.map((names, index) => ({ y: 100 + index * 80, names })) });
const nothing: ScreenScan = seen();

async function until(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 400 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(check(), `timed out waiting for: ${label}`);
}

describe("watching for mentions", () => {
  let workbench: Workbench;
  let screen: FakeScreen;
  let allowed: string[] = [];
  let mentions: WorkbenchMention[];
  let existing: number[];
  let statuses: WorkbenchStatus[];
  let reads: ChatReading[];
  let failures: string[];
  let dropped: string[];
  let onRead: (reading: ChatReading) => Promise<void>;
  let readAllowed = true;

  function start(...plan: FakeScreen["plan"]) {
    screen = new FakeScreen();
    screen.plan = plan;
    mentions = [];
    existing = [];
    statuses = [];
    reads = [];
    failures = [];
    dropped = [];
    onRead = async () => {};
    workbench = new Workbench({
      screen,
      intervalMs: 1,
      allowedGroups: () => allowed,
      onMention: (mention) => {
        mentions.push(mention);
        return mention.allowed && readAllowed;
      },
      onRead: async (reading) => {
        reads.push(reading);
        await onRead(reading);
      },
      onReadFailed: (group, reason) => failures.push(`${group}: ${reason}`),
      onDropped: (group) => dropped.push(group),
      onExisting: (count) => existing.push(count),
      onStatus: (status) => statuses.push(status),
      askedWaitMs,
    });
    workbench.start();
  }
  let askedWaitMs = 1;

  afterEach(async () => {
    await workbench.stop();
    allowed = [];
    readAllowed = true;
    askedWaitMs = 1;
  });

  it("reports a new mention once, however many scans still show it", async () => {
    start(nothing, seen(["项目周会群"]));
    await until(() => screen.scans > 10, "scans");
    assert.deepEqual(mentions, [{ group: "项目周会群", allowed: false }]);
  });

  it("doesn't treat what was already there at the start as new", async () => {
    start(seen(["项目周会群"], ["财务报销群"]));
    await until(() => screen.scans > 5, "scans");
    assert.deepEqual(mentions, []);
    assert.deepEqual(existing, [2]);
  });

  it("stays quiet about a start with nothing waiting", async () => {
    start(nothing);
    await until(() => screen.scans > 3, "scans");
    assert.deepEqual(existing, []);
  });

  it("does report a new mention in another group alongside one already there", async () => {
    start(seen(["项目周会群"]), seen(["项目周会群"], ["财务报销群"]));
    await until(() => mentions.length === 1, "mention");
    assert.equal(mentions[0]!.group, "财务报销群");
  });

  it("reports the same group again after its marker has really gone", async () => {
    start(nothing, seen(["项目周会群"]), nothing, nothing, nothing, seen(["项目周会群"]), seen(["项目周会群"]));
    await until(() => mentions.length === 2, "second mention");
  });

  it("doesn't count one or two missed reads as the marker going away, however often they happen", async () => {
    start(nothing, seen(["项目周会群"]), nothing, nothing, seen(["项目周会群"]), nothing, nothing, seen(["项目周会群"]));
    await until(() => screen.scans > 12, "scans");
    assert.equal(mentions.length, 1);
  });

  it("treats a name read one character differently as the same group", async () => {
    start(nothing, seen(["项目周会群"]), seen(["项目周今群"]), seen(["项目周会群"]));
    await until(() => screen.scans > 10, "scans");
    assert.equal(mentions.length, 1);
  });

  it("keeps two rows apart even when their names read alike", async () => {
    start(nothing, seen(["项目周会群"], ["项目周今群"]));
    await until(() => mentions.length === 2, "both rows");
  });

  it("reports a row whose name couldn't be read, once", async () => {
    start(nothing, seen([]));
    await until(() => screen.scans > 10, "scans");
    assert.deepEqual(mentions, [{ group: null, allowed: false }]);
  });

  it("gives a row a few scans to become readable before saying it couldn't be read", async () => {
    allowed = ["项目周会群"];
    start(nothing, seen([]), seen([]), seen(["项目周会群"]));
    await until(() => reads.length === 1, "a read once the name came through");
    assert.deepEqual(mentions, [{ group: "项目周会群", allowed: true }]);
  });

  it("says nothing about a row it could only not read twice", async () => {
    start(nothing, seen([]), seen([]), nothing);
    await until(() => screen.scans > 10, "scans");
    assert.deepEqual(mentions, []);
  });

  it("says so on the third scan it still can't read a row's name", async () => {
    start(nothing, seen([]), seen([]), seen([]), nothing);
    await until(() => screen.scans > 10, "scans");
    assert.deepEqual(mentions, [{ group: null, allowed: false }]);
  });

  it("still acts on a name that only comes through after that", async () => {
    allowed = ["项目周会群"];
    start(nothing, seen([]), seen([]), seen([]), seen([]), seen(["项目周会群"]));
    await until(() => reads.length === 1, "a read");
    assert.deepEqual(mentions, [
      { group: null, allowed: false },
      { group: "项目周会群", allowed: true },
    ]);
  });

  it("counts an unreadable row among what was already there at the start, straight away", async () => {
    start(seen([]));
    await until(() => existing.length === 1, "first scan");
    assert.deepEqual(existing, [1]);
    await until(() => screen.scans > 6, "scans");
    assert.deepEqual(mentions, []);
  });

  it("says which mentions are in an allowed group", async () => {
    allowed = ["项目周会群"];
    start(nothing, seen(["项目周会群"], ["财务报销群"]));
    await until(() => mentions.length === 2, "both");
    assert.deepEqual(mentions, [
      { group: "项目周会群", allowed: true },
      { group: "财务报销群", allowed: false },
    ]);
  });

  it("uses the allowed list as it is at the time", async () => {
    start(nothing, nothing);
    await until(() => screen.scans > 2, "scans");
    allowed = ["项目周会群"];
    screen.plan = [seen(["项目周会群"])];
    await until(() => mentions.length === 1, "mention");
    assert.equal(mentions[0]!.allowed, true);
  });

  it("carries on after the window was minimized, remembering what it had seen", async () => {
    start(seen(["项目周会群"]), { state: "minimized" }, seen(["项目周会群"]), seen(["项目周会群"], ["财务报销群"]));
    await until(() => mentions.length === 1, "mention");
    assert.equal(mentions[0]!.group, "财务报销群");
    assert.ok(statuses.some((status) => status.state === "paused" && status.detail?.includes("最小化")));
    assert.equal(statuses.at(-1)!.state, "scanning");
  });

  it("doesn't let a minimized window count towards a marker going away", async () => {
    start(nothing, seen(["项目周会群"]), { state: "minimized" }, { state: "minimized" }, { state: "minimized" }, { state: "minimized" }, seen(["项目周会群"]));
    await until(() => screen.scans > 10, "scans");
    assert.equal(mentions.length, 1);
  });

  it("says so when WeChat isn't open or its window comes out blank", async () => {
    start({ state: "missing" }, { state: "blank" }, nothing);
    await until(() => statuses.filter((status) => status.state === "paused").length === 2, "both");
    const details = statuses.filter((status) => status.state === "paused").map((status) => status.detail);
    assert.match(details[0]!, /没找到微信/);
    assert.match(details[1]!, /空白/);
  });

  it("reports a failure and keeps trying", async () => {
    start(new Error("读取程序退出了"), nothing, seen(["项目周会群"]));
    await until(() => mentions.length === 1, "mention after the failure");
    assert.ok(statuses.some((status) => status.state === "error" && status.detail === "读取程序退出了"));
    assert.equal(statuses.at(-1)!.state, "scanning");
  });

  it("stops scanning at once, and ends the helper", async () => {
    start(nothing);
    await until(() => screen.scans > 2, "scans");
    await workbench.stop();
    const after = screen.scans;
    assert.equal(screen.stops, 1);
    assert.equal(statuses.at(-1)!.state, "off");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(screen.scans, after);
  });

  it("ignores a scan that finishes after being stopped", async () => {
    let finish!: (scan: ScreenScan) => void;
    start(nothing);
    await until(() => screen.scans > 0, "first scan");
    const before = screen.scans;
    screen.plan = [new Promise<ScreenScan>((resolve) => (finish = resolve))];
    await until(() => screen.scans > before, "a scan under way");
    await workbench.stop();
    const statusesAtStop = statuses.length;
    finish(seen(["项目周会群"]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(mentions, []);
    assert.equal(statuses.length, statusesAtStop);
  });

  it("starts fresh when turned back on, so what's waiting doesn't count as new", async () => {
    start(nothing, seen(["项目周会群"]));
    await until(() => mentions.length === 1, "mention");
    await workbench.stop();
    screen.plan = [seen(["项目周会群"], ["财务报销群"])];
    workbench.start();
    await until(() => existing.length === 1, "first scan of the new run");
    assert.deepEqual(existing, [2]);
    assert.equal(mentions.length, 1);
  });

  it("carries on as it was when started again, instead of starting over", async () => {
    start(nothing, seen(["项目周会群"]));
    await until(() => mentions.length === 1, "mention");
    workbench.start();
    const before = screen.scans;
    await until(() => screen.scans > before + 3, "scans");
    assert.deepEqual(existing, []);
    assert.equal(mentions.length, 1);
  });

  describe("reading an allowed group", () => {
    const allowedGroup = ["项目周会群"];
    const away = (...rows: string[][]): ScreenScan => ({ ...(seen(...rows) as Extract<ScreenScan, { state: "ok" }>), foreground: false, idleMs: 0 });
    const inWeChat = (idleMs: number, ...rows: string[][]): ScreenScan => ({ ...(seen(...rows) as Extract<ScreenScan, { state: "ok" }>), foreground: true, idleMs });

    it("opens that row and hands over its pages", async () => {
      allowed = allowedGroup;
      start(nothing, seen(["财务报销群"], ["项目周会群"]));
      await until(() => reads.length === 1, "a read");
      assert.deepEqual(screen.opened, [180]);
      assert.equal(reads[0]!.group, "项目周会群");
      assert.equal(reads[0]!.images.length, 2);
    });

    it("reads each mention once", async () => {
      allowed = allowedGroup;
      start(nothing, seen(["项目周会群"]));
      await until(() => screen.scans > 10, "scans");
      assert.equal(screen.opened.length, 1);
      assert.equal(reads.length, 1);
    });

    it("never opens a group that isn't allowed, or a row it couldn't read", async () => {
      allowed = allowedGroup;
      start(nothing, seen(["财务报销群"], []));
      await until(() => screen.scans > 10, "scans");
      assert.equal(mentions.length, 2);
      assert.deepEqual(screen.opened, []);
    });

    it("never opens a near miss of an allowed name", async () => {
      allowed = allowedGroup;
      start(nothing, seen(["项目周今群"]));
      await until(() => screen.scans > 10, "scans");
      assert.deepEqual(screen.opened, []);
    });

    it("doesn't open what was already there when reading began", async () => {
      allowed = allowedGroup;
      start(seen(["项目周会群"]));
      await until(() => screen.scans > 10, "scans");
      assert.deepEqual(screen.opened, []);
    });

    it("doesn't open anything when told not to read it", async () => {
      allowed = allowedGroup;
      readAllowed = false;
      start(nothing, seen(["项目周会群"]));
      await until(() => screen.scans > 10, "scans");
      assert.equal(mentions.length, 1);
      assert.deepEqual(screen.opened, []);
    });

    it("sends nothing when the opened chat's title doesn't match", async () => {
      allowed = allowedGroup;
      start(nothing);
      screen.openAnswer = { state: "ok", titles: ["财务报销群(8)"] };
      screen.plan = [seen(["项目周会群"])];
      await until(() => failures.length === 1, "failure");
      assert.match(failures[0]!, /标题对不上/);
      assert.equal(screen.captures, 0);
      assert.deepEqual(reads, []);
    });

    it("doesn't try again after a failed read, since opening has already marked a chat as read", async () => {
      allowed = allowedGroup;
      start(nothing);
      screen.openAnswer = { state: "ok", titles: ["财务报销群"] };
      screen.plan = [seen(["项目周会群"])];
      await until(() => failures.length === 1, "failure");
      const before = screen.scans;
      await until(() => screen.scans > before + 5, "scans");
      assert.equal(screen.opened.length, 1);
    });

    it("sends nothing if any image's own title doesn't match", async () => {
      allowed = allowedGroup;
      start(nothing);
      screen.captureAnswer = { state: "ok", pages: [page("项目周会群"), page("财务报销群")], reachedTop: false, interrupted: false };
      screen.plan = [seen(["项目周会群"])];
      await until(() => failures.length === 1, "failure");
      assert.match(failures[0]!, /聊天变了/);
      assert.deepEqual(reads, []);
    });

    it("says so when the owner came back before anything was captured", async () => {
      allowed = allowedGroup;
      start(nothing);
      screen.captureAnswer = { state: "ok", pages: [], reachedTop: false, interrupted: true };
      screen.plan = [seen(["项目周会群"])];
      await until(() => failures.length === 1, "failure");
      assert.match(failures[0]!, /回到了微信/);
    });

    it("uses what it got when the owner came back part way", async () => {
      allowed = allowedGroup;
      start(nothing);
      screen.captureAnswer = { state: "ok", pages: [page("项目周会群")], reachedTop: false, interrupted: true };
      screen.plan = [seen(["项目周会群"])];
      await until(() => reads.length === 1, "a read");
      assert.equal(reads[0]!.images.length, 1);
    });

    it("says so when the window goes away", async () => {
      allowed = allowedGroup;
      start(nothing);
      screen.openAnswer = { state: "minimized" };
      screen.plan = [seen(["项目周会群"])];
      await until(() => failures.length === 1, "failure");
      assert.match(failures[0]!, /读不到/);
    });

    it("says so when the capture can't be taken", async () => {
      allowed = allowedGroup;
      start(nothing);
      screen.captureAnswer = { state: "blank" };
      screen.plan = [seen(["项目周会群"])];
      await until(() => failures.length === 1, "failure");
      assert.match(failures[0]!, /读不到/);
    });

    it("reports an error along the way and keeps scanning", async () => {
      allowed = allowedGroup;
      start(nothing);
      screen.captureAnswer = new Error("读取程序退出了");
      screen.plan = [seen(["项目周会群"])];
      await until(() => failures.length === 1, "failure");
      assert.match(failures[0]!, /读取程序退出了/);
      const before = screen.scans;
      await until(() => screen.scans > before, "another scan");
    });

    it("reads one at a time, each from a new scan", async () => {
      allowed = ["项目周会群", "财务报销群"];
      start(nothing, seen(["项目周会群"], ["财务报销群"]), seen(["财务报销群"]));
      screen.openAnswer = { state: "ok", titles: ["项目周会群", "财务报销群"] };
      screen.captureAnswer = { state: "ok", pages: [page("项目周会群", "财务报销群")], reachedTop: false, interrupted: false };
      await until(() => reads.length === 2, "both reads");
      assert.deepEqual(screen.opened, [100, 100]);
    });

    it("waits while the owner is using WeChat, says so once per wait, then reads", async () => {
      allowed = allowedGroup;
      start(nothing, inWeChat(100, ["项目周会群"]), inWeChat(100, ["项目周会群"]), inWeChat(100, ["项目周会群"]), away(["项目周会群"]));
      await until(() => reads.length === 1, "a read");
      assert.equal(statuses.filter((status) => status.detail?.includes("你正在用微信")).length, 3);
      const changes = statuses.map((status) => status.detail ?? "").filter((detail, index, all) => detail !== all[index - 1]);
      assert.equal(changes.filter((detail) => detail.includes("你正在用微信")).length, 1, "the status doesn't flip back and forth");
    });

    it("counts WeChat left in front with nobody there as not in use", async () => {
      allowed = allowedGroup;
      start(nothing, inWeChat(180_000, ["项目周会群"]));
      await until(() => reads.length === 1, "a read");
    });

    it("still counts as in use just under that, since reading a long message involves no input", async () => {
      allowed = allowedGroup;
      start(nothing, inWeChat(179_999, ["项目周会群"]));
      await until(() => screen.scans > 10, "scans");
      assert.deepEqual(screen.opened, []);
    });

    it("gives up when the owner opens the chat themselves", async () => {
      allowed = allowedGroup;
      start(nothing, inWeChat(100, ["项目周会群"]), inWeChat(100), inWeChat(100), inWeChat(100), inWeChat(100));
      await until(() => dropped.length === 1, "dropped");
      assert.deepEqual(dropped, ["项目周会群"]);
      assert.deepEqual(screen.opened, []);
    });

    it("forgets a dropped mention, so a later one that shouldn't be read isn't", async () => {
      allowed = allowedGroup;
      start(nothing, inWeChat(100, ["项目周会群"]), inWeChat(100), inWeChat(100), inWeChat(100));
      await until(() => dropped.length === 1, "dropped");
      readAllowed = false;
      screen.plan = [away(["项目周会群"])];
      await until(() => mentions.length === 2, "the later mention");
      const before = screen.scans;
      await until(() => screen.scans > before + 3, "scans");
      assert.deepEqual(screen.opened, []);
    });

    it("drops a mention in a group that's been taken off the list", async () => {
      allowed = allowedGroup;
      start(nothing, inWeChat(100, ["项目周会群"]), inWeChat(100, ["项目周会群"]));
      await until(() => mentions.length === 1, "mention");
      allowed = [];
      screen.plan = [away(["项目周会群"])];
      const before = screen.scans;
      await until(() => screen.scans > before + 5, "scans");
      assert.deepEqual(screen.opened, []);
    });

    it("keeps waiting while the marker has only slipped out of view", async () => {
      allowed = allowedGroup;
      start(nothing, inWeChat(100, ["项目周会群"]), inWeChat(100), away(["项目周会群"]));
      await until(() => reads.length === 1, "a read");
      assert.deepEqual(dropped, []);
    });

    it("aborts the read and ignores its outcome when stopped", async () => {
      allowed = allowedGroup;
      start(nothing, seen(["项目周会群"]));
      let signal: AbortSignal | undefined;
      let release!: () => void;
      onRead = async (reading) => {
        signal = reading.signal;
        await new Promise<void>((resolve) => (release = resolve));
      };
      await until(() => signal !== undefined, "a read under way");
      assert.equal(signal!.aborted, false);
      await workbench.stop();
      assert.equal(signal!.aborted, true);
      const scans = screen.scans;
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(screen.scans, scans);
    });

    it("sends nothing if stopped while opening the chat", async () => {
      allowed = allowedGroup;
      start(nothing);
      let finish!: (row: OpenedRow) => void;
      screen.openAnswer = new Promise<OpenedRow>((resolve) => (finish = resolve));
      screen.plan = [seen(["项目周会群"])];
      await until(() => screen.opened.length === 1, "opening");
      await workbench.stop();
      finish({ state: "ok", titles: ["项目周会群"] });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(screen.captures, 0);
      assert.deepEqual(failures, []);
    });

    it("sends nothing if stopped while capturing", async () => {
      allowed = allowedGroup;
      start(nothing);
      let finish!: (capture: ChatCapture) => void;
      screen.captureAnswer = new Promise<ChatCapture>((resolve) => (finish = resolve));
      screen.plan = [seen(["项目周会群"])];
      await until(() => screen.captures === 1, "capturing");
      await workbench.stop();
      finish({ state: "ok", pages: [page("项目周会群")], reachedTop: false, interrupted: false });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(reads, []);
    });

    describe("while sending", () => {
      it("passes the send on and gives back the answer", async () => {
        start(nothing);
        screen.sendAnswer = { state: "refused", reason: "wrong-chat" };
        assert.deepEqual(await workbench.sendDraft("项目周会群", "收到"), { state: "refused", reason: "wrong-chat" });
        assert.deepEqual(screen.sends, ["项目周会群: 收到"]);
      });

      it("passes on who to mention", async () => {
        start(nothing);
        await workbench.sendDraft("项目周会群", "收到", "小号");
        assert.deepEqual(screen.sends, ["项目周会群: @小号 收到"]);
      });

      it("opens nothing, since both would be working in the same window", async () => {
        allowed = allowedGroup;
        start(nothing);
        await until(() => screen.scans > 0, "first scan");
        let finish!: (outcome: SendOutcome) => void;
        screen.sendAnswer = new Promise<SendOutcome>((resolve) => (finish = resolve));
        const sending = workbench.sendDraft("财务报销群", "收到");
        await until(() => screen.sends.length === 1, "sending");

        screen.plan = [seen(["项目周会群"])];
        const before = screen.scans;
        await until(() => screen.scans > before + 5, "scans during the send");
        assert.deepEqual(screen.opened, []);

        finish({ state: "sent" });
        await sending;
        await until(() => screen.opened.length === 1, "the read it was holding back");
      });

      it("waits for a read that's under way, even one still with the model", async () => {
        allowed = allowedGroup;
        start(nothing, seen(["项目周会群"]));
        let release!: () => void;
        let reading = false;
        onRead = async () => {
          reading = true;
          await new Promise<void>((resolve) => (release = resolve));
        };
        await until(() => reading, "a read under way");
        const sending = workbench.sendDraft("财务报销群", "收到");
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual(screen.sends, [], "not until the read is done");
        release();
        await sending;
        assert.equal(screen.sends.length, 1);
      });

      it("goes back to reading after a send that failed", async () => {
        allowed = allowedGroup;
        start(nothing);
        await until(() => screen.scans > 0, "first scan");
        screen.sendAnswer = Promise.reject(new Error("中止")) as Promise<SendOutcome>;
        (screen.sendAnswer as Promise<SendOutcome>).catch(() => {});
        await assert.rejects(workbench.sendDraft("财务报销群", "收到"), /中止/);
        screen.plan = [seen(["项目周会群"])];
        await until(() => screen.opened.length === 1, "a read");
      });
    });

    it("forgets what was waiting when turned off", async () => {
      allowed = allowedGroup;
      start(nothing, inWeChat(100, ["项目周会群"]));
      await until(() => mentions.length === 1, "mention");
      await workbench.stop();
      screen.plan = [away(["项目周会群"])];
      workbench.start();
      const before = screen.scans;
      await until(() => screen.scans > before + 5, "scans");
      assert.deepEqual(screen.opened, []);
    });
  });

  describe("reading a chat record the owner forwarded", () => {
    it("only while reading is on", async () => {
      start(nothing);
      await workbench.stop();
      await assert.rejects(workbench.readRecord(), /没有打开/);
      assert.deepEqual(screen.located, []);
    });

    it("reads it where it is when File Transfer Assistant is already open, clicking nothing in the list", async () => {
      start(nothing);
      const record = await workbench.readRecord();
      assert.deepEqual(record, { title: "群聊的聊天记录", images: [Buffer.from("top"), Buffer.from("end")], pages: 5, complete: true, uncertain: false });
      assert.deepEqual(screen.located, [FILE_TRANSFER]);
      assert.deepEqual(screen.opened, []);
      assert.deepEqual(screen.recorded, [FILE_TRANSFER]);
    });

    it("opens File Transfer Assistant from the list first, and reads only once its title says so", async () => {
      start(nothing);
      screen.locatePlan = [located({ rows: [420, 300] })];
      screen.openAnswer = { state: "ok", titles: ["文件传输助于", FILE_TRANSFER] };
      await workbench.readRecord();
      assert.deepEqual(screen.opened, [420], "the closest read, which comes first");
      assert.deepEqual(screen.recorded, [FILE_TRANSFER]);
    });

    it("stops when what opened has another title", async () => {
      start(nothing);
      screen.locatePlan = [located()];
      screen.openAnswer = { state: "ok", titles: ["文件传输助手群"] };
      await assert.rejects(workbench.readRecord(), /标题不是“文件传输助手”/);
      assert.deepEqual(screen.recorded, []);
    });

    it("says so when the list doesn't show it", async () => {
      start(nothing);
      screen.locatePlan = [located({ rows: [] })];
      await assert.rejects(workbench.readRecord(), /左栏里没看到“文件传输助手”/);
      assert.deepEqual(screen.opened, []);
    });

    it("waits for the owner to stop using WeChat before opening it", async () => {
      start(nothing);
      screen.locatePlan = [located({ foreground: true, idleMs: 800 }), located({ foreground: true, idleMs: 900 }), located({ foreground: true, idleMs: 6_000 })];
      screen.openAnswer = { state: "ok", titles: [FILE_TRANSFER] };
      await workbench.readRecord();
      assert.equal(screen.located.length, 3);
      assert.deepEqual(screen.opened, [300]);
    });

    it("gives up, opening nothing, while the owner keeps using WeChat", { timeout: 5_000 }, async () => {
      start(nothing);
      screen.locatePlan = [located({ foreground: true, idleMs: 800 })];
      await assert.rejects(workbench.readRecord(), /一直在用微信/);
      assert.deepEqual(screen.opened, []);
      assert.deepEqual(screen.recorded, []);
    });

    it("isn't held up by the owner using WeChat when nothing needs opening", async () => {
      start(nothing);
      screen.locatePlan = [{ ...located({ open: true }), foreground: true, idleMs: 100 } as LocatedChat];
      await workbench.readRecord();
      assert.equal(screen.located.length, 1);
      assert.deepEqual(screen.recorded, [FILE_TRANSFER]);
    });

    for (const [state, message] of [
      ["no-record", /合并转发到文件传输助手/],
      ["not-opened", /已经开着一个聊天记录窗口/],
      ["not-record", /没有关掉它/],
      ["wrong-chat", /不是“文件传输助手”/],
      ["minimized", /最小化/],
    ] as const) {
      it(`explains a ${state} capture`, async () => {
        start(nothing);
        screen.recordAnswer = { state } as RecordCapture;
        await assert.rejects(workbench.readRecord(), message);
      });
    }

    it("doesn't scan while a record is being read, and scans again afterwards", async () => {
      start(nothing);
      await until(() => screen.scans > 0, "first scan");
      let finish!: (capture: RecordCapture) => void;
      screen.recordAnswer = new Promise<RecordCapture>((resolve) => (finish = resolve));
      const reading = workbench.readRecord();
      await until(() => screen.recording, "reading the record");
      await new Promise((resolve) => setTimeout(resolve, 20));
      finish({ state: "ok", title: "群聊的聊天记录", slices: [Buffer.from("x")], pages: 1, complete: true, uncertain: false });
      await reading;
      const after = screen.scans;
      await until(() => screen.scans > after + 3, "scans afterwards");
      assert.equal(screen.overlapped, 0);
    });

    it("holds back a send until the record has been read", async () => {
      start(nothing);
      let finish!: (capture: RecordCapture) => void;
      screen.recordAnswer = new Promise<RecordCapture>((resolve) => (finish = resolve));
      const reading = workbench.readRecord();
      await until(() => screen.recording, "reading the record");
      const sending = workbench.sendDraft("财务报销群", "收到");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(screen.sends, []);
      finish({ state: "ok", title: "群聊的聊天记录", slices: [Buffer.from("x")], pages: 1, complete: true, uncertain: false });
      await reading;
      await sending;
      assert.equal(screen.sends.length, 1);
    });

    it("won't start while a reply is being sent", async () => {
      start(nothing);
      let finish!: (outcome: SendOutcome) => void;
      screen.sendAnswer = new Promise<SendOutcome>((resolve) => (finish = resolve));
      const sending = workbench.sendDraft("财务报销群", "收到");
      await until(() => screen.sends.length === 1, "sending");
      await assert.rejects(workbench.readRecord(), /正在往群里发消息/);
      assert.deepEqual(screen.located, []);
      finish({ state: "sent" });
      await sending;
    });

    it("gives nothing back, and asks the helper nothing more, once stopped", async () => {
      start(nothing);
      let finish!: (capture: RecordCapture) => void;
      screen.recordAnswer = new Promise<RecordCapture>((resolve) => (finish = resolve));
      const reading = workbench.readRecord();
      await until(() => screen.recording, "reading the record");
      await workbench.stop();
      finish({ state: "ok", title: "群聊的聊天记录", slices: [Buffer.from("x")], pages: 1, complete: true, uncertain: false });
      await assert.rejects(reading, /已停止/);
      const scans = screen.scans;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(screen.scans, scans);
    });

    it("asks nothing of the helper after a stop that came while waiting for the owner", async () => {
      askedWaitMs = 100;
      start(nothing);
      screen.locatePlan = [located({ foreground: true, idleMs: 800 })];
      const reading = workbench.readRecord();
      await until(() => screen.located.length === 1, "first look");
      await workbench.stop();
      await assert.rejects(reading, /已停止/);
      assert.equal(screen.located.length, 1);
    });
  });
});

describe("telling groups apart", () => {
  it("matches an exact read", () => {
    assert.deepEqual(identifyGroup(["项目周会群"], ["项目周会群"]), { group: "项目周会群", allowed: true });
  });

  it("needs only one of the reads to match", () => {
    assert.equal(identifyGroup(["项目周今群", "项目周会群"], ["项目周会群"]).allowed, true);
  });

  it("doesn't match on a near miss", () => {
    assert.deepEqual(identifyGroup(["项目周今群"], ["项目周会群"]), { group: "项目周今群", allowed: false });
  });

  it("doesn't match a name that only contains an allowed one, or the start of one", () => {
    assert.equal(identifyGroup(["项目周会群二期"], ["项目周会群"]).allowed, false);
    assert.equal(identifyGroup(["周会"], ["项目周会群"]).allowed, false);
    assert.equal(identifyGroup(["项目周会"], ["项目周会群"]).allowed, false);
  });

  it("matches a name the list has cut short", () => {
    assert.deepEqual(identifyGroup(["华东区项目周会..."], ["华东区项目周会讨论组"]), { group: "华东区项目周会讨论组", allowed: true });
  });

  it("doesn't trust a cut-short name with too little left to go on", () => {
    assert.equal(identifyGroup(["华东区..."], ["华东区项目周会讨论组"]).allowed, false);
  });

  it("refuses to guess when a cut-short name fits two allowed groups", () => {
    const allowed = ["华东区项目周会一组", "华东区项目周会二组"];
    assert.deepEqual(identifyGroup(["华东区项目周会..."], allowed), { group: "华东区项目周会...", allowed: false });
  });

  it("compares names in the form OCR gives them", () => {
    assert.equal(normalizeGroupName("项目 周会（二期）"), "项目周会(二期)");
    assert.equal(identifyGroup(["项目周会(二期)"], ["项目 周会（二期）"]).allowed, true);
  });

  it("goes with the most common read when it isn't an allowed group, then the longest", () => {
    assert.equal(identifyGroup(["甲乙丙", "甲乙丁", "甲乙丙"], []).group, "甲乙丙");
    assert.equal(identifyGroup(["甲乙", "甲乙丙"], []).group, "甲乙丙");
  });

  it("has no name when nothing could be read", () => {
    assert.deepEqual(identifyGroup([], ["项目周会群"]), { group: null, allowed: false });
    assert.deepEqual(identifyGroup([" "], []), { group: null, allowed: false });
  });

  it("finds an allowed name one character away, but not the name itself", () => {
    assert.equal(confusableGroup("项目周会群", ["财务报销群", "项目周今群"]), "项目周今群");
    assert.equal(confusableGroup("项目周会", ["项目周会群"]), "项目周会群");
    assert.equal(confusableGroup("项目周会群", ["项目周会群"]), undefined);
    assert.equal(confusableGroup("项目周会群", ["财务报销群"]), undefined);
  });

  it("measures edit distance", () => {
    assert.equal(editDistance("abc", "abc"), 0);
    assert.equal(editDistance("abc", "abd"), 1);
    assert.equal(editDistance("abc", "ab"), 1);
    assert.equal(editDistance("", "ab"), 2);
    assert.equal(editDistance("kitten", "sitting"), 3);
  });
});

describe("checking an opened chat's title", () => {
  it("accepts the exact name, with or without a member count", () => {
    assert.equal(titleMatches(["项目周会群"], "项目周会群"), true);
    assert.equal(titleMatches(["项目周会群(12)"], "项目周会群"), true);
    assert.equal(titleMatches(["项目周会群（12）"], "项目周会群"), true);
  });

  it("needs only one read to be exact", () => {
    assert.equal(titleMatches(["项目周今群", "项目周会群(3)"], "项目周会群"), true);
  });

  it("rejects anything else, since this decides what leaves the computer", () => {
    assert.equal(titleMatches(["项目周今群"], "项目周会群"), false);
    assert.equal(titleMatches(["项目周会群二期"], "项目周会群"), false);
    assert.equal(titleMatches(["项目周会"], "项目周会群"), false);
    assert.equal(titleMatches(["项目周会群(3)x"], "项目周会群"), false);
    assert.equal(titleMatches(["项目周会群(abc)"], "项目周会群"), false);
    assert.equal(titleMatches([], "项目周会群"), false);
  });

  it("copes with a group whose real name ends in brackets", () => {
    assert.equal(titleMatches(["周会(2)"], "周会(2)"), true);
    assert.equal(titleMatches(["周会(2)(8)"], "周会(2)"), true);
    assert.equal(titleMatches(["周会(3)"], "周会(2)"), false);
  });
});
