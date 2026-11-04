import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { ApiBrain, type BrainRequest, type ToolOutcome } from "../src/brain.ts";

const MODEL = "claude-opus-5-5";
const GATE = "request_web_search";

type FakeResponse = {
  stop_reason: string;
  content: unknown[];
  usage?: Record<string, unknown>;
};

// Records what the brain sends and answers from a script.
function fakeClient(script: FakeResponse[]) {
  const calls: { params: any; options: any }[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: any, options: any) => {
          // The brain keeps appending to the same array, so keep a snapshot of this call.
          calls.push({ params: { ...params, messages: [...params.messages] }, options });
          const next = script[calls.length - 1];
          if (!next) throw new Error("the model was called more times than the test expected");
          return { model: MODEL, usage: { input_tokens: 1000, output_tokens: 100 }, ...next };
        },
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
    system: "system",
    prompt: "hello",
    tools: [],
    webSearchUses: 0,
    signal: new AbortController().signal,
    runTool: async (): Promise<ToolOutcome> => ({ content: "ok", isError: false }),
    ...overrides,
  };
}

const toolNames = (call: { params: any }) => (call.params.tools ?? []).map((tool: any) => tool.name);

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

  it("runs the turn again with real search when the model asks, and adds up both calls", async () => {
    const { client, calls } = fakeClient([
      toolUse(GATE),
      { ...say("晴天"), usage: { input_tokens: 2000, output_tokens: 100, server_tool_use: { web_search_requests: 2 } } },
    ]);
    const result = await new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(request({ webSearchUses: 2 }));
    assert.equal(result.text, "晴天");
    assert.deepEqual(toolNames(calls[1]!), ["web_search"]);
    assert.equal(calls[1]!.params.tools[0].max_uses, 2);
    assert.equal(calls[1]!.params.messages.length, 1);
    assert.equal(result.webSearches, 2);
    // First call: 1000 in, 100 out. Second: 2000 in, 100 out, plus two searches at $0.01.
    assert.ok(Math.abs(result.costUsd - (((1000 + 2000) * 4 + 200 * 20) / 1e6 + 0.02)) < 1e-9);
  });

  it("never runs a local tool that arrives alongside a search request", async () => {
    const ran: string[] = [];
    const { client } = fakeClient([toolUse("local_tool", GATE), say("好")]);
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
    assert.deepEqual(ran, []);
  });

  it("keeps local tools available during the search run", async () => {
    const { client, calls } = fakeClient([toolUse(GATE), say("好")]);
    await new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(
      request({ webSearchUses: 1, tools: [{ name: "local_tool", description: "", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] }),
    );
    assert.deepEqual(toolNames(calls[1]!), ["local_tool", "web_search"]);
  });

  it("fails rather than looping if the gate is called when search wasn't allowed", async () => {
    const { client } = fakeClient([toolUse(GATE)]);
    await assert.rejects(new ApiBrain({ apiKey: "k", model: MODEL, client }).reply(request({ webSearchUses: 0 })));
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
});
