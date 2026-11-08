// The gacha pool: pictures the owner chose, each with a name and a rarity. The list is kept in the
// bot's settings and the pictures in the workspace's gacha folder, copied from what the owner sent
// or from the candidates. Only the owner can change it, and only from their own private chat.
//
// Candidates come from groups where the owner asked for pictures to be counted: a picture posted
// there by at least two people is kept, and the less often a picture turns up, the rarer it's
// suggested to be. Pictures can also come from PigHub, ranked the same way by how much the site's
// visitors download them.
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Jimp } from "jimp";
import { z } from "zod";
import type { Pools, Rarity } from "./gacha.ts";
import { sniffImage } from "./images.ts";
import type { PighubPicture, PighubSource } from "./pighub.ts";
import { candidateSheetPng } from "./render.ts";
import { webpToPng } from "./webp.ts";
import type { Sighting, Store } from "./store.ts";
import type { LocalTool, ToolContext } from "./tools.ts";
import type { ChatImage, SeenImage, SettingsStore } from "./types.ts";
import type { Workspace } from "./workspace.ts";

export type PoolCard = {
  id: string;
  name: string;
  rarity: Rarity;
  // In the workspace, under gacha/.
  file: string;
  mediaType: "image/png" | "image/jpeg" | "image/gif";
  addedAt: number;
  // The picture's MD5, as QQ names it, so the same picture isn't offered again as a candidate.
  fingerprint?: string;
  // Where it came from when that wasn't the owner or a group, such as "pighub:1361".
  source?: string;
};

export type PoolStore = SettingsStore & Pick<Store, "candidates" | "settleSighting" | "recordSighting" | "setSightingFile">;

export type GroupChoice = { channelId: string; conversationId: string; title: string };

const POOL_KEY = "gacha:pool";
const COLLECT_KEY = "gacha:collect";
// The candidates as last shown to the owner, so the numbers they answer with mean the same pictures.
const SHOWN_KEY = "gacha:candidatesShown";
// Five-stars are also shown on their own, uploaded once each, and the platform keeps only 100.
const MAX_CARDS = 80;
const MAX_NAME_CHARS = 12;
// What QQ takes as a picture to keep.
const MAX_BYTES = 10 * 1024 * 1024;
const THUMBNAIL = 260;
// Posted this often by this many different people before a copy is kept.
export const CANDIDATE_MIN_POSTS = 2;
export const CANDIDATE_MIN_SENDERS = 2;
const MAX_SHOWN = 20;
// PigHub pictures as last shown to the owner, by the site's id.
const PIGHUB_SHOWN_KEY = "gacha:pighubShown";
// Each shown one is fetched to draw the preview, so fewer than the candidates.
const PIGHUB_SHOWN = 12;
// At most this many fetched to find them, when some can't be used.
const PIGHUB_TRIED = 36;
const PIGHUB_FILL = 50;
// Fetch failures in a row before an import gives up on the site.
const PIGHUB_GIVE_UP = 3;
const RARITY_NAMES: Record<Rarity, string> = { 5: "五星", 4: "四星", 3: "三星" };
const EXTENSIONS: Record<PoolCard["mediaType"], string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif" };

export function readPool(store: SettingsStore): PoolCard[] {
  return store.getSetting<PoolCard[]>(POOL_KEY) ?? [];
}

export function poolsOf(cards: PoolCard[]): Pools {
  const names = (rarity: Rarity) => cards.filter((card) => card.rarity === rarity).map((card) => card.name);
  return { 5: names(5), 4: names(4), 3: names(3) };
}

function counts(cards: PoolCard[]): string {
  const pools = poolsOf(cards);
  return ([5, 4, 3] as const).map((rarity) => `${RARITY_NAMES[rarity]} ${pools[rarity].length} 张`).join("、");
}

