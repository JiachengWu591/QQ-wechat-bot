// WebP pictures turned into PNG. QQ's picture store, the renderer and the image library don't take
// WebP, and many pictures on PigHub are WebP whatever their names say. The decoder is Google's
// libwebp compiled to WebAssembly (repackaged from Squoosh as @jsquash/webp). It reads still
// pictures only, so an animated one is turned away before it's tried.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import decode, { init } from "@jsquash/webp/decode.js";
import { Jimp } from "jimp";

// A picture bigger than this many pixels isn't worth a card, and would take a lot of memory.
const MAX_PIXELS = 16 * 1024 * 1024;

let ready: Promise<void> | null = null;

// Next to the bundled engine in the installed app; from the package while developing.
function wasmPath(): string {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), "webp_dec.wasm");
  return existsSync(bundled) ? bundled : createRequire(import.meta.url).resolve("@jsquash/webp/codec/dec/webp_dec.wasm");
}

// Node has it; the type settings here leave it out.
declare const WebAssembly: { compile(bytes: Uint8Array): Promise<object> };

// Given the compiled module, the decoder never goes looking for its file over the network.
const initWith = init as unknown as (module: object) => Promise<void>;

export function isAnimatedWebp(data: Buffer): boolean {
  return data.length >= 21 && data.toString("latin1", 12, 16) === "VP8X" && ((data[20] as number) & 0x02) !== 0;
}

export async function webpToPng(data: Buffer): Promise<Buffer> {
  if (isAnimatedWebp(data)) throw new Error("会动的 WebP 用不了，换一张。");
  ready ??= WebAssembly.compile(readFileSync(wasmPath())).then(initWith);
  await ready;
  const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const image = (await decode(copy).catch(() => {
    throw new Error("这张图读不出来，换一张。");
  })) as unknown as { data: Uint8ClampedArray; width: number; height: number };
  if (image.width * image.height > MAX_PIXELS) throw new Error("图片太大了，换一张。");
  const picture = new Jimp({ width: image.width, height: image.height, data: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength) });
  return Buffer.from(await picture.getBuffer("image/png"));
}
