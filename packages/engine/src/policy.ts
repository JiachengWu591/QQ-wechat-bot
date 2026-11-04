// Who may do what. Enforced in code, because a model can be talked out of its instructions.
import type { ConversationKind, Tier } from "@shu/protocol";

const rank: Record<Tier, number> = { member: 0, trusted: 1, owner: 2 };

export function atLeast(tier: Tier, required: Tier): boolean {
  return rank[tier] >= rank[required];
}

export type Identity = { channelId: string; senderId: string };

export type AccessList = { owners: Identity[]; trusted: Identity[] };

// Identity comes from the sender's account ID. Display names and rooms prove nothing:
// anyone can call themselves the owner, and anyone in an allowed group can speak in it.
export function tierOf(access: AccessList, channelId: string, senderId: string): Tier {
  const matches = (entry: Identity) => entry.channelId === channelId && entry.senderId === senderId;
  if (access.owners.some(matches)) return "owner";
  if (access.trusted.some(matches)) return "trusted";
  return "member";
}

// A turn runs with the lowest authority of anything in its context, since text from a
// less trusted sender can steer the model whoever asked. Groups also stop short of owner,
// because the reply is visible to the whole room.
export function effectiveTier(contextTiers: Tier[], kind: ConversationKind): Tier {
  const lowest = contextTiers.reduce<Tier>((low, tier) => (rank[tier] < rank[low] ? tier : low), "owner");
  return kind === "group" && lowest === "owner" ? "trusted" : lowest;
}

// Sliding window kept in memory. Limits reset when the engine restarts.
export class RateLimiter {
  #hits = new Map<string, number[]>();
  #limit: number;
  #windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  allow(key: string, now: number): boolean {
    const recent = (this.#hits.get(key) ?? []).filter((at) => now - at < this.#windowMs);
    const allowed = recent.length < this.#limit;
    if (allowed) recent.push(now);
    this.#hits.set(key, recent);
    return allowed;
  }
}
