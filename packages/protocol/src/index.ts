// The shapes shared by the engine and the console.
import { z } from "zod";

export type Tier = "owner" | "trusted" | "member";

// The tiers that have to be granted. Everyone else is a member.
export const grantedTiers = ["owner", "trusted"] as const;
export type GrantedTier = (typeof grantedTiers)[number];

// What happens to a reply once the model has written it.
//   notify:  don't call the model, just surface the message
//   confirm: hold the reply until the owner approves it
//   auto:    send it straight away
export const autonomyLevels = ["notify", "confirm", "auto"] as const;
export type Autonomy = (typeof autonomyLevels)[number];

// The models the owner can switch between in the console.
export const modelIds = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
export type ModelId = (typeof modelIds)[number];

export const modelOptions: { id: ModelId; label: string; note: string }[] = [
  { id: "claude-opus-5-5", label: "Opus 5.5", note: "最强，最贵" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", note: "约为 Opus 的一半价" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", note: "约为 Opus 的 1/40 价" },
];

export type ConversationKind = "group" | "dm";

export type InboundMessage = {
  id: string;
  channelId: string;
  conversationId: string;
  conversationKind: ConversationKind;
  // Used when the conversation is seen for the first time.
  conversationTitle: string;
  senderId: string;
  senderName: string;
  text: string;
  mentionsBot: boolean;
  at: number;
};

export type ChatLine = {
  id: string;
  channelId: string;
  conversationId: string;
  direction: "in" | "out";
  senderId: string;
  senderName: string;
  text: string;
  at: number;
  // For an outgoing line, the authority its turn ran with: what the bot wrote can carry
  // whatever was in its context, so it never counts as more trusted than that.
  tier: Tier;
};

export type ActivityLevel = "info" | "ok" | "blocked" | "error";

export type ActivityEntry = {
  id: number;
  at: number;
  level: ActivityLevel;
  summary: string;
  conversationTitle?: string;
  costUsd?: number;
};

export type ConversationView = {
  id: string;
  title: string;
  kind: ConversationKind;
  enabled: boolean;
  autonomy: Autonomy;
};

export type ChannelStatus = {
  state: "stopped" | "connecting" | "connected" | "error" | "needs-login";
  detail?: string;
};

// A QR login in progress, for platforms that sign in that way.
export type ChannelLogin =
  | { state: "qr"; qrContent: string }
  | { state: "scanned" }
  | { state: "verify" }
  | { state: "failed"; message: string };

export type ChannelView = {
  id: string;
  name: string;
  enabled: boolean;
  status: ChannelStatus;
  botName?: string;
  canLogin: boolean;
  login?: ChannelLogin;
  conversations: ConversationView[];
};

// Replies drafted for a WeChat work group. They wait for the owner like any held reply, but
// they'd go out through the WeChat window rather than a channel.
export const WECHAT_WORK_CHANNEL_ID = "wechat-work";

const MAX_WORK_MESSAGE_CHARS = 1000;

// What's wrong with this text as something to type into a work group, as the owner would need it
// put. Checked in the console, which shows it, and again in the engine.
export function workMessageProblem(text: string): string | null {
  if (!text.trim()) return "草稿是空的。";
  if (/[【】]/.test(text)) return "草稿里还有【】，填好才能发送。";
  if (/[\r\n]/.test(text)) return "微信里换行等于发送，请改成一行。";
  // Typed character by character, an @ goes out as plain text: on real WeChat the person got no
  // mention. It also opens the member list, where Enter might pick someone instead of sending, though
  // that hasn't been tried with an @ at the end.
  if (/[@＠]/.test(text)) return "草稿里有 @。这样发出去对方收不到 @ 提醒，请删掉，或者复制后自己发。";
  if (text.length > MAX_WORK_MESSAGE_CHARS) return `草稿太长了，最多 ${MAX_WORK_MESSAGE_CHARS} 字。`;
  return null;
}

// Why this name can't be picked from WeChat's member list. A space closes the list while typing.
export function workMentionProblem(name: string): string | null {
  if (/[\s@＠]/.test(name)) return "@ 的名字里不能有空格或 @，这样选不了人。可以留空，复制后自己发。";
  if (name === "所有人") return "不能 @ 所有人，要的话请自己发。";
  if (name.length > 40) return "@ 的名字太长了。";
  return null;
}

