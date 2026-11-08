import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Jimp } from "jimp";
import { collectSeen, collectsIn, poolProblem, poolTool, rarityByFrequency, readPool, thumbnail } from "../src/pool.ts";
import { sniffImage } from "../src/images.ts";
import type { ChatImage, SeenImage } from "../src/types.ts";
import { Store } from "../src/store.ts";
import { Workspace } from "../src/workspace.ts";
import { picture, WEBP_ANIMATED, WEBP_BROKEN, WEBP_GREEN } from "./helpers.ts";

const GROUPS = [
  { channelId: "qq", conversationId: "g-test", title: "测试" },
  { channelId: "qq", conversationId: "g-hsr", title: "崩坏：星穹铁道总部群" },
  { channelId: "qq", conversationId: "g-hsr2", title: "崩坏：星穹铁道二群" },
];

function setup() {
  const store = new Store(":memory:");
  const workspace = new Workspace(join(tmpdir(), `shu-pool-${randomUUID()}`));
  const tool = poolTool(store, workspace, { now: () => 1_000, groups: () => GROUPS });
  const run = (input: unknown, context = {}) => tool.run(input, context) as Promise<string>;
  return { store, workspace, tool, run };
}

// A picture as a group message brings it: known by its MD5, fetched only when asked.
function seen(data: Buffer, fetches: { count: number } = { count: 0 }): SeenImage {
  return {
    fingerprint: createHash("md5").update(data).digest("hex").toUpperCase(),
    fetch: async () => {
      fetches.count += 1;
      return data;
    },
  };
}

