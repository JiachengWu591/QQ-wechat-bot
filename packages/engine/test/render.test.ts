import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diceGif, gachaPng } from "../src/render.ts";

// The width and height in a PNG's header.
const pngSize = (data: Buffer) => ({ width: data.readUInt32BE(16), height: data.readUInt32BE(20) });
// How many images a GIF holds: each starts with an image descriptor after a graphic control block.
const gifFrames = (data: Buffer) => data.toString("latin1").split("\x21\xf9\x04").length - 1;

describe("drawing", () => {
  it("draws a die rolling and landing on each face, the same each time for the same face", async () => {
    const drawn = await Promise.all([1, 2, 3, 4, 5, 6].map((face) => diceGif(face)));
    for (const [index, die] of drawn.entries()) {
      assert.equal(die.data.subarray(0, 6).toString("latin1"), "GIF89a");
      assert.equal(die.reuseKey, `dice-d6-v1-${index + 1}`);
      assert.equal(die.alt, `骰子 ${index + 1} 点`);
      assert.deepEqual([die.width, die.height], [160, 160]);
      assert.equal(gifFrames(die.data), 12);
    }
    assert.equal(new Set(drawn.map((die) => die.data.toString("base64"))).size, 6, "each face looks different");
    assert.equal((await diceGif(3)).data, drawn[2]!.data, "drawn once, then kept");
  });

  it("plays once rather than looping", async () => {
    // The NETSCAPE loop block is left out when the animation plays once.
    assert.ok(!(await diceGif(2)).data.toString("latin1").includes("NETSCAPE2.0"));
  });

  it("refuses a face a die doesn't have", async () => {
    await assert.rejects(diceGif(0), /骰子没有 0 点/);
    await assert.rejects(diceGif(7), /骰子没有 7 点/);
  });

  it("draws one card, or ten in two rows of five", async () => {
    const one = await gachaPng("小明 的单抽 · 猪猪池", "已 1 抽未出五星", [{ rarity: 5, name: "猪降临" }]);
    assert.equal(one.mediaType, "image/png");
    assert.deepEqual(pngSize(one.data), { width: one.width, height: one.height });
    const ten = await gachaPng(
      "小明 的十连 · 角色池",
      "已 0 抽未出五星",
      Array.from({ length: 10 }, (_, index) => ({ rarity: index === 4 ? (5 as const) : (3 as const), name: `卡${index}` })),
    );
    assert.ok(ten.width > one.width && ten.height > one.height);
    assert.equal(ten.width, 5 * 150 + 4 * 18 + 80);
  });

  it("puts the pool's picture in the card", async () => {
    const { Jimp } = await import("jimp");
    // A solid red picture, so it shows up as red in the middle of the card.
    const red = Buffer.from(await new Jimp({ width: 260, height: 260, color: 0xff0000ff }).getBuffer("image/png"));
    const drawn = await gachaPng("t", "f", [{ rarity: 3, name: "红猪", picture: red }]);
    const image = await Jimp.read(drawn.data);
    const left = (drawn.width - 150) / 2;
    const { r, g, b } = (await import("jimp")).intToRGBA(image.getPixelColor(Math.round(left + 75), 90 + 75));
    assert.deepEqual([r, g, b], [255, 0, 0]);
  });

  it("isn't thrown by names that look like markup", async () => {
    const odd = await gachaPng(`<b>&"小明'</b> 的单抽`, "</svg>", [{ rarity: 4, name: "<script>&" }, { rarity: 3, name: "]]>-->" }]);
    assert.equal(odd.data.subarray(1, 4).toString("latin1"), "PNG");
  });
});
