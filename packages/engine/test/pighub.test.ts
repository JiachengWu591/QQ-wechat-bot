import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseList, Pighub, PIGHUB_ORIGIN, type PighubPicture, type PighubSource } from "../src/pighub.ts";
import { fitName, poolTool, readPool } from "../src/pool.ts";
import { Store } from "../src/store.ts";
import type { ChatImage } from "../src/types.ts";
import { Workspace } from "../src/workspace.ts";
import { picture, WEBP_ANIMATED, WEBP_GREEN } from "./helpers.ts";

const entry = (id: number, title: string, views: number, downloads: number, filename = `${title}.jpg`) => ({
  id,
  title,
  filename,
  mtime: 1,
  view_count: views,
  download_count: downloads,
  image_url: `/images/${filename}`,
});

describe("PigHub's list", () => {
  it("ranks pictures by the share of viewers who took them, not by downloads alone", () => {
    const list = parseList({
      code: 0,
      message: "OK",
      data: [entry(1, "老猪", 100_000, 1_000), entry(2, "新猪", 2_000, 100), entry(3, "冷门猪", 50_000, 20)],
    });
    assert.deepEqual(
      list.map((picture) => picture.title),
      ["新猪", "老猪", "冷门猪"],
    );
    assert.deepEqual(list[0], { id: 2, title: "新猪", filename: "新猪.jpg", views: 2_000, downloads: 100 });
  });

  it("leaves out anything that isn't a plain picture in its images folder", () => {
    const list = parseList({
      code: 0,
      data: [
        entry(1, "好猪", 100, 1),
        entry(2, "动图猪", 100, 1, "动图猪.gif"),
        entry(3, "png猪", 100, 1, "png猪.png"),
        entry(4, "webp猪", 100, 1, "webp猪.webp"),
        { ...entry(5, "别处猪", 100, 1), image_url: "https://elsewhere.example/a.jpg" },
        entry(6, "上级猪", 100, 1, "../上级猪.jpg"),
        entry(7, "斜杠猪", 100, 1, "a\\b.jpg"),
        entry(8, "隐藏猪", 100, 1, ".jpg"),
        { ...entry(9, "坏猪", 100, 1), view_count: "many" },
        "not an entry",
        entry(1, "重复猪", 100, 1),
      ],
    });
    assert.deepEqual(
      list.map((picture) => picture.id),
      [1, 2, 3],
    );
  });

  it("cleans titles, and falls back to the file name", () => {
    const list = parseList({ code: 0, data: [entry(1, "  猪\u202e猪\n ", 100, 1), entry(2, " ", 100, 0, "无名猪.png")] });
    assert.deepEqual(
      list.map((picture) => picture.title),
      ["猪猪", "无名猪"],
    );
  });

  it("turns down a list it doesn't understand", () => {
    assert.throws(() => parseList({ code: 1, data: [] }), /看不懂/);
    assert.throws(() => parseList({ data: "x" }), /看不懂/);
  });
});

type Call = { url: string; init: RequestInit | undefined };

function site(respond: (url: string) => Response | Promise<Response>, now = { at: 0 }) {
  const calls: Call[] = [];
  const pighub = new Pighub({
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return respond(String(url));
    }) as typeof fetch,
    now: () => now.at,
  });
  return { pighub, calls, now };
}

const listBody = (...entries: unknown[]) => new Response(JSON.stringify({ code: 0, message: "OK", data: entries }));

