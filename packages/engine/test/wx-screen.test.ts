import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { titleMatches } from "../src/workbench.ts";
import { WxHelperScreen } from "../src/wx-screen.ts";

const windowsOnly = { skip: process.platform === "win32" ? false : "needs Windows PowerShell" };

const script = (name: string) => readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), "utf8");
const readingCode = () => script("wx-helper.ps1") + script("wx-common.ps1");

describe("the real helper", windowsOnly, () => {
  const screen = new WxHelperScreen();
  after(() => screen.stop());

  for (const name of ["wx-common.ps1", "wx-helper.ps1", "wx-send.ps1"]) {
    it(`keeps ${name} ASCII, because Windows PowerShell 5.1 misreads UTF-8 without a BOM`, () => {
      assert.doesNotMatch(script(name), /[^\x00-\x7F]/);
    });
  }

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

  it("can't type or take focus: the Windows calls for that aren't in what stays running", () => {
    assert.doesNotMatch(readingCode(), /SendInput|keybd_event|SendMessage|mouse_event|SetForegroundWindow|SetCursorPos|ShowWindow|WM_KEY|WM_CHAR|WM_PASTE|Clipboard/);
  });

  it("only posts the messages for moving the mouse over a row, clicking it and scrolling", () => {
    const posted = [...readingCode().matchAll(/\[Win\]::PostMessage\(\$window\.Handle, (\$WM_[A-Z]+),/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(posted)].sort(), ["$WM_LBUTTONDOWN", "$WM_LBUTTONUP", "$WM_MOUSEMOVE", "$WM_MOUSEWHEEL"]);
  });
});

describe("the real sender", windowsOnly, () => {
  const screen = new WxHelperScreen();
  after(() => screen.stop());

  it("checks what Enter would open, what's in the input box and which chat is open, on generated images", async () => {
    const results = await screen.selfTestSend();
    assert.deepEqual(results, {
      state: "ok",
      // The member Enter would pick.
      memberBandTop: 38,
      memberBandBottom: 72,
      memberSelected: true,
      otherMemberSelected: false,
      memberBelowSelection: false,
      // The search result Enter would open.
      nameInBand: true,
      otherNameInBand: false,
      nameBelowBand: false,
      bandTop: 50,
      bandBottom: 130,
      // The input card is found exactly, above the window's shadow.
      boxTop: 0,
      boxBottom: 0,
      // The input box, which its icons or a blinking caret mustn't count as filling.
      emptyIsEmpty: true,
      caretIsEmpty: true,
      textIsEmpty: false,
      readsTyped: true,
      readsOther: false,
      latinAlwaysPasses: true,
      // Roughly the right text, from reads as poor as the real ones.
      misreadPasses: true,
      wrongTextFails: false,
      halfIsEnough: true,
      lessThanHalfIsNot: false,
      onlyTheEndCounts: false,
      // The sent message showing up.
      shownBeforeSending: false,
      shownAfterSending: true,
      otherNotShown: false,
      latinNotHeldAgainst: true,
      // The chat's title.
      titleExact: true,
      titleWithCount: true,
      titleOneRead: true,
      titleOther: false,
      titleLonger: false,
      titleCountThenMore: false,
    });
  });

  it("only presses Enter on the member list with that exact name selected", () => {
    const source = script("wx-send.ps1");
    const select = source.slice(source.indexOf("function Select-Member"), source.indexOf("# Where typed text shows"));
    const enter = select.indexOf("Combo($VK_RETURN)");
    assert.ok(enter > 0);
    const before = (code: string, reason: string) => {
      const at = select.indexOf(code);
      assert.ok(at >= 0 && at < enter, reason);
    };
    before("if (-not $list) {", "the list has to be open");
    before("Stop-Send 'mention-no-list'", "or it stops");
    before("Test-MemberSelected $image $name", "with this name selected");
    before("if (-not $selected) {", "checked, not just looked at");
    before("Stop-Send 'mention-not-found'", "or it stops");
  });

  it("says an emptied box after picking someone may mean it went out, rather than carrying on", () => {
    const source = script("wx-send.ps1");
    assert.match(source, /if \(Test-InputEmpty \$image\) \{ throw 'uncertain:mention-sent-early' \}/);
  });

  it("presses Enter in only three places: the checked search result, the checked member, and after every last check", () => {
    const source = script("wx-send.ps1");
    assert.equal([...source.matchAll(/Combo\(\$VK_RETURN\)/g)].length, 3);
    const send = source.indexOf("function Invoke-Send");
    const finalEnter = source.indexOf("Combo($VK_RETURN)", send);
    for (const check of ["Test-InputEmpty $image", "Test-Title (Get-Titles $image) $group", "Test-TypedText $image $text", "Assert-Foreground $window"]) {
      const at = source.lastIndexOf(check, finalEnter);
      assert.ok(at > source.indexOf("Send-Text $window $text", send), `${check} comes after typing and before Enter`);
    }
  });

  it("stops a rehearsal after every check, before Enter, and clears what it typed", () => {
    const source = script("wx-send.ps1");
    const send = source.indexOf("function Invoke-Send");
    const rehearsal = source.indexOf("if ($rehearse) { Clear-Typed $window; return @{ state = 'refused'; reason = 'rehearsal' } }", send);
    assert.ok(rehearsal > source.indexOf("Test-TypedText $image $text", send));
    assert.ok(rehearsal < source.indexOf("Combo($VK_RETURN)", send));
  });

  it("doesn't try again, or clear the box, once Enter has been pressed", () => {
    const source = script("wx-send.ps1");
    const afterEnter = source.slice(source.indexOf("Combo($VK_RETURN)", source.indexOf("function Invoke-Send")), source.indexOf("function Invoke-SelfTest"));
    assert.doesNotMatch(afterEnter, /Clear-Typed|Send-Text|VK_RETURN\)\s*\n\s*\[Keys\]::Combo/);
  });

  it("uses no clipboard", () => {
    assert.doesNotMatch(script("wx-send.ps1"), /Clipboard|WM_PASTE/);
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

  describe("sending", () => {
    function sender(body: string, sendTimeoutMs?: number) {
      const senderScript = join(directory, `sender-${count++}.ps1`);
      writeFileSync(senderScript, body);
      screen = new WxHelperScreen({ senderScript, ...(sendTimeoutMs ? { sendTimeoutMs } : {}) });
      return screen;
    }
    const reply = (json: string) => `$request = ConvertFrom-Json ([Console]::In.ReadLine())\n[Console]::Out.WriteLine('${json}')`;

    it("passes on the answer", async () => {
      assert.deepEqual(await sender(reply('{"state":"sent"}')).sendText("甲", "乙"), { state: "sent" });
      assert.deepEqual(await sender(reply('{"state":"refused","reason":"wrong-chat"}')).sendText("甲", "乙"), { state: "refused", reason: "wrong-chat" });
    });

    it("gets Chinese across, whatever the console's code page", async () => {
      const echo = `$r = ConvertFrom-Json ([Console]::In.ReadLine())
$codes = (($r.group + '|' + $r.text).ToCharArray() | ForEach-Object { [int]$_ }) -join ','
[Console]::Out.WriteLine('{"state":"refused","reason":"' + $codes + '"}')`;
      const outcome = (await sender(echo).sendText("项目周会群", "好的，收到😀")) as { reason: string };
      const received = String.fromCharCode(...outcome.reason.split(",").map(Number));
      assert.equal(received, "项目周会群|好的，收到😀");
    });

    it("doesn't hand the sender the engine's secrets", async () => {
      process.env.SHU_ANTHROPIC_API_KEY = "secret-for-test";
      try {
        const body = `$null = [Console]::In.ReadLine(); $has = if ($env:SHU_ANTHROPIC_API_KEY) { 'yes' } else { 'no' }; [Console]::Out.WriteLine('{"state":"refused","reason":"' + $has + '"}')`;
        assert.deepEqual(await sender(body).sendText("甲", "乙"), { state: "refused", reason: "no" });
      } finally {
        delete process.env.SHU_ANTHROPIC_API_KEY;
      }
    });

    it("passes on who to mention, and leaves it out when there's nobody", async () => {
      const echo = `$r = ConvertFrom-Json ([Console]::In.ReadLine())
$codes = ("$($r.mention)".ToCharArray() | ForEach-Object { [int]$_ }) -join ','
[Console]::Out.WriteLine('{"state":"refused","reason":"' + $codes + '|' + ($null -eq $r.mention) + '"}')`;
      const named = (await sender(echo).sendText("甲", "乙", "小号")) as { reason: string };
      const [codes, missing] = named.reason.split("|") as [string, string];
      assert.equal(String.fromCharCode(...codes.split(",").map(Number)), "小号");
      assert.equal(missing, "False");
      const nobody = (await sender(echo).sendText("甲", "乙")) as { reason: string };
      assert.equal(nobody.reason, "|True");
    });

    it("starts a new sender for each send", async () => {
      const body = `$null = [Console]::In.ReadLine(); [Console]::Out.WriteLine('{"state":"refused","reason":"' + $PID + '"}')`;
      sender(body);
      const first = (await screen.sendText("甲", "乙")) as { reason: string };
      const second = (await screen.sendText("甲", "乙")) as { reason: string };
      assert.notEqual(first.reason, second.reason);
    });

    it("ends the sender at once when stopped, and says the box may hold unsent text", async () => {
      const sending = sender(`Start-Sleep -Seconds 60`).sendText("甲", "乙");
      await new Promise((resolve) => setTimeout(resolve, 200));
      await screen.stop();
      await assert.rejects(sending, /中止.*输入框/);
    });

    it("ends a sender that takes too long, rather than waiting for it", async () => {
      const started = Date.now();
      await assert.rejects(sender(`Start-Sleep -Seconds 60`, 1500).sendText("甲", "乙"), /超时.*输入框/);
      assert.ok(Date.now() - started < 20_000, "it didn't wait for the sender to finish by itself");
    });

    it("asks for a rehearsal only when told to, so an ordinary send can't be one by accident", async () => {
      const body = `$r = ConvertFrom-Json ([Console]::In.ReadLine()); [Console]::Out.WriteLine('{"state":"refused","reason":"' + $r.rehearse + '"}')`;
      assert.deepEqual(await sender(body).rehearseSend("甲", "乙"), { state: "refused", reason: "True" });
      assert.deepEqual(await sender(body).sendText("甲", "乙"), { state: "refused", reason: "" });
    });

    it("reports the sender's own errors", async () => {
      await assert.rejects(sender(reply('{"error":"boom"}')).sendText("甲", "乙"), /发送出错：boom/);
    });

    it("treats output it can't read as a failure, never as sent", async () => {
      await assert.rejects(sender(`[Console]::Out.WriteLine('sent')`).sendText("甲", "乙"), /发送程序退出了/);
      await assert.rejects(sender(`exit 3`).sendText("甲", "乙"), /发送程序退出了（3）/);
    });
  });
});
