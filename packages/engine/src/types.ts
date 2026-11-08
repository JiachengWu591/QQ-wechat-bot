import type { Autonomy, ChannelLogin, ChannelStatus, ConversationKind, InboundMessage } from "@shu/protocol";

// The bot's own settings, where small pieces of state are kept between runs.
export type SettingsStore = {
  getSetting<T>(key: string): T | undefined;
  setSetting(key: string, value: unknown): void;
};

export type OutboundTarget = {
  channelId: string;
  conversationId: string;
  conversationKind: ConversationKind;
  replyToId?: string;
};

export type OutboundText = OutboundTarget & { text: string };

// A picture the bot drew. One the same every time, such as a die landing on 3, says so with a key,
// so a platform can upload it once and reuse it.
export type ChatImage = {
  data: Buffer;
  mediaType: "image/png" | "image/jpeg" | "image/gif";
  width: number;
  height: number;
  alt: string;
  reuseKey?: string;
};

export type AdapterConversation = {
  id: string;
  title: string;
  kind: ConversationKind;
  defaultAutonomy: Autonomy;
  defaultEnabled: boolean;
};

// A file on the platform. Only fetched for the owner: nobody else can make the bot download.
export type InboundAttachment = { name: string; download(): Promise<Buffer> };

// A picture posted in a group, known by its content's MD5, which QQ gives as the file's name. It's
// only fetched where the owner has asked for a group's pictures to be counted, and only once
// enough people have posted it.
export type SeenImage = { fingerprint: string; fetch(): Promise<Buffer> };

export type AdapterMessage = InboundMessage & { attachments?: InboundAttachment[]; seenImages?: SeenImage[] };

export type AdapterHandlers = {
  onMessage(message: AdapterMessage): void;
  onStatus(status: ChannelStatus): void;
  onLogin?(login: ChannelLogin | null): void;
};

// One chat platform. Adapters can fail and reconnect on their own without taking the
// engine down, and they know nothing about tiers or models.
export interface Adapter {
  readonly id: string;
  readonly name: string;
  // Added to the system prompt, for what the model needs to know about this platform.
  readonly promptHint?: string;
  // Where the owner's own private chat is for talking rather than work, so it takes the persona.
  readonly personaInOwnerChat?: boolean;
  // Conversations that always exist. Others are discovered as messages arrive.
  conversations(): AdapterConversation[];
  botName?(): string | undefined;
  // An account the platform itself proves belongs to the owner.
  ownerId?(): string | undefined;
  start(handlers: AdapterHandlers): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundText): Promise<void>;
  sendFile?(conversationId: string, absolutePath: string, fileName: string): Promise<void>;
  // Pictures in one message, with an optional line of text.
  sendImages?(target: OutboundTarget, images: ChatImage[], caption?: string): Promise<void>;
  // A formatted card, written in the platform's Markdown.
  sendCard?(target: OutboundTarget, markdown: string): Promise<void>;
  beginLogin?(): Promise<void>;
  submitLoginCode?(code: string): void;
  logout?(): Promise<void>;
}
