import type { Autonomy, ChannelStatus, ConversationKind, InboundMessage } from "@shu/protocol";

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

export type AdapterHandlers = {
  onMessage(message: InboundMessage): void;
  onStatus(status: ChannelStatus): void;
};

// One chat platform. Adapters can fail and reconnect on their own without taking the
// engine down, and they know nothing about tiers or models.
export interface Adapter {
  readonly id: string;
  readonly name: string;
  // Added to the system prompt, for what the model needs to know about this platform.
  readonly promptHint?: string;
  // Conversations that always exist. Others are discovered as messages arrive.
  conversations(): AdapterConversation[];
  botName?(): string | undefined;
  start(handlers: AdapterHandlers): Promise<void>;
  stop(): Promise<void>;
  send(message: OutboundText): Promise<void>;
}
