import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Brain, BrainRequest, BrainResult } from "../src/brain.ts";
import { Engine, type EngineConfig } from "../src/engine.ts";
import { SIM_CHANNEL_ID, SimAdapter, simConversations, simSenders } from "../src/sim.ts";
import { Store } from "../src/store.ts";
import type { LocalTool } from "../src/tools.ts";
import type { AdapterMessage } from "../src/types.ts";
import { Workspace } from "../src/workspace.ts";

export const OWNER = "sim-owner";
export const TRUSTED = "sim-trusted";
export const MEMBER = "sim-member";
export const GROUP = "sim-group";
export const WORK_GROUP = "sim-work";
export const DM = "sim-dm";

// Stands in for the model. Each test scripts how it behaves, including misbehaving.
export class FakeBrain implements Brain {
  readonly model = "fake";
  requests: BrainRequest[] = [];
  behavior: (request: BrainRequest) => Promise<Partial<BrainResult>> = async () => ({ text: "好的" });

  async reply(request: BrainRequest): Promise<BrainResult> {
    this.requests.push(request);
    const result = await this.behavior(request);
    const costUsd = result.costUsd ?? 0.01;
    request.onCost(costUsd);
    return { text: "", model: this.model, webSearches: 0, refused: false, truncated: false, ...result, costUsd };
  }
}

export type Harness = ReturnType<typeof harness>;

export function harness(options: { config?: Partial<EngineConfig>; brain?: Brain | null; tools?: LocalTool[]; store?: Store } = {}) {
  const store = options.store ?? new Store(":memory:");
  const fake = new FakeBrain();
  const adapter = new SimAdapter();
  const toolRuns: string[] = [];
  const tools: LocalTool[] = [
    {
      name: "safe_tool",
      description: "Open to everyone.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      minTier: "member",
      run: async () => {
        toolRuns.push("safe_tool");
        return "safe";
      },
    },
    {
      name: "owner_tool",
      description: "Owner only.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      minTier: "owner",
      run: async () => {
        toolRuns.push("owner_tool");
        return "secret";
      },
    },
    ...(options.tools ?? []),
  ];
  let clock = 1_000_000;
  const config: EngineConfig = {
    botName: "枢",
    access: {
      owners: [{ channelId: SIM_CHANNEL_ID, senderId: OWNER }],
      trusted: [{ channelId: SIM_CHANNEL_ID, senderId: TRUSTED }],
    },
    dailyLimitUsd: 3,
    ownerDailyLimitUsd: 10,
    taskAckMs: 60_000,
    fileSettleMs: 0,
    webSearch: false,
    sharedSearchesPerDay: 10,
    contextMessages: 30,
    perSenderPerMinute: 100,
    perConversationPerMinute: 100,
    retentionDays: 30,
    simSenders,
    ...options.config,
  };
  // Nothing is created on disk until a test saves a file.
  const workspace = new Workspace(join(tmpdir(), `shu-test-${randomUUID()}`));
  const engine = new Engine({
    store,
    brain: options.brain === undefined ? fake : options.brain,
    adapters: [adapter],
    tools,
    workspace,
    config,
    now: () => clock,
  });
  const activity: string[] = [];
  engine.on("activity", (entry) => activity.push(`${entry.level}: ${entry.summary}`));

  let nextId = 0;
  function message(senderId: string, conversationId: string, text: string, overrides: Partial<AdapterMessage> = {}): AdapterMessage {
    clock += 1000;
    const known = simConversations.find((conversation) => conversation.id === conversationId);
    return {
      id: `m${nextId++}`,
      channelId: SIM_CHANNEL_ID,
      conversationId,
      conversationKind: known?.kind ?? "group",
      conversationTitle: known?.title ?? "新群",
      senderId,
      senderName: simSenders.find((sender) => sender.id === senderId)?.name ?? "陌生人",
      text,
      mentionsBot: true,
      at: clock,
      ...overrides,
    };
  }

  return {
    store,
    fake,
    adapter,
    engine,
    workspace,
    toolRuns,
    activity,
    message,
    advance(ms: number) {
      clock += ms;
    },
  };
}
