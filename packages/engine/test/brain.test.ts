import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { ApiBrain, tokenCost, type BrainReadRequest, type BrainRequest, type ToolOutcome } from "../src/brain.ts";

const MODEL = "claude-opus-5-5";
const GATE = "request_web_search";

type FakeResponse = {
  stop_reason?: string;
  content?: unknown[];
  usage?: Record<string, unknown>;
  throws?: Error;
};

// Records what the brain sends and answers from a script.
function fakeClient(script: FakeResponse[]) {
  const calls: { params: any; options: any }[] = [];
  const client = {
    beta: {
      messages: {
        stream: (params: any, options: any) => ({
          finalMessage: async () => {
            // A copy, so a test sees what this call sent even if the history changes later.
            calls.push({ params: structuredClone(params), options });
            const next = script[calls.length - 1];
            if (!next) throw new Error("the model was called more times than the test expected");
            if (next.throws) throw next.throws;
            return { model: MODEL, usage: { input_tokens: 1000, output_tokens: 100 }, ...next };
          },
        }),
      },
    },
  };
  return { client: client as unknown as Anthropic, calls };
}

const say = (text: string, stop_reason = "end_turn"): FakeResponse => ({ stop_reason, content: [{ type: "text", text }] });
const toolUse = (...names: string[]): FakeResponse => ({
  stop_reason: "tool_use",
  content: names.map((name, index) => ({ type: "tool_use", id: `call-${index}`, name, input: { n: index } })),
});

function request(overrides: Partial<BrainRequest> = {}): BrainRequest {
  return {
    model: MODEL,
    system: "system",
    prompt: "hello",
    tools: [],
    profile: "chat",
    webSearchUses: 0,
    signal: new AbortController().signal,
    onCost: () => {},
    runTool: async (): Promise<ToolOutcome> => ({ content: "ok", isError: false }),
    ...overrides,
  };
}

const toolNames = (call: { params: any }) => (call.params.tools ?? []).map((tool: any) => tool.name);

describe("reading images", () => {
  const readRequest = (overrides: Partial<BrainReadRequest> = {}): BrainReadRequest => ({
    model: MODEL,
    system: "system",
    text: "读这些",
    images: [
      { mediaType: "image/png", data: Buffer.from("first") },
      { mediaType: "image/png", data: Buffer.from("second") },
    ],
    signal: new AbortController().signal,
    onCost: () => {},
    ...overrides,
  });

  it("sends the images in order, then the instruction, and gives back the text", async () => {
    const { client, calls } = fakeClient([say("读到了")]);
    const result = await new ApiBrain({ apiKey: "k", model: MODEL, client }).read(readRequest());
    const content = calls[0]!.params.messages[0].content;
    assert.equal(content[0].source.data, Buffer.from("first").toString("base64"));
    assert.equal(content[0].source.media_type, "image/png");
    assert.equal(content[1].source.data, Buffer.from("second").toString("base64"));
    assert.deepEqual(content[2], { type: "text", text: "读这些" });
    assert.equal(calls[0]!.params.system, "system");
    assert.equal(result.text, "读到了");
  });

  it("offers no tools at all, because everything in the images came from someone else", async () => {
    const { client, calls } = fakeClient([say("读到了")]);
    await new ApiBrain({ apiKey: "k", model: MODEL, client }).read(readRequest());
    assert.equal("tools" in calls[0]!.params, false);
    assert.equal(calls.length, 1);
  });

  it("reports the cost and can be aborted", async () => {
    const { client, calls } = fakeClient([say("读到了")]);
    const controller = new AbortController();
    const costs: number[] = [];
    const result = await new ApiBrain({ apiKey: "k", model: MODEL, client }).read(readRequest({ signal: controller.signal, onCost: (cost) => costs.push(cost) }));
    assert.deepEqual(costs, [result.costUsd]);
    assert.ok(result.costUsd > 0);
    assert.equal(calls[0]!.options.signal, controller.signal);
  });

  it("says when the model refused or ran out of room", async () => {
    const brain = () => new ApiBrain({ apiKey: "k", model: MODEL, client: fakeClient([say("", "refusal")]).client });
    assert.equal((await brain().read(readRequest())).refused, true);
    const cut = new ApiBrain({ apiKey: "k", model: MODEL, client: fakeClient([say("半截", "max_tokens")]).client });
    assert.equal((await cut.read(readRequest())).truncated, true);
  });

  it("asks for a fallback model, except from a model that has none", async () => {
    const opus = fakeClient([say("x")]);
    await new ApiBrain({ apiKey: "k", model: MODEL, client: opus.client }).read(readRequest());
    assert.equal(opus.calls[0]!.params.fallbacks, "default");
    const haiku = fakeClient([say("x")]);
    await new ApiBrain({ apiKey: "k", model: MODEL, client: haiku.client }).read(readRequest({ model: "claude-haiku-5-5" }));
    assert.equal("fallbacks" in haiku.calls[0]!.params, false);
  });
});

