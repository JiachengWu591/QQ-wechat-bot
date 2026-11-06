// Bundled the same way as the engine and run beside it, on the Node the installed app ships with:
// the parts that lean on outside libraries or on files next to the bundle, each once.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jimp } from "jimp";
import { prepareImage } from "../src/images.ts";
import { Store } from "../src/store.ts";
import { Workspace, workspaceTools } from "../src/workspace.ts";
import { WxHelperScreen } from "../src/wx-screen.ts";

const root = mkdtempSync(join(tmpdir(), "shu-smoke-"));
try {
  const store = new Store(join(root, "shu.db"));
  store.setSetting("smoke", true);
  assert.equal(store.getSetting("smoke"), true);
  store.close();

  const workspace = new Workspace(join(root, "workspace"));
  const tool = (name: string) => workspaceTools(workspace).find((candidate) => candidate.name === name)!;
  const made = await tool("create_spreadsheet").run({ filename: "冒烟", sheets: [{ name: "表", rows: [["名字", "数"], ["甲", 1], ["合计", { formula: "=B2*2", result: 2 }]] }] }, {});
  const sheet = String(await tool("read_workspace_file").run({ path: String(made).replace(/^已生成：/, "") }, {}));
  assert.match(sheet, /甲/);
  const written = await tool("create_document").run({ filename: "冒烟", title: "标题", blocks: [{ type: "paragraph", text: "第一段" }, { type: "table", rows: [["a", "b"]] }] }, {});
  const document = String(await tool("read_workspace_file").run({ path: String(written).replace(/^已生成：/, "") }, {}));
  assert.match(document, /第一段/);

  const tall = await new Jimp({ width: 400, height: 2000, color: 0xffffffff }).getBuffer("image/png");
  const { parts } = await prepareImage(Buffer.from(tall));
  assert.ok(parts.length > 1, "a tall picture is cut into pieces");

  // The helper is found beside the bundle, and its own reading code runs.
  const screen = new WxHelperScreen();
  try {
    const located = await screen.selfTestLocate();
    assert.deepEqual(located.rows, [340, 470]);
  } finally {
    await screen.stop();
  }
  console.log("smoke test passed: SQLite, Excel, Word, images and the WeChat helper all work from the bundle");
} finally {
  rmSync(root, { recursive: true, force: true });
}