describe("fetching from PigHub", () => {
  it("fetches the list once an hour, with plain GETs that never follow a redirect away", async () => {
    const { pighub, calls, now } = site(() => listBody(entry(1, "猪", 100, 1)));
    assert.equal((await pighub.list()).length, 1);
    now.at = 59 * 60 * 1000;
    await pighub.list();
    assert.equal(calls.length, 1);
    now.at = 61 * 60 * 1000;
    await pighub.list();
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.url, `${PIGHUB_ORIGIN}/api/images?sort=2`);
      assert.equal(call.init?.method, undefined, "a GET, so its counters are left alone");
      assert.equal(call.init?.redirect, "error");
      assert.equal(call.init?.body, undefined);
    }
  });

  it("asks for a picture by its encoded name, and keeps the ones just fetched", async () => {
    const data = await picture();
    const { pighub, calls } = site(() => new Response(data));
    const pig: PighubPicture = { id: 7, title: "猪#1?", filename: "猪#1?.jpg", views: 1, downloads: 1 };
    assert.deepEqual(await pighub.picture(pig), data);
    assert.deepEqual(await pighub.picture(pig), data);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, `${PIGHUB_ORIGIN}/images/%E7%8C%AA%231%3F.jpg`);
  });

  it("refuses a picture over 10 MB, whether it says so up front or not", async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1);
    const said = site(() => new Response("x", { headers: { "content-length": String(big.length) } }));
    await assert.rejects(said.pighub.picture({ id: 1, title: "a", filename: "a.jpg", views: 1, downloads: 1 }), /10 MB/);
    const unsaid = site(() => new Response(new Blob([big]).stream()));
    await assert.rejects(unsaid.pighub.picture({ id: 1, title: "a", filename: "a.jpg", views: 1, downloads: 1 }), /10 MB/);
  });

  it("says what went wrong with the site", async () => {
    const down = site(() => new Response("nope", { status: 503 }));
    await assert.rejects(down.pighub.list(), /PigHub 出错了（HTTP 503）/);
    const gone = site(() => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(gone.pighub.list(), /连不上 PigHub：fetch failed/);
    const garbled = site(() => new Response("<html>"));
    await assert.rejects(garbled.pighub.list(), /看不懂/);
  });
});

describe("card names from titles", () => {
  it("fit the length a name may be, without splitting a character", () => {
    assert.equal(fitName("粉色小猪提醒您：您已过完本年所有法定假期", new Set()), "粉色小猪提醒您：您已过完");
    assert.equal(fitName("被捕捉的小🐖🐖🐖🐖", new Set()), "被捕捉的小🐖🐖🐖");
    assert.equal(fitName("被捕捉的小猪🐖🐖x🐖", new Set()), "被捕捉的小猪🐖🐖x");
    assert.equal(fitName("  a   b ", new Set()), "a b");
  });

  it("aren't taken twice", () => {
    assert.equal(fitName("猪画画", new Set(["猪画画"])), "猪画画2");
    assert.equal(fitName("猪画画", new Set(["猪画画", "猪画画2"])), "猪画画3");
    assert.equal(fitName("粉色小猪提醒您：您已过完本年", new Set(["粉色小猪提醒您：您已过完"])), "粉色小猪提醒您：您已过2");
  });
});

// Twenty pictures, the first the most used. Of twenty, the two least used are five-star and the
// six before them four-star.
async function fakeSite(count = 20, broken: Record<number, Error | Buffer> = {}) {
  const pictures: PighubPicture[] = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    title: `猪${index + 1}`,
    filename: `猪${index + 1}.png`,
    views: 1_000,
    downloads: (count - index) * 10,
  }));
  const data = new Map<number, Buffer>();
  for (const pig of pictures) data.set(pig.id, await picture((0x10000000 * ((pig.id % 15) + 1) + pig.id * 0x100 + 0xff) >>> 0));
  const fetched: number[] = [];
  const source: PighubSource & { fetched: number[]; lists: number } = {
    fetched,
    lists: 0,
    async list() {
      source.lists += 1;
      return pictures;
    },
    async picture(pig) {
      fetched.push(pig.id);
      const special = broken[pig.id];
      if (special instanceof Error) throw special;
      return special ?? (data.get(pig.id) as Buffer);
    },
  };
  return source;
}

