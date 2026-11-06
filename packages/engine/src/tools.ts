// Local tools the bot can call. Each one states the lowest tier allowed to use it, and
// the engine checks that twice: when offering tools and again when one is called.
import type { Tier } from "@shu/protocol";
import type { ToolBlock } from "./brain.ts";

export type ToolInputSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
};

export type ToolContext = {
  // Sends a file back to the conversation this turn belongs to, through the send gate.
  sendFile?(absolutePath: string, fileName: string): Promise<void>;
  // Ends with the turn.
  signal?: AbortSignal;
  // For a tool that calls the model itself, which is paid for from this turn's budget.
  onCost?(costUsd: number): void;
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
