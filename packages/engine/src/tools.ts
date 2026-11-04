// Local tools the bot can call. Each one states the lowest tier allowed to use it, and
// the engine checks that twice: when offering tools and again when one is called.
import { mkdir, readdir } from "node:fs/promises";
import type { Tier } from "@shu/protocol";

export type ToolInputSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
};

export type LocalTool = {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  minTier: Tier;
  run(input: unknown): Promise<string>;
};

const noInput: ToolInputSchema = { type: "object", properties: {}, additionalProperties: false };

export function defaultTools(workspaceDir: string): LocalTool[] {
  return [
    {
      name: "current_time",
      description: "Get the current date and time on the bot's computer.",
      inputSchema: noInput,
      minTier: "member",
      run: async () => new Date().toLocaleString("zh-CN"),
    },
    {
      name: "list_workspace_files",
      description: "List the file names in the owner's workspace folder on this computer.",
      inputSchema: noInput,
      minTier: "owner",
      run: async () => {
        await mkdir(workspaceDir, { recursive: true });
        const names = await readdir(workspaceDir);
        return names.length ? names.join("\n") : "(the workspace folder is empty)";
      },
    },
  ];
}
