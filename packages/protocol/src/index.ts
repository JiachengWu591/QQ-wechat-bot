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
  state: "stopped" | "connecting" | "connected" | "error";
  detail?: string;
};

export type ChannelView = {
  id: string;
  name: string;
  enabled: boolean;
  status: ChannelStatus;
  botName?: string;
  conversations: ConversationView[];
};

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

export type EngineState = {
  running: boolean;
  channels: ChannelView[];
  pending: PendingReply[];
  usage: { todayUsd: number; dailyLimitUsd: number; searchesToday: number; searchLimit: number };
  brain: { ready: boolean; model: string };
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
  z.object({ type: z.literal("channel.setEnabled"), channelId: id, enabled: z.boolean() }),
  z.object({ type: z.literal("conversation.setEnabled"), channelId: id, conversationId: id, enabled: z.boolean() }),
  z.object({ type: z.literal("conversation.setAutonomy"), channelId: id, conversationId: id, autonomy: z.enum(autonomyLevels) }),
  z.object({ type: z.literal("conversation.rename"), channelId: id, conversationId: id, title: z.string().trim().min(1).max(60) }),
  z.object({ type: z.literal("pending.approve"), pendingId: id, text: z.string().min(1).max(10000).optional() }),
  z.object({ type: z.literal("pending.reject"), pendingId: id }),
  z.object({ type: z.literal("pairing.start"), channelId: id, tier: z.enum(grantedTiers) }),
  z.object({ type: z.literal("pairing.cancel") }),
  z.object({ type: z.literal("access.remove"), channelId: id, senderId: id }),
  z.object({
    type: z.literal("sim.send"),
    conversationId: id,
    senderId: id,
    text: z.string().min(1).max(10000),
    mentionsBot: z.boolean(),
  }),
]);

export type Command = z.infer<typeof commandSchema>;