function setup(pighub?: PighubSource, random = () => 0.5) {
  const store = new Store(":memory:");
  const workspace = new Workspace(join(tmpdir(), `shu-pighub-${randomUUID()}`));
  const tool = poolTool(store, workspace, { now: () => 1_000, random, ...(pighub ? { pighub } : {}) });
  const run = (input: unknown, context = {}) => tool.run(input, context) as Promise<string>;
  return { store, workspace, run };
}

const tierOf = (id: number) => (id >= 19 ? 5 : id >= 13 ? 4 : 3);
const idOf = (source: string | undefined) => Number(source?.replace("pighub:", ""));

describe("importing a set from PigHub", () => {
  it("fills the pool with a tenth five-star and three tenths four-star, by how little each is used", async () => {
    const source = await fakeSite();
    const { store, workspace, run } = setup(source);
    const answer = await run({ action: "pighub_fill", count: 10 });
    const cards = readPool(store);
    assert.equal(cards.length, 10);
    assert.deepEqual(
      [5, 4, 3].map((level) => cards.filter((card) => card.rarity === level).length),
      [1, 3, 6],
    );
    for (const card of cards) {
      assert.equal(card.rarity, tierOf(idOf(card.source)), `${card.name} is as rare as it is little used`);
      assert.equal(card.name, `猪${idOf(card.source)}`);
      assert.ok(existsSync(await workspace.resolve(card.file)));
    }
    assert.match(answer, /^从 PigHub 加了 10 张：五星 1 张、四星 3 张、三星 6 张。\n五星是「猪(19|20)」。\n卡池现在一共 10 张（五星 1 张、四星 3 张、三星 6 张）。可以抽了。/);
    assert.equal(source.fetched.length, 10, "only the pictures it adds are fetched");
  });

  it("fills 50 by default, but never past what the pool has room for", async () => {
    const source = await fakeSite(70);
    const { store, run } = setup(source);
    await run({ action: "pighub_fill" });
    assert.equal(readPool(store).length, 50);
    source.fetched.length = 0;
    await run({ action: "pighub_fill", count: 40 });
    assert.equal(readPool(store).length, 70, "everything the site has");
    assert.equal(source.fetched.length, 20, "what's already in the pool isn't fetched again");
    const ids = readPool(store).map((card) => card.source);
    assert.equal(new Set(ids).size, 70, "nothing added twice");
    await assert.rejects(run({ action: "pighub_fill", count: 81 }), /参数不对/);
  });

  it("stops at 80 cards", async () => {
    const source = await fakeSite(90);
    const { store, run } = setup(source);
    await run({ action: "pighub_fill", count: 75 });
    assert.match(await run({ action: "pighub_fill", count: 10 }), /^从 PigHub 加了 5 张/);
    assert.equal(readPool(store).length, 80);
    await assert.rejects(run({ action: "pighub_fill" }), /卡池已经满了（最多 80 张）/);
    await run({ action: "pighub", order: "common" });
    assert.match(await run({ action: "pighub_add", picks: [{ number: 1 }, { number: 2 }] }), /^一张都没加上。\n卡池满了（最多 80 张），#1 没加。\n现在/);
    assert.equal(readPool(store).length, 80);
  });

  it("skips a picture it can't fetch or read, or one already in the pool, and takes another of the same rarity", async () => {
    const source = await fakeSite(20, { 19: new Error("PigHub 出错了（HTTP 404）。"), 13: Buffer.from("not a picture") });
    const { store, workspace, run } = setup(source);
    // Already in the pool, sent by the owner.
    const copy = (await source.picture({ id: 14 } as PighubPicture)) as Buffer;
    source.fetched.length = 0;
    await run({ action: "add", file: await workspace.saveInbox("a.png", copy), name: "主人的猪", rarity: 3 });
    const answer = await run({ action: "pighub_fill", count: 10 });
    const cards = readPool(store).filter((card) => card.source);
    assert.deepEqual(
      [5, 4, 3].map((level) => cards.filter((card) => card.rarity === level).length),
      [1, 3, 6],
    );
    assert.ok(!cards.some((card) => [13, 14, 19].includes(idOf(card.source))));
    assert.match(answer, /有 3 张下载不了或者用不了，跳过了。/);
    assert.equal(await run({ action: "pighub", keyword: "猪13" }), "PigHub 上没有名字里带“猪13”的猪猪图（已经在卡池里的不算）。", "what it couldn't use isn't offered again");
  });

  it("gives up when the site keeps failing, keeping what it added", async () => {
    const failing = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [index + 1, new Error("连不上 PigHub：fetch failed")]));
    const source = await fakeSite(20, failing);
    const { store, run } = setup(source);
    const answer = await run({ action: "pighub_fill", count: 10 });
    // The five- and four-stars came first and worked; then three threes failed in a row.
    assert.equal(readPool(store).length, 4);
    assert.equal(source.fetched.length, 7);
    assert.match(answer, /后来 PigHub 连续出错，先停在这里：连不上 PigHub：fetch failed/);
  });

  it("stops when the owner cancels, keeping what it added", async () => {
    const source = await fakeSite();
    const controller = new AbortController();
    const picture = source.picture.bind(source);
    source.picture = async (pig, signal) => {
      if (source.fetched.length === 3) controller.abort();
      return picture(pig, signal);
    };
    const { store, run } = setup(source);
    const answer = await run({ action: "pighub_fill", count: 10 }, { signal: controller.signal });
    assert.equal(readPool(store).length, 4);
    assert.match(answer, /中途停下了，已经加进去的留着。/);
  });

  it("isn't there without the site", async () => {
    const { run } = setup();
    await assert.rejects(run({ action: "pighub_fill" }), /这里用不了 PigHub/);
    await assert.rejects(run({ action: "pighub" }), /这里用不了 PigHub/);
  });
});

