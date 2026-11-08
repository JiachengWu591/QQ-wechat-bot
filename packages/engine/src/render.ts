// Pictures the bot draws for a chat: dice that roll and land on the result, and what a gacha pull
// brought. Drawn as SVG and turned into pixels by resvg, compiled to WebAssembly, so nothing native
// has to be installed. Chinese text uses a font Windows already has; without one, it's left out.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import gifenc from "gifenc";
import type { ChatImage } from "./types.ts";

const FONT_FAMILY = "Microsoft YaHei";
const FONT_FILES = ["msyh.ttc", "msyhbd.ttc"];

let ready: Promise<void> | null = null;
let fonts: Uint8Array[] | null = null;

// Next to the bundled engine in the installed app; from the package while developing.
function wasmPath(): string {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), "resvg.wasm");
  return existsSync(bundled) ? bundled : createRequire(import.meta.url).resolve("@resvg/resvg-wasm/index_bg.wasm");
}

function loadFonts(): Uint8Array[] {
  if (fonts) return fonts;
  const folder = join(process.env.WINDIR ?? "C:\\Windows", "Fonts");
  fonts = FONT_FILES.map((name) => join(folder, name))
    .filter((path) => existsSync(path))
    .map((path) => new Uint8Array(readFileSync(path)));
  return fonts;
}

async function rasterize(svg: string, withText: boolean): Promise<{ width: number; height: number; pixels: Uint8Array }> {
  ready ??= initWasm(readFileSync(wasmPath()));
  await ready;
  const options = withText ? { font: { fontBuffers: loadFonts(), defaultFontFamily: FONT_FAMILY, sansSerifFamily: FONT_FAMILY } } : { font: { fontBuffers: [] } };
  const renderer = new Resvg(svg, options);
  try {
    const image = renderer.render();
    try {
      return { width: image.width, height: image.height, pixels: new Uint8Array(image.pixels) };
    } finally {
      image.free();
    }
  } finally {
    renderer.free();
  }
}

async function png(svg: string): Promise<{ data: Buffer; width: number; height: number }> {
  ready ??= initWasm(readFileSync(wasmPath()));
  await ready;
  const renderer = new Resvg(svg, { font: { fontBuffers: loadFonts(), defaultFontFamily: FONT_FAMILY, sansSerifFamily: FONT_FAMILY } });
  try {
    const image = renderer.render();
    try {
      return { data: Buffer.from(image.asPng()), width: image.width, height: image.height };
    } finally {
      image.free();
    }
  } finally {
    renderer.free();
  }
}

const escapeXml = (text: string) => text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char] as string);

// ---- Dice ----

const DIE = 160;
const FACE = 84;
// Where the pips sit on a 3×3 grid, as on a real die.
const PIPS: Record<number, Array<[number, number]>> = {
  1: [[1, 1]],
  2: [[0, 0], [2, 2]],
  3: [[0, 0], [1, 1], [2, 2]],
  4: [[0, 0], [2, 0], [0, 2], [2, 2]],
  5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
  6: [[0, 0], [0, 1], [0, 2], [2, 0], [2, 1], [2, 2]],
};

// The die's path through the roll: across, bouncing lower each time, spinning down to a stop.
export const ROLL = [
  { x: 40, lift: 50, turn: -40, squash: 1 },
  { x: 42, lift: 34, turn: 20, squash: 1 },
  { x: 50, lift: 4, turn: 75, squash: 0.86 },
  { x: 57, lift: 28, turn: 130, squash: 1 },
  { x: 63, lift: 36, turn: 180, squash: 1 },
  { x: 68, lift: 20, turn: 225, squash: 1 },
  { x: 72, lift: 2, turn: 262, squash: 0.9 },
  { x: 75, lift: 14, turn: 292, squash: 1 },
  { x: 77, lift: 16, turn: 315, squash: 1 },
  { x: 79, lift: 6, turn: 334, squash: 1 },
  { x: 80, lift: 0, turn: 348, squash: 0.95 },
  { x: 80, lift: 0, turn: 356, squash: 1 },
];