describe("what each model costs, per the pricing page", () => {
  const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 };

  it("Opus 5.5", () => close(tokenCost("claude-opus-5-5", usage), 4 + 20 + 0.2 + 5));
  it("Sonnet 5.5", () => close(tokenCost("claude-sonnet-5-5", usage), 2 + 10 + 0.1 + 2.5));

  it("Haiku 5.5 on an ordinary prompt", () => {
    const small = { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 1000 };
    close(tokenCost("claude-haiku-5-5", small), (1000 * 0.1 + 1000 * 0.5 + 1000 * 0.01 + 1000 * 0.125) / 1e6);
  });

  it("Haiku 5.5 charges five times the price once a prompt passes 100,000 tokens", () => {
    close(tokenCost("claude-haiku-5-5", { input_tokens: 100_000, output_tokens: 0 }), (100_000 * 0.1) / 1e6);
    close(tokenCost("claude-haiku-5-5", { input_tokens: 100_001, output_tokens: 1000 }), (100_001 * 0.5 + 1000 * 2.5) / 1e6);
  });

  it("Haiku 5.5 counts cached tokens towards that threshold, and bills them at the higher price too", () => {
    const usage = { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 40_000 };
    close(tokenCost("claude-haiku-5-5", usage), (1 * 0.5 + 60_000 * 0.05 + 40_000 * 0.625) / 1e6);
  });

  it("the threshold is only Haiku's", () => {
    close(tokenCost("claude-sonnet-5-5", { input_tokens: 200_000, output_tokens: 0 }), (200_000 * 2) / 1e6);
  });

  it("charges an unknown model as the dearest, so a budget can't be bypassed", () => {
    close(tokenCost("claude-new-model", { input_tokens: 1000, output_tokens: 1000 }), (1000 * 4 + 1000 * 20) / 1e6);
  });
});

