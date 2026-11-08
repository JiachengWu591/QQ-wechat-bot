import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Jimp } from "jimp";
import { sniffImage } from "../src/images.ts";
import { isAnimatedWebp, webpToPng } from "../src/webp.ts";
import { WEBP_ANIMATED, WEBP_BROKEN, WEBP_EXTENDED, WEBP_GREEN, WEBP_ORANGE } from "./helpers.ts";

describe("WebP pictures", () => {
  it("become PNG of the same size and colour", async () => {
    for (const [webp, color] of [
      [WEBP_GREEN, 0x66cc99ff],
      [WEBP_ORANGE, 0xcc6633ff],
    ] as const) {
      const png = await webpToPng(webp);
      assert.equal(sniffImage(png), "image/png");
      const image = await Jimp.read(png);
      assert.deepEqual([image.width, image.height], [120, 90]);
      assert.equal(image.getPixelColor(60, 45), color);
    }
  });

  it("keep their transparency, with an extended header too", async () => {
    const image = await Jimp.read(await webpToPng(WEBP_EXTENDED));
    assert.deepEqual([image.width, image.height], [64, 48]);
    assert.equal(image.getPixelColor(10, 24) & 0xff, 0xff, "the left half is solid");
    assert.equal(image.getPixelColor(54, 24) & 0xff, 0, "the right half is clear");
  });

  it("turn away an animated one before decoding it", async () => {
    assert.equal(isAnimatedWebp(WEBP_ANIMATED), true);
    assert.equal(isAnimatedWebp(WEBP_GREEN), false);
    assert.equal(isAnimatedWebp(WEBP_EXTENDED), false, "still, though its header is the extended kind");
    assert.equal(isAnimatedWebp(Buffer.from("RIFF")), false);
    await assert.rejects(webpToPng(WEBP_ANIMATED), /会动的 WebP 用不了/);
  });

  it("say so when one can't be read", async () => {
    await assert.rejects(webpToPng(WEBP_BROKEN), /读不出来/);
    // And the decoder still works after a failure.
    assert.equal(sniffImage(await webpToPng(WEBP_GREEN)), "image/png");
  });
});