export type PendingReply = {
  id: string;
  channelId: string;
  conversationId: string;
  conversationTitle: string;
  replyToId: string;
  triggerSender: string;
  triggerText: string;
  draft: string;
  tier: Tier;
  costUsd: number;
  createdAt: number;
  // A try to send this may have gone out, so sending again takes the owner saying it didn't.
  sendUncertain?: boolean;
  // Who to pick from WeChat's member list when sending. The owner can change it.
  mentionName?: string;
};

export type SimSender = { id: string; name: string; tier: Tier };

export type AccessEntry = {
  channelId: string;
  senderId: string;
  name: string;
  tier: GrantedTier;
};

export type PairingView = {
  channelId: string;
  tier: GrantedTier;
  code: string;
  expiresAt: number;
};

// Reading the WeChat window for mentions in work groups.
export type WorkbenchStatus = {
  state: "off" | "scanning" | "paused" | "error";
  detail?: string;
};

export type WorkbenchView = {
  // Its own switch, off by default, because it reads the screen.
  enabled: boolean;
  status: WorkbenchStatus;
  allowedGroups: string[];
  intervalSeconds: number;
  // An approved reply is being typed into WeChat right now.
  sending: boolean;
};

export type EngineState = {
  running: boolean;
  channels: ChannelView[];
  // Null where the screen can't be read, such as outside Windows.
  workbench: WorkbenchView | null;
  pending: PendingReply[];
  usage: {
    todayUsd: number;
    dailyLimitUsd: number;
    ownerTodayUsd: number;
    ownerDailyLimitUsd: number;
    searchesToday: number;
    searchLimit: number;
  };
  brain: { ready: boolean; model: string };
  // Whether the master switch comes on by itself when the app starts with Windows.
  runAtLogin: boolean;
  simSenders: SimSender[];
  access: AccessEntry[];
  pairing: PairingView | null;
};

export type ServerEvent =
  | { type: "state"; state: EngineState }
  | { type: "activity"; entry: ActivityEntry }
  | { type: "chat"; line: ChatLine }
  | { type: "history"; activity: ActivityEntry[]; chat: ChatLine[] }
  | { type: "error"; message: string };

const id = z.string().min(1).max(200);

export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("engine.start") }),
  z.object({ type: z.literal("engine.stop") }),
  z.object({ type: z.literal("engine.setRunAtLogin"), enabled: z.boolean() }),
  z.object({ type: z.literal("brain.setModel"), model: z.enum(modelIds) }),
  z.object({ type: z.literal("channel.setEnabled"), channelId: id, enabled: z.boolean() }),
  z.object({ type: z.literal("channel.login"), channelId: id }),
  z.object({ type: z.literal("channel.loginCode"), channelId: id, code: z.string().trim().min(1).max(20) }),
  z.object({ type: z.literal("channel.logout"), channelId: id }),
  z.object({ type: z.literal("conversation.setEnabled"), channelId: id, conversationId: id, enabled: z.boolean() }),
  z.object({ type: z.literal("conversation.setAutonomy"), channelId: id, conversationId: id, autonomy: z.enum(autonomyLevels) }),
  z.object({ type: z.literal("conversation.rename"), channelId: id, conversationId: id, title: z.string().trim().min(1).max(60) }),
  z.object({ type: z.literal("pending.approve"), pendingId: id, text: z.string().min(1).max(10000).optional(), confirmedUnsent: z.boolean().optional(), mention: z.string().trim().min(1).max(60).optional() }),
  z.object({ type: z.literal("pending.reject"), pendingId: id }),
  z.object({ type: z.literal("pairing.start"), channelId: id, tier: z.enum(grantedTiers) }),
  z.object({ type: z.literal("pairing.cancel") }),
  z.object({ type: z.literal("access.remove"), channelId: id, senderId: id }),
  z.object({ type: z.literal("workbench.setEnabled"), enabled: z.boolean() }),
  z.object({ type: z.literal("workbench.allowGroup"), name: z.string().trim().min(1).max(60) }),
  z.object({ type: z.literal("workbench.removeGroup"), name: z.string().min(1).max(60) }),
  z.object({
    type: z.literal("sim.send"),
    conversationId: id,
    senderId: id,
    text: z.string().min(1).max(10000),
    mentionsBot: z.boolean(),
  }),
]);

export type Command = z.infer<typeof commandSchema>;
