import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { titleMatches } from "../src/workbench.ts";
import { WxHelperScreen } from "../src/wx-screen.ts";

const windowsOnly = { skip: process.platform === "win32" ? false : "needs Windows PowerShell" };

const realHelper = fileURLToPath(new URL("../src/wx-helper.ps1", import.meta.url));

describe("the real helper", windowsOnly, () => {
  const screen = new WxHelperScreen();
  after(() => screen.stop());

  it("stays ASCII, because Windows PowerShell 5.1 misreads UTF-8 without a BOM", () => {
    assert.doesNotMatch(readFileSync(realHelper, "utf8"), /[^\x00-\x7F]/);
  });

  it("finds rows with the marker in a generated list, with their names, and no others", async () => {
    const result = await screen.selfTest();
    assert.equal(result.state, "ok");
    assert.ok(result.state === "ok");
    assert.equal(result.mentions.length, 2);
    assert.ok(result.mentions[0]!.names.includes("项目周会群"), JSON.stringify(result.mentions));
    assert.ok(result.mentions[1]!.names.includes("市场推广群"), JSON.stringify(result.mentions));
    assert.ok(result.mentions[0]!.y < result.mentions[1]!.y);
  });

  it("finds a row's name even when one read of the marker lost its start", async () => {
    const result = await screen.selfTestRows();
    assert.ok(result.state === "ok");
    assert.equal(result.mentions.length, 1, JSON.stringify(result.mentions));
    assert.deepEqual(result.mentions[0]!.names, ["测试"], "only the name, not the time or the row above");
  });

  it("crops to the open chat, leaving out the session list and the input box, and reads the title", async () => {
    const result = await screen.selfTestChat();
    assert.equal(result.width, result.expectedWidth);
    assert.equal(result.height, result.expectedHeight);
    assert.equal(result.listVisible, false);
    assert.ok(titleMatches(result.titles, "项目周会群"), JSON.stringify(result.titles));
  });

  it("can't type or take focus: the Windows calls for that aren't there", () => {
    const source = readFileSync(realHelper, "utf8");
    assert.doesNotMatch(source, /SendInput|keybd_event|SendMessage|mouse_event|SetForegroundWindow|SetCursorPos|WM_KEY|WM_CHAR|WM_PASTE|Clipboard/);
  });

  it("only posts the messages for moving the mouse over a row, clicking it and scrolling", () => {
    const source = readFileSync(realHelper, "utf8");
    const posted = [...source.matchAll(/\[Win\]::PostMessage\(\$window\.Handle, (\$WM_[A-Z]+),/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(posted)].sort(), ["$WM_LBUTTONDOWN", "$WM_LBUTTONUP", "$WM_MOUSEMOVE", "$WM_MOUSEWHEEL"]);
  });
});

// Stand-in helpers, so these tests can make one misbehave.
describe("running the helper", windowsOnly, () => {
  const directory = mkdtempSync(join(tmpdir(), "shu-wx-helper-"));
  let screen: WxHelperScreen;
  let count = 0;

  function helper(body: string, timeoutMs?: number) {
    const script = join(directory, `helper-${count++}.ps1`);
    writeFileSync(script, body);
    screen = new WxHelperScreen({ script, ...(timeoutMs ? { timeoutMs } : {}) });
    return screen;
  }

  const answering = (reply: string) => `
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $id = (ConvertFrom-Json $line).id
  ${reply}
}`;

  afterEach(() => screen.stop());
  after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

  it("passes on the helper's answer", async () => {
    assert.deepEqual(await helper(answering(`[Console]::Out.WriteLine('{"id":' + $id + ',"state":"minimized"}'); [Console]::Out.Flush()`)).scan(), { id: 1, state: "minimized" });
  });

  it("passes on the row to open", async () => {
    const opened = await helper(answering(`$y = (ConvertFrom-Json $line).y; [Console]::Out.WriteLine('{"id":' + $id + ',"state":"ok","titles":["row ' + $y + '"]}'); [Console]::Out.Flush()`)).openRow(345);
    assert.deepEqual(opened, { id: 1, state: "ok", titles: ["row 345"] });
  });

  it("turns captured pages into images, oldest first, and passes on how to capture them", async () => {
    const newest = Buffer.from("newest").toString("base64");
    const oldest = Buffer.from("oldest").toString("base64");
    const capture = await helper(
      answering(`$r = ConvertFrom-Json $line; [Console]::Out.WriteLine('{"id":' + $id + ',"state":"ok","reachedTop":true,"interrupted":false,"pages":[{"image":"${newest}","titles":["' + $r.pages + '"]},{"image":"${oldest}","titles":["' + $r.postsPerPage + '"]}]}'); [Console]::Out.Flush()`),
    ).captureChat({ pages: 3, postsPerPage: 4 });
    assert.ok(capture.state === "ok");
    assert.deepEqual(capture.pages.map((page) => page.image.toString()), ["oldest", "newest"]);
    assert.deepEqual(capture.pages.map((page) => page.titles), [["4"], ["3"]]);
    assert.equal(capture.reachedTop, true);
    assert.equal(capture.interrupted, false);
  });

  it("passes on a capture that couldn't be taken", async () => {
    const capture = await helper(answering(`[Console]::Out.WriteLine('{"id":' + $id + ',"state":"minimized"}'); [Console]::Out.Flush()`)).captureChat({ pages: 1, postsPerPage: 1 });
    assert.equal(capture.state, "minimized");
  });

  it("keeps the same helper between scans, however long the gap", async () => {
    const counting = `$answers = 0
${answering(`$answers++; [Console]::Out.WriteLine('{"id":' + $id + ',"state":"answer-' + $answers + '"}'); [Console]::Out.Flush()`)}`;
    const timeoutMs = 4000;
    const first = await helper(counting, timeoutMs).scan();
    assert.equal(first.state, "answer-1");
    await new Promise((resolve) => setTimeout(resolve, timeoutMs + 200));
    assert.equal((await screen.scan()).state, "answer-2");
  });

  it("reports the helper's error, in words the owner can use if it knows them", async () => {
    await assert.rejects(helper(answering(`[Console]::Out.WriteLine('{"id":' + $id + ',"error":"no-chinese-ocr"}'); [Console]::Out.Flush()`)).scan(), /中文 OCR/);
    await screen.stop();
    await assert.rejects(helper(answering(`[Console]::Out.WriteLine('{"id":' + $id + ',"error":"boom"}'); [Console]::Out.Flush()`)).scan(), /读取微信窗口出错：boom/);
  });

  it("doesn't hand the helper the engine's secrets", async () => {
    process.env.SHU_ANTHROPIC_API_KEY = "secret-for-test";
    try {
      const result = (await helper(
        answering(`$has = if ($env:SHU_ANTHROPIC_API_KEY) { 'yes' } else { 'no' }; [Console]::Out.WriteLine('{"id":' + $id + ',"state":"' + $has + '"}'); [Console]::Out.Flush()`),
      ).scan()) as unknown as { state: string };
      assert.equal(result.state, "no");
    } finally {
      delete process.env.SHU_ANTHROPIC_API_KEY;
    }
  });

  it("reports a helper that dies, then starts a new one for the next scan", async () => {
    const marker = join(directory, `died-once-${count}`);
    helper(`
if (-not (Test-Path '${marker}')) { New-Item -ItemType File '${marker}' | Out-Null; [Console]::Error.WriteLine('gave up'); exit 7 }
${answering(`[Console]::Out.WriteLine('{"id":' + $id + ',"state":"missing"}'); [Console]::Out.Flush()`)}`);
    await assert.rejects(screen.scan(), /读取程序退出了（7）：gave up/);
    assert.equal((await screen.scan()).state, "missing");
  });

  it("gives up on a helper that stops answering, and starts over", async () => {
    const marker = join(directory, `hung-once-${count}`);
    helper(
      `
if (-not (Test-Path '${marker}')) { New-Item -ItemType File '${marker}' | Out-Null; Start-Sleep -Seconds 60 }
${answering(`[Console]::Out.WriteLine('{"id":' + $id + ',"state":"blank"}'); [Console]::Out.Flush()`)}`,
      3000,
    );
    await assert.rejects(screen.scan(), /超时/);
    assert.equal((await screen.scan()).state, "blank");
  });

  it("treats output it can't read as a failure, not a crash", async () => {
    await assert.rejects(helper(answering(`[Console]::Out.WriteLine('not json'); [Console]::Out.Flush()`)).scan(), /看不懂/);
  });

  it("fails what's waiting when stopped", async () => {
    const scanning = helper(`Start-Sleep -Seconds 60`).scan();
    await screen.stop();
    await assert.rejects(scanning, /已停止/);
  });

  it("says when the helper's script is missing", async () => {
    screen = new WxHelperScreen({ script: join(directory, "missing.ps1") });
    await assert.rejects(screen.scan(), /读取程序/);
  });
});
