// The model behind the bot. Chat goes straight to the Claude API with an explicit tool
// list, so a turn can only ever reach the tools the engine chose to offer it.
import Anthropic from "@anthropic-ai/sdk";
import type { ToolInputSchema } from "./tools.ts";

export type BrainTool = { name: string; description: string; inputSchema: ToolInputSchema };

export type ToolOutcome = { content: string; isError: boolean };

export type BrainRequest = {
  system: string;
  prompt: string;
  tools: BrainTool[];
  // How many searches this turn may make. Zero leaves search out entirely.
  webSearchUses: number;
  signal: AbortSignal;
  runTool(name: string, input: unknown): Promise<ToolOutcome>;
};

export type BrainResult = {
  text: string;
  model: string;
  costUsd: number;
  webSearches: number;
  refused: boolean;
};

export interface Brain {
  readonly model: string;
  reply(request: BrainRequest): Promise<BrainResult>;
}

// USD per million tokens. Check against the pricing page when models change.
const prices: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

const USD_PER_SEARCH = 0.01;
const MAX_ITERATIONS = 8;

// Offering the real search tool multiplied the cost of every reply, even ones that never
// searched: about $0.026 against $0.004 per short reply in real use. So a turn first gets
// only this small tool, and runs again with real search if the model asks for it.
const SEARCH_GATE: Anthropic.Beta.BetaTool = {
  name: "request_web_search",
  description: "Call this only when answering needs current information or a web lookup. You'll then be given web search. Don't call it for ordinary chat.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
};

type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

export function tokenCost(model: string, usage: Usage): number {
  const price = prices[model];
  if (!price) return 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return (usage.input_tokens * price.input + cacheRead * price.input * 0.1 + cacheWrite * price.input * 1.25 + usage.output_tokens * price.output) / 1e6;
}

type Tally = { costUsd: number; webSearches: number };

export class ApiBrain implements Brain {
  readonly model: string;
  #client: Anthropic;

  constructor(options: { apiKey: string; model: string; client?: Anthropic }) {
    this.#client = options.client ?? new Anthropic({ apiKey: options.apiKey });
    this.model = options.model;
  }

  async reply(request: BrainRequest): Promise<BrainResult> {
    const tally: Tally = { costUsd: 0, webSearches: 0 };
    const first = await this.#runTurn(request, request.webSearchUses > 0 ? [SEARCH_GATE] : [], tally);
    const result =
      first ??
      (await this.#runTurn(request, [{ type: "web_search_20260209", name: "web_search", max_uses: request.webSearchUses }], tally));
    if (!result) throw new Error("The model asked for web search again after it was given.");
    return { ...result, ...tally };
  }

  // Returns null if the model asked for web search instead of answering.
  async #runTurn(request: BrainRequest, extraTools: Anthropic.Beta.BetaToolUnion[], tally: Tally): Promise<Omit<BrainResult, keyof Tally> | null> {
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: request.prompt }];
    const tools: Anthropic.Beta.BetaToolUnion[] = [
      ...request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })),
      ...extraTools,
    ];

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const response = await this.#client.beta.messages.create(
        {
          model: this.model,
          max_tokens: 16000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: "low" },
          system: request.system,
          messages,
          ...(tools.length ? { tools } : {}),
        },
        { signal: request.signal },
      );
      const searches = response.usage.server_tool_use?.web_search_requests ?? 0;
      tally.webSearches += searches;
      tally.costUsd += tokenCost(response.model, response.usage) + searches * USD_PER_SEARCH;

      if (response.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: response.content });
        continue;
      }
      if (response.stop_reason === "tool_use") {
        const calls = response.content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use");
        if (calls.some((call) => call.name === SEARCH_GATE.name)) {
          return extraTools.includes(SEARCH_GATE) ? null : Promise.reject(new Error("Unexpected search request."));
        }
        messages.push({ role: "assistant", content: response.content });
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const call of calls) {
          const outcome = await request.runTool(call.name, call.input);
          results.push({ type: "tool_result", tool_use_id: call.id, content: outcome.content, is_error: outcome.isError });
        }
        messages.push({ role: "user", content: results });
        continue;
      }

      const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
      return { text, model: response.model, refused: response.stop_reason === "refusal" };
    }
    throw new Error(`The model didn't finish within ${MAX_ITERATIONS} rounds of tool calls.`);
  }
}
