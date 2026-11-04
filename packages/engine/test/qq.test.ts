import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import type { ChannelStatus, InboundMessage } from "@shu/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import { prepareContent, QqAdapter } from "../src/qq.ts";

const SELF = "bot-openid";
const GROUP = "group-openid-abcdef";
const USER = "user-openid";

type Frame = { op: number; d?: any; s?: number; t?: string };
type SentRequest = { path: string; body: any };

// Stands in for QQ, including the ways it can misbehave.
class FakeQq {
  http: Server;
  wss: WebSocketServer;
  frames: Frame[] = [];
  sent: SentRequest[] = [];
  sockets: WebSocket[] = [];
  connections = 0;
  tokenRequests = 0;
  answerHeartbeats = true;
  heartbeatIntervalMs = 40;
  sendFailure: { status: number; body: unknown } | null = null;
  rejectTokenOnce = false;
  #seq = 0;

  constructor() {
    this.http = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const respond = (status: number, body: unknown) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (req.url === "/app/getAppAccessToken") {
          this.tokenRequests++;
          return respond(200, { access_token: `token-${this.tokenRequests}`, expires_in: "7200" });
        }
        if (req.url === "/gateway/bot") return respond(200, { url: `ws://127.0.0.1:${this.port}/ws` });
        if (this.rejectTokenOnce) {
          this.rejectTokenOnce = false;
          return respond(401, { code: 11244, message: "token expired" });
        }
        if (this.sendFailure) return respond(this.sendFailure.status, this.sendFailure.body);
        this.sent.push({ path: req.url ?? "", body: JSON.parse(raw) });
        respond(200, { id: "sent" });
      });
    });
    this.wss = new WebSocketServer({ server: this.http, path: "/ws" });
    this.wss.on("connection", (socket) => {
      this.connections++;
      this.sockets.push(socket);
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: this.heartbeatIntervalMs } }));
      socket.on("message", (raw) => {
        const frame = JSON.parse(String(raw)) as Frame;
        this.frames.push(frame);
        if (frame.op === 1 && this.answerHeartbeats) socket.send(JSON.stringify({ op: 11 }));
        if (frame.op === 2) this.dispatch("READY", { session_id: "session-1", user: { id: SELF, username: "公司狼", bot: true } });
        if (frame.op === 6) this.dispatch("RESUMED", {});
      });
    });
  }

  get port() {
    return (this.http.address() as AddressInfo).port;
  }

  get socket() {
    return this.sockets.at(-1)!;
  }

  listen() {
    return new Promise<void>((resolve) => this.http.listen(0, "127.0.0.1", resolve));
  }

  dispatch(t: string, d: unknown) {
    this.socket.send(JSON.stringify({ op: 0, s: ++this.#seq, t, d }));
  }

  framesWithOp(op: number) {
    return this.frames.filter((frame) => frame.op === op);
  }

  close() {
    return new Promise<void>((resolve) => {
      for (const socket of this.sockets) socket.terminate();
      this.wss.close(() => this.http.close(() => resolve()));
    });
  }
}

async function until(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 400 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), `timed out waiting for: ${label}`);
}

const groupEvent = (overrides: Record<string, unknown> = {}) => ({
  id: `msg-${Math.random()}`,
  group_openid: GROUP,
  content: "大家好",
  author: { id: USER, member_openid: USER, username: "小明" },
  ...overrides,
});