// Why the pool can't be pulled from yet, if it can't.
export function poolProblem(cards: PoolCard[]): string | null {
  const pools = poolsOf(cards);
  if (pools[5].length && pools[4].length && pools[3].length) return null;
  return `猪猪池还没开：现在${counts(cards)}，每种至少要有一张。主人在私聊里把图发给我，再说要加成几星、叫什么，就能加进去；也可以说“从 PigHub 导入一套”。`;
}

// A card name from a title: at most the length a name may be, and not one already taken.
export function fitName(title: string, taken: Set<string>): string {
  const characters = Array.from(title.replace(/\s+/g, " ").trim());
  const cut = (limit: number) => {
    let name = "";
    for (const character of characters) {
      if ((name + character).length > limit) break;
      name += character;
    }
    return name.trim() || "猪猪";
  };
  const whole = cut(MAX_NAME_CHARS);
  if (!taken.has(whole)) return whole;
  for (let copy = 2; ; copy++) {
    const name = `${cut(MAX_NAME_CHARS - String(copy).length)}${copy}`;
    if (!taken.has(name)) return name;
  }
}

const short = (text: string, limit: number) => {
  const characters = Array.from(text);
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : text;
};

function shuffled<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other] as T, copy[index] as T];
  }
  return copy;
}

// The more often a picture turns up, the commoner. Of the candidates ranked by postings, the
// rarest tenth are 5-star and the next three tenths 4-star, with at least one of each once there
// are enough to go round; the rest are 3-star.
export function rarityByFrequency(rank: number, total: number): Rarity {
  const fives = total >= 2 ? Math.max(1, Math.round(total * 0.1)) : 0;
  const fours = total >= 3 ? Math.max(1, Math.round(total * 0.3)) : 0;
  if (rank >= total - fives) return 5;
  if (rank >= total - fives - fours) return 4;
  return 3;
}

export function collectsIn(store: SettingsStore, channelId: string, conversationId: string): boolean {
  return (store.getSetting<string[]>(COLLECT_KEY) ?? []).includes(`${channelId}:${conversationId}`);
}

const thumbnails = new Map<string, Buffer>();

async function scaled(data: Buffer, side: number): Promise<Buffer> {
  const image = await Jimp.read(data);
  image.cover({ w: side, h: side });
  return Buffer.from(await image.getBuffer("image/png"));
}

// The picture scaled down to fill a card, as PNG. Kept, since a card is drawn again and again.
export async function thumbnail(workspace: Workspace, card: PoolCard): Promise<Buffer> {
  const key = `${card.id}:${card.file}`;
  const kept = thumbnails.get(key);
  if (kept) return kept;
  const data = await scaled(await readFile(await workspace.resolve(card.file)), THUMBNAIL);
  thumbnails.set(key, data);
  return data;
}

const fingerprintOf = (data: Buffer) => createHash("md5").update(data).digest("hex").toUpperCase();

// A picture as the pool keeps it. The fingerprint is of what came in, as QQ names it.
type Prepared = { data: Buffer; mediaType: PoolCard["mediaType"]; fingerprint: string };

// A picture made ready for the pool, or why the pool can't take it. A still WebP is kept as PNG,
// which QQ and the renderer take.
async function preparePicture(raw: Buffer, fingerprint = fingerprintOf(raw)): Promise<Prepared> {
  const tooBig = () => new Error("图片太大了，要 10 MB 以内。");
  if (raw.length > MAX_BYTES) throw tooBig();
  const kind = sniffImage(raw);
  const data = kind === "image/webp" ? await webpToPng(raw) : raw;
  if (data.length > MAX_BYTES) throw tooBig();
  const mediaType = kind === "image/webp" ? "image/png" : kind;
  if (mediaType !== "image/png" && mediaType !== "image/jpeg" && mediaType !== "image/gif") throw new Error("只能用 png、jpg、gif 或 webp 图片。");
  // Read once here, so a picture that can't be drawn is turned away now and not mid-pull.
  await Jimp.read(data).catch(() => {
    throw new Error("这张图读不出来，换一张。");
  });
  return { data, mediaType, fingerprint };
}

const fetching = new Set<string>();

