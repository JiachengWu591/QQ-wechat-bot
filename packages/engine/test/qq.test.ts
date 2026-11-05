import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it, type TestContext } from "node:test";
import type { ChannelStatus, InboundMessage } from "@shu/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import { describeNetworkError, networkErrorCode } from "../src/net.ts";
import { prepareContent, QqAdapter, QqApiError } from "../src/qq.ts";

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
  tokenExpiresIn = "7200";
  // What happens to particular token requests, by number, counting from 1.
  tokenPlan = new Map<number, "drop" | "hold">();
  dropHeldTokenRequest: (() => void) | null = null;
  badGatewayUrlOnce = false;
  // What happens to each coming send, in order. Once these run out, sends work normally.
  sendPlan: Array<"drop" | "arrive-then-drop" | { status: number; body: unknown }> = [];
  sendAttempts = 0;
  #acceptedReplies = new Set<string>();
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
          const step = this.tokenPlan.get(this.tokenRequests);
          if (step === "drop") return req.socket.destroy();
          if (step === "hold") {
            this.dropHeldTokenRequest = () => req.socket.destroy();
            return;
          }
          return respond(200, { access_token: `token-${this.tokenRequests}`, expires_in: this.tokenExpiresIn });
        }
        if (req.url === "/gateway/bot") {
          if (this.badGatewayUrlOnce) {
            this.badGatewayUrlOnce = false;
            return respond(200, { url: "not a url" });
          }
          return respond(200, { url: `ws://127.0.0.1:${this.port}/ws` });
        }
        if (this.rejectTokenOnce) {
          this.rejectTokenOnce = false;
          return respond(401, { code: 11244, message: "token expired" });
        }
        this.sendAttempts++;
        if (this.sendFailure) return respond(this.sendFailure.status, this.sendFailure.body);
        const step = this.sendPlan.shift();
        if (step === "drop") return req.socket.destroy();
        if (step && step !== "arrive-then-drop") return respond(step.status, step.body);
        const body = JSON.parse(raw);
        // The real platform refuses a second copy of a reply.
        const reply = body.msg_id ? `${body.msg_id}/${body.msg_seq}` : null;
        if (reply && this.#acceptedReplies.has(reply)) return respond(400, { code: 40054005, message: "消息被去重" });
        if (reply) this.#acceptedReplies.add(reply);
        this.sent.push({ path: req.url ?? "", body });
        if (step === "arrive-then-drop") return req.socket.destroy();
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

  async function connect(backoffMs = 5) {
    fake = new FakeQq();
    await fake.listen();
    statuses.length = 0;
    messages.length = 0;
    adapter = new QqAdapter({ appId: "app", appSecret: "secret", apiBase: `http://127.0.0.1:${fake.port}`, backoffMs });
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

  it("says what went wrong while reconnecting, not just that a fetch failed", async () => {
    fake = new FakeQq();
    await fake.listen();
    const closedPort = fake.port;
    await fake.close();
    adapter = new QqAdapter({ appId: "app", appSecret: "secret", apiBase: `http://127.0.0.1:${closedPort}`, backoffMs: 5 });
    const seen: ChannelStatus[] = [];
    await adapter.start({ onMessage: () => {}, onStatus: (status) => seen.push(status) });
    await until(() => seen.some((status) => status.detail), "a reason");
    assert.equal(seen.find((status) => status.detail)!.detail, "网络错误（ECONNREFUSED），正在重连");
    await adapter.stop();
    fake = new FakeQq();
    await fake.listen();
  });

  // A failure here that nothing catches would end the whole engine, and it restarts switched off.
  describe("when handling the gateway fails", () => {
    async function startWith(prepare: (fake: FakeQq) => void) {
      fake = new FakeQq();
      await fake.listen();
      prepare(fake);
      statuses.length = 0;
      adapter = new QqAdapter({ appId: "app", appSecret: "secret", apiBase: `http://127.0.0.1:${fake.port}`, backoffMs: 5 });
      await adapter.start({ onMessage: (message) => messages.push(message), onStatus: (status) => statuses.push(status) });
    }
    const connected = () => statuses.at(-1)?.state === "connected";

    // A token this close to expiring is fetched again every time it's used: once to connect,
    // once for the gateway address, and the third time in answer to the gateway's hello.
    const tokenRequestAtHello = 3;

    it("reconnects when the token can't be refreshed during the handshake", async () => {
      await startWith((qq) => {
        qq.tokenExpiresIn = "60";
        qq.tokenPlan.set(tokenRequestAtHello, "drop");
      });
      await until(connected, "connected on the next try");
      assert.equal(fake.connections, 2);
      assert.ok(statuses.some((status) => status.detail === "网络错误（UND_ERR_SOCKET），正在重连"));
    });

    it("leaves the new connection alone when the old one's token request fails late", async () => {
      await startWith((qq) => {
        qq.tokenExpiresIn = "60";
        qq.tokenPlan.set(tokenRequestAtHello, "hold");
      });
      await until(() => fake.dropHeldTokenRequest !== null, "the handshake to be waiting on a token");
      fake.socket.terminate();
      await until(connected, "connected on the next try");

      fake.dropHeldTokenRequest!();
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(fake.connections, 2);
      assert.ok(connected());
    });

    it("reconnects after a frame it can't read", async () => {
      await connect();
      fake.socket.send("not json");
      await until(() => fake.connections === 2, "a new connection");
      await until(() => fake.framesWithOp(6).length === 1, "resume");
    });

    it("reconnects after an event it can't process, and doesn't see that event again", async () => {
      await connect();
      fake.dispatch("GROUP_MESSAGE_CREATE", null);
      await until(() => fake.framesWithOp(6).length === 1, "resume");
      assert.equal(fake.framesWithOp(6)[0]!.d.seq, 2, "past the bad event, which was number 2 after READY");
      await until(connected, "connected again");
      fake.dispatch("GROUP_MESSAGE_CREATE", groupEvent({ id: "after" }));
      await until(() => messages.some((message) => message.id === "after"), "the next message");
    });

    it("ignores what arrives on a connection it has already dropped", async () => {
      await connect();
      fake.socket.send(JSON.stringify({ op: 7 }));
      fake.dispatch("GROUP_MESSAGE_CREATE", groupEvent({ id: "late" }));
      await until(() => fake.framesWithOp(6).length === 1, "resume");
      await until(connected, "connected again");
      assert.deepEqual(messages, []);
    });

    it("tries again when the gateway address is unusable", async () => {
      await startWith((qq) => {
        qq.badGatewayUrlOnce = true;
      });
      await until(connected, "connected on the next try");
      assert.equal(fake.connections, 1);
      assert.ok(statuses.some((status) => status.detail?.endsWith("正在重连")));
    });
  });

  describe("when a send fails", () => {
    const ordinary =(text = "你好") => adapter.send({ channelId: "qq", conversationId: GROUP, conversationKind: "group", text });
    const reply = (text = "你好") => adapter.send({ channelId: "qq", conversationId: GROUP, conversationKind: "group", text, replyToId: "m1" });

    async function connectWithMessageToReplyTo(backoffMs?: number) {
      await connect(backoffMs);
      fake.dispatch("GROUP_MESSAGE_CREATE", groupEvent({ id: "m1" }));
      await until(() => messages.length === 1, "message");
    }

    // Fails the first send with this error before it reaches the network. Sends after that,
    // and every other request, go through as usual.
    function failFirstSend(t: TestContext, failure: Error) {
      const realFetch = globalThis.fetch;
      let failed = false;
      const calls = { sends: 0 };
      t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
        if (String(url).includes("/messages")) {
          calls.sends++;
          if (!failed) {
            failed = true;
            throw failure;
          }
        }
        return realFetch(url, init);
      });
      return calls;
    }

    const networkFailure = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
    const timeout = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

    it("sends a reply again after the connection drops, as the same reply", async () => {
      await connectWithMessageToReplyTo();
      fake.sendPlan = ["drop"];
      await reply("第一条");
      assert.equal(fake.sendAttempts, 2);
      assert.deepEqual(fake.sent.map((request) => [request.body.content, request.body.msg_id, request.body.msg_seq]), [["第一条", "m1", 1]]);

      await reply("第二条");
      assert.equal(fake.sent[1]!.body.msg_seq, 2, "the retry didn't use up a reply");
    });

    it("doesn't post a reply twice when only the answer to the first try was lost", async () => {
      await connectWithMessageToReplyTo();
      fake.sendPlan = ["arrive-then-drop"];
      await reply();
      assert.equal(fake.sendAttempts, 2);
      assert.equal(fake.sent.length, 1);
    });

    it("treats a duplicate on the very first try as an error, since nothing had been sent", async () => {
      await connectWithMessageToReplyTo();
      fake.sendPlan = [{ status: 400, body: { code: 40054005, message: "消息被去重" } }];
      await assert.rejects(reply(), /40054005/);
      assert.equal(fake.sendAttempts, 1);
    });

    it("gets a reply through on the last try", async () => {
      await connectWithMessageToReplyTo();
      fake.sendPlan = ["drop", "drop"];
      await reply();
      assert.equal(fake.sendAttempts, 3);
      assert.equal(fake.sent.length, 1);
    });

    it("gives up on a reply after three tries and says why", async () => {
      await connectWithMessageToReplyTo();
      fake.sendPlan = ["drop", "drop", "drop", "drop"];
      await assert.rejects(reply(), /^Error: 网络错误（UND_ERR_SOCKET）$/);
      assert.equal(fake.sendAttempts, 3);
      assert.equal(fake.sent.length, 0);
    });

    it("sends a reply again after a timeout", async (t) => {
      await connectWithMessageToReplyTo();
      const calls = failFirstSend(t, timeout());
      await reply();
      assert.equal(calls.sends, 2);
      assert.equal(fake.sent.length, 1);
    });

    it("sends a reply again after a server error, but not an ordinary message, which may have gone out", async () => {
      await connectWithMessageToReplyTo();
      fake.sendPlan = [{ status: 500, body: {} }];
      await reply();
      assert.equal(fake.sendAttempts, 2);
      assert.equal(fake.sent.length, 1);

      fake.sendAttempts = 0;
      fake.sendPlan = [{ status: 500, body: {} }];
      await assert.rejects(ordinary(), /QQ 接口错误 500/);
      assert.equal(fake.sendAttempts, 1);
    });

    it("doesn't send an ordinary message again when it may have arrived", async () => {
      await connect();
      fake.sendPlan = ["arrive-then-drop"];
      await assert.rejects(ordinary(), /网络错误（UND_ERR_SOCKET）/);
      assert.equal(fake.sendAttempts, 1);
      assert.equal(fake.sent.length, 1);
    });

    it("doesn't send an ordinary message again after a timeout, and says what happened", async (t) => {
      await connect();
      const calls = failFirstSend(t, timeout());
      await assert.rejects(ordinary(), /连接QQ超时/);
      assert.equal(calls.sends, 1);
    });

    for (const code of ["UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]) {
      it(`sends an ordinary message again after ${code}, which means it never left`, async (t) => {
        await connect();
        const calls = failFirstSend(t, networkFailure(code));
        await ordinary();
        assert.equal(calls.sends, 2);
        assert.equal(fake.sent.length, 1);
      });
    }

    for (const code of [50055001, 50055002]) {
      it(`sends anything again when the platform says to try later (${code})`, async () => {
        await connect();
        fake.sendPlan = [{ status: 500, body: { code, message: "消息发送异常，请稍后重试" } }];
        await ordinary();
        assert.equal(fake.sendAttempts, 2);
        assert.equal(fake.sent.length, 1);
      });
    }

    it("doesn't try again when the platform refuses the message, and passes on its error", async () => {
      const refusal = (error: unknown) => error instanceof QqApiError && error.status === 400 && error.code === 304003;
      await connectWithMessageToReplyTo();
      fake.sendFailure = { status: 400, body: { code: 304003, message: "url not allowed" } };
      await assert.rejects(reply(), refusal);
      assert.equal(fake.sendAttempts, 1);
      fake.sendAttempts = 0;
      await assert.rejects(ordinary(), refusal);
      assert.equal(fake.sendAttempts, 1);
    });

    it("reports a refusal that comes back on a later try, instead of taking it for success", async () => {
      await connectWithMessageToReplyTo();
      fake.sendPlan = ["drop", { status: 400, body: { code: 304003, message: "url not allowed" } }];
      await assert.rejects(reply(), /304003/);
      assert.equal(fake.sendAttempts, 2);
      assert.equal(fake.sent.length, 0);
    });

    it("stops trying once switched off, so a written reply can't go out afterwards", async () => {
      await connectWithMessageToReplyTo(150);
      fake.sendPlan = ["drop", "drop"];
      const sending = reply();
      await until(() => fake.sendAttempts === 1, "first try");
      await adapter.stop();
      await assert.rejects(sending, /网络错误/);
      assert.equal(fake.sendAttempts, 1);
      assert.equal(fake.sent.length, 0);
    });

    it("waits longer before each new try", async (t) => {
      await connectWithMessageToReplyTo(40);
      const started: number[] = [];
      const realFetch = globalThis.fetch;
      t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
        if (String(url).includes("/messages")) {
          started.push(performance.now());
          throw networkFailure("ECONNREFUSED");
        }
        return realFetch(url, init);
      });
      await assert.rejects(reply());
      assert.equal(started.length, 3);
      assert.ok(started[1]! - started[0]! >= 35, "about one step");
      assert.ok(started[2]! - started[1]! >= 75, "about two steps");
    });
  });
});

