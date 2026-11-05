import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ChannelLogin, ChannelStatus } from "@shu/protocol";
import type { AdapterMessage } from "../src/types.ts";
import { fileSessionStore, splitText, WeChatAdapter, type SessionStore, type WeChatSession } from "../src/wechat.ts";

const OWNER_ID = "owner@im.wechat";

type Handler = (request: { url: string; body: any; raw: Buffer; headers: IncomingMessage["headers"] }, response: ServerResponse) => void;

// Plays the part of Tencent's servers. Long polls hang until a test queues something.
class FakeILink {
  server!: Server;
  requests: { url: string; body: any; headers: IncomingMessage["headers"] }[] = [];
  updates: string[] = [];
  #waiting: ServerResponse[] = [];
  routes = new Map<string, Handler>();
  qrStatuses: object[] = [];
  uploads: Buffer[] = [];

  get base() {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/`;
  }

  async start() {
    this.server = createServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const raw = Buffer.concat(chunks);
        const url = incoming.url ?? "";
        const isJson = incoming.headers["content-type"] === "application/json";
        const body = isJson && raw.length ? JSON.parse(raw.toString()) : undefined;
        this.requests.push({ url, body, headers: incoming.headers });
        const path = url.split("?")[0] as string;
        const route = this.routes.get(path);
        if (route) return route({ url, body, raw, headers: incoming.headers }, response);
        if (path === "/ilink/bot/getupdates") {
          const next = this.updates.shift();
          if (next === undefined) return void this.#waiting.push(response);
          return response.end(next);
        }
        if (path === "/ilink/bot/get_bot_qrcode") return respond(response, { qrcode: "qr-1", qrcode_img_content: "https://qr.example/1" });
        if (path === "/ilink/bot/get_qrcode_status") {
          const next = this.qrStatuses.shift();
          if (!next) return void this.#waiting.push(response);
          return respond(response, next);
        }
        if (path === "/ilink/bot/sendmessage") return respond(response, { ret: 0 });
        response.statusCode = 404;
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
  }

  // A client that gave up leaves its request here, and nothing written to it would arrive.
  #nextWaiting() {
    this.#waiting = this.#waiting.filter((response) => !response.socket?.destroyed);
    return this.#waiting.shift();
  }

  // Delivers a raw response body to the next or a waiting long poll.
  push(body: string | object) {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    const waiting = this.#nextWaiting();
    if (waiting) waiting.end(text);
    else this.updates.push(text);
  }

  pushStatus(status: object) {
    const waiting = this.#nextWaiting();
    if (waiting) respond(waiting, status);
    else this.qrStatuses.push(status);
  }

  sent() {
    return this.requests.filter((request) => request.url.startsWith("/ilink/bot/sendmessage"));
  }

  async stop() {
    for (const waiting of this.#waiting) waiting.end("{}");
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

function respond(response: ServerResponse, body: object) {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

function memoryStore(initial: WeChatSession | null = { botToken: "token-1", userId: OWNER_ID }): SessionStore & { current: WeChatSession | null } {
  return {
    current: initial,
    load() {
      return this.current;
    },
    save(session) {
      this.current = session;
    },
    clear() {
      this.current = null;
    },
  };
}

async function until(check: () => boolean, what = "condition") {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 3000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const running: { adapter: WeChatAdapter; ilink: FakeILink }[] = [];

afterEach(async () => {
  for (const { adapter, ilink } of running.splice(0)) {
    await adapter.stop();
    await ilink.stop();
  }
});

async function setup(store: SessionStore = memoryStore(), options: { requestTimeoutMs?: number; backoffMs?: number; pollTimeoutMs?: number } = {}) {
  const ilink = new FakeILink();
  await ilink.start();
  const adapter = new WeChatAdapter({ sessionStore: store, apiBase: ilink.base, cdnBase: `${ilink.base}c2c`, backoffMs: 1, ...options });
  running.push({ adapter, ilink });
  const messages: AdapterMessage[] = [];
  const statuses: ChannelStatus[] = [];
  const logins: (ChannelLogin | null)[] = [];
  const handlers = {
    onMessage: (message: AdapterMessage) => void messages.push(message),
    onStatus: (status: ChannelStatus) => void statuses.push(status),
    onLogin: (login: ChannelLogin | null) => void logins.push(login),
  };
  return { ilink, adapter, messages, statuses, logins, handlers, lastStatus: () => statuses.at(-1)?.state };
}

let nextMessage = 1000;
function text(body: string, overrides: object = {}) {
  return {
    message_id: nextMessage++,
    from_user_id: OWNER_ID,
    message_type: 1,
    create_time_ms: Date.now(),
    context_token: "ctx-1",
    item_list: [{ type: 1, text_item: { text: body } }],
    ...overrides,
  };
}

const batch = (...msgs: object[]) => ({ ret: 0, msgs, get_updates_buf: "cursor-next" });

describe("WeChat long polling", () => {
  it("needs a QR login when no session is saved, and makes no calls", async () => {
    const t = await setup(memoryStore(null));
    await t.adapter.start(t.handlers);
    assert.equal(t.lastStatus(), "needs-login");
    assert.equal(t.ilink.requests.length, 0);
  });

  it("delivers an owner's text as a private message", async () => {
    const t = await setup();
    await t.adapter.start(t.handlers);
    t.ilink.push(batch(text("你好")));
    await until(() => t.messages.length === 1, "message");
    const [message] = t.messages;
    assert.equal(message!.text, "你好");
    assert.equal(message!.conversationKind, "dm");
    assert.equal(message!.senderId, OWNER_ID);
    assert.equal(message!.channelId, "wechat");
    assert.equal(t.lastStatus(), "connected");
  });

  it("identifies the signed-in account as the owner", async () => {
    const t = await setup();
    assert.equal(t.adapter.ownerId(), OWNER_ID);
    const empty = await setup(memoryStore(null));
    assert.equal(empty.adapter.ownerId(), undefined);
  });

  it("sends the token and the headers iLink expects", async () => {
    const t = await setup();
    await t.adapter.start(t.handlers);
    await until(() => t.ilink.requests.length > 0, "first poll");
    const { headers, body } = t.ilink.requests[0]!;
    assert.equal(headers.authorization, "Bearer token-1");
    assert.equal(headers.authorizationtype, "ilink_bot_token");
    assert.equal(headers["ilink-app-id"], "bot");
    assert.equal(headers["ilink-app-clientversion"], String((2 << 16) | (4 << 8) | 10));
    assert.match(Buffer.from(String(headers["x-wechat-uin"]), "base64").toString(), /^\d+$/);
    assert.equal(body.get_updates_buf, "");
    assert.equal(body.base_info.bot_agent, "Shu/0.1");
  });

  it("carries the cursor from one poll to the next", async () => {
    const t = await setup();
    await t.adapter.start(t.handlers);
    t.ilink.push(batch(text("一")));
    await until(() => t.ilink.requests.length >= 2, "second poll");
    assert.equal(t.ilink.requests[1]!.body.get_updates_buf, "cursor-next");
  });

  it("keeps 64-bit message IDs exact", async () => {
    const t = await setup();
    await t.adapter.start(t.handlers);
    t.ilink.push(`{"ret":0,"msgs":[{"message_id":9007199254740993,"from_user_id":"${OWNER_ID}","message_type":1,"create_time_ms":${Date.now()},"item_list":[{"type":1,"text_item":{"text":"大数"}}]}]}`);
    await until(() => t.messages.length === 1, "message");
    assert.equal(t.messages[0]!.id, "9007199254740993");
  });

  it("doesn't deliver the same message twice", async () => {
    const t = await setup();
    await t.adapter.start(t.handlers);
    const once = text("一次");
    t.ilink.push(batch(once));
    t.ilink.push(batch(once, text("下一条")));
    await until(() => t.messages.length === 2, "messages");
    assert.deepEqual(t.messages.map((message) => message.text), ["一次", "下一条"]);
  });

  it("ignores the bot's own messages and anything sent before this run began", async () => {
    const t = await setup();
    await t.adapter.start(t.handlers);
    t.ilink.push(batch(text("机器人发的", { message_type: 2 }), text("昨天发的", { create_time_ms: Date.now() - 86_400_000 }), text("现在发的")));
    await until(() => t.messages.length >= 1, "message");
    assert.deepEqual(t.messages.map((message) => message.text), ["现在发的"]);
  });

  it("outlives network and server errors", async () => {
    const t = await setup();
    let failures = 2;
    t.ilink.routes.set("/ilink/bot/getupdates", (_request, response) => {
      if (failures-- > 0) {
        response.statusCode = 500;
        return response.end("oops");
      }
      t.ilink.routes.delete("/ilink/bot/getupdates");
      respond(response, batch(text("恢复了")));
    });
    await t.adapter.start(t.handlers);
    await until(() => t.messages.length === 1, "message after errors");
    assert.ok(t.statuses.some((status) => status.state === "connecting" && status.detail?.includes("重连")));
    assert.equal(t.lastStatus(), "connected");
  });

  it("counts a long poll with nothing to report as connected, and keeps polling", async () => {
    const t = await setup(memoryStore(), { pollTimeoutMs: 30 });
    await t.adapter.start(t.handlers);
    assert.equal(t.lastStatus(), "connecting");
    await until(() => t.lastStatus() === "connected", "connected");
    await until(() => t.ilink.requests.length >= 2, "next poll");
  });

  it("goes back to connected once the network recovers, even with nothing to report", async () => {
    const t = await setup(memoryStore(), { pollTimeoutMs: 30 });
    let calls = 0;
    t.ilink.routes.set("/ilink/bot/getupdates", (_request, response) => {
      calls += 1;
      if (calls === 1) return respond(response, batch());
      if (calls === 2) {
        response.statusCode = 500;
        response.end("oops");
      }
    });
    await t.adapter.start(t.handlers);
    await until(() => t.statuses.filter((status) => status.state === "connected").length === 2, "connected a second time");
    assert.deepEqual(t.statuses.map((status) => status.state), ["connecting", "connected", "connecting", "connected"]);
  });

  it("doesn't count a refused connection as connected", async () => {
    const t = await setup();
    await t.ilink.stop();
    await t.adapter.start(t.handlers);
    await until(() => t.statuses.some((status) => status.detail?.includes("重连")), "failure");
    assert.ok(!t.statuses.some((status) => status.state === "connected"));
    await t.adapter.stop();
    await t.ilink.start();
  });

  it("treats an error code in the body as a failure, without losing its place", async () => {
    const t = await setup();
    await t.adapter.start(t.handlers);
    t.ilink.push(batch(text("一")));
    t.ilink.push({ ret: 1, errcode: 123, errmsg: "busy" });
    t.ilink.push(batch(text("二")));
    await until(() => t.messages.length === 2, "messages");
    assert.ok(t.statuses.some((status) => status.detail?.includes("123")));
  });

  for (const stale of [{ ret: -14 }, { errcode: -14 }]) {
    it(`stops calling and asks for a new login on ${JSON.stringify(stale)}, keeping the token`, async () => {
      const store = memoryStore();
      const t = await setup(store);
      await t.adapter.start(t.handlers);
      t.ilink.push(stale);
      await until(() => t.lastStatus() === "needs-login", "needs-login");
      const calls = t.ilink.requests.length;
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(t.ilink.requests.length, calls);
      assert.equal(store.current?.botToken, "token-1");
    });
  }

  it("stops polling on stop, and can start again", async () => {
    const t = await setup();
    await t.adapter.start(t.handlers);
    await until(() => t.ilink.requests.length === 1, "first poll");
    await t.adapter.stop();
    assert.equal(t.lastStatus(), "stopped");
    const calls = t.ilink.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(t.ilink.requests.length, calls);

    await t.adapter.start(t.handlers);
    await until(() => t.ilink.requests.length === calls + 1, "poll after restart");
    t.ilink.push(batch(text("重启后")));
    await until(() => t.messages.length === 1, "message after restart");
  });

  it("drops what arrives from a poll that was stopped", async () => {
    const t = await setup();
    let release: (() => void) | undefined;
    t.ilink.routes.set("/ilink/bot/getupdates", (_request, response) => {
      release = () => respond(response, batch(text("关了之后")));
    });
    await t.adapter.start(t.handlers);
    await until(() => release !== undefined, "first poll");
    await t.adapter.stop();
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(t.messages.length, 0);
  });

  it("uses the server the login said to use", async () => {
    const other = new FakeILink();
    await other.start();
    const t = await setup(memoryStore({ botToken: "t", userId: OWNER_ID, baseUrl: other.base }));
    await t.adapter.start(t.handlers);
    await until(() => other.requests.length === 1, "poll on the other server");
    assert.equal(t.ilink.requests.length, 0);
    await t.adapter.stop();
    await other.stop();
  });
});

describe("WeChat inbound content", () => {
  it("passes on a voice message's transcript", async () => {
    const t = await setup();
    await t.adapter.start(t.handlers);
    t.ilink.push(batch(text("", { item_list: [{ type: 3, voice_item: { text: "语音转的文字" } }] })));
    await until(() => t.messages.length === 1, "message");
    assert.equal(t.messages[0]!.text, "语音转的文字");
  });

  it("includes what a message quotes", async () => {
    const t = await setup();
    await t.adapter.start(t.handlers);
    t.ilink.push(batch(text("", { item_list: [{ type: 1, text_item: { text: "这个呢" }, ref_msg: { message_item: { text_item: { text: "原话" } } } }] })));
    await until(() => t.messages.length === 1, "message");
    assert.match(t.messages[0]!.text, /原话/);
    assert.match(t.messages[0]!.text, /这个呢/);
  });

  it("says a video can't be watched rather than dropping it silently", async () => {
    const t = await setup();
    await t.adapter.start(t.handlers);
    t.ilink.push(batch(text("", { item_list: [{ type: 5 }] })));
    await until(() => t.messages.length === 1, "message");
    assert.match(t.messages[0]!.text, /视频/);
  });

  it("skips a message with nothing in it", async () => {
    const t = await setup();
    await t.adapter.start(t.handlers);
    t.ilink.push(batch(text("", { item_list: [] }), text("有内容")));
    await until(() => t.messages.length >= 1, "message");
    assert.deepEqual(t.messages.map((message) => message.text), ["有内容"]);
  });

  function encrypted(plain: Buffer, key: Buffer) {
    const cipher = createCipheriv("aes-128-ecb", key, null);
    return Buffer.concat([cipher.update(plain), cipher.final()]);
  }

  it("doesn't download a file until asked, then decrypts it", async () => {
    const t = await setup();
    const key = Buffer.from("0123456789abcdef");
    let downloads = 0;
    t.ilink.routes.set("/c2c/download", (request, response) => {
      downloads += 1;
      assert.match(request.url, /encrypted_query_param=param%2F1/);
      response.end(encrypted(Buffer.from("文件内容"), key));
    });
    await t.adapter.start(t.handlers);
    // File keys are base64 of the key written as hex.
    const aes_key = Buffer.from(key.toString("hex")).toString("base64");
    t.ilink.push(batch(text("", { item_list: [{ type: 4, file_item: { file_name: "周报.docx", media: { encrypt_query_param: "param/1", aes_key } } }] })));
    await until(() => t.messages.length === 1, "message");
    assert.equal(downloads, 0);
    const [attachment] = t.messages[0]!.attachments ?? [];
    assert.equal(attachment!.name, "周报.docx");
    assert.equal((await attachment!.download()).toString(), "文件内容");
  });

  it("decrypts an image with the key format images use, and prefers a full URL", async () => {
    const t = await setup();
    const key = Buffer.from("fedcba9876543210");
    t.ilink.routes.set("/full", (_request, response) => response.end(encrypted(Buffer.from("图片"), key)));
    await t.adapter.start(t.handlers);
    t.ilink.push(batch(text("", { item_list: [{ type: 2, image_item: { aeskey: key.toString("hex"), media: { full_url: `${t.ilink.base}full`, encrypt_query_param: "x" } } }] })));
    await until(() => t.messages.length === 1, "message");
    assert.equal((await t.messages[0]!.attachments![0]!.download()).toString(), "图片");
  });

  it("accepts a key given as base64 of the raw bytes", async () => {
    const t = await setup();
    const key = Buffer.from("0123456789abcdef");
    t.ilink.routes.set("/c2c/download", (_request, response) => response.end(encrypted(Buffer.from("x"), key)));
    await t.adapter.start(t.handlers);
    t.ilink.push(batch(text("", { item_list: [{ type: 4, file_item: { file_name: "a", media: { encrypt_query_param: "p", aes_key: key.toString("base64") } } }] })));
    await until(() => t.messages.length === 1, "message");
    assert.equal((await t.messages[0]!.attachments![0]!.download()).toString(), "x");
  });

  it("reports a failed download and a bad key", async () => {
    const t = await setup();
    t.ilink.routes.set("/c2c/download", (_request, response) => {
      response.statusCode = 403;
      response.end();
    });
    await t.adapter.start(t.handlers);
    t.ilink.push(batch(text("", { item_list: [{ type: 4, file_item: { file_name: "a", media: { encrypt_query_param: "p", aes_key: Buffer.from("short").toString("base64") } } }] })));
    await until(() => t.messages.length === 1, "message");
    await assert.rejects(t.messages[0]!.attachments![0]!.download(), /403/);
    t.ilink.routes.set("/c2c/download", (_request, response) => response.end("data"));
    await assert.rejects(t.messages[0]!.attachments![0]!.download(), /密钥/);
  });
});

describe("WeChat sending", () => {
  const out = (body: string) => ({ channelId: "wechat", conversationId: OWNER_ID, conversationKind: "dm" as const, text: body });

  it("replies with the latest context token", async () => {
    const t = await setup();
    await t.adapter.start(t.handlers);
    t.ilink.push(batch(text("你好", { context_token: "ctx-9" })));
    await until(() => t.messages.length === 1, "message");
    await t.adapter.send(out("收到"));
    const { body, headers } = t.ilink.sent()[0]!;
    assert.equal(headers.authorization, "Bearer token-1");
    assert.equal(body.msg.to_user_id, OWNER_ID);
    assert.equal(body.msg.context_token, "ctx-9");
    assert.equal(body.msg.message_type, 2);
    assert.equal(body.msg.message_state, 2);
    assert.deepEqual(body.msg.item_list, [{ type: 1, text_item: { text: "收到" } }]);
  });

  it("can send without a context token, which is how the first message after a restart goes", async () => {
    const t = await setup();
    await t.adapter.start(t.handlers);
    await t.adapter.send(out("主动发"));
    assert.equal("context_token" in t.ilink.sent()[0]!.body.msg, false);
  });

  it("gives every message its own ID", async () => {
    const t = await setup();
    await t.adapter.send(out("一"));
    await t.adapter.send(out("二"));
    const [first, second] = t.ilink.sent();
    assert.notEqual(first!.body.msg.client_id, second!.body.msg.client_id);
  });

  it("splits a long message", async () => {
    const t = await setup();
    await t.adapter.send(out("字".repeat(9000)));
    assert.equal(t.ilink.sent().length, 3);
    const sentText = t.ilink.sent().map((request) => request.body.msg.item_list[0].text_item.text).join("");
    assert.equal(sentText.length, 9000);
  });

  it("raises an error the platform reports in the body, without trying again", async () => {
    const t = await setup();
    t.ilink.routes.set("/ilink/bot/sendmessage", (_request, response) => respond(response, { ret: -2, errmsg: "bad" }));
    await assert.rejects(t.adapter.send(out("一")), /-2/);
    assert.equal(t.ilink.sent().length, 1);
  });

  it("tries again after a timeout, as the same message", async () => {
    const t = await setup(memoryStore(), { requestTimeoutMs: 40 });
    let calls = 0;
    t.ilink.routes.set("/ilink/bot/sendmessage", (_request, response) => {
      calls += 1;
      if (calls > 1) respond(response, { ret: 0 });
    });
    await t.adapter.send(out("一"));
    assert.equal(calls, 2);
    const [first, second] = t.ilink.sent();
    assert.equal(first!.body.msg.client_id, second!.body.msg.client_id);
  });

  it("tries again after a server error", async () => {
    const t = await setup();
    let calls = 0;
    t.ilink.routes.set("/ilink/bot/sendmessage", (_request, response) => {
      calls += 1;
      if (calls < 3) {
        response.statusCode = 502;
        return response.end();
      }
      respond(response, { ret: 0 });
    });
    await t.adapter.send(out("一"));
    assert.equal(calls, 3);
  });

  it("doesn't try again after a refusal", async () => {
    const t = await setup();
    let calls = 0;
    t.ilink.routes.set("/ilink/bot/sendmessage", (_request, response) => {
      calls += 1;
      response.statusCode = 403;
      response.end();
    });
    await assert.rejects(t.adapter.send(out("一")), /403/);
    assert.equal(calls, 1);
  });

  it("gives up after a few tries, in words a person can read", async () => {
    const t = await setup(memoryStore(), { requestTimeoutMs: 20 });
    let calls = 0;
    t.ilink.routes.set("/ilink/bot/sendmessage", () => {
      calls += 1;
    });
    await assert.rejects(t.adapter.send(out("一")), /超时/);
    assert.equal(calls, 3);
  });

  it("stops trying once the channel is stopped, so the master switch still means stop", async () => {
    const t = await setup(memoryStore(), { requestTimeoutMs: 20, backoffMs: 40 });
    await t.adapter.start(t.handlers);
    let calls = 0;
    t.ilink.routes.set("/ilink/bot/sendmessage", () => {
      calls += 1;
    });
    const sending = t.adapter.send(out("一"));
    await until(() => calls === 1, "first attempt");
    await t.adapter.stop();
    await assert.rejects(sending, /超时/);
    assert.equal(calls, 1);
  });

  it("can send again after a restart", async () => {
    const t = await setup();
    await t.adapter.start(t.handlers);
    await t.adapter.stop();
    await t.adapter.start(t.handlers);
    let calls = 0;
    t.ilink.routes.set("/ilink/bot/sendmessage", (_request, response) => {
      calls += 1;
      if (calls === 1) {
        response.statusCode = 500;
        return response.end();
      }
      respond(response, { ret: 0 });
    });
    await t.adapter.send(out("一"));
    assert.equal(calls, 2);
  });

  it("tries again if asking where to upload fails", async () => {
    const t = await setup();
    let calls = 0;
    t.ilink.routes.set("/ilink/bot/getuploadurl", (_request, response) => {
      calls += 1;
      if (calls === 1) {
        response.statusCode = 500;
        return response.end();
      }
      respond(response, { upload_param: "up" });
    });
    t.ilink.routes.set("/c2c/upload", (_request, response) => {
      response.setHeader("x-encrypted-param", "down");
      response.end();
    });
    const dir = mkdtempSync(join(tmpdir(), "shu-wechat-"));
    writeFileSync(join(dir, "a.txt"), "x");
    await t.adapter.sendFile(OWNER_ID, join(dir, "a.txt"), "a.txt");
    assert.equal(calls, 2);
    rmSync(dir, { recursive: true });
  });

  it("refuses to send without a login", async () => {
    const t = await setup(memoryStore(null));
    await assert.rejects(t.adapter.send(out("一")), /登录/);
    await assert.rejects(t.adapter.sendFile(OWNER_ID, "x", "x"), /登录/);
  });

  function fileUploadRoutes(t: Awaited<ReturnType<typeof setup>>) {
    const seen: { uploadRequest?: any; cipher?: Buffer } = {};
    t.ilink.routes.set("/ilink/bot/getuploadurl", (request, response) => {
      seen.uploadRequest = request.body;
      respond(response, { upload_param: "up/1" });
    });
    t.ilink.routes.set("/c2c/upload", (request, response) => {
      assert.match(request.url, /encrypted_query_param=up%2F1/);
      assert.ok(request.url.includes(`filekey=${seen.uploadRequest.filekey}`));
      seen.cipher = request.raw;
      response.setHeader("x-encrypted-param", "down/1");
      response.end();
    });
    return seen;
  }

  it("uploads a file encrypted, in a way the recipient can decrypt, then sends it", async () => {
    const t = await setup();
    const seen = fileUploadRoutes(t);
    const dir = mkdtempSync(join(tmpdir(), "shu-wechat-"));
    const path = join(dir, "周报.xlsx");
    const plain = Buffer.from("这是一份报告".repeat(50));
    writeFileSync(path, plain);

    await t.adapter.sendFile(OWNER_ID, path, "周报.xlsx");

    const request = seen.uploadRequest;
    assert.equal(request.media_type, 3);
    assert.equal(request.to_user_id, OWNER_ID);
    assert.equal(request.rawsize, plain.length);
    assert.equal(request.rawfilemd5, createHash("md5").update(plain).digest("hex"));
    assert.equal(request.filesize, Math.ceil((plain.length + 1) / 16) * 16);
    assert.equal(request.no_need_thumb, true);
    assert.match(request.filekey, /^[0-9a-f]{32}$/);
    assert.match(request.aeskey, /^[0-9a-f]{32}$/);

    const decipher = createDecipheriv("aes-128-ecb", Buffer.from(request.aeskey, "hex"), null);
    assert.deepEqual(Buffer.concat([decipher.update(seen.cipher!), decipher.final()]), plain);
    assert.equal(seen.cipher!.length, request.filesize);

    const item = t.ilink.sent()[0]!.body.msg.item_list[0];
    assert.equal(item.type, 4);
    assert.equal(item.file_item.file_name, "周报.xlsx");
    assert.equal(item.file_item.len, String(plain.length));
    assert.equal(item.file_item.media.encrypt_query_param, "down/1");
    assert.equal(item.file_item.media.encrypt_type, 1);
    assert.equal(Buffer.from(item.file_item.media.aes_key, "base64").toString(), request.aeskey);
    rmSync(dir, { recursive: true });
  });

  it("prefers a full upload URL when one is given", async () => {
    const t = await setup();
    let used = false;
    t.ilink.routes.set("/ilink/bot/getuploadurl", (_request, response) => respond(response, { upload_full_url: `${t.ilink.base}direct`, upload_param: "up/1" }));
    t.ilink.routes.set("/direct", (_request, response) => {
      used = true;
      response.setHeader("x-encrypted-param", "down/1");
      response.end();
    });
    const dir = mkdtempSync(join(tmpdir(), "shu-wechat-"));
    writeFileSync(join(dir, "a.txt"), "x");
    await t.adapter.sendFile(OWNER_ID, join(dir, "a.txt"), "a.txt");
    assert.equal(used, true);
    rmSync(dir, { recursive: true });
  });

  it("retries an upload the server failed, but not one it rejected", async () => {
    const t = await setup();
    t.ilink.routes.set("/ilink/bot/getuploadurl", (_request, response) => respond(response, { upload_param: "up" }));
    const dir = mkdtempSync(join(tmpdir(), "shu-wechat-"));
    writeFileSync(join(dir, "a.txt"), "x");

    let attempts = 0;
    t.ilink.routes.set("/c2c/upload", (_request, response) => {
      attempts += 1;
      if (attempts < 3) {
        response.statusCode = 500;
        return response.end();
      }
      response.setHeader("x-encrypted-param", "down");
      response.end();
    });
    await t.adapter.sendFile(OWNER_ID, join(dir, "a.txt"), "a.txt");
    assert.equal(attempts, 3);

    attempts = 0;
    t.ilink.routes.set("/c2c/upload", (_request, response) => {
      attempts += 1;
      response.statusCode = 403;
      response.end();
    });
    await assert.rejects(t.adapter.sendFile(OWNER_ID, join(dir, "a.txt"), "a.txt"), /403/);
    assert.equal(attempts, 1);

    attempts = 0;
    t.ilink.routes.set("/c2c/upload", (_request, response) => {
      attempts += 1;
      response.statusCode = 503;
      response.end();
    });
    await assert.rejects(t.adapter.sendFile(OWNER_ID, join(dir, "a.txt"), "a.txt"), /503/);
    assert.equal(attempts, 3);
    rmSync(dir, { recursive: true });
  });

  it("doesn't send a message pointing at a file that didn't upload", async () => {
    const t = await setup();
    t.ilink.routes.set("/ilink/bot/getuploadurl", (_request, response) => respond(response, { upload_param: "up" }));
    t.ilink.routes.set("/c2c/upload", (_request, response) => response.end());
    const dir = mkdtempSync(join(tmpdir(), "shu-wechat-"));
    writeFileSync(join(dir, "a.txt"), "x");
    await assert.rejects(t.adapter.sendFile(OWNER_ID, join(dir, "a.txt"), "a.txt"));
    assert.equal(t.ilink.sent().length, 0);
    rmSync(dir, { recursive: true });
  });
});

describe("splitText", () => {
  it("never cuts an emoji in half", () => {
    const parts = splitText("a😀b", 2);
    assert.deepEqual(parts, ["a", "😀", "b"]);
  });

  it("splits plain text exactly, and handles empty text", () => {
    assert.deepEqual(splitText("abcde", 2), ["ab", "cd", "e"]);
    assert.deepEqual(splitText("", 2), []);
  });
});

describe("WeChat QR login", () => {
  it("shows the code, follows the scan, saves the session, and starts listening", async () => {
    const store = memoryStore(null);
    const t = await setup(store);
    await t.adapter.start(t.handlers);
    await t.adapter.beginLogin();
    await until(() => t.logins.at(-1)?.state === "qr", "QR");
    assert.deepEqual(t.logins.at(-1), { state: "qr", qrContent: "https://qr.example/1" });

    t.ilink.pushStatus({ status: "scaned" });
    await until(() => t.logins.at(-1)?.state === "scanned", "scanned");
    t.ilink.pushStatus({ status: "confirmed", bot_token: "new-token", ilink_user_id: "me@im.wechat", baseurl: t.ilink.base });
    await until(() => t.logins.at(-1) === null, "login finished");
    assert.deepEqual(store.current, { botToken: "new-token", userId: "me@im.wechat", baseUrl: t.ilink.base });
    assert.equal(t.adapter.ownerId(), "me@im.wechat");
    await until(() => t.ilink.requests.some((request) => request.url === "/ilink/bot/getupdates" && request.headers.authorization === "Bearer new-token"), "polling");
  });

  it("asks for the code shown on the phone and sends it back", async () => {
    const t = await setup(memoryStore(null));
    await t.adapter.start(t.handlers);
    await t.adapter.beginLogin();
    await until(() => t.logins.at(-1)?.state === "qr", "QR");
    t.ilink.pushStatus({ status: "need_verifycode" });
    await until(() => t.logins.at(-1)?.state === "verify", "verify");
    t.adapter.submitLoginCode("1234");
    await until(() => t.ilink.requests.some((request) => request.url.includes("verify_code=1234")), "code sent");
  });

  it("gets a new code when one expires, and gives up after a few", async () => {
    const t = await setup(memoryStore(null));
    await t.adapter.start(t.handlers);
    await t.adapter.beginLogin();
    for (let i = 0; i < 3; i++) {
      await until(() => t.ilink.requests.filter((request) => request.url.includes("get_bot_qrcode")).length === i + 1, "new code");
      await until(() => t.ilink.requests.filter((request) => request.url.includes("get_qrcode_status")).length === i + 1, "polling");
      t.ilink.pushStatus({ status: "expired" });
    }
    await until(() => t.logins.at(-1)?.state === "failed", "failure");
    assert.equal(t.ilink.requests.filter((request) => request.url.includes("get_bot_qrcode")).length, 3);
  });

  it("reports an account bound elsewhere", async () => {
    const t = await setup(memoryStore(null));
    await t.adapter.start(t.handlers);
    await t.adapter.beginLogin();
    await until(() => t.logins.at(-1)?.state === "qr", "QR");
    t.ilink.pushStatus({ status: "binded_redirect" });
    await until(() => t.logins.at(-1)?.state === "failed", "failure");
  });

  it("follows a redirect to another server", async () => {
    const other = new FakeILink();
    await other.start();
    const t = await setup(memoryStore(null));
    await t.adapter.start(t.handlers);
    await t.adapter.beginLogin();
    await until(() => t.logins.at(-1)?.state === "qr", "QR");
    // Only the host is given, and redirects are https in real use, so this one fails to connect.
    t.ilink.pushStatus({ status: "scaned_but_redirect", redirect_host: new URL(other.base).host });
    await until(() => t.logins.at(-1)?.state === "failed", "connection attempt on the new host");
    await other.stop();
  });

  it("rejects a confirmation with no token", async () => {
    const store = memoryStore(null);
    const t = await setup(store);
    await t.adapter.start(t.handlers);
    await t.adapter.beginLogin();
    await until(() => t.logins.at(-1)?.state === "qr", "QR");
    t.ilink.pushStatus({ status: "confirmed" });
    await until(() => t.logins.at(-1)?.state === "failed", "failure");
    assert.equal(store.current, null);
  });

  it("can't start while stopped, and is dropped on stop", async () => {
    const t = await setup(memoryStore(null));
    await assert.rejects(t.adapter.beginLogin(), /总闸/);
    await t.adapter.start(t.handlers);
    await t.adapter.beginLogin();
    await until(() => t.logins.at(-1)?.state === "qr", "QR");
    await t.adapter.stop();
    assert.equal(t.logins.at(-1), null);
    t.ilink.pushStatus({ status: "confirmed", bot_token: "late", ilink_user_id: "x" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(t.adapter.ownerId(), undefined);
  });

  it("keeps listening on the old session while a new login is under way", async () => {
    const t = await setup();
    await t.adapter.start(t.handlers);
    await until(() => t.ilink.requests.length === 1, "first poll");
    await t.adapter.beginLogin();
    await until(() => t.logins.at(-1)?.state === "qr", "QR");
    t.ilink.push(batch(text("还在听")));
    await until(() => t.messages.length === 1, "message during login");
  });

  it("forgets the session on logout", async () => {
    const store = memoryStore();
    const t = await setup(store);
    await t.adapter.start(t.handlers);
    await t.adapter.logout();
    assert.equal(store.current, null);
    assert.equal(t.adapter.ownerId(), undefined);
    assert.equal(t.lastStatus(), "needs-login");
  });
});

describe("the saved session", () => {
  it("survives a restart, and is gone after clearing", () => {
    const dir = mkdtempSync(join(tmpdir(), "shu-session-"));
    const store = fileSessionStore(join(dir, "nested", "session.json"));
    assert.equal(store.load(), null);
    store.save({ botToken: "t", userId: "u" });
    assert.deepEqual(fileSessionStore(join(dir, "nested", "session.json")).load(), { botToken: "t", userId: "u" });
    store.clear();
    assert.equal(store.load(), null);
    store.clear();
    rmSync(dir, { recursive: true });
  });
});