// One posting of a picture in a group the owner is collecting from. Once enough people have posted
// it, a copy is kept as a candidate. Says whether this posting is the one that kept it.
export async function collectSeen(
  store: PoolStore,
  workspace: Workspace,
  where: { channelId: string; conversationId: string; senderId: string; at: number },
  image: SeenImage,
): Promise<boolean> {
  const sighting = store.recordSighting(where.channelId, where.conversationId, image.fingerprint, where.senderId, where.at);
  if (sighting.file || sighting.settled || sighting.count < CANDIDATE_MIN_POSTS || sighting.senders < CANDIDATE_MIN_SENDERS) return false;
  if (readPool(store).some((card) => card.fingerprint === image.fingerprint) || fetching.has(image.fingerprint)) return false;
  fetching.add(image.fingerprint);
  try {
    const picture = await preparePicture(await image.fetch());
    const file = await workspace.saveCandidate(image.fingerprint, EXTENSIONS[picture.mediaType], picture.data);
    store.setSightingFile(where.channelId, where.conversationId, image.fingerprint, file);
    return true;
  } finally {
    fetching.delete(image.fingerprint);
  }
}

// A sheet of the candidates, numbered, with how often each was posted and what it's suggested as.
async function candidateSheet(workspace: Workspace, shown: Sighting[]): Promise<ChatImage> {
  const entries = await Promise.all(
    shown.map(async (sighting, index) => ({
      label: `#${index + 1}`,
      caption: `${sighting.count} 次 · ${sighting.senders} 人 · ${RARITY_NAMES[rarityByFrequency(index, shown.length)]}`,
      picture: await scaled(await readFile(await workspace.resolve(sighting.file as string)), 150).catch(() => undefined),
    })),
  );
  return candidateSheetPng("猪猪候选", entries);
}

const pickInput = z.object({ number: z.number().int().min(1), name: z.string().trim().min(1).max(MAX_NAME_CHARS).optional(), rarity: z.union([z.literal(3), z.literal(4), z.literal(5)]).optional() });

const ACTIONS = ["add", "update", "remove", "list", "collect", "candidates", "adopt", "dismiss", "pighub", "pighub_add", "pighub_fill"] as const;

const manageInput = z.object({
  action: z.enum(ACTIONS),
  file: z.string().trim().min(1).max(300).optional(),
  name: z.string().trim().min(1).max(MAX_NAME_CHARS).optional(),
  rarity: z.union([z.literal(3), z.literal(4), z.literal(5)]).optional(),
  newName: z.string().trim().min(1).max(MAX_NAME_CHARS).optional(),
  group: z.string().trim().min(1).max(60).optional(),
  on: z.boolean().optional(),
  picks: z.array(pickInput).min(1).max(MAX_SHOWN).optional(),
  numbers: z.array(z.number().int().min(1)).min(1).max(MAX_SHOWN).optional(),
  keyword: z.string().trim().min(1).max(30).optional(),
  order: z.enum(["common", "rare", "random"]).optional(),
  count: z.number().int().min(1).max(MAX_CARDS).optional(),
});

