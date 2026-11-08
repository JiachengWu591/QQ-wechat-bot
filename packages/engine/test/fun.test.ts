import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { conversationNicknames, groupTools } from "../src/fun.ts";
import { poolTool, readPool } from "../src/pool.ts";
import { Store } from "../src/store.ts";
import type { LocalTool, ToolCaller } from "../src/tools.ts";
import type { ChatImage } from "../src/types.ts";
import { Workspace } from "../src/workspace.ts";
import { picture } from "./helpers.ts";

const caller = (overrides: Partial<ToolCaller> = {}): ToolCaller => ({
  channelId: "qq",
  conversationId: "group-1",
  conversationKind: "group",
  senderId: "xiaoming",
  senderName: "小明",
  senderTier: "member",
  ...overrides,
});
const XIAOHONG = caller({ senderId: "xiaohong", senderName: "小红" });
const OWNER = caller({ senderId: "boss", senderName: "乔治", senderTier: "owner" });

function setup(options: { random?: (below: number) => number } = {}) {
  const store = new Store(":memory:");
  const workspace = new Workspace(join(tmpdir(), `shu-fun-${randomUUID()}`));
  let clock = 1_000_000;
  const tools = groupTools(store, { workspace, now: () => clock, ...options });
  const tool = (name: string) => tools.find((entry) => entry.name === name) as LocalTool;
  const run = (name: string, input: unknown, who: ToolCaller = caller()) => tool(name).run(input, { caller: who }) as Promise<string>;
  // The owner fills the pig pool from pictures they sent.
  const fill = async (cards: Array<[string, 3 | 4 | 5, number?, ("image/png" | "image/gif")?]>) => {
    const manage = poolTool(store, workspace);
    for (const [name, rarity, color, mime] of cards) {
      const file = await workspace.saveInbox(`${name}.${mime === "image/gif" ? "gif" : "png"}`, await picture(color, mime));
      await manage.run({ action: "add", file, name, rarity }, {});
    }
  };
  return { store, workspace, tools, run, fill, advance: (ms: number) => (clock += ms) };
}

const PIGS: Array<[string, 3 | 4 | 5, number?, ("image/png" | "image/gif")?]> = [
  ["猪降临", 5, 0xffcc00ff, "image/gif"],
  ["猪摸鱼", 4, 0x9966ffff],
  ["猪", 3, 0xff99ccff],
];

// Plays back the given draws, then keeps giving the last one.
const scripted = (...draws: number[]) => {
  let next = 0;
  return (below: number) => Math.min(draws[Math.min(next++, draws.length - 1)] as number, below - 1);
};