describe("the gacha pool", () => {
  it("can only be changed by the owner", () => {
    assert.equal(setup().tool.minTier, "owner");
  });

  it("adds a picture the owner sent, copied into its own folder", async () => {
    const { store, workspace, run } = setup();
    const data = await picture();
    const sent = await workspace.saveInbox("猪.png", data);
    assert.equal(await run({ action: "add", file: sent, name: "猪降临", rarity: 5 }), "加好了：五星「猪降临」。现在五星 1 张、四星 0 张、三星 0 张。");
    const [card] = readPool(store);
    const fingerprint = createHash("md5").update(data).digest("hex").toUpperCase();
    assert.deepEqual({ ...card, id: "x" }, { id: "x", name: "猪降临", rarity: 5, file: "gacha/猪降临.png", mediaType: "image/png", addedAt: 1_000, fingerprint });
    assert.ok(existsSync(await workspace.resolve("gacha/猪降临.png")));
    assert.ok(existsSync(await workspace.resolve(sent)), "what the owner sent stays where it was");
  });

  it("takes jpg and gif, and says when it's ready to pull", async () => {
    const { workspace, run } = setup();
    await run({ action: "add", file: await workspace.saveInbox("a.jpg", await picture(0xffcc00ff, "image/jpeg")), name: "金猪", rarity: 5 });
    await run({ action: "add", file: await workspace.saveInbox("b.gif", await picture(0x9966ffff, "image/gif")), name: "紫猪", rarity: 4 });
    assert.match(await run({ action: "add", file: await workspace.saveInbox("c.png", await picture()), name: "粉猪", rarity: 3 }), /三星 1 张。可以抽了。$/);
    assert.equal(await run({ action: "list" }), "猪猪池一共 3 张（五星 1 张、四星 1 张、三星 1 张）：\n五星：金猪\n四星：紫猪\n三星：粉猪\n可以抽了。");
  });

  it("keeps a WebP as PNG, known by the file it came as", async () => {
    const { store, workspace, run } = setup();
    assert.match(await run({ action: "add", file: await workspace.saveInbox("猪.webp", WEBP_GREEN), name: "绿猪", rarity: 4 }), /^加好了：四星「绿猪」。/);
    const [card] = readPool(store);
    assert.equal(card?.file, "gacha/绿猪.png");
    assert.equal(card?.mediaType, "image/png");
    assert.equal(card?.fingerprint, createHash("md5").update(WEBP_GREEN).digest("hex").toUpperCase());
    assert.equal(sniffImage(await readFile(await workspace.resolve(card?.file ?? ""))), "image/png");
    await assert.rejects(run({ action: "add", file: await workspace.saveInbox("again.webp", WEBP_GREEN), name: "又一只", rarity: 3 }), /已经在卡池里了（绿猪）/);
  });

  it("says what's missing until every rarity has a card", async () => {
    const { store, workspace, run } = setup();
    assert.equal(await run({ action: "list" }), "猪猪池是空的。");
    await run({ action: "add", file: await workspace.saveInbox("a.png", await picture()), name: "猪", rarity: 3 });
    assert.match(poolProblem(readPool(store))!, /^猪猪池还没开：现在五星 0 张、四星 0 张、三星 1 张，每种至少要有一张。/);
  });

  it("turns away what isn't a usable picture", async () => {
    const { store, workspace, run } = setup();
    await assert.rejects(run({ action: "add", file: await workspace.saveInbox("a.txt", Buffer.from("not a picture")), name: "猪", rarity: 3 }), /只能用 png、jpg、gif 或 webp/);
    await assert.rejects(run({ action: "add", file: await workspace.saveInbox("a.webp", WEBP_BROKEN), name: "猪", rarity: 3 }), /读不出来/);
    await assert.rejects(run({ action: "add", file: await workspace.saveInbox("b.webp", WEBP_ANIMATED), name: "猪", rarity: 3 }), /会动的 WebP 用不了/);
    const broken = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("broken")]);
    await assert.rejects(run({ action: "add", file: await workspace.saveInbox("b.png", broken), name: "猪", rarity: 3 }), /读不出来/);
    await assert.rejects(run({ action: "add", file: await workspace.saveInbox("big.png", Buffer.alloc(10 * 1024 * 1024 + 1)), name: "猪", rarity: 3 }), /10 MB/);
    await assert.rejects(run({ action: "add", file: "inbox/none.png", name: "猪", rarity: 3 }), /工作区里没有/);
    await assert.rejects(run({ action: "add", file: "../../secret.png", name: "猪", rarity: 3 }), /不在工作区内/);
    await assert.rejects(run({ action: "add", file: "inbox/a.png", name: "猪", rarity: 6 }), /参数不对/);
    await assert.rejects(run({ action: "add", name: "猪", rarity: 3 }), /要有图片、名字和几星/);
    await assert.rejects(run({ action: "add", file: "inbox/a.png", name: "这个名字实在是太长太长了啊", rarity: 3 }), /参数不对/);
    assert.deepEqual(readPool(store), []);
  });

  it("keeps names unique", async () => {
    const { workspace, run } = setup();
    const file = await workspace.saveInbox("a.png", await picture());
    await run({ action: "add", file, name: "猪", rarity: 3 });
    await assert.rejects(run({ action: "add", file, name: "猪", rarity: 4 }), /已经有一张叫“猪”的卡了/);
  });

  it("won't take the same picture twice", async () => {
    const { workspace, run } = setup();
    await run({ action: "add", file: await workspace.saveInbox("a.png", await picture()), name: "猪", rarity: 3 });
    await assert.rejects(run({ action: "add", file: await workspace.saveInbox("b.png", await picture()), name: "又是猪", rarity: 4 }), /这张图已经在卡池里了（猪）/);
  });

  it("changes a card's rarity or name", async () => {
    const { store, workspace, run } = setup();
    await run({ action: "add", file: await workspace.saveInbox("a.png", await picture()), name: "猪", rarity: 3 });
    await run({ action: "add", file: await workspace.saveInbox("b.png", await picture(0x123456ff)), name: "大猪", rarity: 4 });
    assert.equal(await run({ action: "update", name: "猪", rarity: 5, newName: "猪降临" }), "改好了：五星「猪降临」。");
    await assert.rejects(run({ action: "update", name: "大猪", newName: "猪降临" }), /已经有一张叫“猪降临”的卡了/);
    await assert.rejects(run({ action: "update", name: "大猪" }), /要改几星或者改名字/);
    await assert.rejects(run({ action: "update", name: "没这张", rarity: 3 }), /卡池里没有叫“没这张”的卡/);
    assert.deepEqual(readPool(store).map((card) => [card.name, card.rarity]), [["猪降临", 5], ["大猪", 4]]);
  });

  it("removes a card and its copy of the picture", async () => {
    const { store, workspace, run } = setup();
    const sent = await workspace.saveInbox("a.png", await picture());
    await run({ action: "add", file: sent, name: "猪", rarity: 3 });
    assert.equal(await run({ action: "remove", name: "猪" }), "删掉了「猪」。");
    assert.deepEqual(readPool(store), []);
    assert.ok(!existsSync(await workspace.resolve("gacha/猪.png")));
    assert.ok(existsSync(await workspace.resolve(sent)), "the original stays");
  });

  it("only ever removes its own copies", async () => {
    const { workspace } = setup();
    const sent = await workspace.saveInbox("a.png", await picture());
    await assert.rejects(workspace.removeGacha(sent), /只能删除卡池里的图/);
    await assert.rejects(workspace.removeGacha("gacha/../inbox/a.png"), /不在工作区内|只能删除/);
    await assert.rejects(workspace.removeCandidate(sent), /只能删除候选图/);
    await assert.rejects(workspace.removeCandidate("candidates/../inbox/a.png"), /只能删除候选图/);
    assert.ok(existsSync(await workspace.resolve(sent)));
  });

  it("holds at most 80 cards", async () => {
    const { store, workspace, run } = setup();
    const file = await workspace.saveInbox("a.png", await picture());
    store.setSetting("gacha:pool", Array.from({ length: 80 }, (_, index) => ({ id: `c${index}`, name: `猪${index}`, rarity: 3, file: "gacha/x.png", mediaType: "image/png", addedAt: 0 })));
    await assert.rejects(run({ action: "add", file, name: "又一只猪", rarity: 3 }), /最多 80 张/);
  });

  describe("candidates from the groups", () => {
    const at = { channelId: "qq", conversationId: "g-test", at: 5 };

    it("turns counting on and off by the group's name", async () => {
      const { store, run } = setup();
      assert.match(await run({ action: "collect", group: "测试", on: true }), /^开始统计「测试」里的图/);
      assert.equal(collectsIn(store, "qq", "g-test"), true);
      assert.equal(collectsIn(store, "qq", "g-hsr"), false);
      await assert.rejects(run({ action: "collect", group: "星穹铁道", on: true }), /有好几个群名字里有“星穹铁道”/);
      await assert.rejects(run({ action: "collect", group: "不存在", on: true }), /没找到叫“不存在”的群。我知道的群：测试、/);
      assert.match(await run({ action: "collect", group: "总部群", on: true }), /崩坏：星穹铁道总部群/);
      await run({ action: "collect", group: "测试", on: false });
      assert.equal(collectsIn(store, "qq", "g-test"), false);
      assert.equal(collectsIn(store, "qq", "g-hsr"), true);
    });

    it("keeps a WebP candidate as PNG, and settles it by the fingerprint it was counted under", async () => {
      const { store, workspace, run } = setup();
      for (const senderId of ["a", "b"]) await collectSeen(store, workspace, { ...at, senderId }, seen(WEBP_GREEN));
      const [candidate] = store.candidates();
      assert.match(candidate?.file ?? "", /^candidates\/[0-9A-F]{32}\.png$/);
      assert.equal(sniffImage(await readFile(await workspace.resolve(candidate?.file ?? ""))), "image/png");
      await run({ action: "candidates" });
      await run({ action: "adopt", picks: [{ number: 1, name: "绿猪" }] });
      assert.equal(readPool(store)[0]?.fingerprint, seen(WEBP_GREEN).fingerprint);
      assert.deepEqual(store.candidates(), []);
      const fetches = { count: 0 };
      for (const senderId of ["c", "d"]) await collectSeen(store, workspace, { ...at, senderId }, seen(WEBP_GREEN, fetches));
      assert.equal(fetches.count, 0, "in the pool, so not kept again");
    });

    it("keeps a copy only once two different people have posted the picture", async () => {
      const { store, workspace } = setup();
      const data = await picture(0xff8899ff);
      const fetches = { count: 0 };
      assert.equal(await collectSeen(store, workspace, { ...at, senderId: "a" }, seen(data, fetches)), false);
      assert.equal(await collectSeen(store, workspace, { ...at, senderId: "a" }, seen(data, fetches)), false, "posted twice, but by one person");
      assert.equal(fetches.count, 0, "nothing fetched yet");
      assert.equal(await collectSeen(store, workspace, { ...at, senderId: "b" }, seen(data, fetches)), true);
      assert.equal(await collectSeen(store, workspace, { ...at, senderId: "c" }, seen(data, fetches)), false, "already kept");
      assert.equal(fetches.count, 1);
      const [candidate] = store.candidates();
      assert.deepEqual([candidate!.count, candidate!.senders], [4, 3]);
      assert.ok(candidate!.file!.startsWith("candidates/"));
    });

    it("doesn't keep what isn't a usable picture, or one already in the pool", async () => {
      const { store, workspace, run } = setup();
      const text = Buffer.from("not a picture");
      await collectSeen(store, workspace, { ...at, senderId: "a" }, seen(text));
      await assert.rejects(collectSeen(store, workspace, { ...at, senderId: "b" }, seen(text)), /只能用 png、jpg、gif 或 webp/);
      const pig = await picture(0x77aa77ff);
      await run({ action: "add", file: await workspace.saveInbox("p.png", pig), name: "绿猪", rarity: 3 });
      await collectSeen(store, workspace, { ...at, senderId: "a" }, seen(pig));
      assert.equal(await collectSeen(store, workspace, { ...at, senderId: "b" }, seen(pig)), false);
      assert.deepEqual(store.candidates(), []);
    });

    it("shows the candidates, most posted first, with rarity suggested by how rarely they turn up", async () => {
      const { store, workspace, run } = setup();
      const pictures = await Promise.all([0x111111ff, 0x222222ff, 0x333333ff].map((color) => picture(color)));
      // Posted 6, 2 and 4 times, each by two people.
      for (const [index, times] of [6, 2, 4].entries()) {
        for (let post = 0; post < times; post++) await collectSeen(store, workspace, { ...at, senderId: post % 2 ? "a" : "b" }, seen(pictures[index]!));
      }
      const sent: ChatImage[][] = [];
      const said = await run({ action: "candidates" }, { sendImages: async (images: ChatImage[]) => void sent.push(images) });
      assert.equal(said, "有 3 张候选，按发的次数排：\n#1：发过 6 次，2 个人，建议三星\n#2：发过 4 次，2 个人，建议四星\n#3：发过 2 次，2 个人，建议五星\n总览图已经发过去了。\n主人可以说“把 1、3 加进去，1 叫猪降临”，不说几星就按建议；不要的说“丢掉 2”。");
      assert.equal(sent.length, 1);
      assert.equal(sent[0]![0]!.alt, "猪猪候选");
      assert.equal(sent[0]![0]!.data.subarray(1, 4).toString("latin1"), "PNG");
    });

    it("adds picks at the suggested rarity unless told, and drops the rest when asked", async () => {
      const { store, workspace, run } = setup();
      const pictures = await Promise.all([0x111111ff, 0x222222ff, 0x333333ff].map((color) => picture(color)));
      for (const [index, times] of [6, 2, 4].entries()) {
        for (let post = 0; post < times; post++) await collectSeen(store, workspace, { ...at, senderId: post % 2 ? "a" : "b" }, seen(pictures[index]!));
      }
      await run({ action: "candidates" });
      const files = store.candidates().map((candidate) => candidate.file!);
      await assert.rejects(run({ action: "adopt", picks: [{ number: 3 }] }), /要给 #3 起个名字/);
      assert.deepEqual(readPool(store), []);
      assert.equal(await run({ action: "adopt", picks: [{ number: 3, name: "稀有猪" }, { number: 1, name: "常见猪", rarity: 4 }] }),"加好了：五星「稀有猪」、四星「常见猪」。现在五星 1 张、四星 1 张、三星 0 张。");
      assert.deepEqual(readPool(store).map((card) => [card.name, card.rarity]), [["稀有猪", 5], ["常见猪", 4]]);
      assert.equal(await run({ action: "dismiss", numbers: [2] }), "丢掉了 1 张候选，以后不会再出现。");
      assert.deepEqual(store.candidates(), []);
      for (const file of files) assert.ok(!existsSync(await workspace.resolve(file)), `${file} is gone`);
      // Posted again later, the one turned down isn't fetched again or offered again.
      const fetches = { count: 0 };
      await collectSeen(store, workspace, { ...at, senderId: "z" }, seen(pictures[2]!, fetches));
      await collectSeen(store, workspace, { ...at, senderId: "y" }, seen(pictures[2]!, fetches));
      assert.equal(fetches.count, 0);
      assert.equal(await run({ action: "candidates" }), "还没有候选。要先在群里开统计，有图被至少两个人发过才会出现。");
    });

    it("refuses numbers it didn't show", async () => {
      const { run } = setup();
      await assert.rejects(run({ action: "adopt", picks: [{ number: 1, name: "猪" }] }), /没有 #1 这张候选/);
      await assert.rejects(run({ action: "dismiss", numbers: [4] }), /没有 #4 这张候选/);
    });

    it("suggests rarity by place: the rarest tenth five-star, the next three tenths four-star, at least one each", () => {
      const tiers = (total: number) => Array.from({ length: total }, (_, rank) => rarityByFrequency(rank, total));
      assert.deepEqual(tiers(10), [3, 3, 3, 3, 3, 3, 4, 4, 4, 5]);
      assert.deepEqual(tiers(20), [...Array(12).fill(3), ...Array(6).fill(4), 5, 5]);
      assert.deepEqual(tiers(3), [3, 4, 5]);
      assert.deepEqual(tiers(2), [3, 5]);
      assert.deepEqual(tiers(1), [3]);
    });
  });

  it("makes a square picture for the card, once", async () => {
    const { store, workspace, run } = setup();
    await run({ action: "add", file: await workspace.saveInbox("a.gif", await picture(0x9966ffff, "image/gif")), name: "动图猪", rarity: 4 });
    const [card] = readPool(store);
    const first = await thumbnail(workspace, card!);
    const image = await Jimp.read(first);
    assert.deepEqual([image.width, image.height], [260, 260]);
    assert.equal(await thumbnail(workspace, card!), first);
  });
});
