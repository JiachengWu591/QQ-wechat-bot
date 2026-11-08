// Local tools the bot can call. Each one states the lowest tier allowed to use it, and
// the engine checks that twice: when offering tools and again when one is called.
import type { ConversationKind, Tier } from "@shu/protocol";
import type { ToolBlock } from "./brain.ts";
import type { ChatImage } from "./types.ts";

// Who the turn is answering, filled in by the engine from the message itself. A tool that acts for
// someone, such as casting a vote, goes by this and never by what the model passes in.
export type ToolCaller = {
  channelId: string;
  conversationId: string;
  conversationKind: ConversationKind;
  senderId: string;
  senderName: string;
  // The person's own standing, which in a group can be above what the turn is allowed.
  senderTier: Tier;
};

export type ToolInputSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
};

export type ToolContext = {
  // Sends a file back to the conversation this turn belongs to, through the send gate.
  sendFile?(absolutePath: string, fileName: string): Promise<void>;
  // Pictures, or a formatted card, to the same place and through the same gate. Only where the
  // platform can show them and the reply goes out without waiting for the owner.
  sendImages?(images: ChatImage[], caption?: string): Promise<void>;
  sendCard?(markdown: string): Promise<void>;
  // Ends with the turn.
  signal?: AbortSignal;
  // For a tool that calls the model itself, which is paid for from this turn's budget.
  onCost?(costUsd: number): void;
  caller?: ToolCaller;
};

export type LocalTool = {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  minTier: Tier;
  // Only offered when the platform can deliver files.
  needsSendFile?: boolean;
  run(input: unknown, context: ToolContext): Promise<string | ToolBlock[]>;
};

export const noInput: ToolInputSchema = { type: "object", properties: {}, additionalProperties: false };

export const currentTimeTool: LocalTool = {
  name: "current_time",
  description: "Get the current date and time on the bot's computer.",
  inputSchema: noInput,
  minTier: "member",
  run: async () => new Date().toLocaleString("zh-CN"),
};
