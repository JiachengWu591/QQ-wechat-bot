// Starts the engine daemon. It comes up stopped: nothing runs until the owner flips the switch.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ApiBrain } from "./brain.ts";
import { Engine } from "./engine.ts";
import { QqAdapter } from "./qq.ts";
import { startServer } from "./server.ts";
import { SIM_CHANNEL_ID, SimAdapter, simSenders } from "./sim.ts";
import { Store } from "./store.ts";
import { currentTimeTool } from "./tools.ts";
import type { Adapter } from "./types.ts";
import { fileSessionStore, WeChatAdapter } from "./wechat.ts";
import { Workspace, workspaceTools } from "./workspace.ts";
import { WxHelperScreen } from "./wx-screen.ts";

const token = process.env.SHU_ENGINE_TOKEN;
if (!token) {
  console.error("SHU_ENGINE_TOKEN must be set by whatever starts the engine.");
  process.exit(2);
}

const dataDir = process.env.SHU_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? homedir(), "Shu");
mkdirSync(dataDir, { recursive: true });
const store = new Store(join(dataDir, "shu.db"));

const apiKey = process.env.SHU_ANTHROPIC_API_KEY;
const brain = apiKey ? new ApiBrain({ apiKey, model: process.env.SHU_MODEL ?? "claude-opus-5-5" }) : null;

// Lets a second copy run for testing without taking over the first one's QQ connection.
const channels = new Set((process.env.SHU_CHANNELS ?? "qq,wechat,sim").split(",").map((channel) => channel.trim()));

const { SHU_QQ_APP_ID: qqAppId, SHU_QQ_APP_SECRET: qqAppSecret } = process.env;
const adapters: Adapter[] = [
  ...(channels.has("qq") && qqAppId && qqAppSecret ? [new QqAdapter({ appId: qqAppId, appSecret: qqAppSecret })] : []),
  ...(channels.has("wechat") ? [new WeChatAdapter({ sessionStore: fileSessionStore(join(dataDir, "wechat-session.json")) })] : []),
  ...(channels.has("sim") ? [new SimAdapter()] : []),
];

const workspace = new Workspace(join(dataDir, "workspace"));

const engine = new Engine({
  store,
  brain,
  adapters,
  workspace,
  tools: [currentTimeTool, ...workspaceTools(workspace)],
  // Available here, but off until the owner turns it on in the console.
  ...(process.platform === "win32" ? { workbench: { screen: new WxHelperScreen(), intervalMs: Number(process.env.SHU_WECHAT_SCAN_SECONDS ?? 15) * 1000 } } : {}),
  config: {
    botName: process.env.SHU_BOT_NAME ?? "枢",
    access: {
      owners: simSenders.filter((sender) => sender.tier === "owner").map((sender) => ({ channelId: SIM_CHANNEL_ID, senderId: sender.id })),
      trusted: simSenders.filter((sender) => sender.tier === "trusted").map((sender) => ({ channelId: SIM_CHANNEL_ID, senderId: sender.id })),
    },
    dailyLimitUsd: Number(process.env.SHU_DAILY_LIMIT_USD ?? 3),
    ownerDailyLimitUsd: Number(process.env.SHU_OWNER_DAILY_LIMIT_USD ?? 5),
    taskAckMs: 20_000,
    fileSettleMs: 5000,
    webSearch: process.env.SHU_WEB_SEARCH !== "off",
    sharedSearchesPerDay: Number(process.env.SHU_SHARED_SEARCHES_PER_DAY ?? 10),
    contextMessages: 30,
    perSenderPerMinute: 10,
    perConversationPerMinute: 20,
    retentionDays: 30,
    simSenders,
  },
});

const server = await startServer({
  engine,
  port: Number(process.env.SHU_ENGINE_PORT ?? 47821),
  token,
  allowedOrigins: (process.env.SHU_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean),
  simSenderName: (senderId) => simSenders.find((sender) => sender.id === senderId)?.name,
});
console.log(`engine listening on 127.0.0.1:${server.port}, model ${brain?.model ?? "not configured"}`);

// Set by the desktop app for the first engine it starts after Windows started it, and no other.
if (process.env.SHU_LAUNCHED_AT_LOGIN === "1") await engine.startAtLogin();

async function shutdown() {
  await engine.stop();
  await server.close();
  store.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
