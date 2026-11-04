// Checks the official WeChat bot channel (iLink): QR login, receiving messages,
// which item types a forwarded chat record arrives as, and whether the bot can
// message you first. Only your own WeChat account is answered.
//   npm run ilink -- login      scan with WeChat, then confirm on the phone
//   npm run ilink -- listen     send or forward things to the bot, Ctrl+C to stop
//   npm run ilink -- proactive  try messaging you without a new inbound message
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import qrcode from "qrcode-terminal";

const BASE = "https://ilinkai.weixin.qq.com/";
const PROTOCOL_VERSION = "2.4.10";
const SECRETS = ".secrets/ilink.json";
const LOG = "output/ilink-msgs.jsonl";
const baseInfo = { channel_version: PROTOCOL_VERSION, bot_agent: "shu-spike/0.1" };

type Session = {
  bot_token: string;
  ilink_user_id: string;
  baseurl?: string;
  last_context_token?: string;
};

function headers(token?: string): Record<string, string> {
  const [major, minor, patch] = PROTOCOL_VERSION.split(".").map(Number);
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString("base64"),
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String((major << 16) | (minor << 8) | patch),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function call(base: string, method: string, path: string, opts: { token?: string; body?: unknown; timeoutMs: number }) {
  const res = await fetch(new URL(path, base), {
    method,
    headers: headers(opts.token),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  return { status: res.status, body: JSON.parse((await res.text()) || "{}") };
}

function loadSession(): Session {
  if (!existsSync(SECRETS)) {
    console.error("Not logged in. Run: npm run ilink -- login");
    process.exit(2);
  }
  return JSON.parse(readFileSync(SECRETS, "utf8"));
}

function saveSession(session: Session) {
  mkdirSync(".secrets", { recursive: true });
  writeFileSync(SECRETS, JSON.stringify(session));
}

async function login() {
  let base = BASE;
  const qr = await call(base, "POST", "ilink/bot/get_bot_qrcode?bot_type=3", {
    body: { local_token_list: [] },
    timeoutMs: 15000,
  });
  if (!qr.body.qrcode_img_content) {
    console.error("could not get a QR code", qr.status, qr.body);
    process.exit(1);
  }
  qrcode.generate(qr.body.qrcode_img_content, { small: true });
  console.log("Scan with WeChat. If the code doesn't render, open:", qr.body.qrcode_img_content);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let verifyCode = "";
  let lastStatus = "";
  for (;;) {
    const query = `qrcode=${encodeURIComponent(qr.body.qrcode)}${verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : ""}`;
    let status;
    try {
      status = await call(base, "GET", `ilink/bot/get_qrcode_status?${query}`, { timeoutMs: 40000 });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") continue;
      throw error;
    }
    const state = status.body.status;
    if (state !== lastStatus) console.log("status:", state);
    lastStatus = state;

    if (state === "confirmed") {
      saveSession({
        bot_token: status.body.bot_token,
        ilink_user_id: status.body.ilink_user_id,
        baseurl: status.body.baseurl,
      });
      console.log(`Logged in. Token saved to spikes/${SECRETS}`);
      break;
    } else if (state === "need_verifycode") {
      verifyCode = (await rl.question("Enter the number shown on your phone: ")).trim();
    } else if (state === "scaned_but_redirect" && status.body.redirect_host) {
      base = `https://${status.body.redirect_host}/`;
    } else if (state === "scaned") {
      verifyCode = "";
    } else if (["expired", "verify_code_blocked", "binded_redirect"].includes(state)) {
      console.log("Stopped at status", state, "- run login again if needed.");
      break;
    }
  }
  rl.close();
}

async function send(session: Session, contextToken: string | undefined, text: string) {
  return call(session.baseurl || BASE, "POST", "ilink/bot/sendmessage", {
    token: session.bot_token,
    timeoutMs: 15000,
    body: {
      msg: {
        from_user_id: "",
        to_user_id: session.ilink_user_id,
        client_id: `shu-spike-${randomUUID()}`,
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text } }],
        context_token: contextToken,
      },
      base_info: baseInfo,
    },
  });
}

async function listen() {
  const session = loadSession();
  mkdirSync("output", { recursive: true });
  let cursor = "";
  console.log("Listening. Send text, a file, and a forwarded chat record to the bot.");
  for (;;) {
    let updates;
    try {
      updates = await call(session.baseurl || BASE, "POST", "ilink/bot/getupdates", {
        token: session.bot_token,
        timeoutMs: 40000,
        body: { get_updates_buf: cursor, base_info: baseInfo },
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") continue;
      // A connect timeout killed the listener once, so long polling has to outlive network errors.
      const reason = error instanceof Error ? ((error.cause as { code?: string })?.code ?? error.message) : String(error);
      console.log("getupdates failed, retrying in 5s:", reason);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }
    const { ret, errcode, errmsg, msgs, get_updates_buf } = updates.body;
    if (ret || errcode) console.log("getupdates returned", { ret, errcode, errmsg });
    if (get_updates_buf) cursor = get_updates_buf;

    for (const message of msgs ?? []) {
      if (message.message_type !== 1) {
        console.log("skipped message_type", message.message_type, "item types", (message.item_list ?? []).map((i: { type: number }) => i.type));
        continue;
      }
      if (message.from_user_id !== session.ilink_user_id) {
        console.log("dropped a message from another sender");
        continue;
      }
      const items = message.item_list ?? [];
      const summary = items.map((item: Record<string, unknown>) => ({ type: item.type, fields: Object.keys(item) }));
      console.log("inbound", JSON.stringify(summary));
      const { context_token, ...record } = message;
      appendFileSync(LOG, `${JSON.stringify(record)}\n`);
      session.last_context_token = context_token;
      saveSession(session);
      try {
        const sent = await send(session, context_token, `M0 测试：收到 ${items.length} 项，类型 ${items.map((i: { type: number }) => i.type).join(",")}`);
        console.log("reply", sent.status, { ret: sent.body.ret, errcode: sent.body.errcode });
      } catch (error) {
        console.log("reply failed:", error instanceof Error ? ((error.cause as { code?: string })?.code ?? error.message) : String(error));
      }
    }
  }
}

async function proactive() {
  const session = loadSession();
  const withToken = await send(session, session.last_context_token, "M0 测试：用上次的 context_token 主动发送。");
  console.log("with last context_token", withToken.status, { ret: withToken.body.ret, errcode: withToken.body.errcode, errmsg: withToken.body.errmsg });
  const without = await send(session, undefined, "M0 测试：不带 context_token 主动发送。");
  console.log("without context_token", without.status, { ret: without.body.ret, errcode: without.body.errcode, errmsg: without.body.errmsg });
  console.log("A 200 isn't proof of delivery. Check which messages actually appeared in WeChat.");
}

const command = process.argv[2];
if (command === "login") await login();
else if (command === "listen") await listen();
else if (command === "proactive") await proactive();
else {
  console.error("usage: npm run ilink -- login | listen | proactive");
  process.exit(2);
}