export function dieSvg(face: number, frame: { x: number; lift: number; turn: number; squash: number }): string {
  const cy = 108 - frame.lift;
  const step = FACE / 4;
  // Red one and four, as on Chinese dice.
  const color = face === 1 || face === 4 ? "#d92b2b" : "#1f2430";
  const radius = face === 1 ? 13 : 8;
  const pips = (PIPS[face] ?? [])
    .map(([column, row]) => `<circle cx="${-FACE / 2 + step * (column + 1)}" cy="${-FACE / 2 + step * (row + 1)}" r="${radius}" fill="${color}"/>`)
    .join("");
  const shadow = 0.55 - frame.lift / 160;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${DIE}" height="${DIE}" viewBox="0 0 ${DIE} ${DIE}">`,
    `<ellipse cx="${frame.x}" cy="${152}" rx="${30 + frame.lift / 6}" ry="6" fill="#000" fill-opacity="${shadow.toFixed(2)}"/>`,
    `<g transform="translate(${frame.x} ${cy}) rotate(${frame.turn}) scale(1 ${frame.squash})">`,
    `<rect x="${-FACE / 2}" y="${-FACE / 2}" width="${FACE}" height="${FACE}" rx="16" fill="#fdfcf8" stroke="#2b2b30" stroke-width="4"/>`,
    pips,
    "</g></svg>",
  ].join("");
}

const diceCache = new Map<number, Buffer>();

// A die tumbling across and landing on the face given. The same face always gives the same
// animation, so a platform can keep it after the first upload. Plays once and stays on the result.
export async function diceGif(face: number): Promise<ChatImage> {
  if (!Number.isInteger(face) || face < 1 || face > 6) throw new Error(`骰子没有 ${face} 点。`);
  let data = diceCache.get(face);
  if (!data) {
    const encoder = gifenc.GIFEncoder();
    // Faces shown while it rolls: never the result just before it lands, so the landing reads.
    const tumbling = [3, 5, 2, 6, 1, 4, 2, 5, 3, 6, 4].map((shown) => (shown === face ? (face % 6) + 1 : shown));
    for (const [index, frame] of ROLL.entries()) {
      const last = index === ROLL.length - 1;
      const { width, height, pixels } = await rasterize(dieSvg(last ? face : (tumbling[index] as number), last ? { ...frame, turn: 360 } : frame), false);
      const palette = gifenc.quantize(pixels, 64, { format: "rgba4444", oneBitAlpha: true });
      const transparentIndex = Math.max(0, palette.findIndex((color) => color[3] === 0));
      encoder.writeFrame(gifenc.applyPalette(pixels, palette, "rgba4444"), width, height, {
        palette,
        delay: last ? 3000 : 70,
        transparent: true,
        transparentIndex,
        dispose: 2,
        ...(index === 0 ? { repeat: -1 } : {}),
      });
    }
    encoder.finish();
    data = Buffer.from(encoder.bytes());
    diceCache.set(face, data);
  }
  return { data, mediaType: "image/gif", width: DIE, height: DIE, alt: `骰子 ${face} 点`, reuseKey: `dice-d6-v1-${face}` };
}

// ---- Gacha ----

// A card in a pull's result, with the pool's picture when it has one: PNG, already the card's size.
export type CardView = { rarity: 3 | 4 | 5; name: string; picture?: Buffer };

const RARITY_STYLE: Record<3 | 4 | 5, { from: string; to: string; edge: string }> = {
  5: { from: "#ffe29a", to: "#d08a1e", edge: "#fff1c4" },
  4: { from: "#c9a7ff", to: "#6b3fc4", edge: "#e6d6ff" },
  3: { from: "#9cc3f0", to: "#3a5f93", edge: "#d5e6fa" },
};

