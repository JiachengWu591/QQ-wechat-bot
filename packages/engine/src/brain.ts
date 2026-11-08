// The model behind the bot. Chat goes straight to the Claude API with an explicit tool
// list, so a turn can only ever reach the tools the engine chose to offer it.
import Anthropic from "@anthropic-ai/sdk";
import type { ImagePart } from "./images.ts";
import type { ToolInputSchema } from "./tools.ts";

export type BrainTool = { name: string; description: string; inputSchema: ToolInputSchema };

export type ToolBlock = Anthropic.Beta.BetaTextBlockParam | Anthropic.Beta.BetaImageBlockParam | Anthropic.Beta.BetaRequestDocumentBlock;

export type ToolOutcome = { content: string | ToolBlock[]; isError: boolean };

// Chat is short and frequent. A task can write a whole document and take many tool calls.
export type BrainProfile = "chat" | "task";

export type BrainRequest = {
  model: string;
  system: string;
  prompt: string;
  tools: BrainTool[];
  profile: BrainProfile;
  // How many searches each model call may make. Zero leaves search out entirely.
  webSearchUses: number;
  // How many pages each model call may fetch. Only offered when the message has a link in it.
  webFetchUses?: number;
  // The system prompt is long and the same on every message, like a persona's: worth caching even
  // for a one-call chat reply, since the next message in the conversation reuses it.
  cacheSystem?: boolean;
  signal: AbortSignal;
  // Called after every API response, so spending is known even if the turn never finishes.
  onCost(costUsd: number): void;
  runTool(name: string, input: unknown): Promise<ToolOutcome>;
};

export type BrainResult = {
  text: string;
  model: string;
  costUsd: number;
  webSearches: number;
  webFetches?: number;
  refused: boolean;
  // The reply hit the output limit, so it stops mid-way.
  truncated: boolean;
};

export type BrainReadRequest = {
  model: string;
  system: string;
  text: string;
  images: ImagePart[];
  signal: AbortSignal;
  onCost(costUsd: number): void;
};

export type BrainReadResult = { text: string; model: string; costUsd: number; refused: boolean; truncated: boolean };

export interface Brain {
  // The model to use until the owner chooses another.
  readonly model: string;
  reply(request: BrainRequest): Promise<BrainResult>;
  // For what other people wrote. One call with no tools at all, so nothing in it can get anything done.
  read(request: BrainReadRequest): Promise<BrainReadResult>;
}

// USD per million tokens, from the pricing page. Check it when models change. Cache writes are
// the 5-minute kind, which is what automatic caching uses.
type Rates = { input: number; cacheWrite: number; cacheRead: number; output: number };

const OPUS_RATES: Rates = { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 };
const rates: Record<string, Rates> = {
  "claude-opus-5-5": OPUS_RATES,
  "claude-sonnet-5-5": { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 },
  "claude-haiku-5-5": { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 },
};

// Haiku bills a whole request at five times the price once its prompt passes this size, and
// cached tokens count towards it. A long task can get there.
const HAIKU_LONG_PROMPT_TOKENS = 100_000;
const HAIKU_LONG_PROMPT_RATES: Rates = { input: 0.5, cacheWrite: 0.625, cacheRead: 0.05, output: 2.5 };

// Haiku rejects a fallback request, because it has no fallback model.
const MODELS_WITHOUT_FALLBACK = new Set(["claude-haiku-5-5"]);

const USD_PER_SEARCH = 0.01;
const MAX_BAD_JSON_RETRIES = 2;

// A task sends its whole history again on every round, which is what caching is for. A chat
// reply is usually one call, so caching would only add the write premium.
const profiles = {
  chat: { maxTokens: 16000, maxRounds: 8, effort: "low", cache: false },
  task: { maxTokens: 64000, maxRounds: 25, effort: "medium", cache: true },
} as const;

// Offering the real search tool multiplied the cost of every reply, even ones that never
// searched: about $0.026 against $0.004 per short reply in real use. So a turn starts with
// only this small tool, and real search is added once the model asks for it.
const SEARCH_GATE: Anthropic.Beta.BetaTool = {
  name: "request_web_search",
  description: "Call this only when answering needs current information or a web lookup. You'll then be given web search. Don't call it for ordinary chat.",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
};

// A page someone linked to. Only links typed in the conversation can be fetched, never ones a
// fetched page or search result points to, so a page can't send the bot on somewhere else.
const MAX_FETCH_CONTENT_TOKENS = 12_000;

export function webFetchTool(model: string, uses: number): Anthropic.Beta.BetaToolUnion {
  const common = {
    name: "web_fetch" as const,
    max_uses: uses,
    max_content_tokens: MAX_FETCH_CONTENT_TOKENS,
    url_sources: { user_input: { type: "all" as const }, server_tool_results: { type: "none" as const }, client_tool_results: { type: "none" as const } },
  };
  // The version that filters pages with code runs only on the larger models.
  return model === "claude-haiku-5-5" ? { type: "web_fetch_20250910", ...common } : { type: "web_fetch_20260209", ...common };
}

type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

export function tokenCost(model: string, usage: Usage): number {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const promptTokens = usage.input_tokens + cacheRead + cacheWrite;
  // A model missing from the table counts as the dearest, so a budget stops early, not never.
  const price = model === "claude-haiku-5-5" && promptTokens > HAIKU_LONG_PROMPT_TOKENS ? HAIKU_LONG_PROMPT_RATES : (rates[model] ?? OPUS_RATES);
  return (usage.input_tokens * price.input + cacheRead * price.cacheRead + cacheWrite * price.cacheWrite + usage.output_tokens * price.output) / 1e6;
}

