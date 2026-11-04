// The hub: everything a message goes through between arriving and a reply leaving.
import { EventEmitter } from "node:events";
import { randomInt, randomUUID } from "node:crypto";
import type {
  AccessEntry,
  ActivityEntry,
  ActivityLevel,
  Autonomy,
  ChannelStatus,
  ChatLine,
  ConversationView,
  EngineState,
  GrantedTier,
  InboundMessage,
  PairingView,
  PendingReply,
  SimSender,
  Tier,
} from "@shu/protocol";
import type { Brain, ToolOutcome } from "./brain.ts";
import { atLeast, effectiveTier, RateLimiter, tierOf, type AccessList } from "./policy.ts";
import { chatPrompt, systemPrompt } from "./prompt.ts";
import type { Store } from "./store.ts";
import type { LocalTool } from "./tools.ts";
import type { Adapter, AdapterConversation } from "./types.ts";

export type EngineConfig = {
  botName: string;
  // Grants that come from configuration rather than pairing, such as the simulated owner.
  access: AccessList;
  dailyLimitUsd: number;
  webSearch: boolean;
  // Shared by everyone except the owner, who isn't limited.
  sharedSearchesPerDay: number;
  contextMessages: number;
  perSenderPerMinute: number;
  perConversationPerMinute: number;
  retentionDays: number;
  simSenders: SimSender[];
};

type EngineEvents = {
  state: [EngineState];
  activity: [ActivityEntry];
  chat: [ChatLine];
};

type ConversationSettings = { enabled: boolean; autonomy: Autonomy; title?: string };

type Pairing = PairingView & { failures: number };

const PAIRING_TTL_MS = 10 * 60_000;
const MAX_PAIRING_FAILURES = 5;
const SEARCHES_PER_TURN = 3;
const DAY_MS = 24 * 60 * 60_000;