describe("QQ adapter", () => {
  let fake: FakeQq;
  let adapter: QqAdapter;
  const statuses: ChannelStatus[] = [];
  const messages: InboundMessage[] = [];

  async function connect() {
    fake = new FakeQq();
    await fake.listen();
    statuses.length = 0;
    messages.length = 0;
    adapter = new QqAdapter({ appId: "app", appSecret: "secret", apiBase: `http://127.0.0.1:${fake.port}`, backoffMs: 5 });
    await adapter.start({ onMessage: (message) => messages.push(message), onStatus: (status) => statuses.push(status) });
    await until(() => statuses.at(-1)?.state === "connected", "connected");
  }

  afterEach(async () => {
    await adapter.stop();
    await fake.close();
  });

  it("identifies with the group and private message events, then reports the bot's name", async () => {
    await connect();
    const identify = fake.framesWithOp(2)[0]!;
    assert.equal(identify.d.token, "QQBot token-1");
    assert.equal(identify.d.intents, 1 << 25);
    assert.equal(adapter.botName(), "公司狼");
  });

  it("sends heartbeats carrying the last sequence number", async () => {
    await connect();
    fake.dispatch("SOMETHING_ELSE", {});
    await until(() => fake.framesWithOp(1).some((frame) => typeof frame.d === "number"), "heartbeat with seq");
  });

  it("turns a group message into a clean inbound message", async () => {
    await connect();
    fake.dispatch("GROUP_MESSAGE_CREATE", groupEvent({ id: "m1" }));
    await until(() => messages.length === 1, "message");
    assert.deepEqual(
      { ...messages[0], at: 0 },
      {
        id: "m1",
        channelId: "qq",
        conversationId: GROUP,
        conversationKind: "group",
        conversationTitle: "QQ 群 group-",
        senderId: USER,
        senderName: "小明",
        text: "大家好",
        mentionsBot: false,
        at: 0,
      },
    );
  });

  it("recognizes a mention of the bot and removes the raw token from the text", async () => {
    await connect();
    fake.dispatch("GROUP_MESSAGE_CREATE", groupEvent({ content: `<@${SELF}> 你好`, mentions: [{ id: SELF, member_openid: SELF, is_you: true }] }));
    await until(() => messages.length === 1, "message");
    assert.equal(messages[0]!.mentionsBot, true);
    assert.equal(messages[0]!.text, "你好");
  });

  it("recognizes the bot by ID when the platform leaves out is_you", async () => {
    await connect();
    fake.dispatch("GROUP_MESSAGE_CREATE", groupEvent({ content: `<@${SELF}> 你好`, mentions: [{ id: SELF, member_openid: SELF }] }));
    await until(() => messages.length === 1, "message");
    assert.equal(messages[0]!.mentionsBot, true);
  });

  it("doesn't count a mention of someone else, and shows their name", async () => {
    await connect();
    fake.dispatch("GROUP_MESSAGE_CREATE", groupEvent({ content: "<@other> 看这个 <@all>", mentions: [{ member_openid: "other", username: "小红" }] }));
    await until(() => messages.length === 1, "message");
    assert.equal(messages[0]!.mentionsBot, false);
    assert.equal(messages[0]!.text, "@小红 看这个 @全体成员");
  });

  it("treats the @-only event as mentioning the bot", async () => {
    await connect();
    fake.dispatch("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: " 你好" }));
    await until(() => messages.length === 1, "message");
    assert.equal(messages[0]!.mentionsBot, true);
  });

  it("ignores its own messages and other bots, so it can't talk to itself", async () => {
    await connect();
    fake.dispatch("GROUP_MESSAGE_CREATE", groupEvent({ author: { id: SELF, member_openid: SELF, bot: true } }));
    fake.dispatch("GROUP_MESSAGE_CREATE", groupEvent({ author: { id: "other-bot", member_openid: "other-bot", bot: true } }));
    fake.dispatch("GROUP_MESSAGE_CREATE", groupEvent({ id: "real" }));
    await until(() => messages.length === 1, "message");
    assert.equal(messages[0]!.id, "real");
  });

  it("delivers a repeated event only once", async () => {
    await connect();
    fake.dispatch("GROUP_MESSAGE_CREATE", groupEvent({ id: "same" }));
    fake.dispatch("GROUP_AT_MESSAGE_CREATE", groupEvent({ id: "same" }));
    fake.dispatch("GROUP_MESSAGE_CREATE", groupEvent({ id: "next" }));
    await until(() => messages.length === 2, "two messages");
    assert.deepEqual(messages.map((message) => message.id), ["same", "next"]);
  });

  it("describes attachments instead of dropping an image-only message", async () => {
    await connect();
    fake.dispatch("GROUP_MESSAGE_CREATE", groupEvent({ content: "", attachments: [{ content_type: "image/png", filename: "a.png" }] }));
    await until(() => messages.length === 1, "message");
    assert.equal(messages[0]!.text, "[图片]");
  });

  it("maps a private message to a private conversation", async () => {
    await connect();
    fake.dispatch("C2C_MESSAGE_CREATE", { id: "dm1", content: "你好", author: { id: USER, user_openid: USER } });
    await until(() => messages.length === 1, "message");
    assert.equal(messages[0]!.conversationKind, "dm");
    assert.equal(messages[0]!.conversationId, USER);
    assert.equal(messages[0]!.mentionsBot, true);
  });

  it("replies with msg_id and a rising msg_seq, then falls back once the limit is reached", async () => {
    await connect();
    fake.dispatch("GROUP_MESSAGE_CREATE", groupEvent({ id: "m1" }));
    await until(() => messages.length === 1, "message");
    for (let reply = 0; reply < 6; reply++) {
      await adapter.send({ channelId: "qq", conversationId: GROUP, conversationKind: "group", text: `回复${reply}`, replyToId: "m1" });
    }
    assert.equal(fake.sent[0]!.path, `/v2/groups/${GROUP}/messages`);
    assert.deepEqual(fake.sent.slice(0, 5).map((request) => request.body.msg_seq), [1, 2, 3, 4, 5]);
    assert.equal(fake.sent[0]!.body.msg_id, "m1");
    assert.equal(fake.sent[5]!.body.msg_id, undefined);
  });

  it("sends a private reply to the private endpoint", async () => {
    await connect();
    await adapter.send({ channelId: "qq", conversationId: USER, conversationKind: "dm", text: "你好" });
    assert.equal(fake.sent[0]!.path, `/v2/users/${USER}/messages`);
  });

  it("raises an error the engine can report when the platform rejects a message", async () => {
    await connect();
    fake.sendFailure = { status: 400, body: { code: 304003, message: "url not allowed" } };
    await assert.rejects(adapter.send({ channelId: "qq", conversationId: GROUP, conversationKind: "group", text: "你好" }), /304003/);
  });

  it("gets a new token and retries once when the token is rejected", async () => {
    await connect();
    fake.rejectTokenOnce = true;
    await adapter.send({ channelId: "qq", conversationId: GROUP, conversationKind: "group", text: "你好" });
    assert.equal(fake.sent.length, 1);
    assert.equal(fake.tokenRequests, 2);
  });

  it("resumes the same session after the connection drops", async () => {
    await connect();
    fake.dispatch("GROUP_MESSAGE_CREATE", groupEvent());
    await until(() => messages.length === 1, "message");
    fake.socket.terminate();
    await until(() => fake.framesWithOp(6).length === 1, "resume");
    const resume = fake.framesWithOp(6)[0]!;
    assert.equal(resume.d.session_id, "session-1");
    assert.equal(typeof resume.d.seq, "number");
    assert.equal(fake.framesWithOp(2).length, 1);
    await until(() => statuses.at(-1)?.state === "connected", "connected again");
    assert.ok(statuses.some((status) => status.state === "connecting"));
  });

  it("identifies again when the session is invalid", async () => {
    await connect();
    fake.socket.send(JSON.stringify({ op: 9, d: false }));
    await until(() => fake.framesWithOp(2).length === 2, "second identify");
    assert.equal(fake.framesWithOp(6).length, 0);
  });

  it("reconnects when the gateway asks", async () => {
    await connect();
    fake.socket.send(JSON.stringify({ op: 7 }));
    await until(() => fake.framesWithOp(6).length === 1, "resume");
  });

  it("detects a dead connection from unanswered heartbeats", async () => {
    await connect();
    fake.answerHeartbeats = false;
    const before = fake.connections;
    await until(() => fake.connections > before, "new connection");
  });

  it("stops retrying and says why when access is refused", async () => {
    await connect();
    const before = fake.connections;
    fake.socket.close(4014, "intent not allowed");
    await until(() => statuses.at(-1)?.state === "error", "error status");
    assert.match(statuses.at(-1)!.detail!, /4014/);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(fake.connections, before);
  });

  it("doesn't reconnect after being stopped", async () => {
    await connect();
    const before = fake.connections;
    await adapter.stop();
    assert.equal(statuses.at(-1)?.state, "stopped");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(fake.connections, before);
  });

  it("doesn't finish connecting if stopped partway through", async () => {
    fake = new FakeQq();
    await fake.listen();
    adapter = new QqAdapter({ appId: "app", appSecret: "secret", apiBase: `http://127.0.0.1:${fake.port}`, backoffMs: 5 });
    await adapter.start({ onMessage: () => {}, onStatus: () => {} });
    await adapter.stop();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(fake.connections, 0);
  });

  it("starts a fresh session after being stopped, so messages from the off period aren't replayed", async () => {
    await connect();
    await adapter.stop();
    await adapter.start({ onMessage: (message) => messages.push(message), onStatus: (status) => statuses.push(status) });
    await until(() => fake.framesWithOp(2).length === 2, "second identify");
    assert.equal(fake.framesWithOp(6).length, 0);
  });

  it("doesn't deliver a message replayed long after it was sent", async () => {
    await connect();
    const old = new Date(Date.now() - 11 * 60_000).toISOString();
    fake.dispatch("GROUP_MESSAGE_CREATE", groupEvent({ id: "old", timestamp: old }));
    fake.dispatch("C2C_MESSAGE_CREATE", { id: "old-dm", content: "早上好", timestamp: old, author: { user_openid: USER } });
    fake.dispatch("GROUP_MESSAGE_CREATE", groupEvent({ id: "new", timestamp: new Date().toISOString() }));
    await until(() => messages.length >= 1, "message");
    assert.deepEqual(messages.map((message) => message.id), ["new"]);
  });

  it("keeps retrying with no network until the gateway comes back", async () => {
    const dead = new QqAdapter({ appId: "app", appSecret: "secret", apiBase: "http://127.0.0.1:9", backoffMs: 5 });
    const seen: ChannelStatus[] = [];
    await dead.start({ onMessage: () => {}, onStatus: (status) => seen.push(status) });
    await until(() => seen.filter((status) => status.state === "connecting" && status.detail).length >= 2, "two retries");
    await dead.stop();
    fake = new FakeQq();
    await fake.listen();
    adapter = dead;
  });
});

describe("outgoing content", () => {
  it("removes links, which the platform would otherwise reject", () => {
    for (const link of ["https://example.com/a?b=1", "www.example.com", "example.com/path", "news.example.cn"]) {
      const out = prepareContent(`看这个 ${link} 吧`);
      assert.equal(out, "看这个 （链接已省略） 吧", link);
    }
  });

  it("leaves ordinary text and numbers alone", () => {
    assert.equal(prepareContent("版本 2.1 发布了，气温 24.5 度。"), "版本 2.1 发布了，气温 24.5 度。");
  });

  it("shortens a very long reply", () => {
    const out = prepareContent("字".repeat(5000));
    assert.ok(out.length < 1900);
    assert.match(out, /截断/);
  });
});
