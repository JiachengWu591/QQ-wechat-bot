// Things a group can do with the bot, open to everyone. None of them touch the computer: they draw
// random numbers and keep a little state per chat in the bot's own settings. Whoever a tool acts
// for comes from the message being answered, never from the model, so nobody can vote, pull or
// take a nickname in someone else's name.
import { randomInt } from "node:crypto";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { freshState, POOL_RULES, pull, type GachaItem, type GachaState } from "./gacha.ts";
import { poolProblem, poolsOf, readPool, thumbnail, type PoolCard } from "./pool.ts";
import { diceGif, gachaPng } from "./render.ts";
import type { LocalTool, ToolCaller, ToolContext } from "./tools.ts";
import type { ChatImage, SettingsStore } from "./types.ts";
import type { Workspace } from "./workspace.ts";

// Pictures are only drawn where they can be shown. The words a tool returns stand on their own if
// they can't be, and the failure is in the activity log.
async function tryToShow(context: ToolContext, draw: () => Promise<ChatImage[]>, caption?: string): Promise<boolean> {
  if (!context.sendImages) return false;
  try {
    await context.sendImages(await draw(), caption);
    return true;
  } catch {
    return false;
  }
}

async function tryCard(context: ToolContext, markdown: string): Promise<boolean> {
  if (!context.sendCard) return false;
  try {
    await context.sendCard(markdown);
    return true;
  } catch {
    return false;
  }
}

// Text that people typed, made safe to drop into Markdown.
const plain = (text: string) => text.replace(/[*_#>[\]~`|\\]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0xfee0));

const SHOWN = "（已经发到聊天里了，回复里接一两句话就好，不用再把结果列一遍。）";

const POLL_TTL_MS = 24 * 60 * 60_000;
const MAX_NICKNAME_CHARS = 12;
// A nickname is what the bot calls someone, so it mustn't read as a standing they don't have.
const RESERVED_NICKNAME = /主人|管理员|开发者|机器人|系统|owner|admin|system|bot/i;

// A die drawn rolling, for the common six-sided kind and a handful at a time.
const MAX_DRAWN_DICE = 6;

function callerOf(context: ToolContext): ToolCaller {
  if (!context.caller) throw new Error("不知道是谁在用这个工具。");
  return context.caller;
}

// Streamed tool input isn't checked by the API, so every tool checks its own.
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input ?? {});
  if (!result.success) throw new Error(`参数不对：${result.error.issues[0]?.message ?? "格式错误"}`);
  return result.data;
}

const chatKey = (prefix: string, caller: ToolCaller) => `${prefix}:${caller.channelId}:${caller.conversationId}`;

const diceInput = z.object({ dice: z.number().int().min(1).max(20).default(1), sides: z.number().int().min(2).max(1000).default(6) });

const pickInput = z
  .object({ options: z.array(z.string().trim().min(1).max(50)).min(2).max(50), count: z.number().int().min(1).default(1) })
  .refine((input) => input.count <= input.options.length, "要抽的个数比选项还多");

const pollInput = z.object({
  action: z.enum(["start", "vote", "results", "close"]),
  question: z.string().trim().min(1).max(100).optional(),
  options: z.array(z.string().trim().min(1).max(40)).min(2).max(10).optional(),
  choice: z.number().int().min(1).optional(),
});

const gachaInput = z.object({ count: z.union([z.literal(1), z.literal(10)]).default(1) });
// A ten-pull with several five-stars shows at most this many of their pictures on their own.
const MAX_FIVE_STAR_PICTURES = 2;

const nicknameInput = z.object({ nickname: z.string().trim().max(MAX_NICKNAME_CHARS).default("") });

type Poll = {
  question: string;
  options: string[];
  creatorId: string;
  creatorName: string;
  createdAt: number;
  votes: Record<string, { name: string; choice: number }>;
};

type Nicknames = Record<string, { name: string; nickname: string }>;

