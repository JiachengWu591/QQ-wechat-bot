// The rules of a gacha, as the common simulators play them: the top rarity is rare, gets likelier
// after many pulls without it and is certain by a pity pull; a 4-star comes at least every ten.
// What can be pulled is a pool the owner fills, so no names or pictures are made up here.

export type Rarity = 3 | 4 | 5;

export type GachaItem = {
  rarity: Rarity;
  name: string;
  // Which pull since the last 5-star it took, for a 5-star.
  pity?: number;
};

export type GachaState = {
  sinceFive: number;
  sinceFour: number;
  total: number;
  fives: number;
};

export const freshState = (): GachaState => ({ sinceFive: 0, sinceFour: 0, total: 0, fives: 0 });

export type Rules = {
  fiveBase: number;
  // From this pull on, each pull adds softStep to the chance, until hardPity makes it certain.
  softFrom: number;
  softStep: number;
  hardPity: number;
  fourBase: number;
  fourEvery: number;
};

// 0.6% for 5-star, rising from the 74th pull, certain on the 90th; 5.1% for 4-star, certain every
// tenth. Over many pulls that comes to about one 5-star in 62.
export const POOL_RULES: Rules = { fiveBase: 0.006, softFrom: 74, softStep: 0.06, hardPity: 90, fourBase: 0.051, fourEvery: 10 };

export type Pools = Record<Rarity, string[]>;

// The chance of the top rarity on the nth pull since the last one.
export function fiveStarChance(rules: Rules, nth: number): number {
  if (nth >= rules.hardPity) return 1;
  if (nth < rules.softFrom) return rules.fiveBase;
  return Math.min(1, rules.fiveBase + rules.softStep * (nth - rules.softFrom + 1));
}

const SCALE = 1_000_000;

// One pull. Changes the state it's given. `random` gives a whole number from 0 up to, not including,
// its bound. Every rarity in the pools needs at least one name.
export function pull(rules: Rules, pools: Pools, state: GachaState, random: (below: number) => number): GachaItem {
  const chance = (p: number) => random(SCALE) < p * SCALE;
  const pick = (rarity: Rarity) => {
    const names = pools[rarity];
    if (!names.length) throw new Error(`卡池里没有${rarity}星。`);
    return names[random(names.length)] as string;
  };
  const nth = state.sinceFive + 1;
  state.total += 1;

  if (chance(fiveStarChance(rules, nth))) {
    state.sinceFive = 0;
    state.sinceFour = 0;
    state.fives += 1;
    return { rarity: 5, name: pick(5), pity: nth };
  }
  state.sinceFive += 1;
  if (state.sinceFour + 1 >= rules.fourEvery || chance(rules.fourBase)) {
    state.sinceFour = 0;
    return { rarity: 4, name: pick(4) };
  }
  state.sinceFour += 1;
  return { rarity: 3, name: pick(3) };
}
