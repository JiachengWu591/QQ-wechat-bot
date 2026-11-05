import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ServerEvent } from "@shu/protocol";
import { WebSocket } from "ws";
import { startServer } from "../src/server.ts";
import { harness, MEMBER, GROUP } from "./helpers.ts";

const TOKEN = "test-token";
const ORIGIN = "http://localhost:5173";

function connect(port: number, options: { token?: string; origin?: string } = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${options.token ?? TOKEN}`, options.origin ? { origin: options.origin } : {});
  const events: ServerEvent[] = [];
  socket.on("message", (raw) => events.push(JSON.parse(String(raw)) as ServerEvent));
  const opened = new Promise<boolean>((resolve) => {
    socket.once("open", () => resolve(true));
    socket.once("error", () => resolve(false));
  });
  return { socket, events, opened };
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), "timed out waiting for the expected event");
}

describe("local server", () => {
  const h = harness();
  let server: Awaited<ReturnType<typeof startServer>>;

  before(async () => {
    server = await startServer({
      engine: h.engine,
      port: 0,
      token: TOKEN,
      allowedOrigins: [ORIGIN],
      simSenderName: () => "群友小明",
      now: () => 9_000_000,
    });
  });
  after(() => server.close());

  it("rejects a wrong token", async () => {
    assert.equal(await connect(server.port, { token: "wrong", origin: ORIGIN }).opened, false);
  });

  it("rejects a page from another origin, even with the token", async () => {
    assert.equal(await connect(server.port, { origin: "https://evil.example" }).opened, false);
  });

  it("sends the current state on connecting and runs commands", async () => {
    const client = connect(server.port, { origin: ORIGIN });
    assert.equal(await client.opened, true);
    await waitFor(() => client.events.some((event) => event.type === "state"));

    client.socket.send(JSON.stringify({ type: "engine.start" }));
    await waitFor(() => client.events.some((event) => event.type === "state" && event.state.running));

    client.socket.send(JSON.stringify({ type: "sim.send", conversationId: GROUP, senderId: MEMBER, text: "你好", mentionsBot: true }));
    await waitFor(() => client.events.some((event) => event.type === "chat" && event.line.direction === "out"));
    client.socket.terminate();
  });

  it("passes login commands on to the channel, tidying the code", async () => {
    const calls: string[] = [];
    Object.defineProperties(h.adapter, {
      beginLogin: { value: async () => void calls.push("begin"), configurable: true },
      submitLoginCode: { value: (code: string) => void calls.push(`code:${code}`), configurable: true },
      logout: { value: async () => void calls.push("logout"), configurable: true },
    });
    await h.engine.start();
    const client = connect(server.port, { origin: ORIGIN });
    await client.opened;
    client.socket.send(JSON.stringify({ type: "channel.login", channelId: "sim" }));
    client.socket.send(JSON.stringify({ type: "channel.loginCode", channelId: "sim", code: " 1234 " }));
    client.socket.send(JSON.stringify({ type: "channel.logout", channelId: "sim" }));
    await waitFor(() => calls.length === 3);
    assert.deepEqual(calls, ["begin", "code:1234", "logout"]);
    client.socket.terminate();
  });

  it("switches the model, and refuses one that isn't offered", async () => {
    const client = connect(server.port, { origin: ORIGIN });
    await client.opened;
    client.socket.send(JSON.stringify({ type: "brain.setModel", model: "claude-haiku-5-5" }));
    await waitFor(() => client.events.some((event) => event.type === "state" && event.state.brain.model === "claude-haiku-5-5"));
    client.socket.send(JSON.stringify({ type: "brain.setModel", model: "gpt-5" }));
    await waitFor(() => client.events.some((event) => event.type === "error"));
    assert.equal(h.engine.getState().brain.model, "claude-haiku-5-5");
    client.socket.terminate();
  });

  it("answers a malformed command with an error instead of crashing", async () => {
    const client = connect(server.port, { origin: ORIGIN });
    await client.opened;
    client.socket.send("not json");
    client.socket.send(JSON.stringify({ type: "shell.run", command: "dir" }));
    await waitFor(() => client.events.filter((event) => event.type === "error").length === 2);
    client.socket.terminate();
  });
});