function tally(poll: Poll, open: boolean): string {
  const lines = poll.options.map((option, index) => {
    const voters = Object.values(poll.votes).filter((vote) => vote.choice === index + 1);
    return `${index + 1}. ${option}：${voters.length} 票${voters.length ? `（${voters.map((vote) => vote.name).join("、")}）` : ""}`;
  });
  return [`投票「${poll.question}」${open ? "进行中" : "已结束"}，共 ${Object.keys(poll.votes).length} 人投票：`, ...lines].join("\n");
}

// The same tally as a card: a bar per option, filled in proportion to its votes.
export function pollCard(poll: Poll, open: boolean): string {
  const total = Object.keys(poll.votes).length;
  const options = poll.options.map((option, index) => {
    const voters = Object.values(poll.votes).filter((vote) => vote.choice === index + 1);
    const share = total ? voters.length / total : 0;
    const filled = Math.round(share * 10);
    const names = voters.length && voters.length <= 5 ? `　${voters.map((vote) => plain(vote.name)).join("、")}` : "";
    return `**${index + 1}. ${plain(option)}**\n\n${"▓".repeat(filled)}${"░".repeat(10 - filled)} ${voters.length} 票（${Math.round(share * 100)}%）${names}`;
  });
  const status = open ? `共 ${total} 人投票 · 24 小时内有效 · @我说“投 1”参与` : `已结束 · 共 ${total} 人投票`;
  return [`## 📊 ${plain(poll.question)}`, ...options, `> ${status}`].join("\n\n");
}

function describeItem(item: GachaItem): string {
  return item.rarity === 5 ? `${item.name}，第 ${item.pity} 抽` : item.name;
}

const RARITY_WORDS = { 5: "五星", 4: "四星", 3: "三星" } as const;

// The nicknames people in this chat asked to be called, by sender, for the conversation prompt.
export function conversationNicknames(store: SettingsStore, channelId: string, conversationId: string): Map<string, string> {
  const saved = store.getSetting<Nicknames>(`nicknames:${channelId}:${conversationId}`) ?? {};
  return new Map(Object.entries(saved).map(([senderId, entry]) => [senderId, entry.nickname]));
}