describe("describing a network error", () => {
  it("names the code a failed fetch hides in its cause", () => {
    const error = new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "UND_ERR_CONNECT_TIMEOUT" }) });
    assert.equal(networkErrorCode(error), "UND_ERR_CONNECT_TIMEOUT");
    assert.equal(describeNetworkError(error, "QQ"), "网络错误（UND_ERR_CONNECT_TIMEOUT）");
  });

  it("falls back to the cause's message when it has no code", () => {
    const error = new TypeError("fetch failed", { cause: new Error("bad port") });
    assert.equal(describeNetworkError(error, "QQ"), "网络错误（bad port）");
    assert.equal(networkErrorCode(error), undefined);
  });

  it("says a timeout was a timeout, on the right platform", () => {
    const error = new DOMException("aborted", "TimeoutError");
    assert.equal(describeNetworkError(error, "QQ"), "连接QQ超时");
    assert.equal(describeNetworkError(error, "微信"), "连接微信超时");
  });

  it("keeps any other message, including the platform's own errors", () => {
    assert.equal(describeNetworkError(new Error("QQ 接口错误 400"), "QQ"), "QQ 接口错误 400");
    assert.equal(describeNetworkError("plain text", "QQ"), "plain text");
    assert.equal(networkErrorCode("plain text"), undefined);
    assert.equal(networkErrorCode(new Error("no cause")), undefined);
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
