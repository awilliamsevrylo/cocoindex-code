// Per-isolate pool shared by BOTH egress routes (/v1/embeddings and
// /v1/rerank). One scheduler and one cooldown map for the whole isolate, so
// the per-key cap is 2 calls TOTAL across routes (not 2 per route), and a 429
// learned on one route benches that slot for the other.
//
// The scheduler and cooldown maps are process-global module bindings, which is
// what makes a mutation that gives a route its own instance testable: a test
// reading through this accessor sees the shared pair either way.
import { SlotScheduler } from './scheduler.ts';

export const POOL_PER_SLOT = 2;

export const poolScheduler = new SlotScheduler(POOL_PER_SLOT);
export const poolCooldownUntil = new Map<number, number>();

export function sharedPool(): { scheduler: SlotScheduler; cooldownUntil: Map<number, number> } {
  return { scheduler: poolScheduler, cooldownUntil: poolCooldownUntil };
}