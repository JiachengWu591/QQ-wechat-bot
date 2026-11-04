// Starts the engine and the console together for development, with a fresh token per run.
// The API key is read from spikes/.env.local if it exists; without it the bot can't reply,
// but everything else works.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const token = randomBytes(24).toString("hex");
const enginePort = process.env.SHU_ENGINE_PORT ?? "47821";
const webPort = process.env.SHU_WEB_PORT ?? "5173";
const dataDir = join(root, ".dev", "data");
mkdirSync(dataDir, { recursive: true });

const envFile = join(root, "spikes", ".env.local");
const nodeArgs = ["--disable-warning=ExperimentalWarning", ...(existsSync(envFile) ? [`--env-file=${envFile}`] : []), "src/main.ts"];

const engine = spawn(process.execPath, nodeArgs, {
  cwd: join(root, "packages", "engine"),
  stdio: "inherit",
  env: {
    ...process.env,
    SHU_ENGINE_TOKEN: token,
    SHU_ENGINE_PORT: enginePort,
    SHU_DATA_DIR: dataDir,
    SHU_ALLOWED_ORIGINS: [`http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`].join(","),
  },
});

const vite = spawn(process.execPath, [join(root, "apps", "desktop", "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", webPort, "--strictPort"], {
  cwd: join(root, "apps", "desktop"),
  stdio: "inherit",
  env: { ...process.env, VITE_ENGINE_TOKEN: token, VITE_ENGINE_PORT: enginePort },
});

function stopAll() {
  engine.kill();
  vite.kill();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stopAll);
for (const child of [engine, vite]) {
  child.on("exit", (code) => {
    stopAll();
    process.exitCode = code ?? 0;
  });
}