export function dayKey(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export class Engine extends EventEmitter<EngineEvents> {
  #store: Store;
  #brain: Brain | null;
  #adapters: Map<string, Adapter>;
  #tools: LocalTool[];
  #config: EngineConfig;
  #now: () => number;
  #senderLimit: RateLimiter;
  #conversationLimit: RateLimiter;

  #running = false;
  #channelEnabled = new Map<string, boolean>();
  #channelStatus = new Map<string, ChannelStatus>();
  // Anything older than this was sent while the channel was off and is never answered.
  #acceptSince = new Map<string, number>();
  #inFlight = new Set<AbortController>();
  #queues = new Map<string, Promise<void>>();
  #pairing: Pairing | null = null;

  constructor(deps: { store: Store; brain: Brain | null; adapters: Adapter[]; tools: LocalTool[]; config: EngineConfig; now?: () => number }) {
    super();
    this.#store = deps.store;
    this.#brain = deps.brain;
    this.#adapters = new Map(deps.adapters.map((adapter) => [adapter.id, adapter]));
    this.#tools = deps.tools;
    this.#config = deps.config;
    this.#now = deps.now ?? Date.now;
    this.#senderLimit = new RateLimiter(deps.config.perSenderPerMinute, 60_000);
    this.#conversationLimit = new RateLimiter(deps.config.perConversationPerMinute, 60_000);
    for (const adapter of deps.adapters) {
      this.#channelEnabled.set(adapter.id, this.#store.getSetting<boolean>(`channel:${adapter.id}:enabled`) ?? true);
    }
  }

  getState(): EngineState {
    const today = dayKey(this.#now());
    return {
      running: this.#running,
      channels: [...this.#adapters.values()].map((adapter) => ({
        id: adapter.id,
        name: adapter.name,
        enabled: this.#channelEnabled.get(adapter.id) ?? false,
        status: this.#channelStatus.get(adapter.id) ?? { state: "stopped" },
        ...(adapter.botName?.() ? { botName: adapter.botName() as string } : {}),
        conversations: this.#knownConversations(adapter.id).map((conversation): ConversationView => {
          const { title, ...settings } = this.#settings(adapter.id, conversation);
          return { id: conversation.id, kind: conversation.kind, title: title ?? conversation.title, ...settings };
        }),
      })),
      pending: this.#store.listPending(),
      usage: {
        todayUsd: this.#store.costForDay(today),
        dailyLimitUsd: this.#config.dailyLimitUsd,
        searchesToday: this.#sharedSearches(today),
        searchLimit: this.#config.sharedSearchesPerDay,
      },
      brain: { ready: this.#brain !== null, model: this.#brain?.model ?? "未配置" },
      simSenders: this.#config.simSenders,
      access: this.#pairedAccess(),
      pairing: this.#activePairing(),
    };
  }

  history() {
    return { activity: this.#store.recentActivity(200), chat: this.#store.recentChat(500) };
  }

  async start() {
    if (this.#running) return;
    this.#running = true;
    const now = this.#now();
    this.#store.purgeBefore(now - this.#config.retentionDays * DAY_MS);
    for (const [id, adapter] of this.#adapters) {
      this.#acceptSince.set(id, now);
      if (this.#channelEnabled.get(id)) await this.#startAdapter(adapter);
    }
    this.#log("info", "已启动，只处理从现在开始的新消息");
    this.#emitState();
  }

  // The running flag flips before anything else, so no reply can pass the send gate from
  // this moment on, even one that has already been written.
  async stop() {
    if (!this.#running) return;
    this.#running = false;
    this.#pairing = null;
    for (const controller of this.#inFlight) controller.abort();
    this.#log("info", "已停止，进行中的任务已中止");
    this.#emitState();
    await Promise.allSettled([...this.#adapters.values()].map((adapter) => adapter.stop()));
    this.#emitState();
  }

  async setChannelEnabled(channelId: string, enabled: boolean) {
    const adapter = this.#adapterFor(channelId);
    this.#channelEnabled.set(channelId, enabled);
    this.#store.setSetting(`channel:${channelId}:enabled`, enabled);
    if (enabled) {
      this.#acceptSince.set(channelId, this.#now());
      if (this.#running) await this.#startAdapter(adapter);
    } else {
      await adapter.stop();
    }
    this.#log("info", `${adapter.name}已${enabled ? "打开" : "关闭"}`);
    this.#emitState();
  }

  setConversationEnabled(channelId: string, conversationId: string, enabled: boolean) {
    const conversation = this.#conversationFor(channelId, conversationId);
    this.#saveSettings(channelId, conversation, { enabled });
    this.#log("info", `已${enabled ? "打开" : "关闭"}这个聊天`, this.#titleOf(channelId, conversation));
    this.#emitState();
  }

  setConversationAutonomy(channelId: string, conversationId: string, autonomy: Autonomy) {
    this.#saveSettings(channelId, this.#conversationFor(channelId, conversationId), { autonomy });
    this.#emitState();
  }

  renameConversation(channelId: string, conversationId: string, title: string) {
    this.#saveSettings(channelId, this.#conversationFor(channelId, conversationId), { title });
    this.#emitState();
  }

  // A short-lived code the owner sends to the bot privately. It proves who an account
  // belongs to without typing an ID, and only someone who can see the console gets it.
  startPairing(channelId: string, tier: GrantedTier) {
    this.#adapterFor(channelId);
    if (!this.#running) throw new Error("先打开总闸，机器人才能收到配对码。");
    this.#pairing = {
      channelId,
      tier,
      code: String(randomInt(100000, 1000000)),
      expiresAt: this.#now() + PAIRING_TTL_MS,
      failures: 0,
    };
    this.#emitState();
  }

  cancelPairing() {
    this.#pairing = null;
    this.#emitState();
  }

  removeAccess(channelId: string, senderId: string) {
    const remaining = this.#pairedAccess().filter((entry) => !(entry.channelId === channelId && entry.senderId === senderId));
    this.#store.setSetting("access", remaining);
    this.#log("info", "已移除一个绑定的身份");
    this.#emitState();
  }

  // Resolves once any reply this message triggers has been dealt with.
  async handleInbound(message: InboundMessage): Promise<void> {
    const adapter = this.#adapterFor(message.channelId);
    const summary = `${message.senderName}：${preview(message.text)}`;
    const incomingTitle = this.#titleForMessage(message);

    if (!this.#running) return this.#log("blocked", `总闸已关闭，已丢弃 ${summary}`, incomingTitle);
    if (!this.#channelEnabled.get(adapter.id)) return this.#log("blocked", `${adapter.name}已关闭，已丢弃 ${summary}`, incomingTitle);

    if (message.conversationKind === "dm" && (await this.#tryPairing(message, adapter))) return;

    this.#refreshAccessName(message);
    const access = this.#accessList();
    const tier = tierOf(access, message.channelId, message.senderId);
    if (message.conversationKind === "dm" && tier === "member") {
      return this.#log("blocked", `拒绝陌生人私聊 ${summary}`, incomingTitle);
    }

    const conversation = this.#ensureConversation(message);
    const title = this.#titleOf(message.channelId, conversation);
    const settings = this.#settings(message.channelId, conversation);
    // A closed conversation stores nothing, so it can't reach a later turn's context.
    if (!settings.enabled) return this.#log("blocked", `这个聊天已关闭，已丢弃 ${summary}`, title);
    if (message.at < (this.#acceptSince.get(adapter.id) ?? 0)) return this.#log("info", `跳过离线期间的消息 ${summary}`, title);

    const line: ChatLine = {
      id: message.id,
      channelId: message.channelId,
      conversationId: message.conversationId,
      direction: "in",
      senderId: message.senderId,
      senderName: message.senderName,
      text: message.text,
      at: message.at,
      tier,
    };
    this.#store.addMessage(line);
    this.emit("chat", line);

    if (conversation.kind === "group" && !this.#addressesBot(message, adapter)) return;

    if (settings.autonomy === "notify") return this.#log("info", `有消息需要你看：${summary}`, title);

    const now = this.#now();
    if (!this.#senderLimit.allow(`${message.channelId}:${message.senderId}`, now)) {
      return this.#log("blocked", `${message.senderName} 发得太频繁，这条不回复`, title);
    }
    if (!this.#conversationLimit.allow(`${message.channelId}:${message.conversationId}`, now)) {
      return this.#log("blocked", "这个聊天的回复太频繁，这条不回复", title);
    }

    // One turn at a time per conversation, so replies can't overtake each other.
    const key = `${message.channelId}:${message.conversationId}`;
    const turn = (this.#queues.get(key) ?? Promise.resolve()).then(() => this.#runTurn(line, conversation, adapter, settings.autonomy));
    this.#queues.set(key, turn);
    await turn;
  }

  async approve(pendingId: string, editedText?: string) {
    const reply = this.#store.listPending().find((entry) => entry.id === pendingId);
    if (!reply) throw new Error("这条待确认的回复已经不存在了。");
    if (!this.#canSend(reply.channelId, reply.conversationId)) {
      throw new Error("总闸或这个聊天已关闭，打开后才能发送。");
    }
    // Removed only after it sends, so a platform failure leaves it there to retry.
    await this.#deliver(this.#conversationFor(reply.channelId, reply.conversationId), reply.channelId, editedText ?? reply.draft, reply.tier, reply.replyToId);
    this.#store.removePending(reply.id);
    this.#emitState();
  }

  reject(pendingId: string) {
    this.#store.removePending(pendingId);
    this.#log("info", "已忽略一条待确认的回复");
    this.#emitState();
  }

  async #runTurn(trigger: ChatLine, conversation: AdapterConversation, adapter: Adapter, autonomy: Autonomy) {
    const title = this.#titleOf(trigger.channelId, conversation);
    if (!this.#running) return;
    if (!this.#brain) return this.#log("error", "还没有配置 API key，无法回复", title);

    const today = dayKey(this.#now());
    if (this.#store.costForDay(today) >= this.#config.dailyLimitUsd) {
      return this.#log("blocked", `今日预算 $${this.#config.dailyLimitUsd} 已用完，不再调用模型`, title);
    }

    const recent = this.#store.recentMessages(trigger.channelId, trigger.conversationId, this.#config.contextMessages + 1);
    const history = recent.filter((line) => line.id !== trigger.id);
    const tier = effectiveTier([...history, trigger].map((line) => line.tier), conversation.kind);
    const offered = this.#tools.filter((tool) => atLeast(tier, tool.minTier));
    const isOwner = trigger.tier === "owner";
    const botName = adapter.botName?.() ?? this.#config.botName;

    const controller = new AbortController();
    this.#inFlight.add(controller);
    try {
      const result = await this.#brain.reply({
        system: systemPrompt(botName, adapter.promptHint),
        prompt: chatPrompt({ conversationTitle: title, kind: conversation.kind, history, current: trigger }),
        tools: offered.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        webSearchUses: this.#searchAllowance(isOwner, today),
        signal: controller.signal,
        runTool: (name, input) => this.#runTool(name, input, tier, title, controller.signal),
      });
      this.#store.addCost(today, result.costUsd);
      if (!isOwner && result.webSearches > 0) this.#store.setSetting(`searches:${today}`, this.#sharedSearches(today) + result.webSearches);

      if (controller.signal.aborted) return this.#log("blocked", "已停止，这条回复没有发送", title);
      const text = result.text.trim();
      if (result.refused) this.#log("blocked", "模型拒绝回复这条消息", title);
      if (!text) return this.#emitState();

      if (autonomy === "auto") {
        await this.#deliver(conversation, trigger.channelId, text, tier, trigger.id, result.costUsd);
      } else {
        const pending: PendingReply = {
          id: randomUUID(),
          channelId: trigger.channelId,
          conversationId: trigger.conversationId,
          conversationTitle: title,
          replyToId: trigger.id,
          triggerSender: trigger.senderName,
          triggerText: trigger.text,
          draft: text,
          tier,
          costUsd: result.costUsd,
          createdAt: this.#now(),
        };
        this.#store.addPending(pending);
        this.#log("info", `写好了给 ${trigger.senderName} 的回复，等你确认`, title, result.costUsd);
      }
      this.#emitState();
    } catch (error) {
      if (controller.signal.aborted) return this.#log("blocked", "已停止，这条回复没有发送", title);
      this.#log("error", `回复失败：${error instanceof Error ? error.message : String(error)}`, title);
    } finally {
      this.#inFlight.delete(controller);
    }
  }

  // The model only sees the tools offered above, but a call is checked again here so
  // that a mistake there, or a model naming a tool it wasn't given, still gets nowhere.
  async #runTool(name: string, input: unknown, tier: Tier, title: string, signal: AbortSignal): Promise<ToolOutcome> {
    const tool = this.#tools.find((candidate) => candidate.name === name);
    if (!tool || !atLeast(tier, tool.minTier)) {
      this.#log("blocked", `已拦截工具调用 ${name}（当前权限 ${tier}）`, title);
      return { content: "没有权限使用这个工具。", isError: true };
    }
    if (signal.aborted || !this.#running) {
      return { content: "已停止。", isError: true };
    }
    try {
      const content = await tool.run(input);
      this.#log("ok", `调用了工具 ${name}`, title);
      return { content, isError: false };
    } catch (error) {
      this.#log("error", `工具 ${name} 出错`, title);
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  }

  #searchAllowance(isOwner: boolean, today: string): number {
    if (!this.#config.webSearch) return 0;
    if (isOwner) return SEARCHES_PER_TURN;
    const left = this.#config.sharedSearchesPerDay - this.#sharedSearches(today);
    return Math.max(0, Math.min(SEARCHES_PER_TURN, left));
  }

  #sharedSearches(today: string): number {
    return this.#store.getSetting<number>(`searches:${today}`) ?? 0;
  }

  // Every outgoing message passes this one checkpoint.
  #canSend(channelId: string, conversationId: string): boolean {
    if (!this.#running || !this.#channelEnabled.get(channelId)) return false;
    return this.#settings(channelId, this.#conversationFor(channelId, conversationId)).enabled;
  }

  async #deliver(conversation: AdapterConversation, channelId: string, text: string, tier: Tier, replyToId: string, costUsd?: number) {
    const title = this.#titleOf(channelId, conversation);
    if (!this.#canSend(channelId, conversation.id)) {
      return this.#log("blocked", "已关闭，这条回复没有发送", title);
    }
    const adapter = this.#adapterFor(channelId);
    await adapter.send({ channelId, conversationId: conversation.id, conversationKind: conversation.kind, text, replyToId });
    const line: ChatLine = {
      id: randomUUID(),
      channelId,
      conversationId: conversation.id,
      direction: "out",
      senderId: "bot",
      senderName: adapter.botName?.() ?? this.#config.botName,
      text,
      at: this.#now(),
      tier,
    };
    this.#store.addMessage(line);
    this.emit("chat", line);
    this.#log("ok", `已回复：${preview(text)}`, title, costUsd);
  }

  async #tryPairing(message: InboundMessage, adapter: Adapter): Promise<boolean> {
    const pairing = this.#activePairing();
    if (!pairing || pairing.channelId !== message.channelId) return false;
    const text = message.text.trim();
    if (!/^\d{6}$/.test(text)) return false;

    if (text !== pairing.code) {
      const current = this.#pairing as Pairing;
      current.failures += 1;
      if (current.failures >= MAX_PAIRING_FAILURES) {
        this.#pairing = null;
        this.#log("blocked", "配对码连续输错，已作废");
        this.#emitState();
      }
      return false;
    }

    this.#pairing = null;
    const entry: AccessEntry = { channelId: message.channelId, senderId: message.senderId, name: message.senderName, tier: pairing.tier };
    const others = this.#pairedAccess().filter((existing) => !(existing.channelId === entry.channelId && existing.senderId === entry.senderId));
    this.#store.setSetting("access", [...others, entry]);
    this.#log("ok", `已绑定 ${message.senderName}，身份：${pairing.tier === "owner" ? "主人" : "信任的人"}`);
    this.#emitState();
    await adapter
      .send({
        channelId: message.channelId,
        conversationId: message.conversationId,
        conversationKind: "dm",
        text: pairing.tier === "owner" ? "绑定成功，你现在是主人。" : "绑定成功。",
        replyToId: message.id,
      })
      .catch((error: unknown) => this.#log("error", `绑定确认发送失败：${error instanceof Error ? error.message : String(error)}`));
    return true;
  }

  // Pairing happens in a private chat, where QQ doesn't send a nickname. A group message
  // does, so the entry picks up the real name when one appears.
  #refreshAccessName(message: InboundMessage) {
    if (message.conversationKind !== "group") return;
    const paired = this.#pairedAccess();
    const entry = paired.find((item) => item.channelId === message.channelId && item.senderId === message.senderId);
    if (!entry || entry.name === message.senderName) return;
    entry.name = message.senderName;
    this.#store.setSetting("access", paired);
    this.#emitState();
  }

  #activePairing(): PairingView | null {
    if (!this.#pairing || this.#pairing.expiresAt <= this.#now()) return null;
    const { failures, ...view } = this.#pairing;
    return view;
  }

  #pairedAccess(): AccessEntry[] {
    return this.#store.getSetting<AccessEntry[]>("access") ?? [];
  }

  #accessList(): AccessList {
    const paired = this.#pairedAccess();
    const identity = ({ channelId, senderId }: AccessEntry) => ({ channelId, senderId });
    return {
      owners: [...this.#config.access.owners, ...paired.filter((entry) => entry.tier === "owner").map(identity)],
      trusted: [...this.#config.access.trusted, ...paired.filter((entry) => entry.tier === "trusted").map(identity)],
    };
  }

  #addressesBot(message: InboundMessage, adapter: Adapter): boolean {
    if (message.mentionsBot) return true;
    const name = adapter.botName?.() ?? this.#config.botName;
    // A one-character name would match too much ordinary text.
    return name.length >= 2 && message.text.includes(name);
  }

  async #startAdapter(adapter: Adapter) {
    await adapter.start({
      onMessage: (message) => {
        void this.handleInbound(message).catch((error) => {
          this.#log("error", `处理消息出错：${error instanceof Error ? error.message : String(error)}`);
        });
      },
      onStatus: (status) => {
        const previous = this.#channelStatus.get(adapter.id);
        this.#channelStatus.set(adapter.id, status);
        if (previous?.state !== status.state) {
          if (status.state === "connected") this.#log("ok", `${adapter.name}已连接`);
          // Routine: the QQ gateway asks for a reconnect every hour. Only a failure that
          // stops the retries is an error.
          if (status.state === "connecting" && previous?.state === "connected") this.#log("info", `${adapter.name}断开了：${status.detail ?? "原因未知"}`);
          if (status.state === "error") this.#log("error", `${adapter.name}连接失败：${status.detail ?? "未知原因"}`);
        }
        this.#emitState();
      },
    });
  }

  #knownConversations(channelId: string): AdapterConversation[] {
    return [...this.#adapterFor(channelId).conversations(), ...(this.#store.getSetting<AdapterConversation[]>(`channel:${channelId}:discovered`) ?? [])];
  }

  // Groups start closed: the bot could be added to one the owner has never heard of, and
  // an open group spends money. Private chats are already limited to granted identities.
  #ensureConversation(message: InboundMessage): AdapterConversation {
    const known = this.#knownConversations(message.channelId).find((entry) => entry.id === message.conversationId);
    if (known) return known;
    const isGroup = message.conversationKind === "group";
    const conversation: AdapterConversation = {
      id: message.conversationId,
      title: message.conversationTitle,
      kind: message.conversationKind,
      defaultAutonomy: "auto",
      defaultEnabled: !isGroup,
    };
    const key = `channel:${message.channelId}:discovered`;
    this.#store.setSetting(key, [...(this.#store.getSetting<AdapterConversation[]>(key) ?? []), conversation]);
    if (isGroup) this.#log("info", "发现一个新群，默认关闭，要回复请在总览里打开", conversation.title);
    this.#emitState();
    return conversation;
  }

  #settings(channelId: string, conversation: AdapterConversation): ConversationSettings {
    const saved = this.#store.getSetting<Partial<ConversationSettings>>(`conversation:${channelId}:${conversation.id}`);
    return {
      enabled: saved?.enabled ?? conversation.defaultEnabled,
      autonomy: saved?.autonomy ?? conversation.defaultAutonomy,
      ...(saved?.title ? { title: saved.title } : {}),
    };
  }

  #saveSettings(channelId: string, conversation: AdapterConversation, change: Partial<ConversationSettings>) {
    this.#store.setSetting(`conversation:${channelId}:${conversation.id}`, { ...this.#settings(channelId, conversation), ...change });
  }

  #titleOf(channelId: string, conversation: AdapterConversation): string {
    return this.#settings(channelId, conversation).title ?? conversation.title;
  }

  #titleForMessage(message: InboundMessage): string {
    const known = this.#knownConversations(message.channelId).find((entry) => entry.id === message.conversationId);
    return known ? this.#titleOf(message.channelId, known) : message.conversationTitle;
  }

  #adapterFor(channelId: string): Adapter {
    const adapter = this.#adapters.get(channelId);
    if (!adapter) throw new Error(`Unknown channel: ${channelId}`);
    return adapter;
  }

  #conversationFor(channelId: string, conversationId: string): AdapterConversation {
    const conversation = this.#knownConversations(channelId).find((entry) => entry.id === conversationId);
    if (!conversation) throw new Error(`Unknown conversation: ${conversationId}`);
    return conversation;
  }

  #log(level: ActivityLevel, summary: string, conversationTitle?: string, costUsd?: number) {
    const entry = this.#store.addActivity({
      at: this.#now(),
      level,
      summary,
      ...(conversationTitle ? { conversationTitle } : {}),
      ...(costUsd === undefined ? {} : { costUsd }),
    });
    this.emit("activity", entry);
  }

  #emitState() {
    this.emit("state", this.getState());
  }
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}
