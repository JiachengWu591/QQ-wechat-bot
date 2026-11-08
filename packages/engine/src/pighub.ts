// PigHub (pighub.top), a public collection of pig pictures that offers them for download. The
// owner can fill the gacha pool from it. Its list says how often each picture was viewed and
// downloaded there, which is how much other people use it.
//
// Only this one site is fetched, only its list and the pictures the owner's choice lands on, one at
// a time. Nothing is sent back: its view and download counters are left alone.
import { z } from "zod";

export const PIGHUB_ORIGIN = "https://pighub.top";
const LIST_URL = `${PIGHUB_ORIGIN}/api/images?sort=2`;
// The list changes slowly, and one fetch is the whole of it.
const LIST_KEPT_MS = 60 * 60 * 1000;
const LIST_MAX_BYTES = 8 * 1024 * 1024;
const PICTURE_MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
// Pictures just shown to the owner, so adding them doesn't fetch them again.
const RECENT_KEPT = 16;
const USER_AGENT = "Shu-bot";

export type PighubPicture = {
  id: number;
  title: string;
  filename: string;
  views: number;
  downloads: number;
};

const entry = z.object({
  id: z.number().int().nonnegative(),
  title: z.string(),
  filename: z.string().min(1).max(200),
  view_count: z.number().nonnegative(),
  download_count: z.number().nonnegative(),
  image_url: z.string(),
});

// Kinds the pool can take; anything else on the site is left out.
const USABLE = /\.(jpe?g|png|gif)$/i;

export type PighubSource = {
  // Most used first: the share of a picture's viewers who downloaded it.
  list(signal?: AbortSignal): Promise<PighubPicture[]>;
  picture(picture: PighubPicture, signal?: AbortSignal): Promise<Buffer>;
};

// How much a picture gets used, fairly between old pictures and new: the share of the people who
// saw it that took it.
export const useOf = (picture: PighubPicture) => picture.downloads / Math.max(1, picture.views);

export function cleanTitle(title: string, filename: string): string {
  const cleaned = title.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  return cleaned || filename.replace(/\.[^.]+$/, "");
}

// The site's list as pictures the pool could take, most used first. Entries that don't look like
// a plain picture in its images folder are dropped.
export function parseList(body: unknown): PighubPicture[] {
  const data = z.object({ code: z.literal(0), data: z.array(z.unknown()) }).safeParse(body);
  if (!data.success) throw new Error("PigHub 返回的列表看不懂。");
  const pictures: PighubPicture[] = [];
  const seen = new Set<number>();
  for (const raw of data.data.data) {
    const parsed = entry.safeParse(raw);
    if (!parsed.success) continue;
    const { id, title, filename, view_count, download_count, image_url } = parsed.data;
    if (seen.has(id) || /[\\/]/.test(filename) || filename.startsWith(".") || !USABLE.test(filename) || image_url !== `/images/${filename}`) continue;
    seen.add(id);
    pictures.push({ id, title: cleanTitle(title, filename), filename, views: view_count, downloads: download_count });
  }
  return pictures.sort((a, b) => useOf(b) - useOf(a) || b.downloads - a.downloads || a.id - b.id);
}

async function readCapped(response: Response, max: number, tooBig: string): Promise<Buffer> {
  if (Number(response.headers.get("content-length") ?? 0) > max) throw new Error(tooBig);
  if (!response.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > max) throw new Error(tooBig);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export class Pighub implements PighubSource {
  #fetch: typeof fetch;
  #now: () => number;
  #list?: { at: number; pictures: PighubPicture[] };
  #recent = new Map<number, Buffer>();

  constructor(options: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async #get(url: string, signal: AbortSignal | undefined): Promise<Response> {
    const response = await this.#fetch(url, {
      // Stays on the site: a redirect elsewhere is refused rather than followed.
      redirect: "error",
      headers: { "user-agent": USER_AGENT },
      signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]),
    }).catch((error: unknown) => {
      if (signal?.aborted) throw error;
      throw new Error(`连不上 PigHub：${error instanceof Error ? error.message : String(error)}`);
    });
    if (!response.ok) throw new Error(`PigHub 出错了（HTTP ${response.status}）。`);
    return response;
  }

  async list(signal?: AbortSignal): Promise<PighubPicture[]> {
    if (this.#list && this.#now() - this.#list.at < LIST_KEPT_MS) return this.#list.pictures;
    const response = await this.#get(LIST_URL, signal);
    const text = (await readCapped(response, LIST_MAX_BYTES, "PigHub 的列表太大了。")).toString("utf8");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("PigHub 返回的列表看不懂。");
    }
    const pictures = parseList(body);
    this.#list = { at: this.#now(), pictures };
    return pictures;
  }

  async picture(picture: PighubPicture, signal?: AbortSignal): Promise<Buffer> {
    const kept = this.#recent.get(picture.id);
    if (kept) return kept;
    const response = await this.#get(`${PIGHUB_ORIGIN}/images/${encodeURIComponent(picture.filename)}`, signal);
    const data = await readCapped(response, PICTURE_MAX_BYTES, "图片太大了，要 10 MB 以内。");
    this.#recent.set(picture.id, data);
    for (const id of this.#recent.keys()) {
      if (this.#recent.size <= RECENT_KEPT) break;
      this.#recent.delete(id);
    }
    return data;
  }
}
