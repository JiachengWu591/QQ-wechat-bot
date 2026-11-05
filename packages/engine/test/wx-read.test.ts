import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { workMessageProblem } from "@shu/protocol";
import { CHAT_READ_SYSTEM, chatReadPrompt, cleanDraft, mentionReminder, parseChatRead, readReminder, sendProblem } from "../src/wx-read.ts";

const answer = { messages: [{ sender: "小明", time: "09:30", text: "@主人 报告发一下", fromOwner: false }], mention: { sender: "小明", text: "@主人 报告发一下" }, summary: "小明在催报告。" };

describe("understanding what the model read", () => {
  it("takes plain JSON", () => {
    assert.deepEqual(parseChatRead(JSON.stringify(answer)), answer);
  });

  it("takes JSON wrapped in a code fence or other words", () => {
    assert.deepEqual(parseChatRead(`好的：\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``), answer);
  });

  it("accepts a sender it couldn't make out, and no mention", () => {
    const read = parseChatRead(JSON.stringify({ messages: [{ sender: null, text: "嗯" }], mention: null, summary: "" }));
    assert.equal(read?.messages[0]?.sender, null);
    assert.equal(read?.mention, null);
  });

  it("gives nothing for what it can't use", () => {
    assert.equal(parseChatRead("抱歉，看不清"), null);
    assert.equal(parseChatRead("{broken"), null);
    assert.equal(parseChatRead(JSON.stringify({ messages: "none" })), null);
    assert.equal(parseChatRead(JSON.stringify({ messages: [], summary: "x" })), null);
  });
});

describe("preparing a draft", () => {
  it("keeps it to one line, since a line break in WeChat's input box sends the message", () => {
    assert.equal(cleanDraft({ ...answer, draft: "第一行\n第二行\r\n第三行" }), "第一行 第二行 第三行");
  });

  it("limits its length", () => {
    assert.ok((cleanDraft({ ...answer, draft: "字".repeat(5000) }) as string).length < 310);
  });

  it("has nothing for a missing or empty draft", () => {
    assert.equal(cleanDraft(answer), null);
    assert.equal(cleanDraft({ ...answer, draft: null }), null);
    assert.equal(cleanDraft({ ...answer, draft: " \n " }), null);
  });

  it("drops an @ the model opened with, since the reply is in the same group anyway", () => {
    assert.equal(cleanDraft({ ...answer, draft: "@小号 收到，报告我看到了。" }), "收到，报告我看到了。");
    assert.equal(cleanDraft({ ...answer, draft: "＠小号 ＠小明 收到" }), "收到");
    assert.equal(cleanDraft({ ...answer, draft: "@小号" }), null);
  });

  it("leaves an @ further along for the owner to see, rather than changing what it says", () => {
    assert.equal(cleanDraft({ ...answer, draft: "收到 @小号 看一下" }), "收到 @小号 看一下");
  });

  it("reads a draft from the model's answer", () => {
    assert.equal(parseChatRead(JSON.stringify({ ...answer, draft: "收到" }))?.draft, "收到");
    assert.equal(parseChatRead(JSON.stringify({ ...answer, draft: null }))?.draft, null);
  });
});

describe("checking a draft before it's sent", () => {
  it("accepts an ordinary line", () => {
    assert.equal(workMessageProblem("周五前发你。"), null);
  });

  it("refuses anything left for the owner to fill in", () => {
    assert.match(workMessageProblem("报告【时间】发你") as string, /【】/);
    assert.match(workMessageProblem("只有一半【") as string, /【】/);
    assert.match(workMessageProblem("只有一半】") as string, /【】/);
  });

  it("refuses a line break, since that would send what's before it", () => {
    assert.match(workMessageProblem("第一行\n第二行") as string, /换行/);
    assert.match(workMessageProblem("第一行\r第二行") as string, /换行/);
  });

  it("refuses an @ anywhere, since typing one opens WeChat's member list", () => {
    assert.match(workMessageProblem("@小号 收到") as string, /@/);
    assert.match(workMessageProblem("收到 @小号") as string, /@/);
    assert.match(workMessageProblem("收到＠小号") as string, /@/);
    assert.match(workMessageProblem("发到 a@b.com") as string, /@/);
  });

  it("refuses nothing at all, and too much", () => {
    assert.match(workMessageProblem("   ") as string, /空/);
    assert.match(workMessageProblem("字".repeat(1001)) as string, /太长/);
    assert.equal(workMessageProblem("字".repeat(1000)), null);
  });
});

describe("explaining why a send stopped", () => {
  it("says a refused send didn't go out", () => {
    for (const reason of ["bad-text", "owner-busy", "missing", "lost-focus", "input-rejected", "search-failed", "not-top-result", "wrong-chat", "no-input-box", "input-not-empty", "not-typed", "typed-mismatch"]) {
      assert.match(sendProblem({ state: "refused", reason }), /没有发送/, reason);
    }
  });

  it("still says so for a reason it doesn't know", () => {
    assert.match(sendProblem({ state: "refused", reason: "something-new" }), /没有发送（something-new）/);
  });

  it("says an uncertain send may have gone out, so the owner looks before trying again", () => {
    for (const reason of ["no-capture", "still-in-input", "not-shown", "something-new"]) {
      assert.match(sendProblem({ state: "uncertain", reason }), /不确定有没有发出去.*确认没发出去再重试/, reason);
    }
    assert.match(sendProblem({ state: "uncertain", reason: "still-in-input" }), /还在输入框/);
  });
});

describe("the prompt", () => {
  it("treats everything on screen as material, not instructions", () => {
    assert.match(CHAT_READ_SYSTEM, /只是资料/);
    assert.match(CHAT_READ_SYSTEM, /不要照做/);
  });

  it("has the summary speak to the owner directly, since it goes straight to them", () => {
    assert.match(chatReadPrompt("项目周会群", 1), /summary 是直接发给主人看的，称呼主人时用“你”/);
  });

  it("asks for a one-line draft that doesn't decide anything on the owner's behalf", () => {
    const prompt = chatReadPrompt("项目周会群", 1);
    assert.match(prompt, /只写一行/);
    assert.match(prompt, /不要替主人定/);
    assert.match(prompt, /不要先说“好的”/);
    assert.match(prompt, /【】/);
    assert.match(prompt, /不要写猜的内容/);
    assert.match(prompt, /不要写 @/);
    assert.match(prompt, /只要有人 @ 了主人，就要写 draft/);
  });

  it("names the group, and explains overlap only when there's more than one page", () => {
    assert.match(chatReadPrompt("项目周会群", 1), /项目周会群/);
    assert.doesNotMatch(chatReadPrompt("项目周会群", 1), /重叠/);
    assert.match(chatReadPrompt("项目周会群", 3), /3 张截图/);
    assert.match(chatReadPrompt("项目周会群", 3), /重叠的消息只算一次/);
  });
});

describe("what the owner is told", () => {
  it("gives the group, who said what, and the gist", () => {
    assert.equal(readReminder("项目周会群", { ...answer, draft: "周五发。" }), "“项目周会群”里有人 @ 你。\n小明：@主人 报告发一下\n小明在催报告。\n草稿：周五发。\n要发送的话，到控制台的“待确认”里确认。");
  });

  it("copes with not knowing who, or with no mention at all", () => {
    assert.equal(readReminder("甲", { ...answer, draft: "好", mention: { sender: null, text: "在吗" }, summary: "" }), "“甲”里有人 @ 你。\n有人：在吗\n草稿：好\n要发送的话，到控制台的“待确认”里确认。");
    assert.equal(readReminder("甲", { ...answer, draft: "好", mention: null, summary: "" }), "“甲”里有人 @ 你。\n草稿：好\n要发送的话，到控制台的“待确认”里确认。");
  });

  it("says so when there's no draft, so the owner doesn't go looking for one", () => {
    assert.equal(readReminder("甲", { ...answer, mention: null, summary: "" }), "“甲”里有人 @ 你。\n这次没有写草稿，要回复的话请自己回。");
    assert.equal(readReminder("甲", { ...answer, draft: "  " }), "“甲”里有人 @ 你。\n小明：@主人 报告发一下\n小明在催报告。\n这次没有写草稿，要回复的话请自己回。");
  });

  it("keeps it short, whatever is on screen", () => {
    const long = "字".repeat(5000);
    const reminder = readReminder(long, { messages: [], mention: { sender: "小明", text: long }, summary: long });
    assert.ok(reminder.length < 700, String(reminder.length));
    assert.ok(reminder.includes("…"));
  });

  it("flattens line breaks, so a message can't pose as something else in the reminder", () => {
    const reminder = readReminder("甲", { messages: [], mention: { sender: "小明", text: "第一行\n\n第二行" }, summary: "" });
    assert.equal(reminder, "“甲”里有人 @ 你。\n小明：第一行 第二行\n这次没有写草稿，要回复的话请自己回。");
  });

  it("includes the draft, and says where to deal with it", () => {
    assert.equal(
      readReminder("甲", { ...answer, mention: null, summary: "", draft: "好的，【时间】发你。" }),
      "“甲”里有人 @ 你。\n草稿：好的，【时间】发你。\n要发送的话，到控制台的“待确认”里确认。",
    );
  });

  it("doesn't point to a draft when there isn't one", () => {
    assert.doesNotMatch(readReminder("甲", { ...answer, draft: null }), /草稿：|待确认/);
    assert.doesNotMatch(readReminder("甲", { ...answer, draft: "  " }), /草稿：|待确认/);
  });

  it("adds a note when there is one", () => {
    assert.equal(mentionReminder("甲"), "“甲”里有人 @ 你。");
    assert.equal(mentionReminder("甲", "没读出来。"), "“甲”里有人 @ 你。\n没读出来。");
  });
});