function cardSvg(card: CardView, x: number, y: number, width: number, height: number, id: string): string {
  const style = RARITY_STYLE[card.rarity];
  // The picture fills a square at the top of the card; without one, the name's first character.
  const inset = 10;
  const side = width - inset * 2;
  const art = card.picture
    ? [
        `<clipPath id="${id}-clip"><rect x="${x + inset}" y="${y + inset}" width="${side}" height="${side}" rx="10"/></clipPath>`,
        `<rect x="${x + inset}" y="${y + inset}" width="${side}" height="${side}" rx="10" fill="#ffffff" fill-opacity="0.9"/>`,
        `<image href="data:image/png;base64,${card.picture.toString("base64")}" x="${x + inset}" y="${y + inset}" width="${side}" height="${side}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id}-clip)"/>`,
      ].join("")
    : [
        `<circle cx="${x + width / 2}" cy="${y + inset + side / 2}" r="${side * 0.38}" fill="#ffffff" fill-opacity="0.22"/>`,
        `<text x="${x + width / 2}" y="${y + inset + side / 2 + 18}" font-size="${Math.round(width * 0.3)}" font-weight="700" fill="#fff" text-anchor="middle">${escapeXml([...card.name][0] ?? "?")}</text>`,
      ].join("");
  return [
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${style.from}"/><stop offset="1" stop-color="${style.to}"/></linearGradient></defs>`,
    card.rarity === 5 ? `<rect x="${x - 5}" y="${y - 5}" width="${width + 10}" height="${height + 10}" rx="18" fill="#ffd36b" fill-opacity="0.35"/>` : "",
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="14" fill="url(#${id})" stroke="${style.edge}" stroke-width="3"/>`,
    art,
    `<text x="${x + width / 2}" y="${y + inset + side + 26}" font-size="16" fill="#fff8e1" text-anchor="middle">${"★".repeat(card.rarity)}</text>`,
    `<text x="${x + width / 2}" y="${y + height - 14}" font-size="${card.name.length > 6 ? 14 : 17}" font-weight="700" fill="#fff" text-anchor="middle">${escapeXml(card.name)}</text>`,
  ].join("");
}

// Pictures waiting to go into the pool, numbered, five to a row, each with a line about it.
export async function candidateSheetPng(title: string, entries: Array<{ label: string; caption: string; picture?: Buffer }>): Promise<ChatImage> {
  const cell = 150;
  const cellHeight = cell + 58;
  const gap = 14;
  const columns = Math.min(5, Math.max(1, entries.length));
  const rows = Math.ceil(entries.length / 5);
  const width = Math.max(420, columns * cell + (columns - 1) * gap + 60);
  const height = 80 + rows * cellHeight + (rows - 1) * gap + 30;
  const left = (width - (columns * cell + (columns - 1) * gap)) / 2;
  const body = entries
    .map((entry, index) => {
      const x = left + (index % 5) * (cell + gap);
      const y = 70 + Math.floor(index / 5) * (cellHeight + gap);
      const picture = entry.picture
        ? `<clipPath id="c${index}"><rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="10"/></clipPath><image href="data:image/png;base64,${entry.picture.toString("base64")}" x="${x}" y="${y}" width="${cell}" height="${cell}" preserveAspectRatio="xMidYMid slice" clip-path="url(#c${index})"/>`
        : `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="10" fill="#2a2f55"/>`;
      return [
        `<rect x="${x - 3}" y="${y - 3}" width="${cell + 6}" height="${cellHeight}" rx="12" fill="#ffffff" fill-opacity="0.08"/>`,
        picture,
        `<rect x="${x + 6}" y="${y + 6}" width="44" height="24" rx="12" fill="#e8453c"/>`,
        `<text x="${x + 28}" y="${y + 23}" font-size="15" font-weight="700" fill="#fff" text-anchor="middle">${escapeXml(entry.label)}</text>`,
        `<text x="${x + cell / 2}" y="${y + cell + 30}" font-size="14" fill="#e6e8ff" text-anchor="middle">${escapeXml(entry.caption)}</text>`,
      ].join("");
    })
    .join("");
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="#151936"/>`,
    `<text x="${width / 2}" y="46" font-size="26" font-weight="700" fill="#fff" text-anchor="middle">${escapeXml(title)}</text>`,
    body,
    "</svg>",
  ].join("");
  const picture = await png(svg);
  return { ...picture, mediaType: "image/png", alt: title };
}

// One card, or ten in two rows, under a title and a line about the pity.
export async function gachaPng(title: string, footer: string, cards: CardView[]): Promise<ChatImage> {
  const cardWidth = 150;
  const cardHeight = 210;
  const gap = 18;
  const columns = Math.min(5, cards.length);
  const rows = Math.ceil(cards.length / 5);
  const width = Math.max(420, columns * cardWidth + (columns - 1) * gap + 80);
  const height = 110 + rows * cardHeight + (rows - 1) * gap + 70;
  const left = (width - (columns * cardWidth + (columns - 1) * gap)) / 2;
  const stars = Array.from({ length: 40 }, (_, index) => {
    const sx = (index * 97) % width;
    const sy = (index * 53) % height;
    return `<circle cx="${sx}" cy="${sy}" r="${index % 3 === 0 ? 1.6 : 1}" fill="#fff" fill-opacity="${0.25 + (index % 4) * 0.1}"/>`;
  }).join("");
  const body = cards
    .map((card, index) => cardSvg(card, left + (index % 5) * (cardWidth + gap), 90 + Math.floor(index / 5) * (cardHeight + gap), cardWidth, cardHeight, `card${index}`))
    .join("");
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d2347"/><stop offset="1" stop-color="#0d1024"/></linearGradient></defs>`,
    `<rect width="${width}" height="${height}" fill="url(#sky)"/>`,
    stars,
    `<text x="${width / 2}" y="54" font-size="28" font-weight="700" fill="#fff" text-anchor="middle">${escapeXml(title)}</text>`,
    body,
    `<text x="${width / 2}" y="${height - 30}" font-size="16" fill="#c8cbe8" text-anchor="middle">${escapeXml(footer)}</text>`,
    "</svg>",
  ].join("");
  const picture = await png(svg);
  return { ...picture, mediaType: "image/png", alt: title };
}
