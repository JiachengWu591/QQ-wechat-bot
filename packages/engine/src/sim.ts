// A chat platform that exists only inside the console, so every path through the engine
// can be exercised without touching a real account.
import type { ChannelLogin, ChannelStatus, SimSender } from "@shu/protocol";
import type { Adapter, AdapterConversation, AdapterHandlers, OutboundText } from "./types.ts";

export const SIM_CHANNEL_ID = "sim";

export const simSenders: SimSender[] = [
  { id: "sim-owner", name: "主人", tier: "owner" },
  { id: "sim-trusted", name: "老朋友", tier: "trusted" },
  { id: "sim-member", name: "群友小明", tier: "member" },
];

export const simConversations: AdapterConversation[] = [
  { id: "sim-group", title: "模拟群聊", kind: "group", defaultAutonomy: "auto", defaultEnabled: true },
  { id: "sim-work", title: "模拟工作群", kind: "group", defaultAutonomy: "confirm", defaultEnabled: true },
  { id: "sim-dm", title: "私聊", kind: "dm", defaultAutonomy: "auto", defaultEnabled: true },
];

export class SimAdapter implements Adapter {
  readonly id = SIM_CHANNEL_ID;
  readonly name = "模拟聊天";
  // Like QQ, so a persona tried out here behaves as it will there.
  readonly personaInOwnerChat = true;
  sent: OutboundText[] = [];
  sentFiles: { conversationId: string; path: string; fileName: string }[] = [];
  // Lets a test make the platform reject a message.
  failNextSend: Error | null = null;
  #handlers: AdapterHandlers | null = null;

  conversations() {
    return simConversations;
  }

  async start(handlers: AdapterHandlers) {
    this.#handlers = handlers;
    handlers.onStatus({ state: "connected", detail: "本地模拟，不经过真实账号" });
  }

  async stop() {
    this.#handlers?.onStatus({ state: "stopped" });
  }

  // Lets a test act out a connection problem.
  reportStatus(status: ChannelStatus) {
    this.#handlers?.onStatus(status);
  }

  // Lets a test act out a platform that signs in by QR code.
  reportLogin(login: ChannelLogin | null) {
    this.#handlers?.onLogin?.(login);
  }

  async send(message: OutboundText) {
    if (this.failNextSend) {
      const error = this.failNextSend;
      this.failNextSend = null;
      throw error;
    }
    this.sent.push(message);
  }

  async sendFile(conversationId: string, path: string, fileName: string) {
    this.sentFiles.push({ conversationId, path, fileName });
  }
}