export function poolTool(
  store: PoolStore,
  workspace: Workspace,
  options: { now?: () => number; random?: () => number; groups?: () => GroupChoice[]; pighub?: PighubSource } = {},
): LocalTool {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const save = (cards: PoolCard[]) => store.setSetting(POOL_KEY, cards);
  const fromPighub = (picture: PighubPicture) => `pighub:${picture.id}`;
  const site = () => {
    if (!options.pighub) throw new Error("这里用不了 PigHub。");
    return options.pighub;
  };
  // PigHub pictures fetched once and found to be something the pool can't take, such as an
  // animated WebP: not fetched or offered again while the bot runs.
  const unusable = new Set<number>();
  const prepareFromPighub = (picture: PighubPicture, data: Buffer) =>
    preparePicture(data).catch((error: unknown) => {
      unusable.add(picture.id);
      throw error;
    });
  const usable = (picture: PighubPicture, data: Buffer) => prepareFromPighub(picture, data).catch(() => undefined);

  // A picture now in the pool may be waiting as a candidate too: it's no longer one.
  async function settle(added: PoolCard[]) {
    const open = store.candidates();
    for (const card of added) {
      if (!card.fingerprint) continue;
      const candidate = open.find((sighting) => sighting.fingerprint === card.fingerprint);
      store.settleSighting(card.fingerprint);
      if (candidate?.file) await workspace.removeCandidate(candidate.file);
    }
  }
  const find = (cards: PoolCard[], name: string | undefined) => {
    const card = name ? cards.find((entry) => entry.name === name) : undefined;
    if (!card) throw new Error(`卡池里没有叫“${name ?? ""}”的卡。`);
    return card;
  };

  // Copies a picture into the pool. The caller has checked the name is free and there's room.
  async function addCard(cards: PoolCard[], name: string, rarity: Rarity, picture: Prepared): Promise<PoolCard> {
    const { data, mediaType, fingerprint } = picture;
    if (cards.some((card) => card.fingerprint === fingerprint)) throw new Error(`这张图已经在卡池里了（${cards.find((card) => card.fingerprint === fingerprint)?.name}）。`);
    return { id: randomUUID(), name, rarity, file: await workspace.saveGacha(name, EXTENSIONS[mediaType], data), mediaType, addedAt: now(), fingerprint };
  }

  function chooseGroup(title: string): GroupChoice {
    const groups = options.groups?.() ?? [];
    const exact = groups.filter((group) => group.title === title);
    const near = exact.length ? exact : groups.filter((group) => group.title.includes(title));
    if (near.length === 1) return near[0] as GroupChoice;
    if (!near.length) throw new Error(`没找到叫“${title}”的群。我知道的群：${groups.map((group) => group.title).join("、") || "（还没有）"}。`);
    throw new Error(`有好几个群名字里有“${title}”：${near.map((group) => group.title).join("、")}，说完整一点。`);
  }

  // The candidates as numbered last time, keeping their numbers: one settled since is a gap.
  function shownCandidates(): Array<Sighting | undefined> {
    const order = store.getSetting<string[]>(SHOWN_KEY) ?? [];
    const open = new Map(store.candidates().map((sighting) => [sighting.fingerprint, sighting]));
    return order.map((fingerprint) => open.get(fingerprint));
  }

  async function run(input: unknown, context: ToolContext): Promise<string> {
    const parsed = manageInput.safeParse(input ?? {});
    if (!parsed.success) throw new Error(`参数不对：${parsed.error.issues[0]?.message ?? "格式错误"}`);
    const { action, file, name, rarity, newName, group, on, picks, numbers, keyword, order, count } = parsed.data;
    const cards = readPool(store);

    if (action === "list") {
      if (!cards.length) return "猪猪池是空的。";
      const lines = ([5, 4, 3] as const).map((level) => `${RARITY_NAMES[level]}：${cards.filter((card) => card.rarity === level).map((card) => card.name).join("、") || "（没有）"}`);
      return [`猪猪池一共 ${cards.length} 张（${counts(cards)}）：`, ...lines, poolProblem(cards) ?? "可以抽了。"].join("\n");
    }

    if (action === "add") {
      if (!file || !name || !rarity) throw new Error("加卡要有图片、名字和几星。");
      if (cards.length >= MAX_CARDS) throw new Error(`卡池最多 ${MAX_CARDS} 张，先删掉一些。`);
      if (cards.some((card) => card.name === name)) throw new Error(`已经有一张叫“${name}”的卡了，换个名字，或者用 update 改它。`);
      const data = await readFile(await workspace.resolve(file)).catch(() => {
        throw new Error(`工作区里没有 ${file}。`);
      });
      const card = await addCard(cards, name, rarity, await preparePicture(data));
      save([...cards, card]);
      await settle([card]);
      return `加好了：${RARITY_NAMES[rarity]}「${name}」。现在${counts([...cards, card])}。${poolProblem([...cards, card]) ? "" : "可以抽了。"}`;
    }

    if (action === "collect") {
      if (!group || on === undefined) throw new Error("要说哪个群，开还是关。");
      const chosen = chooseGroup(group);
      const key = `${chosen.channelId}:${chosen.conversationId}`;
      const current = store.getSetting<string[]>(COLLECT_KEY) ?? [];
      store.setSetting(COLLECT_KEY, on ? [...new Set([...current, key])] : current.filter((entry) => entry !== key));
      return on
        ? `开始统计「${chosen.title}」里的图：被至少 ${CANDIDATE_MIN_SENDERS} 个人发过的图会存一份当候选，说“看看猪猪候选”就能看到。`
        : `不再统计「${chosen.title}」里的图了，已经存下的候选还在。`;
    }

    if (action === "candidates") {
      const open = store.candidates().filter((sighting) => !cards.some((card) => card.fingerprint === sighting.fingerprint));
      const shown = open.slice(0, MAX_SHOWN);
      store.setSetting(SHOWN_KEY, shown.map((sighting) => sighting.fingerprint));
      if (!shown.length) return "还没有候选。要先在群里开统计，有图被至少两个人发过才会出现。";
      let sent = false;
      if (context.sendImages) {
        try {
          await context.sendImages([await candidateSheet(workspace, shown)]);
          sent = true;
        } catch {
          sent = false;
        }
      }
      const lines = shown.map((sighting, index) => `#${index + 1}：发过 ${sighting.count} 次，${sighting.senders} 个人，建议${RARITY_NAMES[rarityByFrequency(index, shown.length)]}`);
      return [
        `有 ${open.length} 张候选${open.length > shown.length ? `，先看最常见的 ${shown.length} 张` : ""}，按发的次数排：`,
        ...lines,
        sent ? "总览图已经发过去了。" : "",
        "主人可以说“把 1、3 加进去，1 叫猪降临”，不说几星就按建议；不要的说“丢掉 2”。",
      ]
        .filter(Boolean)
        .join("\n");
    }

    if (action === "adopt") {
      if (!picks) throw new Error("要说加哪几张、各叫什么。");
      const shown = shownCandidates();
      const added: PoolCard[] = [];
      for (const pick of picks) {
        const sighting = shown[pick.number - 1];
        if (!sighting?.file) throw new Error(`没有 #${pick.number} 这张候选，先说“看看猪猪候选”。`);
        if (!pick.name) throw new Error(`要给 #${pick.number} 起个名字。`);
        const pool = [...cards, ...added];
        if (pool.length >= MAX_CARDS) throw new Error(`卡池最多 ${MAX_CARDS} 张，先删掉一些。`);
        if (pool.some((card) => card.name === pick.name)) throw new Error(`已经有一张叫“${pick.name}”的卡了。`);
        const level = pick.rarity ?? rarityByFrequency(pick.number - 1, shown.length);
        // Kept by the fingerprint it was counted under, which a WebP kept as PNG no longer has.
        added.push(await addCard(pool, pick.name, level, await preparePicture(await readFile(await workspace.resolve(sighting.file)), sighting.fingerprint)));
      }
      save([...cards, ...added]);
      await settle(added);
      const all = [...cards, ...added];
      return `加好了：${added.map((card) => `${RARITY_NAMES[card.rarity]}「${card.name}」`).join("、")}。现在${counts(all)}。${poolProblem(all) ? "" : "可以抽了。"}`;
    }

    if (action === "dismiss") {
      if (!numbers) throw new Error("要说丢掉哪几张。");
      const shown = shownCandidates();
      const dropped = numbers.map((number) => {
        const sighting = shown[number - 1];
        if (!sighting) throw new Error(`没有 #${number} 这张候选，先说“看看猪猪候选”。`);
        return sighting;
      });
      for (const sighting of dropped) {
        store.settleSighting(sighting.fingerprint);
        if (sighting.file) await workspace.removeCandidate(sighting.file);
      }
      return `丢掉了 ${dropped.length} 张候选，以后不会再出现。`;
    }

    if (action === "pighub") {
      const all = await site().list(context.signal);
      const rankOf = new Map(all.map((picture, rank) => [picture.id, rank]));
      const suggested = (picture: PighubPicture) => rarityByFrequency(rankOf.get(picture.id) as number, all.length);
      const needle = keyword?.toLowerCase();
      const open = all.filter(
        (picture) => !unusable.has(picture.id) && !cards.some((card) => card.source === fromPighub(picture)) && (!needle || picture.title.toLowerCase().includes(needle)),
      );
      if (!open.length) return keyword ? `PigHub 上没有名字里带“${keyword}”的猪猪图（已经在卡池里的不算）。` : "PigHub 上能用的图都已经在卡池里了。";
      const sorted = (order ?? (keyword ? "common" : "random")) === "random" ? shuffled(open, random) : order === "rare" ? [...open].reverse() : open;
      let shown = sorted.slice(0, PIGHUB_SHOWN);
      let sent = false;
      if (context.sendImages) {
        // Drawing the preview fetches each picture anyway, so the ones the pool can't take are
        // left out here and the next ones shown instead.
        shown = [];
        const previews: Array<Buffer | undefined> = [];
        let failedInARow = 0;
        for (const picture of sorted.slice(0, PIGHUB_TRIED)) {
          if (shown.length >= PIGHUB_SHOWN || context.signal?.aborted) break;
          let data: Buffer;
          try {
            data = await site().picture(picture, context.signal);
            failedInARow = 0;
          } catch {
            if (++failedInARow >= PIGHUB_GIVE_UP) break;
            continue;
          }
          const prepared = await usable(picture, data);
          if (!prepared) continue;
          shown.push(picture);
          previews.push(await scaled(prepared.data, 150).catch(() => undefined));
        }
        if (shown.length) {
          try {
            const entries = shown.map((picture, index) => {
              const preview = previews[index];
              return { label: `#${index + 1}`, caption: `${short(picture.title, 6)} · ${RARITY_NAMES[suggested(picture)]}`, ...(preview ? { picture: preview } : {}) };
            });
            await context.sendImages([await candidateSheetPng("PigHub 猪猪", entries)]);
            sent = true;
          } catch {
            sent = false;
          }
        }
      }
      store.setSetting(PIGHUB_SHOWN_KEY, shown.map((picture) => picture.id));
      if (!shown.length) return `PigHub 上${keyword ? `名字里带“${keyword}”的` : ""}有 ${open.length} 张，但试过的几张都下载不了，或者格式卡池用不了。`;
      const lines = shown.map((picture, index) => `#${index + 1}「${picture.title}」：${picture.views} 次浏览，${picture.downloads} 次下载，建议${RARITY_NAMES[suggested(picture)]}`);
      return [
        `PigHub 上${keyword ? `名字里带“${keyword}”的` : "还没进卡池的"}有 ${open.length} 张${open.length > shown.length ? `，这里是其中 ${shown.length} 张` : ""}：`,
        ...lines,
        sent ? "预览图已经发过去了。" : "",
        "主人可以说“把 1、3 加进去”，不说名字就用网站上的名字，不说几星就按建议。建议的稀有度看的是网站上看到这张图的人里有多少下载了：用得越少越稀有，最少的一成是五星，接下来三成是四星。",
      ]
        .filter(Boolean)
        .join("\n");
    }

    if (action === "pighub_add") {
      if (!picks) throw new Error("要说加哪几张。");
      const ids = store.getSetting<number[]>(PIGHUB_SHOWN_KEY) ?? [];
      const all = await site().list(context.signal);
      const added: PoolCard[] = [];
      const problems: string[] = [];
      for (const pick of picks) {
        const id = ids[pick.number - 1];
        const rank = all.findIndex((picture) => picture.id === id);
        const picture = all[rank];
        const pool = [...cards, ...added];
        if (!picture) {
          problems.push(`没有 #${pick.number} 这张，先让我在 PigHub 找一下`);
          continue;
        }
        if (pool.length >= MAX_CARDS) {
          problems.push(`卡池满了（最多 ${MAX_CARDS} 张），#${pick.number} 没加`);
          break;
        }
        if (pool.some((card) => card.source === fromPighub(picture))) {
          problems.push(`#${pick.number} 已经在卡池里了`);
          continue;
        }
        if (pick.name && pool.some((card) => card.name === pick.name)) {
          problems.push(`已经有一张叫“${pick.name}”的卡了，#${pick.number} 没加`);
          continue;
        }
        try {
          const prepared = await prepareFromPighub(picture, await site().picture(picture, context.signal));
          const level = pick.rarity ?? rarityByFrequency(rank, all.length);
          const card = await addCard(pool, pick.name ?? fitName(picture.title, new Set(pool.map((entry) => entry.name))), level, prepared);
          added.push({ ...card, source: fromPighub(picture) });
          save([...cards, ...added]);
        } catch (error) {
          if (context.signal?.aborted) break;
          problems.push(`#${pick.number} 没加上：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await settle(added);
      const after = [...cards, ...added];
      return [
        added.length ? `加好了：${added.map((card) => `${RARITY_NAMES[card.rarity]}「${card.name}」`).join("、")}。` : "一张都没加上。",
        ...problems.map((problem) => problem.replace(/[。.]?$/, "。")),
        `现在${counts(after)}。${poolProblem(after) ? "" : "可以抽了。"}`,
      ].join("\n");
    }

    if (action === "pighub_fill") {
      const room = MAX_CARDS - cards.length;
      if (room <= 0) throw new Error(`卡池已经满了（最多 ${MAX_CARDS} 张），先删掉一些。`);
      const wanted = Math.min(count ?? PIGHUB_FILL, room);
      const all = await site().list(context.signal);
      const tiers: Record<Rarity, PighubPicture[]> = { 5: [], 4: [], 3: [] };
      all.forEach((picture, rank) => {
        if (!unusable.has(picture.id) && !cards.some((card) => card.source === fromPighub(picture))) tiers[rarityByFrequency(rank, all.length)].push(picture);
      });
      // The same split as within the site: the rarest tenth five-star, the next three tenths four-star.
      const quota: Record<Rarity, number> = { 5: 0, 4: 0, 3: 0 };
      for (let index = 0; index < wanted; index++) quota[rarityByFrequency(index, wanted)]++;
      const added: PoolCard[] = [];
      let skipped = 0;
      let failedInARow = 0;
      let unreachable: string | undefined;
      fill: for (const level of [5, 4, 3] as const) {
        const queue = shuffled(tiers[level], random);
        let got = 0;
        while (got < quota[level] && queue.length) {
          if (context.signal?.aborted) break fill;
          const picture = queue.shift() as PighubPicture;
          const pool = [...cards, ...added];
          let data: Buffer;
          try {
            data = await site().picture(picture, context.signal);
            failedInARow = 0;
          } catch (error) {
            if (context.signal?.aborted) break fill;
            skipped++;
            if (++failedInARow >= PIGHUB_GIVE_UP) {
              unreachable = error instanceof Error ? error.message : String(error);
              break fill;
            }
            continue;
          }
          // Too big or a kind the pool can't take: the next one instead.
          const prepared = await usable(picture, data);
          if (!prepared) {
            skipped++;
            continue;
          }
          try {
            const card = await addCard(pool, fitName(picture.title, new Set(pool.map((entry) => entry.name))), level, prepared);
            added.push({ ...card, source: fromPighub(picture) });
            save([...cards, ...added]);
            got++;
          } catch {
            // Already in the pool from somewhere else.
            skipped++;
          }
        }
      }
      await settle(added);
      const after = [...cards, ...added];
      const named = (level: Rarity) => added.filter((card) => card.rarity === level).map((card) => `「${card.name}」`).join("、");
      return [
        added.length ? `从 PigHub 加了 ${added.length} 张：${counts(added)}。` : "一张都没加上。",
        named(5) ? `五星是${named(5)}。` : "",
        skipped ? `有 ${skipped} 张下载不了或者用不了，跳过了。` : "",
        unreachable ? `后来 PigHub 连续出错，先停在这里：${unreachable}` : "",
        context.signal?.aborted ? "中途停下了，已经加进去的留着。" : "",
        `卡池现在一共 ${after.length} 张（${counts(after)}）。${poolProblem(after) ? "" : "可以抽了。"}`,
        "稀有度看的是 PigHub 上看到这张图的人里有多少下载了，用得越少越稀有。想换掉哪张可以删掉，或者改几星。",
      ]
        .filter(Boolean)
        .join("\n");
    }

    const card = find(cards, name);
    if (action === "remove") {
      save(cards.filter((entry) => entry.id !== card.id));
      await workspace.removeGacha(card.file);
      return `删掉了「${card.name}」。`;
    }

    if (!rarity && !newName) throw new Error("要改几星或者改名字。");
    if (newName && newName !== card.name && cards.some((entry) => entry.name === newName)) throw new Error(`已经有一张叫“${newName}”的卡了。`);
    const changed = { ...card, ...(rarity ? { rarity } : {}), ...(newName ? { name: newName } : {}) };
    save(cards.map((entry) => (entry.id === card.id ? changed : entry)));
    return `改好了：${RARITY_NAMES[changed.rarity]}「${changed.name}」。`;
  }

  return {
    name: "manage_gacha_pool",
    description:
      'The owner\'s control of the gacha pool (the pig pictures the group pulls). action "add" with file (a picture the owner sent, by its workspace path such as inbox/xx.jpg), name (up to 12 characters, unique) and rarity (5, 4 or 3); "update" with name and a new rarity or newName; "remove" with name; "list". Candidates come from groups where pictures are counted: "collect" with group (its name) and on true/false starts or stops counting there; "candidates" shows the ones posted by 2+ people, numbered, most posted first, with a suggested rarity (rarer the less it\'s posted); "adopt" with picks [{number, name, rarity?}] adds them, at the suggested rarity unless given; "dismiss" with numbers drops them. PigHub (pighub.top, a site of pig pictures) is another source, ranked by how few of its visitors download each picture (rarer the less it\'s used): "pighub_fill" with count (default 50, up to what the pool has room for) imports a whole set at once, a tenth five-star and three tenths four-star; "pighub" with keyword (matched in the title) and order ("common", "rare" or "random") shows up to 12 of its pictures, numbered, with a preview sent to the owner; "pighub_add" with picks [{number, name?, rarity?}] adds shown ones, keeping the site\'s title and the suggested rarity unless given. A fill takes a minute or two.',
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...ACTIONS] },
        file: { type: "string", description: "For add: the picture's path in the workspace." },
        name: { type: "string", maxLength: MAX_NAME_CHARS, description: "The card's name." },
        rarity: { type: "integer", enum: [3, 4, 5] },
        newName: { type: "string", maxLength: MAX_NAME_CHARS, description: "For update: a new name." },
        group: { type: "string", description: "For collect: the group's name." },
        on: { type: "boolean", description: "For collect." },
        picks: {
          type: "array",
          items: { type: "object", properties: { number: { type: "integer" }, name: { type: "string" }, rarity: { type: "integer", enum: [3, 4, 5] } }, required: ["number"], additionalProperties: false },
          description: "For adopt (name required) and pighub_add (name optional).",
        },
        numbers: { type: "array", items: { type: "integer" }, description: "For dismiss." },
        keyword: { type: "string", description: "For pighub: a word in the picture's title." },
        order: { type: "string", enum: ["common", "rare", "random"], description: "For pighub: most used first, least used first, or mixed. Mixed unless a keyword is given." },
        count: { type: "integer", minimum: 1, maximum: MAX_CARDS, description: "For pighub_fill: how many to import." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    minTier: "owner",
    run,
  };
}
