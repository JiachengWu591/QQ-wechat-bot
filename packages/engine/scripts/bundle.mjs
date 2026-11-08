// Builds the engine for the installed app: one file, the PowerShell scripts it runs beside it, and
// the Node it runs on, so nothing is needed from this checkout once installed. With --smoke it also
// runs, on that Node, the parts that lean on outside libraries, to see bundling hasn't broken them.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../src/", import.meta.url));
const out = fileURLToPath(new URL("../../../apps/desktop/src-tauri/engine/", import.meta.url));

// The engine relies on Node's own SQLite and on TypeScript being stripped as it was written.
const major = Number(process.versions.node.split(".")[0]);
if (major < 24) throw new Error(`Node ${process.versions.node} is too old to ship; the engine needs 24 or later.`);

const options = {
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  // Some libraries are CommonJS and call require for Node's own modules.
  banner: { js: "import { createRequire as __shuCreateRequire } from 'node:module'; const require = __shuCreateRequire(import.meta.url);" },
  legalComments: "none",
  logLevel: "warning",
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({ ...options, entryPoints: [join(source, "main.ts")], outfile: join(out, "engine.mjs") });
for (const script of ["wx-common.ps1", "wx-helper.ps1", "wx-send.ps1"]) copyFileSync(join(source, script), join(out, script));
// The renderer for the pictures the bot draws, which render.ts looks for beside the bundle.
copyFileSync(createRequire(import.meta.url).resolve("@resvg/resvg-wasm/index_bg.wasm"), join(out, "resvg.wasm"));
// The WebP decoder, which webp.ts looks for beside the bundle.
copyFileSync(createRequire(import.meta.url).resolve("@jsquash/webp/codec/dec/webp_dec.wasm"), join(out, "webp_dec.wasm"));
copyFileSync(process.execPath, join(out, "node.exe"));
console.log(`engine bundled into ${out} with Node ${process.versions.node}`);

if (process.argv.includes("--smoke")) {
  const smoke = join(out, "smoke.mjs");
  await build({ ...options, entryPoints: [fileURLToPath(new URL("./smoke.ts", import.meta.url))], outfile: smoke });
  try {
    const result = spawnSync(join(out, "node.exe"), ["--disable-warning=ExperimentalWarning", smoke], { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`the smoke test failed (${result.status ?? result.signal})`);
  } finally {
    rmSync(smoke, { force: true });
  }
}
