import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { describe, it } from "node:test";
import { fiveStarChance, freshState, POOL_RULES, pull, type Pools } from "../src/gacha.ts";

const pools: Pools = { 5: ["猪降临"], 4: ["猪摸鱼", "猪加班"], 3: ["猪", "小猪", "猪猪"] };
// Every draw as high as it can be: nothing is ever won by luck, only by pity.
const unlucky = (below: number) => below - 1;
// Every draw as low as it can be: every chance comes off.
const lucky = () => 0;

describe("gacha rules", () => {
  it("makes a 5-star certain on the 90th pull, and not before, when unlucky", () => {
    const state = freshState();
    const pulls = Array.from({ length: 90 }, () => pull(POOL_RULES, pools, state, unlucky));
    assert.deepEqual(pulls.map((item, index) => (item.rarity === 5 ? index + 1 : null)).filter(Boolean), [90]);
    assert.deepEqual(pulls.at(-1), { rarity: 5, name: "猪降临", pity: 90 });
    assert.equal(state.sinceFive, 0);
    assert.equal(state.total, 90);
    assert.equal(state.fives, 1);
  });

  it("gives a 4-star at least every ten pulls", () => {
    const state = freshState();
    const rarities = Array.from({ length: 30 }, () => pull(POOL_RULES, pools, state, unlucky).rarity);
    assert.deepEqual(rarities.map((rarity, index) => (rarity === 4 ? index + 1 : null)).filter(Boolean), [10, 20, 30]);
  });

  it("raises the 5-star chance from the 74th pull", () => {
    assert.equal(fiveStarChance(POOL_RULES, 73), 0.006);
    assert.ok(Math.abs(fiveStarChance(POOL_RULES, 74) - 0.066) < 1e-9);
    assert.ok(Math.abs(fiveStarChance(POOL_RULES, 80) - 0.426) < 1e-9);
    assert.equal(fiveStarChance(POOL_RULES, 90), 1);
  });

  it("names what it pulls from the pool of that rarity", () => {
    const state = freshState();
    assert.deepEqual(pull(POOL_RULES, pools, state, lucky), { rarity: 5, name: "猪降临", pity: 1 });
    const common = pull(POOL_RULES, pools, freshState(), unlucky);
    assert.equal(common.rarity, 3);
    assert.equal(common.name, "猪猪", "the last name, since every draw is as high as it gets");
  });

  it("refuses a pool without any of a rarity it lands on", () => {
    assert.throws(() => pull(POOL_RULES, { ...pools, 5: [] }, freshState(), lucky), /卡池里没有5星/);
  });

  it("comes out near one 5-star in 62 over many pulls", () => {
    const state = freshState();
    let fives = 0;
    const pulls = 200_000;
    for (let index = 0; index < pulls; index++) if (pull(POOL_RULES, pools, state, (below) => randomInt(below)).rarity === 5) fives++;
    const rate = fives / pulls;
    assert.ok(Math.abs(rate - 1 / 62.5) / (1 / 62.5) < 0.12, `${rate} against about ${1 / 62.5}`);
  });
});
