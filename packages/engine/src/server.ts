// The console's only way in: a WebSocket on loopback. Web pages can reach loopback too,
// so a connection needs both the per-run token and an allowed origin.
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { commandSchema, type ActivityEntry, type ChatLine, type Command, type EngineState, type ServerEvent } from "@shu/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import type { Engine } from "./engine.ts";
import { SIM_CHANNEL_ID, simConversations } from "./sim.ts";

export type ServerOptions = {
  engine: Engine;
  port: number;
  token: string;
  allowedOrigins: string[];
  simSenderName(senderId: string): string | undefined;
  now?: () => number;
};

function tokenMatches(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function startServer(options: ServerOptions): Promise<{ port: number; close(): Promise<void> }> {
  const { engine, token, allowedOrigins } = options;
  const now = options.now ?? Date.now;

  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: options.port,
    verifyClient: ({ origin, req }: { origin?: string; req: IncomingMessage }) => {
      if (origin && !allowedOrigins.includes(origin)) return false;
      const url = new URL(req.url ?? "/", "ws://127.0.0.1");
      return tokenMatches(url.searchParams.get("token"), token);
    },
  });

  const send = (socket: WebSocket, event: ServerEvent) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  };
  const broadcast = (event: ServerEvent) => {
    for (const socket of wss.clients) send(socket, event);
  };

  const onState = (state: EngineState) => broadcast({ type: "state", state });
  const onActivity = (entry: ActivityEntry) => broadcast({ type: "activity", entry });
  const onChat = (line: ChatLine) => broadcast({ type: "chat", line });
  engine.on("state", onState);
  engine.on("activity", onActivity);
  engine.on("chat", onChat);

  async function run(command: Command) {
    switch (command.type) {
      case "engine.start":
        return engine.start();
      case "engine.stop":
        return engine.stop();
      case "brain.setModel":
        return engine.setModel(command.model);
      case "channel.setEnabled":
        return engine.setChannelEnabled(command.channelId, command.enabled);
      case "channel.login":
        return engine.beginChannelLogin(command.channelId);
      case "channel.loginCode":
        return engine.submitChannelLoginCode(command.channelId, command.code);
      case "channel.logout":
        return engine.logoutChannel(command.channelId);
      case "conversation.setEnabled":
        return engine.setConversationEnabled(command.channelId, command.conversationId, command.enabled);
      case "conversation.setAutonomy":
        return engine.setConversationAutonomy(command.channelId, command.conversationId, command.autonomy);
      case "pending.approve":
        return engine.approve(command.pendingId, command.text, {
          ...(command.confirmedUnsent ? { confirmedUnsent: true } : {}),
          ...(command.mention ? { mention: command.mention } : {}),
        });
      case "pending.reject":
        return engine.reject(command.pendingId);
      case "conversation.rename":
        return engine.renameConversation(command.channelId, command.conversationId, command.title);
      case "pairing.start":
        return engine.startPairing(command.channelId, command.tier);
      case "pairing.cancel":
        return engine.cancelPairing();
      case "access.remove":
        return engine.removeAccess(command.channelId, command.senderId);
      case "workbench.setEnabled":
        return engine.setWorkbenchEnabled(command.enabled);
      case "workbench.allowGroup":
        return engine.allowWorkbenchGroup(command.name);
      case "workbench.removeGroup":
        return engine.removeWorkbenchGroup(command.name);
      case "sim.send": {
        const conversation = simConversations.find((entry) => entry.id === command.conversationId);
        if (!conversation) throw new Error("没有这个模拟聊天。");
        return engine.handleInbound({
          id: randomUUID(),
          channelId: SIM_CHANNEL_ID,
          conversationId: conversation.id,
          conversationKind: conversation.kind,
          conversationTitle: conversation.title,
          senderId: command.senderId,
          senderName: options.simSenderName(command.senderId) ?? command.senderId,
          text: command.text,
          mentionsBot: command.mentionsBot,
          at: now(),
        });
      }
    }
  }

  wss.on("connection", (socket) => {
    send(socket, { type: "state", state: engine.getState() });
    send(socket, { type: "history", ...engine.history() });
    socket.on("message", (raw) => {
      let command: Command;
      try {
        command = commandSchema.parse(JSON.parse(String(raw)));
      } catch {
        return send(socket, { type: "error", message: "无法识别这条指令。" });
      }
      run(command).catch((error: unknown) => {
        send(socket, { type: "error", message: error instanceof Error ? error.message : String(error) });
      });
    });
  });

  return new Promise((resolve, reject) => {
    wss.once("error", reject);
    wss.once("listening", () => {
      const address = wss.address();
      resolve({
        port: typeof address === "object" && address ? address.port : options.port,
        close: () =>
          new Promise<void>((done) => {
            engine.off("state", onState);
            engine.off("activity", onActivity);
            engine.off("chat", onChat);
            for (const socket of wss.clients) socket.terminate();
            wss.close(() => done());
          }),
      });
    });
  });
}