// The pool's pictures are read from the workspace. Without one, cards show the name's first character.
export function groupTools(store: SettingsStore, options: { workspace?: Workspace; now?: () => number; random?: (below: number) => number } = {}): LocalTool[] {
  const now = options.now ?? Date.now;
  // An integer from 0 up to, not including, the bound.
  const random = options.random ?? ((below: number) => randomInt(below));

  function activePoll(caller: ToolCaller): Poll | null {
    const poll = store.getSetting<Poll | null>(chatKey("poll", caller));
    return poll && now() - poll.createdAt < POLL_TTL_MS ? poll : null;
  }

  return [
    {
      name: "roll_dice",
      description: "Roll dice. Use it whenever someone asks for a dice roll, rather than making up numbers.",
      inputSchema: {
        type: "object",
        properties: { dice: { type: "integer", minimum: 1, maximum: 20, description: "How many dice. Default 1." }, sides: { type: "integer", minimum: 2, maximum: 1000, description: "Sides per die. Default 6." } },
        additionalProperties: false,
      },
      minTier: "member",
      run: async (input, context) => {
        const { dice, sides } = parse(diceInput, input);
        const rolls = Array.from({ length: dice }, () => random(sides) + 1);
        const total = rolls.reduce((sum, roll) => sum + roll, 0);
        const said = `掷了 ${dice} 个 ${sides} 面骰：${rolls.join("、")}${dice > 1 ? `，合计 ${total}` : ""}`;
        // The result is settled before anything is drawn; the animation only shows it.
        const shown = sides === 6 && dice <= MAX_DRAWN_DICE && (await tryToShow(context, () => Promise.all(rolls.map((roll) => diceGif(roll))), dice > 1 ? `合计 ${total}` : undefined));
        return shown ? `${said}。骰子动画${SHOWN}` : said;
      },
    },
    {
      name: "random_pick",
      description:
        "Pick at random from a list: drawing lots, who goes first, where to eat, a random roll call. For a roll call, list the names of people who have been talking. Use it rather than choosing yourself, since only this is really random.",
      inputSchema: {
        type: "object",
        properties: {
          options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 50, description: "What to pick from." },
          count: { type: "integer", minimum: 1, description: "How many to pick, all different. Default 1." },
        },
        required: ["options"],
        additionalProperties: false,
      },
      minTier: "member",
      run: async (input) => {
        const { options: choices, count } = parse(pickInput, input);
        const pool = [...choices];
        for (let index = 0; index < count; index++) {
          const swap = index + random(pool.length - index);
          [pool[index], pool[swap]] = [pool[swap] as string, pool[index] as string];
        }
        return `从 ${choices.length} 个里随机抽了 ${count} 个：${pool.slice(0, count).join("、")}`;
      },
    },
    {
      name: "poll",
      description:
        'A poll in this chat, one at a time, open for a day. action "start" with a question and 2-10 options; "vote" with choice (the option\'s number), which counts for the person whose message you are answering and replaces their earlier vote; "results"; "close", which only whoever started it or the owner can do. People vote by messaging you, such as "投 2".',
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "vote", "results", "close"] },
          question: { type: "string", description: "For start." },
          options: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 10, description: "For start." },
          choice: { type: "integer", minimum: 1, description: "For vote: the option's number, from 1." },
        },
        required: ["action"],
        additionalProperties: false,
      },
      minTier: "member",
      run: async (input, context) => {
        const caller = callerOf(context);
        const { action, question, options: choices, choice } = parse(pollInput, input);
        const poll = activePoll(caller);
        if (action === "start") {
          if (poll) throw new Error(`这里已经有一个进行中的投票：「${poll.question}」。先结束它再开新的。`);
          if (!question || !choices) throw new Error("开投票要有问题和至少两个选项。");
          if (new Set(choices).size !== choices.length) throw new Error("选项有重复。");
          const started: Poll = { question, options: choices, creatorId: caller.senderId, creatorName: caller.senderName, createdAt: now(), votes: {} };
          store.setSetting(chatKey("poll", caller), started);
          const carded = await tryCard(context, pollCard(started, true));
          return `${caller.senderName} 发起了投票，24 小时内有效。\n${tally(started, true)}\n${carded ? `投票卡片${SHOWN}` : "告诉大家 @ 你说“投 1”这样投票。"}`;
        }
        if (!poll) throw new Error("现在没有进行中的投票。");
        if (action === "vote") {
          if (!choice || choice > poll.options.length) throw new Error(`选项是 1 到 ${poll.options.length}。`);
          const before = poll.votes[caller.senderId];
          poll.votes[caller.senderId] = { name: caller.senderName, choice };
          store.setSetting(chatKey("poll", caller), poll);
          const carded = await tryCard(context, pollCard(poll, true));
          return `记下了：${caller.senderName} 投给 ${choice}. ${poll.options[choice - 1]}${before && before.choice !== choice ? `（原来投的是 ${before.choice}，已改）` : ""}。\n${tally(poll, true)}${carded ? `\n最新的票数卡片${SHOWN}` : ""}`;
        }
        if (action === "results") {
          const carded = await tryCard(context, pollCard(poll, true));
          return `${tally(poll, true)}${carded ? `\n票数卡片${SHOWN}` : ""}`;
        }
        if (poll.creatorId !== caller.senderId && caller.senderTier !== "owner") throw new Error(`只有发起人 ${poll.creatorName} 或主人能结束这个投票。`);
        store.setSetting(chatKey("poll", caller), null);
        const carded = await tryCard(context, pollCard(poll, false));
        return `${tally(poll, false)}${carded ? `\n结果卡片${SHOWN}` : ""}`;
      },
    },
    {
      name: "gacha_pull",
      description:
        "Pull from the group's 猪猪池 (pig pool), single or ten, for the person whose message you are answering. The owner chose the pig pictures and their rarity. 0.6% for 5-star, rising from pull 74, certain by 90; a 4-star at least every 10. Pity is kept per person in this chat. Only a game: nothing real is won or spent.",
      inputSchema: {
        type: "object",
        properties: { count: { type: "integer", enum: [1, 10], description: "1 or 10. Default 1." } },
        additionalProperties: false,
      },
      minTier: "member",
      run: async (input, context) => {
        const caller = callerOf(context);
        const { count } = parse(gachaInput, input);
        const cards = readPool(store);
        const problem = poolProblem(cards);
        if (problem) throw new Error(problem);
        const byName = new Map(cards.map((card) => [card.name, card]));

        const key = `${chatKey("gacha", caller)}:${caller.senderId}:pig`;
        const state: GachaState = { ...freshState(), ...store.getSetting<GachaState>(key) };
        const items = Array.from({ length: count }, () => pull(POOL_RULES, poolsOf(cards), state, random));
        store.setSetting(key, state);

        const kind = count === 1 ? "单抽" : "十连";
        const byRarity = (rarity: 3 | 4 | 5) => items.filter((item) => item.rarity === rarity);
        const got =
          count === 1
            ? `${RARITY_WORDS[items[0]!.rarity]}（${describeItem(items[0]!)}）`
            : ([3, 4, 5] as const).map((rarity) => `${RARITY_WORDS[rarity]}×${byRarity(rarity).length}${rarity > 3 && byRarity(rarity).length ? `（${byRarity(rarity).map(describeItem).join("；")}）` : ""}`).join("，");
        const footer = `已 ${state.sinceFive} 抽未出五星 · 累计 ${state.total} 抽`;

        const workspace = options.workspace;
        const picture = async (card: PoolCard | undefined) => (workspace && card ? await thumbnail(workspace, card).catch(() => undefined) : undefined);
        const shown = await tryToShow(context, async () => [
          await gachaPng(
            `${caller.senderName} 的${kind} · 猪猪池`,
            footer,
            await Promise.all(items.map(async (item) => ({ rarity: item.rarity, name: item.name, ...(await picture(byName.get(item.name)).then((data) => (data ? { picture: data } : {}))) }))),
          ),
        ]);
        // A five-star's own picture, as the owner added it, kept on the platform for next time.
        const fiveStars = [...new Set(byRarity(5).map((item) => item.name))].slice(0, MAX_FIVE_STAR_PICTURES).flatMap((name) => (byName.get(name) ? [byName.get(name) as PoolCard] : []));
        const originals =
          shown && workspace && fiveStars.length
            ? await tryToShow(context, async () =>
                Promise.all(
                  fiveStars.map(async (card) => {
                    const data = await readFile(await workspace.resolve(card.file));
                    const size = await thumbnail(workspace, card).then(() => 240);
                    return { data, mediaType: card.mediaType, width: size, height: size, alt: card.name, reuseKey: `pool-${card.id}` };
                  }),
                ),
              )
            : false;
        return `${caller.senderName} 的猪猪池${kind}：${got}。${footer.replaceAll(" · ", "，")}，一共出了 ${state.fives} 个五星。${shown ? `\n结果图${originals ? "和五星原图" : ""}${SHOWN}` : ""}`;
      },
    },
    {
      name: "set_nickname",
      description: "Remember what the person whose message you are answering wants to be called in this chat, such as “以后叫我老王”. An empty nickname forgets it. Only for themselves.",
      inputSchema: {
        type: "object",
        properties: { nickname: { type: "string", maxLength: MAX_NICKNAME_CHARS, description: "Up to 12 characters. Empty to forget." } },
        additionalProperties: false,
      },
      minTier: "member",
      run: async (input, context) => {
        const caller = callerOf(context);
        const { nickname } = parse(nicknameInput, input);
        if (/\s{2,}|[\r\n]/.test(nickname) || RESERVED_NICKNAME.test(nickname)) throw new Error("这个称呼不行，换一个。");
        const key = chatKey("nicknames", caller);
        const saved = store.getSetting<Nicknames>(key) ?? {};
        if (!nickname) {
          delete saved[caller.senderId];
          store.setSetting(key, saved);
          return `好，不再叫 ${caller.senderName} 的外号了。`;
        }
        saved[caller.senderId] = { name: caller.senderName, nickname };
        store.setSetting(key, saved);
        return `记住了，以后叫 ${caller.senderName}「${nickname}」。`;
      },
    },
  ];
}