// Streamed tool input isn't checked by the API, and the SDK raises this when it can't be
// parsed at all. No tool call came out of it, so the request can simply be made again.
function isBadToolJson(error: unknown): boolean {
  return error instanceof Anthropic.AnthropicError && error.message.startsWith("Unable to parse tool parameter JSON");
}

export class ApiBrain implements Brain {
  readonly model: string;
  #client: Anthropic;

  constructor(options: { apiKey: string; model: string; client?: Anthropic }) {
    this.#client = options.client ?? new Anthropic({ apiKey: options.apiKey });
    this.model = options.model;
  }

  async reply(request: BrainRequest): Promise<BrainResult> {
    const profile = profiles[request.profile];
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: request.prompt }];
    const tools: Anthropic.Beta.BetaToolUnion[] = [
      // Tool inputs can be whole documents, so they stream. Every local tool validates what
      // it receives, since nothing else does for streamed input.
      ...request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema, eager_input_streaming: true })),
      ...(request.webSearchUses > 0 ? [SEARCH_GATE] : []),
      ...(request.webFetchUses ? [webFetchTool(request.model, request.webFetchUses)] : []),
    ];
    // The breakpoint goes on the system prompt itself: placed automatically, it would land on the
    // message, which is different every time, and nothing would be reused.
    const system: string | Anthropic.Beta.BetaTextBlockParam[] =
      request.cacheSystem && !profile.cache ? [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }] : request.system;
    let searchAdded = false;
    let costUsd = 0;
    let webSearches = 0;
    let webFetches = 0;
    let badJsonRetries = 0;

    for (let round = 0; round < profile.maxRounds; round++) {
      request.signal.throwIfAborted();

      let response: Anthropic.Beta.BetaMessage;
      try {
        response = await this.#client.beta.messages
          .stream(
            {
              model: request.model,
              max_tokens: profile.maxTokens,
              ...(MODELS_WITHOUT_FALLBACK.has(request.model) ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
              output_config: { effort: profile.effort },
              ...(profile.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
              system,
              messages,
              ...(tools.length ? { tools } : {}),
            },
            { signal: request.signal },
          )
          .finalMessage();
      } catch (error) {
        if (isBadToolJson(error) && badJsonRetries < MAX_BAD_JSON_RETRIES) {
          badJsonRetries += 1;
          continue;
        }
        throw error;
      }

      const searches = response.usage.server_tool_use?.web_search_requests ?? 0;
      const cost = tokenCost(response.model, response.usage) + searches * USD_PER_SEARCH;
      webSearches += searches;
      // Fetching costs nothing beyond the page's tokens, which are counted above.
      webFetches += response.usage.server_tool_use?.web_fetch_requests ?? 0;
      costUsd += cost;
      request.onCost(cost);

      if (response.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: response.content });
        continue;
      }

      if (response.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: response.content });
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type !== "tool_use") continue;
          if (block.name === SEARCH_GATE.name && request.webSearchUses > 0) {
            if (!searchAdded) {
              searchAdded = true;
              tools.push({ type: "web_search_20260209", name: "web_search", max_uses: request.webSearchUses });
              // The API rejects thinking made under a different tool list. This happens at
              // most once per turn, and the model only loses its reasoning, not its work.
              for (const message of messages) {
                if (message.role === "assistant" && Array.isArray(message.content)) {
                  message.content = message.content.filter((part) => part.type !== "thinking" && part.type !== "redacted_thinking");
                }
              }
            }
            results.push({ type: "tool_result", tool_use_id: block.id, content: "Web search is available now." });
            continue;
          }
          const outcome = await request.runTool(block.name, block.input);
          results.push({ type: "tool_result", tool_use_id: block.id, content: outcome.content, is_error: outcome.isError });
        }
        messages.push({ role: "user", content: results });
        continue;
      }

      // A reply cut off by the limit or a refusal may end in a half-written tool call, which
      // is never run: only a "tool_use" stop reaches the code above.
      return {
        text: response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
        model: response.model,
        costUsd,
        webSearches,
        webFetches,
        refused: response.stop_reason === "refusal",
        truncated: response.stop_reason === "max_tokens",
      };
    }
    throw new Error(`The model didn't finish within ${profile.maxRounds} rounds of tool calls.`);
  }

  async read(request: BrainReadRequest): Promise<BrainReadResult> {
    const images = request.images.map((image) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: image.mediaType, data: image.data.toString("base64") },
    }));
    const response = await this.#client.beta.messages
      .stream(
        {
          model: request.model,
          max_tokens: profiles.chat.maxTokens,
          ...(MODELS_WITHOUT_FALLBACK.has(request.model) ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
          output_config: { effort: profiles.chat.effort },
          system: request.system,
          messages: [{ role: "user", content: [...images, { type: "text", text: request.text }] }],
        },
        { signal: request.signal },
      )
      .finalMessage();
    const costUsd = tokenCost(response.model, response.usage);
    request.onCost(costUsd);
    return {
      text: response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
      model: response.model,
      costUsd,
      refused: response.stop_reason === "refusal",
      truncated: response.stop_reason === "max_tokens",
    };
  }
}
