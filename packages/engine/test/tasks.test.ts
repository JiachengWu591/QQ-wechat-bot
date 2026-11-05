import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { BrainRequest } from "../src/brain.ts";
import { dayKey } from "../src/engine.ts";
import type { LocalTool } from "../src/tools.ts";
import { DM, GROUP, harness, MEMBER, OWNER, TRUSTED, type Harness } from "./helpers.ts";

const noInput = { type: "object", properties: {}, additionalProperties: false } as const;

function sendTool(paths: string[]): LocalTool {
  return {
    name: "deliver",
    description: "Sends a file.",
    inputSchema: noInput,
    minTier: "owner",
    needsSendFile: true,
    run: async (_input, context) => {
      if (!context.sendFile) throw new Error("no way to send");
      for (const path of paths) await context.sendFile(path, "周报.xlsx");
      return "sent";
    },
  };
}

// Holds a turn open until the test lets go of it, watching for the signal as a real model call would.
function hang(h: Harness) {
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => (entered = resolve));
  h.fake.behavior = (request: BrainRequest) =>
    new Promise((_resolve, reject) => {
      entered();
      request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  return started;
}

const offered = (request: BrainRequest) => request.tools.map((tool) => tool.name);
const sentTexts = (h: Harness) => h.adapter.sent.map((message) => message.text);

describe("work in the owner's private chat", () => {
  it("runs as a task only for the owner's private chat", async () => {
    const h = harness();
    await h.engine.start();
    await h.engine.handleInbound(h.message(OWNER, DM, "做个表"));
    await h.engine.handleInbound(h.message(OWNER, GROUP, "聊天"));
    await h.engine.handleInbound(h.message(TRUSTED, DM, "你好"));
    assert.deepEqual(
      h.fake.requests.map((request) => request.profile),
      ["task", "chat", "chat"],
    );
    assert.match(h.fake.requests[0]!.system, /send_file/);
    assert.doesNotMatch(h.fake.requests[1]!.system, /send_file/);
    assert.doesNotMatch(h.fake.requests[2]!.system, /send_file/);
  });

  it("delivers a file to this conversation and records it", async () => {
    const h = harness({ tools: [sendTool(["C:/a.xlsx"])] });
    await h.engine.start();
    h.fake.behavior = async (request) => {
      await request.runTool("deliver", {});
      return { text: "做好了" };
    };
    await h.engine.handleInbound(h.message(OWNER, DM, "做个表"));
    assert.deepEqual(h.adapter.sentFiles, [{ conversationId: DM, path: "C:/a.xlsx", fileName: "周报.xlsx" }]);
    const chat = h.engine.history().chat;
    assert.ok(chat.some((line) => line.direction === "out" && line.text === "[文件] 周报.xlsx" && line.tier === "owner"));
  });

  it("doesn't offer or run file delivery when replies need approval", async () => {
    const h = harness({ tools: [sendTool(["C:/a.xlsx"])] });
    await h.engine.start();
    h.engine.setConversationAutonomy("sim", DM, "confirm");
    let outcome: unknown;
    h.fake.behavior = async (request) => {
      outcome = await request.runTool("deliver", {});
      return { text: "做好了" };
    };
    await h.engine.handleInbound(h.message(OWNER, DM, "做个表"));
    assert.ok(!offered(h.fake.requests[0]!).includes("deliver"));
    assert.deepEqual(outcome, { content: "没有权限使用这个工具。", isError: true });
    assert.deepEqual(h.adapter.sentFiles, []);
  });

  it("doesn't offer file delivery on a platform that can't send files", async () => {
    const h = harness({ tools: [sendTool([])] });
    Object.defineProperty(h.adapter, "sendFile", { value: undefined });
    await h.engine.start();
    await h.engine.handleInbound(h.message(OWNER, DM, "做个表"));
    assert.ok(!offered(h.fake.requests[0]!).includes("deliver"));
  });

  it("won't deliver a file after the channel is closed mid-task", async () => {
    const h = harness({ tools: [sendTool(["C:/a.xlsx"])] });
    await h.engine.start();
    let outcome: { content: unknown; isError: boolean } | undefined;
    h.fake.behavior = async (request) => {
      h.engine.setConversationEnabled("sim", DM, false);
      outcome = await request.runTool("deliver", {});
      return { text: "" };
    };
    await h.engine.handleInbound(h.message(OWNER, DM, "做个表"));
    assert.equal(outcome?.isError, true);
    assert.deepEqual(h.adapter.sentFiles, []);
  });

  it("says it's working on it when a task takes a while, and only once", async () => {
    const h = harness({ config: { taskAckMs: 5 } });
    await h.engine.start();
    h.fake.behavior = async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { text: "完成" };
    };
    await h.engine.handleInbound(h.message(OWNER, DM, "写报告"));
    assert.equal(sentTexts(h).length, 2);
    assert.match(sentTexts(h)[0]!, /正在处理/);
    assert.equal(sentTexts(h)[1], "完成");
  });

  it("doesn't say it's working on something it has already delivered", async () => {
    const h = harness({ config: { taskAckMs: 10 }, tools: [sendTool(["C:/a.xlsx"])] });
    await h.engine.start();
    h.fake.behavior = async (request) => {
      await request.runTool("deliver", {});
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { text: "做好了" };
    };
    await h.engine.handleInbound(h.message(OWNER, DM, "做个表"));
    assert.deepEqual(sentTexts(h), ["做好了"]);
  });

  it("stays quiet when a task finishes quickly", async () => {
    const h = harness({ config: { taskAckMs: 40 } });
    await h.engine.start();
    await h.engine.handleInbound(h.message(OWNER, DM, "你好"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(sentTexts(h), ["好的"]);
  });

  it("doesn't announce work in a group", async () => {
    const h = harness({ config: { taskAckMs: 1 } });
    await h.engine.start();
    h.fake.behavior = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { text: "完成" };
    };
    await h.engine.handleInbound(h.message(OWNER, GROUP, "在吗"));
    assert.deepEqual(sentTexts(h), ["完成"]);
  });

  it("tells the owner when a task dies, but not a group", async () => {
    const h = harness();
    await h.engine.start();
    h.fake.behavior = async () => {
      throw new Error("boom");
    };
    await h.engine.handleInbound(h.message(OWNER, DM, "写报告"));
    await h.engine.handleInbound(h.message(MEMBER, GROUP, "在吗"));
    assert.equal(sentTexts(h).length, 1);
    assert.match(sentTexts(h)[0]!, /没有做完/);
  });

  it("allows a task more searches per call than chat, and doesn't count them against the group", async () => {
    const h = harness({ config: { webSearch: true, sharedSearchesPerDay: 2 } });
    await h.engine.start();
    h.fake.behavior = async () => ({ text: "好", webSearches: 5 });
    await h.engine.handleInbound(h.message(OWNER, DM, "查资料"));
    await h.engine.handleInbound(h.message(OWNER, GROUP, "查一下"));
    h.fake.behavior = async () => ({ text: "好" });
    await h.engine.handleInbound(h.message(MEMBER, GROUP, "查一下"));
    assert.deepEqual(
      h.fake.requests.map((request) => request.webSearchUses),
      [8, 3, 2],
    );
    assert.equal(h.engine.getState().usage.searchesToday, 0);
  });

  it("says so when a reply was cut off", async () => {
    const h = harness();
    await h.engine.start();
    h.fake.behavior = async () => ({ text: "前半段", truncated: true });
    await h.engine.handleInbound(h.message(OWNER, DM, "写长文"));
    assert.match(sentTexts(h)[0]!, /^前半段/);
    assert.match(sentTexts(h)[0]!, /截断/);
  });
});

describe("cancelling", () => {
  for (const word of ["取消", "/cancel", "/stop", "停止", " 取消 ", "/CANCEL"]) {
    it(`stops the running task on "${word}"`, async () => {
      const h = harness();
      await h.engine.start();
      const started = hang(h);
      const task = h.engine.handleInbound(h.message(OWNER, DM, "写报告"));
      await started;
      await h.engine.handleInbound(h.message(OWNER, DM, word));
      await task;
      assert.deepEqual(sentTexts(h), ["已取消。"]);
      assert.equal(h.fake.requests.length, 1);
    });
  }

  it("drops what's queued behind the running task", async () => {
    const h = harness();
    await h.engine.start();
    const started = hang(h);
    const first = h.engine.handleInbound(h.message(OWNER, DM, "写报告"));
    await started;
    const second = h.engine.handleInbound(h.message(OWNER, DM, "再做个表"));
    await h.engine.handleInbound(h.message(OWNER, DM, "取消"));
    await Promise.all([first, second]);
    assert.equal(h.fake.requests.length, 1);
    assert.deepEqual(sentTexts(h), ["已取消。"]);
  });

  it("still takes new work after a cancel", async () => {
    const h = harness();
    await h.engine.start();
    await h.engine.handleInbound(h.message(OWNER, DM, "取消"));
    await h.engine.handleInbound(h.message(OWNER, DM, "写报告"));
    assert.equal(h.fake.requests.length, 1);
    assert.deepEqual(sentTexts(h), ["现在没有进行中的任务。", "好的"]);
  });

  it("isn't the model's business: the word never reaches it or the history", async () => {
    const h = harness();
    await h.engine.start();
    await h.engine.handleInbound(h.message(OWNER, DM, "取消"));
    await h.engine.handleInbound(h.message(OWNER, DM, "写报告"));
    assert.ok(!h.fake.requests[0]!.prompt.includes("取消"));
  });

  it("only touches the conversation it was sent in", async () => {
    const h = harness();
    await h.engine.start();
    const started = hang(h);
    const groupTurn = h.engine.handleInbound(h.message(MEMBER, GROUP, "在吗"));
    await started;
    await h.engine.handleInbound(h.message(OWNER, DM, "取消"));
    assert.deepEqual(sentTexts(h), ["现在没有进行中的任务。"]);
    await h.engine.stop();
    await groupTurn;
  });

  for (const [who, sender, conversation, first] of [
    ["a member in a group", MEMBER, GROUP, MEMBER],
    ["someone trusted in a group", TRUSTED, GROUP, MEMBER],
    ["the owner in a group", OWNER, GROUP, MEMBER],
    ["someone trusted in a private chat", TRUSTED, DM, TRUSTED],
  ] as const) {
    it(`is just ordinary text from ${who}`, async () => {
      const h = harness();
      await h.engine.start();
      const started = hang(h);
      const running = h.engine.handleInbound(h.message(first, conversation, "在吗"));
      await started;
      const word = h.engine.handleInbound(h.message(sender, conversation, "取消"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(h.fake.requests[0]!.signal.aborted, false);
      assert.deepEqual(sentTexts(h), []);
      await h.engine.stop();
      await Promise.all([running, word]);
    });
  }
});

describe("two daily budgets", () => {
  const today = (h: Harness) => dayKey(new Date(h.message(OWNER, DM, "").at).getTime());

  it("charges the owner's work and group chat separately", async () => {
    const h = harness();
    await h.engine.start();
    h.fake.behavior = async () => ({ text: "好", costUsd: 2 });
    await h.engine.handleInbound(h.message(OWNER, DM, "写报告"));
    h.fake.behavior = async () => ({ text: "好", costUsd: 0.5 });
    await h.engine.handleInbound(h.message(MEMBER, GROUP, "在吗"));
    const { usage } = h.engine.getState();
    assert.equal(usage.ownerTodayUsd, 2);
    assert.equal(usage.todayUsd, 0.5);
    assert.equal(usage.ownerDailyLimitUsd, 10);
    assert.equal(usage.dailyLimitUsd, 3);
  });

  it("keeps the group going when the owner's budget is used up, and the reverse", async () => {
    const h = harness({ config: { ownerDailyLimitUsd: 1, dailyLimitUsd: 1 } });
    await h.engine.start();
    h.store.addCost(today(h), 1, "owner");
    await h.engine.handleInbound(h.message(MEMBER, GROUP, "在吗"));
    assert.equal(h.fake.requests.length, 1);

    const other = harness({ config: { ownerDailyLimitUsd: 1, dailyLimitUsd: 1 } });
    await other.engine.start();
    other.store.addCost(today(other), 1, "shared");
    await other.engine.handleInbound(other.message(OWNER, DM, "写报告"));
    assert.equal(other.fake.requests.length, 1);
  });

  it("tells the owner the budget is gone instead of staying silent, without calling the model", async () => {
    const h = harness({ config: { ownerDailyLimitUsd: 1 } });
    await h.engine.start();
    h.store.addCost(today(h), 1, "owner");
    await h.engine.handleInbound(h.message(OWNER, DM, "写报告"));
    assert.equal(h.fake.requests.length, 0);
    assert.match(sentTexts(h)[0]!, /预算/);
  });

  it("stays silent in a group when its budget is gone", async () => {
    const h = harness({ config: { dailyLimitUsd: 1 } });
    await h.engine.start();
    h.store.addCost(today(h), 1, "shared");
    await h.engine.handleInbound(h.message(MEMBER, GROUP, "在吗"));
    assert.deepEqual(sentTexts(h), []);
  });

  it("stops a task that runs out of budget part-way, before its next tool", async () => {
    const h = harness({ config: { ownerDailyLimitUsd: 1 } });
    await h.engine.start();
    let outcome: { isError: boolean } | undefined;
    let aborted = false;
    h.fake.behavior = async (request) => {
      request.onCost(1);
      outcome = await request.runTool("owner_tool", {});
      aborted = request.signal.aborted;
      return { text: "写完了", costUsd: 0 };
    };
    await h.engine.handleInbound(h.message(OWNER, DM, "写报告"));
    assert.equal(outcome?.isError, true);
    assert.equal(aborted, true);
    assert.deepEqual(h.toolRuns, []);
    assert.equal(sentTexts(h).length, 1);
    assert.match(sentTexts(h)[0]!, /预算/);
    assert.ok(!sentTexts(h).includes("写完了"));
  });

  it("still delivers a reply that finished right as the budget ran out", async () => {
    const h = harness({ config: { ownerDailyLimitUsd: 1 } });
    await h.engine.start();
    h.fake.behavior = async () => ({ text: "写完了", costUsd: 1 });
    await h.engine.handleInbound(h.message(OWNER, DM, "写报告"));
    assert.deepEqual(sentTexts(h), ["写完了"]);
  });

  it("records spending even when the turn then fails", async () => {
    const h = harness();
    await h.engine.start();
    h.fake.behavior = async (request) => {
      request.onCost(0.5);
      throw new Error("boom");
    };
    await h.engine.handleInbound(h.message(MEMBER, GROUP, "在吗"));
    assert.equal(h.engine.getState().usage.todayUsd, 0.5);
  });
});

describe("files the owner sends", () => {
  const attachment = (name: string, data = "内容") => ({
    name,
    fetched: 0,
    async download() {
      this.fetched += 1;
      return Buffer.from(data);
    },
  });

  it("saves them to the workspace and tells the model where", async () => {
    const h = harness();
    await h.engine.start();
    const file = attachment("周报.txt");
    await h.engine.handleInbound(h.message(OWNER, DM, "总结一下", { attachments: [file] }));
    assert.match(h.fake.requests[0]!.prompt, /inbox\/周报\.txt/);
    assert.equal(await readFile(join(h.workspace.root, "inbox", "周报.txt"), "utf8"), "内容");
  });

  it("doesn't overwrite an earlier file with the same name", async () => {
    const h = harness();
    await h.engine.start();
    await h.engine.handleInbound(h.message(OWNER, DM, "", { attachments: [attachment("a.txt", "一")] }));
    await h.engine.handleInbound(h.message(OWNER, DM, "", { attachments: [attachment("a.txt", "二")] }));
    assert.equal(await readFile(join(h.workspace.root, "inbox", "a.txt"), "utf8"), "一");
    assert.equal(await readFile(join(h.workspace.root, "inbox", "a (2).txt"), "utf8"), "二");
  });

  it("can't be led out of the workspace by a file name", async () => {
    const h = harness();
    await h.engine.start();
    await h.engine.handleInbound(h.message(OWNER, DM, "", { attachments: [attachment("..\\..\\evil.txt")] }));
    assert.equal(await readFile(join(h.workspace.root, "inbox", "evil.txt"), "utf8"), "内容");
  });

  it("never downloads for anyone but the owner in a private chat", async () => {
    const h = harness();
    await h.engine.start();
    const fromTrusted = attachment("a.txt");
    const fromOwnerInGroup = attachment("b.txt");
    const fromMember = attachment("c.txt");
    await h.engine.handleInbound(h.message(TRUSTED, DM, "看看", { attachments: [fromTrusted] }));
    await h.engine.handleInbound(h.message(OWNER, GROUP, "看看", { attachments: [fromOwnerInGroup] }));
    await h.engine.handleInbound(h.message(MEMBER, GROUP, "看看", { attachments: [fromMember] }));
    assert.equal(fromTrusted.fetched + fromOwnerInGroup.fetched + fromMember.fetched, 0);
    assert.match(h.fake.requests[0]!.prompt, /没有保存/);
  });

  it("doesn't download anything when the conversation is closed", async () => {
    const h = harness();
    await h.engine.start();
    h.engine.setConversationEnabled("sim", DM, false);
    const file = attachment("a.txt");
    await h.engine.handleInbound(h.message(OWNER, DM, "", { attachments: [file] }));
    assert.equal(file.fetched, 0);
  });

  it("tells the model when a download failed, so it can ask for the file again", async () => {
    const h = harness();
    await h.engine.start();
    await h.engine.handleInbound(
      h.message(OWNER, DM, "总结", {
        attachments: [
          {
            name: "a.txt",
            download: async () => {
              throw new Error("network");
            },
          },
        ],
      }),
    );
    assert.match(h.fake.requests[0]!.prompt, /下载失败/);
    assert.ok(h.activity.some((line) => line.includes("下载失败")));
  });

  it("keeps an instruction sent right after a file from overtaking it", async () => {
    const h = harness();
    await h.engine.start();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = h.engine.handleInbound(
      h.message(OWNER, DM, "", {
        attachments: [
          {
            name: "a.txt",
            download: async () => {
              await gate;
              return Buffer.from("内容");
            },
          },
        ],
      }),
    );
    const second = h.engine.handleInbound(h.message(OWNER, DM, "总结这个"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(h.fake.requests.length, 0);
    release();
    await Promise.all([first, second]);
    assert.equal(h.fake.requests.length, 1);
    assert.match(h.fake.requests[0]!.prompt, /inbox\/a\.txt/);
    assert.match(h.fake.requests[0]!.prompt, /总结这个/);
  });
});

describe("choosing the model", () => {
  it("uses the brain's own default until one is chosen", async () => {
    const h = harness();
    await h.engine.start();
    await h.engine.handleInbound(h.message(MEMBER, GROUP, "在吗"));
    assert.equal(h.fake.requests[0]!.model, "fake");
    assert.equal(h.engine.getState().brain.model, "fake");
  });

  it("applies a new choice to the next message, in groups and private chats alike", async () => {
    const h = harness();
    await h.engine.start();
    await h.engine.handleInbound(h.message(MEMBER, GROUP, "一"));
    h.engine.setModel("claude-haiku-5-5");
    await h.engine.handleInbound(h.message(MEMBER, GROUP, "二"));
    await h.engine.handleInbound(h.message(OWNER, DM, "三"));
    assert.deepEqual(
      h.fake.requests.map((request) => request.model),
      ["fake", "claude-haiku-5-5", "claude-haiku-5-5"],
    );
    assert.equal(h.engine.getState().brain.model, "claude-haiku-5-5");
    assert.ok(h.activity.some((line) => line.includes("Haiku 5.5")));
  });

  it("doesn't change the model of a turn already running", async () => {
    const h = harness();
    await h.engine.start();
    const started = hang(h);
    const running = h.engine.handleInbound(h.message(OWNER, DM, "写报告"));
    await started;
    h.engine.setModel("claude-haiku-5-5");
    assert.equal(h.fake.requests[0]!.model, "fake");
    await h.engine.stop();
    await running;
  });

  it("remembers the choice after the program restarts", async () => {
    const first = harness();
    first.engine.setModel("claude-sonnet-5-5");
    const second = harness({ store: first.store });
    assert.equal(second.engine.getState().brain.model, "claude-sonnet-5-5");
  });

  it("works while the master switch is off", () => {
    const h = harness();
    h.engine.setModel("claude-sonnet-5-5");
    assert.equal(h.engine.getState().brain.model, "claude-sonnet-5-5");
    assert.equal(h.engine.getState().running, false);
  });

  it("refuses a model it doesn't offer, and keeps the current one", () => {
    const h = harness();
    h.engine.setModel("claude-sonnet-5-5");
    assert.throws(() => h.engine.setModel("gpt-5"), /没有这个模型/);
    assert.equal(h.engine.getState().brain.model, "claude-sonnet-5-5");
  });

  it("falls back to the default if a saved choice is no longer offered", async () => {
    const h = harness();
    h.store.setSetting("brain:model", "claude-retired-1");
    await h.engine.start();
    await h.engine.handleInbound(h.message(MEMBER, GROUP, "在吗"));
    assert.equal(h.engine.getState().brain.model, "fake");
    assert.equal(h.fake.requests[0]!.model, "fake");
  });

  it("doesn't reset what's been spent today", async () => {
    const h = harness();
    await h.engine.start();
    await h.engine.handleInbound(h.message(OWNER, DM, "写报告"));
    const before = h.engine.getState().usage.ownerTodayUsd;
    h.engine.setModel("claude-haiku-5-5");
    assert.equal(h.engine.getState().usage.ownerTodayUsd, before);
    assert.ok(before > 0);
  });

  it("reports no model when there's no API key", () => {
    const h = harness({ brain: null });
    assert.equal(h.engine.getState().brain.model, "未配置");
    assert.equal(h.engine.getState().brain.ready, false);
  });
});

describe("a reply that can't be sent", () => {
  it("is kept for the owner to send again, and the owner is told", async () => {
    const h = harness();
    await h.engine.start();
    h.fake.behavior = async () => ({ text: "写好的总结" });
    h.adapter.failNextSend = new Error("连接微信超时");
    await h.engine.handleInbound(h.message(OWNER, DM, "总结"));

    const [pending] = h.engine.getState().pending;
    assert.equal(pending?.draft, "写好的总结");
    assert.equal(pending?.tier, "owner");
    assert.ok(h.activity.some((line) => line.startsWith("error") && line.includes("连接微信超时")));
    assert.match(sentTexts(h)[0]!, /待确认/);

    await h.engine.approve(pending!.id);
    assert.equal(sentTexts(h).at(-1), "写好的总结");
    assert.equal(h.engine.getState().pending.length, 0);
  });

  it("doesn't also claim the work wasn't done", async () => {
    const h = harness();
    await h.engine.start();
    h.adapter.failNextSend = new Error("超时");
    await h.engine.handleInbound(h.message(OWNER, DM, "总结"));
    assert.ok(!sentTexts(h).some((text) => text.includes("没有做完")));
  });

  it("isn't kept in a group, where a late reply would make no sense", async () => {
    const h = harness();
    await h.engine.start();
    h.adapter.failNextSend = new Error("超时");
    await h.engine.handleInbound(h.message(MEMBER, GROUP, "在吗"));
    assert.equal(h.engine.getState().pending.length, 0);
    assert.deepEqual(sentTexts(h), []);
  });
});

describe("what a file on its own asks of the model", () => {
  const file = { name: "a.txt", download: async () => Buffer.from("内容") };

  it("waits for an instruction, so the model hears both at once", async () => {
    const h = harness({ config: { fileSettleMs: 30 } });
    await h.engine.start();
    const fileTurn = h.engine.handleInbound(h.message(OWNER, DM, "", { attachments: [file] }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await h.engine.handleInbound(h.message(OWNER, DM, "帮我总结一下"));
    await fileTurn;
    assert.equal(h.fake.requests.length, 1);
    assert.match(h.fake.requests[0]!.prompt, /inbox\/a\.txt/);
    assert.match(h.fake.requests[0]!.prompt, /帮我总结一下/);
  });

  it("turns several files in a row into one question", async () => {
    const h = harness({ config: { fileSettleMs: 30 } });
    await h.engine.start();
    await Promise.all([
      h.engine.handleInbound(h.message(OWNER, DM, "", { attachments: [file] })),
      h.engine.handleInbound(h.message(OWNER, DM, "", { attachments: [file] })),
      h.engine.handleInbound(h.message(OWNER, DM, "", { attachments: [file] })),
    ]);
    assert.equal(h.fake.requests.length, 1);
  });

  it("still gets a reply if no instruction comes", async () => {
    const h = harness({ config: { fileSettleMs: 5 } });
    await h.engine.start();
    await h.engine.handleInbound(h.message(OWNER, DM, "", { attachments: [file] }));
    assert.equal(h.fake.requests.length, 1);
  });

  it("isn't put off by the bot's own reply arriving meanwhile", async () => {
    const h = harness({ config: { fileSettleMs: 40 } });
    await h.engine.start();
    h.fake.behavior = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { text: "前一件做完了" };
    };
    const earlier = h.engine.handleInbound(h.message(OWNER, DM, "写报告"));
    const fileTurn = h.engine.handleInbound(h.message(OWNER, DM, "", { attachments: [file] }));
    await Promise.all([earlier, fileTurn]);
    assert.equal(h.fake.requests.length, 2);
  });

  it("doesn't wait when the instruction came with the file", async () => {
    const h = harness({ config: { fileSettleMs: 5000 } });
    await h.engine.start();
    const started = Date.now();
    await h.engine.handleInbound(h.message(OWNER, DM, "总结", { attachments: [file] }));
    assert.ok(Date.now() - started < 1000);
    assert.equal(h.fake.requests.length, 1);
  });

  it("asks what to do rather than reading it unprompted", async () => {
    const h = harness();
    await h.engine.start();
    await h.engine.handleInbound(h.message(OWNER, DM, "", { attachments: [file] }));
    assert.match(h.fake.requests[0]!.prompt, /问一句/);
  });

  it("doesn't say that when the owner already gave an instruction", async () => {
    const h = harness();
    await h.engine.start();
    await h.engine.handleInbound(h.message(OWNER, DM, "总结", { attachments: [file] }));
    assert.doesNotMatch(h.fake.requests[0]!.prompt, /问一句/);
  });
});

describe("QR login through the engine", () => {
  function withLogin() {
    const h = harness();
    const calls: string[] = [];
    Object.defineProperties(h.adapter, {
      beginLogin: { value: async () => void calls.push("begin") },
      submitLoginCode: { value: (code: string) => void calls.push(`code:${code}`) },
      logout: { value: async () => void calls.push("logout") },
    });
    return { h, calls };
  }

  it("says which channels sign in that way", () => {
    assert.equal(harness().engine.getState().channels[0]!.canLogin, false);
    assert.equal(withLogin().h.engine.getState().channels[0]!.canLogin, true);
  });

  it("refuses a login on a channel that has none", async () => {
    const h = harness();
    await h.engine.start();
    await assert.rejects(h.engine.beginChannelLogin("sim"), /不用扫码/);
  });

  it("needs the master switch and the channel to be on", async () => {
    const { h, calls } = withLogin();
    await assert.rejects(h.engine.beginChannelLogin("sim"), /总闸/);
    await h.engine.start();
    await h.engine.setChannelEnabled("sim", false);
    await assert.rejects(h.engine.beginChannelLogin("sim"), /总闸/);
    await h.engine.setChannelEnabled("sim", true);
    await h.engine.beginChannelLogin("sim");
    assert.deepEqual(calls, ["begin"]);
  });

  it("passes the code and the logout on to the channel", async () => {
    const { h, calls } = withLogin();
    await h.engine.start();
    h.engine.submitChannelLoginCode("sim", "1234");
    await h.engine.logoutChannel("sim");
    assert.deepEqual(calls, ["code:1234", "logout"]);
  });

  it("shows the login's progress, and clears it when finished", async () => {
    const { h } = withLogin();
    await h.engine.start();
    assert.equal(h.engine.getState().channels[0]!.login, undefined);
    h.adapter.reportLogin({ state: "qr", qrContent: "https://qr" });
    assert.deepEqual(h.engine.getState().channels[0]!.login, { state: "qr", qrContent: "https://qr" });
    h.adapter.reportLogin(null);
    assert.equal(h.engine.getState().channels[0]!.login, undefined);
  });

  it("records a failed login and a channel that needs one", async () => {
    const { h } = withLogin();
    await h.engine.start();
    h.adapter.reportLogin({ state: "failed", message: "二维码过期" });
    h.adapter.reportStatus({ state: "needs-login", detail: "请扫码" });
    assert.ok(h.activity.some((line) => line.startsWith("error") && line.includes("二维码过期")));
    assert.ok(h.activity.some((line) => line.startsWith("info") && line.includes("请扫码")));
  });
});

describe("signed-in accounts", () => {
  it("treats the account the platform confirms as the owner, and nobody else", async () => {
    const h = harness();
    Object.defineProperty(h.adapter, "ownerId", { value: () => "wx-me" });
    await h.engine.start();
    await h.engine.handleInbound(h.message("wx-me", DM, "你好", { senderName: "我" }));
    await h.engine.handleInbound(h.message("wx-other", DM, "你好", { senderName: "别人" }));
    assert.equal(h.fake.requests.length, 1);
    assert.equal(h.fake.requests[0]!.profile, "task");
    assert.ok(h.activity.some((line) => line.includes("拒绝陌生人")));
  });
});
