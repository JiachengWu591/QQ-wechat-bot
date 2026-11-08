// Gets a picture ready for the model. A long phone screenshot would otherwise be scaled down
// until its text can't be read, so tall images are cut into overlapping pieces.
import { Jimp } from "jimp";

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
export type ImagePart = { mediaType: ImageMediaType; data: Buffer };

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_WIDTH = 1600;
const TILE_RATIO = 1.6;
const OVERLAP_RATIO = 0.05;
const MAX_TILES = 20;
const JPEG_QUALITY = 85;

// The file's extension can't be trusted, and the API rejects a mismatched media type.
export function sniffImage(data: Buffer): ImageMediaType | null {
  if (data.length >= 8 && data.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.toString("latin1", 0, 4) === "GIF8") return "image/gif";
  if (data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export async function prepareImage(data: Buffer): Promise<{ parts: ImagePart[]; note?: string }> {
  const mediaType = sniffImage(data);
  if (!mediaType) throw new Error("认不出这种图片格式。");

  // Neither is how phones save screenshots, and the library can't decode WebP.
  if (mediaType === "image/gif" || mediaType === "image/webp") {
    if (data.length > MAX_BYTES) throw new Error("图片太大，读不了。");
    return { parts: [{ mediaType, data }] };
  }

  const image = await Jimp.read(data);
  const tall = image.height > image.width * TILE_RATIO * 1.25;
  if (!tall && data.length <= MAX_BYTES) return { parts: [{ mediaType, data }] };

  if (image.width > MAX_WIDTH) image.resize({ w: MAX_WIDTH });
  const encode = async (piece: { getBuffer(mime: "image/jpeg", options: { quality: number }): Promise<Buffer> }): Promise<ImagePart> => ({
    mediaType: "image/jpeg",
    data: Buffer.from(await piece.getBuffer("image/jpeg", { quality: JPEG_QUALITY })),
  });
  if (!tall) return { parts: [await encode(image)] };

  const { width, height } = image;
  const tileHeight = Math.round(width * TILE_RATIO);
  const step = tileHeight - Math.round(tileHeight * OVERLAP_RATIO);
  const parts: ImagePart[] = [];
  let top = 0;
  while (top < height && parts.length < MAX_TILES) {
    const h = Math.min(tileHeight, height - top);
    parts.push(await encode(image.clone().crop({ x: 0, y: top, w: width, h })));
    if (top + h >= height) {
      top = height;
      break;
    }
    top += step;
  }
  const cutOff = top < height;
  return {
    parts,
    note: `这张长图切成了 ${parts.length} 段，从上到下排列，相邻两段有少量重叠。${cutOff ? "图太长，后面的部分没有读到，告诉主人。" : ""}`,
  };
}