describe("group tools", () => {
  it("are all open to everyone, and check their own input", () => {
    const { tools } = setup();
    assert.deepEqual(tools.map((tool) => tool.name), ["roll_dice", "random_pick", "poll", "gacha_pull", "set_nickname"]);
    assert.ok(tools.every((tool) => tool.minTier === "member" && tool.inputSchema.additionalProperties === false));
  });

  describe("dice", () => {
    it("rolls one six-sided die by default", async () => {
      const { run } = setup({ random: scripted(3) });
      assert.equal(await run("roll_dice", {}), "掷了 1 个 6 面骰：4");
    });

    it("adds up several dice", async () => {
      const { run } = setup({ random: scripted(0, 19) });
      assert.equal(await run("roll_dice", { dice: 2, sides: 20 }), "掷了 2 个 20 面骰：1、20，合计 21");
    });

    it("refuses dice it can't roll", async () => {
      const { run } = setup();
      await assert.rejects(run("roll_dice", { sides: 1 }), /参数不对/);
      await assert.rejects(run("roll_dice", { dice: 21 }), /参数不对/);
      await assert.rejects(run("roll_dice", { dice: "3" }), /参数不对/);
    });

    it("really is random when nothing is scripted", async () => {
      const { run } = setup();
      const seen = new Set<string>();
      for (let roll = 0; roll < 60; roll++) seen.add(await run("roll_dice", {}));
      assert.ok(seen.size > 3);
      for (const result of seen) assert.match(result, /^掷了 1 个 6 面骰：[1-6]$/);
    });
  });

  describe("random pick", () => {
    it("picks different ones without repeating", async () => {
      const { run } = setup({ random: scripted(2, 0) });
      assert.equal(await run("random_pick", { options: ["火锅", "烧烤", "日料"], count: 2 }), "从 3 个里随机抽了 2 个：日料、烧烤");
    });

    it("refuses to pick more than there are", async () => {
      const { run } = setup();
      await assert.rejects(run("random_pick", { options: ["甲", "乙"], count: 3 }), /个数比选项还多/);
      await assert.rejects(run("random_pick", { options: ["甲"] }), /参数不对/);
    });
  });

  describe("polls", () => {
    const start = { action: "start", question: "周五吃什么", options: ["火锅", "烧烤"] };

    it("starts one, counts each person's vote once, and lets them change it", async () => {
      const { run } = setup();
      assert.match(await run("poll", start), /小明 发起了投票，24 小时内有效[\s\S]*1\. 火锅：0 票/);
      await run("poll", { action: "vote", choice: 1 });
      await run("poll", { action: "vote", choice: 2 }, XIAOHONG);
      const changed = await run("poll", { action: "vote", choice: 2 });
      assert.match(changed, /小明 投给 2\. 烧烤（原来投的是 1，已改）/);
      assert.match(changed, /共 2 人投票[\s\S]*1\. 火锅：0 票\n2\. 烧烤：2 票（小明、小红）/);
    });

    it("counts a vote for whoever sent the message, whatever the model passes", async () => {
      const { run } = setup();
      await run("poll", start);
      await run("poll", { action: "vote", choice: 1, voter: "小红" }, caller()).catch(() => {});
      await run("poll", { action: "vote", choice: 1 });
      assert.match(await run("poll", { action: "results" }), /共 1 人投票[\s\S]*（小明）/);
    });

    it("keeps one poll at a time in a chat, but separate chats have their own", async () => {
      const { run } = setup();
      await run("poll", start);
      await assert.rejects(run("poll", start, XIAOHONG), /已经有一个进行中的投票：「周五吃什么」/);
      assert.match(await run("poll", start, caller({ conversationId: "group-2" })), /发起了投票/);
    });

    it("lets only whoever started it, or the owner, close it", async () => {
      const { run } = setup();
      await run("poll", start);
      await assert.rejects(run("poll", { action: "close" }, XIAOHONG), /只有发起人 小明 或主人能结束/);
      assert.match(await run("poll", { action: "close" }, OWNER), /已结束/);
      await assert.rejects(run("poll", { action: "results" }), /现在没有进行中的投票/);
      await run("poll", start, XIAOHONG);
      assert.match(await run("poll", { action: "close" }, XIAOHONG), /已结束/);
    });

    it("ends by itself after a day", async () => {
      const { run, advance } = setup();
      await run("poll", start);
      advance(24 * 60 * 60_000);
      await assert.rejects(run("poll", { action: "vote", choice: 1 }), /没有进行中的投票/);
      assert.match(await run("poll", start, XIAOHONG), /发起了投票/);
    });

    it("refuses a vote for an option that isn't there, and a poll with repeats or one option", async () => {
      const { run } = setup();
      await assert.rejects(run("poll", { action: "start", question: "吃啥", options: ["火锅", "火锅"] }), /选项有重复/);
      await assert.rejects(run("poll", { action: "start", question: "吃啥", options: ["火锅"] }), /参数不对/);
      await assert.rejects(run("poll", { action: "start", options: ["火锅", "烧烤"] }), /要有问题/);
      await run("poll", start);
      await assert.rejects(run("poll", { action: "vote", choice: 3 }), /选项是 1 到 2/);
      await assert.rejects(run("poll", { action: "vote" }), /选项是 1 到 2/);
    });
  });

  describe("gacha", () => {
    // Never lucky: every draw is as high as it gets.
    const unlucky = (below: number) => below - 1;
    // Every chance comes off, so the first pull is a five-star.
    const lucky = () => 0;
    const collect = () => {
      const sent: Array<{ images: ChatImage[]; caption?: string }> = [];
      return { sent, sendImages: async (images: ChatImage[], caption?: string) => void sent.push({ images, ...(caption ? { caption } : {}) }) };
    };

    it("won't open until the owner has added each rarity", async () => {
      const { run, fill } = setup();
      await assert.rejects(run("gacha_pull", {}), /猪猪池还没开：现在五星 0 张、四星 0 张、三星 0 张/);
      await fill([PIGS[2]!]);
      await assert.rejects(run("gacha_pull", {}), /五星 0 张、四星 0 张、三星 1 张/);
    });

    it("says what came out of the pig pool, with the pity left", async () => {
      const { run, fill } = setup({ random: unlucky });
      await fill(PIGS);
      assert.equal(await run("gacha_pull", { count: 10 }), "小明 的猪猪池十连：三星×9，四星×1（猪摸鱼），五星×0。已 10 抽未出五星，累计 10 抽，一共出了 0 个五星。");
      for (let round = 0; round < 7; round++) await run("gacha_pull", { count: 10 });
      assert.match(await run("gacha_pull", { count: 10 }), /五星×1（猪降临，第 90 抽）。已 0 抽未出五星，累计 90 抽，一共出了 1 个五星。$/);
    });

    it("keeps each person's pity apart, and each chat's", async () => {
      const { run, fill } = setup({ random: unlucky });
      await fill(PIGS);
      await run("gacha_pull", { count: 10 });
      assert.match(await run("gacha_pull", {}, XIAOHONG), /^小红 的猪猪池单抽：三星（猪）。已 1 抽未出五星，累计 1 抽/);
      assert.match(await run("gacha_pull", {}, caller({ conversationId: "group-2" })), /累计 1 抽/);
      assert.match(await run("gacha_pull", {}), /累计 11 抽/);
    });

    it("only does a single or a ten", async () => {
      const { run, fill } = setup();
      await fill(PIGS);
      await assert.rejects(run("gacha_pull", { count: 100 }), /参数不对/);
    });

    it("shows the pull as a picture made from the pool's pictures", async () => {
      const { tools, fill } = setup({ random: unlucky });
      await fill(PIGS);
      const { sent, sendImages } = collect();
      const said = String(await tools.find((entry) => entry.name === "gacha_pull")!.run({ count: 10 }, { caller: caller(), sendImages }));
      assert.equal(sent.length, 1, "no five-star, so only the result");
      const [result] = sent[0]!.images;
      assert.equal(result!.mediaType, "image/png");
      assert.equal(result!.reuseKey, undefined, "every pull is its own picture");
      assert.equal(result!.alt, "小明 的十连 · 猪猪池");
      assert.match(said, /\n结果图（已经发到聊天里了/);
    });

    it("also sends a five-star's own picture, as added, to keep for next time", async () => {
      const { tools, fill, store } = setup({ random: lucky });
      await fill(PIGS);
      const { sent, sendImages } = collect();
      const said = String(await tools.find((entry) => entry.name === "gacha_pull")!.run({}, { caller: caller(), sendImages }));
      assert.equal(sent.length, 2);
      const [original] = sent[1]!.images;
      const card = readPool(store).find((entry) => entry.name === "猪降临")!;
      assert.equal(original!.mediaType, "image/gif");
      assert.equal(original!.data.subarray(0, 6).toString("latin1"), "GIF89a");
      assert.equal(original!.reuseKey, `pool-${card.id}`);
      assert.equal(original!.alt, "猪降临");
      assert.match(said, /^小明 的猪猪池单抽：五星（猪降临，第 1 抽）。[\s\S]*结果图和五星原图（已经发到聊天里了/);
    });

    it("still says the result where pictures can't be shown", async () => {
      const { tools, fill } = setup({ random: lucky });
      await fill(PIGS);
      const said = String(await tools.find((entry) => entry.name === "gacha_pull")!.run({}, { caller: caller(), sendImages: async () => Promise.reject(new Error("QQ 接口错误")) }));
      assert.equal(said, "小明 的猪猪池单抽：五星（猪降临，第 1 抽）。已 0 抽未出五星，累计 1 抽，一共出了 1 个五星。");
    });
  });

  describe("pictures and cards", () => {
    it("shows six-sided dice rolling, as pictures that can be reused", async () => {
      const { tools } = setup({ random: scripted(3, 0) });
      const sent: Array<{ images: ChatImage[]; caption?: string }> = [];
      const said = String(await tools[0]!.run({ dice: 2 }, { sendImages: async (images, caption) => void sent.push({ images, ...(caption ? { caption } : {}) }) }));
      assert.deepEqual(sent.map(({ images, caption }) => ({ keys: images.map((image) => image.reuseKey), types: images.map((image) => image.mediaType), caption })), [
        { keys: ["dice-d6-v1-4", "dice-d6-v1-1"], types: ["image/gif", "image/gif"], caption: "合计 5" },
      ]);
      assert.equal(sent[0]!.images[0]!.data.subarray(0, 6).toString("latin1"), "GIF89a");
      assert.match(said, /^掷了 2 个 6 面骰：4、1，合计 5。骰子动画（已经发到聊天里了/);
    });

    it("keeps other dice, and lots of them, as words", async () => {
      const { tools } = setup({ random: scripted(5) });
      let sends = 0;
      const sendImages = async () => void sends++;
      assert.equal(await tools[0]!.run({ sides: 20 }, { sendImages }), "掷了 1 个 20 面骰：6");
      assert.match(String(await tools[0]!.run({ dice: 7 }, { sendImages })), /^掷了 7 个 6 面骰：.*合计/);
      assert.equal(sends, 0);
    });

    it("falls back to words when a picture can't go out", async () => {
      const { tools } = setup({ random: scripted(2) });
      const said = await tools[0]!.run({}, { sendImages: async () => Promise.reject(new Error("QQ 接口错误")) });
      assert.equal(said, "掷了 1 个 6 面骰：3");
    });

    it("shows a poll as a card with a bar for each option, and says so", async () => {
      const { tools } = setup();
      const cards: string[] = [];
      const context = (who: ToolCaller) => ({ caller: who, sendCard: async (markdown: string) => void cards.push(markdown) });
      const poll = tools.find((tool) => tool.name === "poll")!;
      const started = String(await poll.run({ action: "start", question: "周五吃*什么*", options: ["火锅", "烧烤"] }, context(caller())));
      assert.match(started, /投票卡片（已经发到聊天里了/);
      await poll.run({ action: "vote", choice: 1 }, context(caller()));
      await poll.run({ action: "vote", choice: 1 }, context(XIAOHONG));
      await poll.run({ action: "vote", choice: 2 }, context(OWNER));
      assert.equal(cards.length, 4);
      assert.equal(
        cards[3],
        "## 📊 周五吃＊什么＊\n\n**1. 火锅**\n\n▓▓▓▓▓▓▓░░░ 2 票（67%）　小明、小红\n\n**2. 烧烤**\n\n▓▓▓░░░░░░░ 1 票（33%）　乔治\n\n> 共 3 人投票 · 24 小时内有效 · @我说“投 1”参与",
      );
      await poll.run({ action: "close" }, context(OWNER));
      assert.match(cards.at(-1)!, /> 已结束 · 共 3 人投票$/);
    });

    it("keeps the poll in words where there are no cards", async () => {
      const { run } = setup();
      assert.match(await run("poll", { action: "start", question: "吃啥", options: ["火锅", "烧烤"] }), /告诉大家 @ 你说“投 1”这样投票/);
    });
  });

  describe("nicknames", () => {
    it("remembers what the sender wants to be called, and forgets it when asked", async () => {
      const { run, store } = setup();
      assert.equal(await run("set_nickname", { nickname: "老王" }), "记住了，以后叫 小明「老王」。");
      await run("set_nickname", { nickname: "红红" }, XIAOHONG);
      assert.deepEqual([...conversationNicknames(store, "qq", "group-1")], [["xiaoming", "老王"], ["xiaohong", "红红"]]);
      await run("set_nickname", { nickname: "" });
      assert.deepEqual([...conversationNicknames(store, "qq", "group-1")], [["xiaohong", "红红"]]);
      assert.deepEqual([...conversationNicknames(store, "qq", "group-2")], []);
    });

    it("won't take a name that sounds like a standing", async () => {
      const { run, store } = setup();
      for (const nickname of ["主人", "群管理员", "Admin", "开发者小明", "system"]) await assert.rejects(run("set_nickname", { nickname }), /这个称呼不行/, nickname);
      await assert.rejects(run("set_nickname", { nickname: "名字太长了超过十二个字了吧" }), /参数不对/);
      assert.deepEqual([...conversationNicknames(store, "qq", "group-1")], []);
    });
  });

  it("refuses to act without knowing who asked", async () => {
    const { tools } = setup();
    for (const name of ["poll", "gacha_pull", "set_nickname"]) {
      await assert.rejects(tools.find((tool) => tool.name === name)!.run({ action: "results", nickname: "a" }, {}), /不知道是谁/);
    }
  });
});