describe("picking from PigHub", () => {
  it("shows matching pictures, numbered, with a preview, and adds the ones picked at their suggested rarity", async () => {
    const source = await fakeSite();
    const { store, run } = setup(source);
    const sent: ChatImage[][] = [];
    const answer = await run({ action: "pighub", keyword: "猪1" }, { sendImages: async (images: ChatImage[]) => void sent.push(images) });
    // 猪1 and 猪10 to 猪19, most used first.
    assert.match(answer, /^PigHub 上名字里带“猪1”的有 11 张：\n#1「猪1」：1000 次浏览，200 次下载，建议三星\n#2「猪10」/);
    assert.match(answer, /#11「猪19」：1000 次浏览，20 次下载，建议五星/);
    assert.match(answer, /预览图已经发过去了。/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.[0]?.alt, "PigHub 猪猪");

    const added = await run({ action: "pighub_add", picks: [{ number: 11 }, { number: 2, name: "十号猪", rarity: 5 }] });
    assert.match(added, /^加好了：五星「猪19」、五星「十号猪」。\n现在五星 2 张、四星 0 张、三星 0 张。$/);
    assert.deepEqual(
      readPool(store).map((card) => [card.name, card.rarity, card.source]),
      [
        ["猪19", 5, "pighub:19"],
        ["十号猪", 5, "pighub:10"],
      ],
    );
  });

  it("leaves out what's already in the pool, and orders as asked", async () => {
    const source = await fakeSite();
    const { run } = setup(source);
    await run({ action: "pighub", keyword: "猪2" });
    await run({ action: "pighub_add", picks: [{ number: 1 }] });
    assert.match(await run({ action: "pighub_add", picks: [{ number: 1 }] }), /^一张都没加上。\n#1 已经在卡池里了。\n/);
    assert.match(await run({ action: "pighub", keyword: "猪2" }), /^PigHub 上名字里带“猪2”的有 1 张：\n#1「猪20」/);
    assert.match(await run({ action: "pighub", order: "rare" }), /^PigHub 上还没进卡池的有 19 张，这里是其中 12 张：\n#1「猪20」[^\n]*\n#2「猪19」/);
    assert.match(await run({ action: "pighub", order: "common" }), /\n#1「猪1」[^\n]*\n#2「猪3」/);
    assert.equal(await run({ action: "pighub", keyword: "牛" }), "PigHub 上没有名字里带“牛”的猪猪图（已经在卡池里的不算）。");
  });

  it("previews only pictures the pool can take, and doesn't fetch or offer the others again", async () => {
    // As PigHub serves many of its .jpg files: really WebP, which is fine unless it's animated.
    const source = await fakeSite(20, { 1: WEBP_ANIMATED, 2: WEBP_GREEN, 3: new Error("PigHub 出错了（HTTP 404）。") });
    const { store, run } = setup(source);
    const answer = await run({ action: "pighub", order: "common" }, { sendImages: async () => {} });
    assert.match(answer, /^PigHub 上还没进卡池的有 20 张，这里是其中 12 张：\n#1「猪2」[^\n]*\n#2「猪4」/);
    assert.match(answer, /#12「猪14」/);
    await run({ action: "pighub_add", picks: [{ number: 1 }] });
    assert.deepEqual(
      readPool(store).map((card) => [card.name, card.mediaType, card.file]),
      [["猪2", "image/png", "gacha/猪2.png"]],
    );
    source.fetched.length = 0;
    // A failed fetch may work next time; a picture the pool can't take won't.
    assert.match(await run({ action: "pighub", order: "common" }), /^PigHub 上还没进卡池的有 18 张，这里是其中 12 张：\n#1「猪3」[^\n]*\n#2「猪4」/);
    assert.equal(source.fetched.length, 0, "nothing is fetched without a preview to draw");
    await run({ action: "pighub_fill", count: 19 });
    assert.ok(!source.fetched.includes(1));
  });

  it("remembers a picked picture the pool can't take", async () => {
    const source = await fakeSite(20, { 1: Buffer.from("not a picture") });
    const { run } = setup(source);
    await run({ action: "pighub", order: "common" });
    assert.match(await run({ action: "pighub_add", picks: [{ number: 1 }] }), /#1 没加上：只能用 png、jpg、gif 或 webp 图片。/);
    assert.match(await run({ action: "pighub", order: "common" }), /有 19 张，这里是其中 12 张：\n#1「猪2」/);
  });

  it("says so when none of the pictures it tried can be used", async () => {
    const source = await fakeSite(3, { 1: Buffer.from("x"), 2: new Error("PigHub 出错了（HTTP 404）。"), 3: Buffer.from("y") });
    const { run } = setup(source);
    assert.equal(await run({ action: "pighub" }, { sendImages: async () => {} }), "PigHub 上有 3 张，但试过的几张都下载不了，或者格式卡池用不了。");
    assert.equal(await run({ action: "pighub_add", picks: [{ number: 1 }] }), "一张都没加上。\n没有 #1 这张，先让我在 PigHub 找一下。\n现在五星 0 张、四星 0 张、三星 0 张。");
  });

  it("says which picks it couldn't add, and adds the rest", async () => {
    const source = await fakeSite(20, { 3: new Error("PigHub 出错了（HTTP 404）。") });
    const { store, workspace, run } = setup(source);
    await run({ action: "add", file: await workspace.saveInbox("a.png", await picture(0x123456ff)), name: "猪2", rarity: 3 });
    await run({ action: "pighub", order: "common" });
    const answer = await run({ action: "pighub_add", picks: [{ number: 1, name: "猪2" }, { number: 2 }, { number: 3 }, { number: 13 }] });
    assert.equal(
      answer,
      ["加好了：三星「猪22」。", "已经有一张叫“猪2”的卡了，#1 没加。", "#3 没加上：PigHub 出错了（HTTP 404）。", "没有 #13 这张，先让我在 PigHub 找一下。", "现在五星 0 张、四星 0 张、三星 2 张。"].join("\n"),
    );
    assert.deepEqual(
      readPool(store).map((card) => [card.name, card.source]),
      [
        ["猪2", undefined],
        ["猪22", "pighub:2"],
      ],
    );
  });
});
