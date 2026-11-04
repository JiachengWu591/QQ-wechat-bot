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
import { defaultTools } from "./tools.ts";
import type { Adapter } from "./types.ts";

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

const { SHU_QQ_APP_ID: qqAppId, SHU_QQ_APP_SECRET: qqAppSecret } = process.env;
const adapters: Adapter[] = [
  ...(qqAppId && qqAppSecret ? [new QqAdapter({ appId: qqAppId, appSecret: qqAppSecret })] : []),
  new SimAdapter(),
];

const engine = new Engine({
  store,
  brain,
  adapters,
  tools: defaultTools(join(dataDir, "workspace")),
  config: {
    botName: process.env.SHU_BOT_NAME ?? "枢",
    access: {
      owners: simSenders.filter((sender) => sender.tier === "owner").map((sender) => ({ channelId: SIM_CHANNEL_ID, senderId: sender.id })),
      trusted: simSenders.filter((sender) => sender.tier === "trusted").map((sender) => ({ channelId: SIM_CHANNEL_ID, senderId: sender.id })),
    },
    dailyLimitUsd: Number(process.env.SHU_DAILY_LIMIT_USD ?? 3),
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

async function shutdown() {
  await engine.stop();
  await server.close();
  store.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
