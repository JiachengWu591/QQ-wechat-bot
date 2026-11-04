import type { InboundMessage } from "@shu/protocol";
import type { Brain, BrainRequest, BrainResult } from "../src/brain.ts";
import { Engine, type EngineConfig } from "../src/engine.ts";
import { SIM_CHANNEL_ID, SimAdapter, simConversations, simSenders } from "../src/sim.ts";
import { Store } from "../src/store.ts";
import type { LocalTool } from "../src/tools.ts";

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
    return { text: "", model: this.model, costUsd: 0.01, webSearches: 0, refused: false, ...result };
  }
}

export type Harness = ReturnType<typeof harness>;

export function harness(options: { config?: Partial<EngineConfig>; brain?: Brain | null } = {}) {
  const store = new Store(":memory:");
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
  ];
  let clock = 1_000_000;
  const config: EngineConfig = {
    botName: "枢",
    access: {
      owners: [{ channelId: SIM_CHANNEL_ID, senderId: OWNER }],
      trusted: [{ channelId: SIM_CHANNEL_ID, senderId: TRUSTED }],
    },
    dailyLimitUsd: 3,
    webSearch: false,
    sharedSearchesPerDay: 10,
    contextMessages: 30,
    perSenderPerMinute: 100,
    perConversationPerMinute: 100,
    retentionDays: 30,
    simSenders,
    ...options.config,
  };
  const engine = new Engine({
    store,
    brain: options.brain === undefined ? fake : options.brain,
    adapters: [adapter],
    tools,
    config,
    now: () => clock,
  });
  const activity: string[] = [];
  engine.on("activity", (entry) => activity.push(`${entry.level}: ${entry.summary}`));

  let nextId = 0;
  function message(senderId: string, conversationId: string, text: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
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
    toolRuns,
    activity,
    message,
    advance(ms: number) {
      clock += ms;
    },
  };
}
