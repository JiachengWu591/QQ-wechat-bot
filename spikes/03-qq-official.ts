// Checks the official QQ bot: login, gateway connection, which events arrive, a passive
// reply, and how the connection holds up over time. No AI is involved. It replies with
// a fixed test sentence.
//   npm run qq            (stops after SHU_QQ_RUN_MINUTES, default 10; Ctrl+C to stop sooner)
const API = "https://api.bot.qq.com";
const GROUP_AND_C2C_EVENT = 1 << 25;
const RUN_MS = Number(process.env.SHU_QQ_RUN_MINUTES ?? 10) * 60 * 1000;

const appId = process.env.SHU_QQ_APP_ID;
const clientSecret = process.env.SHU_QQ_APP_SECRET;
if (!appId || !clientSecret) {
  console.error("SHU_QQ_APP_ID and SHU_QQ_APP_SECRET must be set in spikes/.env.local");
  process.exit(2);
}

const startedAt = Date.now();
function log(...parts: unknown[]) {
  console.log(`[+${Math.round((Date.now() - startedAt) / 1000)}s]`, ...parts);
}

let accessToken = "";

async function refreshToken(): Promise<number> {
  const res = await fetch(`${API}/app/getAppAccessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId, clientSecret }),
  });
  const body = await res.json();
  if (!body.access_token) {
    console.error("token request failed", res.status, { code: body.code, message: body.message });
    process.exit(1);
  }
  accessToken = body.access_token;
  return Number(body.expires_in);
}

async function callApi(method: string, path: string, payload?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `QQBot ${accessToken}` },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const expiresIn = await refreshToken();
log("token ok, expires in", expiresIn, "s");
setInterval(() => void refreshToken(), Math.max(expiresIn - 60, 60) * 1000).unref();

const gateway = await callApi("GET", "/gateway/bot");
log("gateway", gateway.status, {
  url: gateway.body?.url,
  shards: gateway.body?.shards,
  sessionLimit: gateway.body?.session_start_limit,
});
if (!gateway.body?.url) process.exit(1);

const seen = new Map<string, number>();
const closes: { afterSeconds: number; code: number }[] = [];
let lastSeq: number | null = null;
let sessionId: string | null = null;
let heartbeatsSent = 0;
let heartbeatAcks = 0;
let stopping = false;
let ws: WebSocket;
let connectedAt = 0;
let retryDelayMs = 2000;

function reply(path: string, msgId: string) {
  return callApi("POST", path, {
    content: "M0 测试：已收到。",
    msg_type: 0,
    msg_id: msgId,
    msg_seq: 1,
  });
}

function connect() {
  ws = new WebSocket(gateway.body.url);
  connectedAt = Date.now();
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  ws.addEventListener("message", async (event) => {
    const frame = JSON.parse(String(event.data));
    if (frame.s) lastSeq = frame.s;

    if (frame.op === 10) {
      log("hello, heartbeat interval", frame.d.heartbeat_interval, "ms");
      heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          heartbeatsSent++;
          ws.send(JSON.stringify({ op: 1, d: lastSeq }));
        }
      }, frame.d.heartbeat_interval);
      heartbeat.unref();
      const token = `QQBot ${accessToken}`;
      ws.send(
        JSON.stringify(
          sessionId
            ? { op: 6, d: { token, session_id: sessionId, seq: lastSeq } }
            : { op: 2, d: { token, intents: GROUP_AND_C2C_EVENT, shard: [0, 1], properties: {} } },
        ),
      );
    } else if (frame.op === 11) {
      heartbeatAcks++;
    } else if (frame.op === 7) {
      log("gateway asked for a reconnect");
      ws.close(4000);
    } else if (frame.op === 9) {
      log("invalid session, identifying again", { d: frame.d });
      sessionId = null;
      ws.close(4000);
    } else if (frame.op === 0) {
      seen.set(frame.t, (seen.get(frame.t) ?? 0) + 1);
      const d = frame.d;
      if (frame.t === "READY") {
        sessionId = d.session_id;
        retryDelayMs = 2000;
        log("READY", { bot: d.user?.username });
      } else if (frame.t === "RESUMED") {
        retryDelayMs = 2000;
        log("RESUMED");
      } else if (frame.t === "GROUP_AT_MESSAGE_CREATE") {
        log("group @ message", { sender: d.author?.member_openid, content: d.content, attachments: d.attachments?.length ?? 0 });
        const sent = await reply(`/v2/groups/${d.group_openid}/messages`, d.id);
        log("group reply", sent.status);
      } else if (frame.t === "GROUP_MESSAGE_CREATE") {
        // With "all messages" on, this carries every group message, reportedly including
        // @ messages and the bot's own, so reply only when the bot itself is mentioned.
        const mentionsBot = (d.mentions ?? []).some((m: { is_you?: boolean }) => m.is_you);
        log("group message (all-messages mode)", {
          sender: d.author?.member_openid,
          fromBot: d.author?.bot ?? false,
          content: d.content,
          mentionsBot,
          mentions: d.mentions?.length ?? 0,
          fields: Object.keys(d),
        });
        if (mentionsBot && !d.author?.bot) {
          const sent = await reply(`/v2/groups/${d.group_openid}/messages`, d.id);
          log("group reply", sent.status);
        }
      } else if (frame.t === "C2C_MESSAGE_CREATE") {
        log("private message", { sender: d.author?.user_openid, content: d.content });
        const sent = await reply(`/v2/users/${d.author?.user_openid}/messages`, d.id);
        log("private reply", sent.status);
      } else {
        log("other event", frame.t, { fields: Object.keys(d ?? {}), content: d?.content });
      }
    }
  });

  ws.addEventListener("close", (event) => {
    clearInterval(heartbeat);
    const afterSeconds = Math.round((Date.now() - connectedAt) / 1000);
    if (stopping) return finish();
    closes.push({ afterSeconds, code: event.code });
    log("connection closed", { code: event.code, reason: event.reason, afterSeconds, heartbeatsSent, heartbeatAcks });
    setTimeout(connect, retryDelayMs);
    retryDelayMs = Math.min(retryDelayMs * 2, 30000);
  });
  ws.addEventListener("error", () => log("websocket error"));
}

function finish() {
  log("summary", { closes, heartbeatsSent, heartbeatAcks, events: Object.fromEntries(seen) });
  process.exit(0);
}

connect();
setTimeout(() => {
  stopping = true;
  if (ws.readyState === WebSocket.OPEN) ws.close(1000);
  else finish();
}, RUN_MS);
log("listening. @ the bot in your test group, or message it privately.");