describe("ApiBrain", () => {
  it("sends no tools at all when none are offered", async () => {
    const { client, calls } = fakeClient([say("你好")]);
    const result = await new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(request());
    assert.equal(result.text, "你好");
    assert.equal(calls[0]!.params.tools, undefined);
  });

  it("passes the abort signal to the API call", async () => {
    const { client, calls } = fakeClient([say("你好")]);
    const { signal } = new AbortController();
    await new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(request({ signal }));
    assert.equal(calls[0]!.options.signal, signal);
  });

  it("offers only the small gate tool when search is allowed, so ordinary chat stays cheap", async () => {
    const { client, calls } = fakeClient([say("你好")]);
    const result = await new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(request({ webSearchUses: 3 }));
    assert.equal(calls.length, 1);
    assert.deepEqual(toolNames(calls[0]!), [GATE]);
    assert.equal(result.webSearches, 0);
  });

  it("adds real search when the model asks, answers the request, and adds up both calls", async () => {
    const { client, calls } = fakeClient([
      toolUse(GATE),
      { ...say("晴天"), usage: { input_tokens: 2000, output_tokens: 100, server_tool_use: { web_search_requests: 2 } } },
    ]);
    const costs: number[] = [];
    const result = await new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(request({ webSearchUses: 2, onCost: (cost) => costs.push(cost) }));
    assert.equal(result.text, "晴天");
    assert.deepEqual(toolNames(calls[1]!), [GATE, "web_search"]);
    assert.equal(calls[1]!.params.tools.at(-1).max_uses, 2);
    assert.equal(calls[1]!.params.messages.at(-1).content[0].tool_use_id, "call-0");
    assert.equal(result.webSearches, 2);
    // First call: 1000 in, 100 out. Second: 2000 in, 100 out, plus two searches at $0.01.
    assert.ok(Math.abs(result.costUsd - (((1000 + 2000) * 4 + 200 * 20) / 1e6 + 0.02)) < 1e-9);
    assert.equal(costs.length, 2);
    assert.ok(Math.abs(costs[0]! + costs[1]! - result.costUsd) < 1e-9);
  });

  it("doesn't start over when search is requested part-way, so finished work isn't repeated", async () => {
    const ran: string[] = [];
    const { client, calls } = fakeClient([toolUse("make_file"), toolUse(GATE), say("完成")]);
    await new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(
      request({
        webSearchUses: 1,
        tools: [{ name: "make_file", description: "", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
        runTool: async (name) => {
          ran.push(name);
          return { content: "", isError: false };
        },
      }),
    );
    assert.deepEqual(ran, ["make_file"]);
    assert.equal(calls.length, 3);
    assert.ok(calls[2]!.params.messages.length > calls[1]!.params.messages.length);
  });

  it("runs a local tool that arrives alongside a search request, and answers both", async () => {
    const ran: string[] = [];
    const { client, calls } = fakeClient([toolUse("local_tool", GATE), say("好")]);
    await new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(
      request({
        webSearchUses: 1,
        tools: [{ name: "local_tool", description: "", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
        runTool: async (name) => {
          ran.push(name);
          return { content: "", isError: false };
        },
      }),
    );
    assert.deepEqual(ran, ["local_tool"]);
    assert.deepEqual(calls[1]!.params.messages.at(-1).content.map((result: any) => result.tool_use_id), ["call-0", "call-1"]);
  });

  it("drops earlier thinking when search changes the tool list, because the API rejects it otherwise", async () => {
    const thinking = (name: string): FakeResponse => ({
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "...", signature: "sig" },
        { type: "redacted_thinking", data: "..." },
        { type: "text", text: "我看看" },
        { type: "tool_use", id: "call-0", name, input: {} },
      ],
    });
    const { client, calls } = fakeClient([thinking("local_tool"), thinking(GATE), say("好")]);
    await new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(
      request({ webSearchUses: 1, tools: [{ name: "local_tool", description: "", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] }),
    );
    const kinds = (call: { params: any }) => call.params.messages.filter((message: any) => message.role === "assistant").map((message: any) => message.content.map((part: any) => part.type));
    // Until the tools change, thinking goes back untouched, as the API requires.
    assert.deepEqual(kinds(calls[1]!), [["thinking", "redacted_thinking", "text", "tool_use"]]);
    assert.deepEqual(kinds(calls[2]!), [
      ["text", "tool_use"],
      ["text", "tool_use"],
    ]);
  });

  it("keeps thinking made after search was added", async () => {
    const withThinking: FakeResponse = {
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "...", signature: "sig" },
        { type: "tool_use", id: "call-0", name: "a", input: {} },
      ],
    };
    const { client, calls } = fakeClient([toolUse(GATE), withThinking, say("好")]);
    await new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(request({ webSearchUses: 1 }));
    const last = calls[2]!.params.messages.at(-2);
    assert.equal(last.content[0].type, "thinking");
  });

  it("adds search only once, however often it's requested", async () => {
    const { client, calls } = fakeClient([toolUse(GATE), toolUse(GATE), say("好")]);
    await new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(request({ webSearchUses: 1 }));
    assert.deepEqual(toolNames(calls[2]!), [GATE, "web_search"]);
  });

  it("gives no search if the gate is called when search wasn't allowed, and lets the engine refuse it", async () => {
    const ran: string[] = [];
    const { client, calls } = fakeClient([toolUse(GATE), say("好")]);
    await new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(
      request({
        webSearchUses: 0,
        runTool: async (name) => {
          ran.push(name);
          return { content: "no", isError: true };
        },
      }),
    );
    assert.deepEqual(ran, [GATE]);
    assert.deepEqual(toolNames(calls[1]!), []);
  });

  it("streams local tool input, but not the server's search tool", async () => {
    const { client, calls } = fakeClient([toolUse(GATE), say("好")]);
    await new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(
      request({ webSearchUses: 1, tools: [{ name: "local_tool", description: "", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] }),
    );
    const tools = calls[1]!.params.tools;
    assert.equal(tools.find((tool: any) => tool.name === "local_tool").eager_input_streaming, true);
    assert.equal(tools.find((tool: any) => tool.name === "web_search").eager_input_streaming, undefined);
  });

  it("gives a task more room and more effort than chat", async () => {
    const chat = fakeClient([say("好")]);
    await new ApiBrain({ apiKey: "k", model: MODEL, client: chat.client }).reply(request({ profile: "chat" }));
    const task = fakeClient([say("好")]);
    await new ApiBrain({ apiKey: "k", model: MODEL, client: task.client }).reply(request({ profile: "task" }));
    assert.equal(chat.calls[0]!.params.output_config.effort, "low");
    assert.equal(task.calls[0]!.params.output_config.effort, "medium");
    assert.ok(task.calls[0]!.params.max_tokens > chat.calls[0]!.params.max_tokens);
  });

  it("caches a task's history between rounds, but not chat", async () => {
    const chat = fakeClient([say("好")]);
    await new ApiBrain({ apiKey: "k", model: MODEL, client: chat.client }).reply(request({ profile: "chat" }));
    const task = fakeClient([say("好")]);
    await new ApiBrain({ apiKey: "k", model: MODEL, client: task.client }).reply(request({ profile: "task" }));
    assert.equal(chat.calls[0]!.params.cache_control, undefined);
    assert.deepEqual(task.calls[0]!.params.cache_control, { type: "ephemeral" });
  });

  it("caches a long system prompt on the prompt itself, where the next message can reuse it", async () => {
    const chat = fakeClient([say("好")]);
    await new ApiBrain({ apiKey: "k", model: MODEL, client: chat.client }).reply(request({ profile: "chat", system: "人设", cacheSystem: true }));
    assert.deepEqual(chat.calls[0]!.params.system, [{ type: "text", text: "人设", cache_control: { type: "ephemeral" } }]);
    assert.equal(chat.calls[0]!.params.cache_control, undefined);
    const plain = fakeClient([say("好")]);
    await new ApiBrain({ apiKey: "k", model: MODEL, client: plain.client }).reply(request({ profile: "chat", system: "普通" }));
    assert.equal(plain.calls[0]!.params.system, "普通");
  });

  it("leaves a task's caching as it is, which already covers the system prompt", async () => {
    const task = fakeClient([say("好")]);
    await new ApiBrain({ apiKey: "k", model: MODEL, client: task.client }).reply(request({ profile: "task", system: "任务", cacheSystem: true }));
    assert.equal(task.calls[0]!.params.system, "任务");
    assert.deepEqual(task.calls[0]!.params.cache_control, { type: "ephemeral" });
  });

  it("keeps the cached system prompt on every round of a turn", async () => {
    const { client, calls } = fakeClient([toolUse("tool_a"), say("好")]);
    await new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(
      request({ system: "人设", cacheSystem: true, tools: [{ name: "tool_a", description: "a", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] }),
    );
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1]!.params.system, calls[0]!.params.system);
  });

  it("asks for the model chosen for this request, not its own default", async () => {
    const { client, calls } = fakeClient([say("好")]);
    await new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(request({ model: "claude-sonnet-5-5" }));
    assert.equal(calls[0]!.params.model, "claude-sonnet-5-5");
  });

  it("only asks for a fallback model where one exists, because Haiku rejects the request", async () => {
    for (const model of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
      const { client, calls } = fakeClient([say("好")]);
      await new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(request({ model }));
      assert.equal(calls[0]!.params.fallbacks, "default", model);
      assert.deepEqual(calls[0]!.params.betas, ["server-side-fallback-2026-07-01"], model);
    }
    const { client, calls } = fakeClient([say("好")]);
    await new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(request({ model: "claude-haiku-5-5" }));
    assert.equal(calls[0]!.params.fallbacks, undefined);
    assert.equal(calls[0]!.params.betas, undefined);
  });

  it("charges for the model that actually answered", async () => {
    const { client } = fakeClient([{ ...say("好"), model: "claude-haiku-5-5", usage: { input_tokens: 1000, output_tokens: 1000 } } as FakeResponse]);
    const result = await new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(request({ model: "claude-haiku-5-5" }));
    assert.ok(Math.abs(result.costUsd - (1000 * 0.1 + 1000 * 0.5) / 1e6) < 1e-12);
  });

  it("passes rich tool results on as they are", async () => {
    const blocks = [{ type: "text" as const, text: "看图" }];
    const { client, calls } = fakeClient([toolUse("a"), say("好")]);
    await new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(request({ runTool: async () => ({ content: blocks, isError: false }) }));
    assert.deepEqual(calls[1]!.params.messages.at(-1).content[0].content, blocks);
  });

  it("reports a reply cut off by the limit, and doesn't run its half-written tool call", async () => {
    const ran: string[] = [];
    const { client } = fakeClient([{ stop_reason: "max_tokens", content: [{ type: "text", text: "写到一半" }, { type: "tool_use", id: "c", name: "a", input: {} }] }]);
    const result = await new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(
      request({
        runTool: async (name) => {
          ran.push(name);
          return { content: "", isError: false };
        },
      }),
    );
    assert.equal(result.truncated, true);
    assert.equal(result.text, "写到一半");
    assert.deepEqual(ran, []);
  });

  it("doesn't run a tool call cut off by a refusal", async () => {
    const ran: string[] = [];
    const { client } = fakeClient([{ stop_reason: "refusal", content: [{ type: "tool_use", id: "c", name: "a", input: {} }] }]);
    const result = await new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(
      request({
        runTool: async (name) => {
          ran.push(name);
          return { content: "", isError: false };
        },
      }),
    );
    assert.equal(result.refused, true);
    assert.deepEqual(ran, []);
  });

  const badJson = new Anthropic.AnthropicError('Unable to parse tool parameter JSON from model. Please retry your request or adjust your prompt. Error: x. JSON: {"a');

  it("asks again when the model's tool input can't be parsed", async () => {
    const { client, calls } = fakeClient([{ throws: badJson }, say("好")]);
    const result = await new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(request());
    assert.equal(result.text, "好");
    assert.equal(calls.length, 2);
  });

  it("gives up if that keeps happening", async () => {
    const { client, calls } = fakeClient([{ throws: badJson }, { throws: badJson }, { throws: badJson }, say("好")]);
    await assert.rejects(new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(request()), /Unable to parse/);
    assert.equal(calls.length, 3);
  });

  it("doesn't mistake other failures for that", async () => {
    const { client, calls } = fakeClient([{ throws: new Anthropic.AnthropicError("rate limited") }, say("好")]);
    await assert.rejects(new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(request()), /rate limited/);
    assert.equal(calls.length, 1);
  });

  it("stops at the abort signal before calling the model again", async () => {
    const controller = new AbortController();
    const { client, calls } = fakeClient([toolUse("a"), say("好")]);
    await assert.rejects(
      new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(
        request({
          signal: controller.signal,
          runTool: async () => {
            controller.abort();
            return { content: "", isError: true };
          },
        }),
      ),
    );
    assert.equal(calls.length, 1);
  });

  it("returns every tool result in one message, after keeping the assistant turn unchanged", async () => {
    const assistant = toolUse("a", "b");
    const { client, calls } = fakeClient([assistant, say("完成")]);
    const result = await new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(
      request({ runTool: async (name) => ({ content: `ran ${name}`, isError: name === "b" }) }),
    );
    assert.equal(result.text, "完成");
    const [, assistantTurn, toolTurn] = calls[1]!.params.messages;
    assert.deepEqual(assistantTurn.content, assistant.content);
    assert.deepEqual(toolTurn.content, [
      { type: "tool_result", tool_use_id: "call-0", content: "ran a", is_error: false },
      { type: "tool_result", tool_use_id: "call-1", content: "ran b", is_error: true },
    ]);
  });

  it("continues a paused turn", async () => {
    const paused: FakeResponse = { stop_reason: "pause_turn", content: [{ type: "text", text: "..." }] };
    const { client, calls } = fakeClient([paused, say("完成")]);
    const result = await new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(request());
    assert.equal(result.text, "完成");
    assert.equal(calls[1]!.params.messages.at(-1).role, "assistant");
  });

  it("reports a refusal", async () => {
    const { client } = fakeClient([say("", "refusal")]);
    const result = await new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(request());
    assert.equal(result.refused, true);
  });

  it("gives up after too many rounds of tool calls", async () => {
    const { client } = fakeClient(Array.from({ length: 20 }, () => toolUse("a")));
    await assert.rejects(new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(request()), /rounds/);
  });

  it("lets a task go further before giving up", async () => {
    const { client, calls } = fakeClient([...Array.from({ length: 20 }, () => toolUse("a")), say("完成")]);
    const result = await new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(request({ profile: "task" }));
    assert.equal(result.text, "完成");
    assert.equal(calls.length, 21);
  });
});
