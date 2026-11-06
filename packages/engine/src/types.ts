import type { Autonomy, ChannelLogin, ChannelStatus, ConversationKind, InboundMessage } from "@shu/protocol";

export type OutboundText = {
  channelId: string;
  conversationId: string;
  conversationKind: ConversationKind;
  text: string;
  replyToId?: string;
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

export type AdapterMessage = InboundMessage & { attachments?: InboundAttachment[] };

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
  beginLogin?(): Promise<void>;
  submitLoginCode?(code: string): void;
  logout?(): Promise<void>;
}
