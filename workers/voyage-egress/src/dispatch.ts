// Pure dispatch core for /v1/embeddings: split inputs into batches under the
// Voyage per-request limits, spread batches over healthy slots, re-route a
// batch when its slot answers 429, and merge vectors back in input order.
// No runtime imports — unit-tested under plain Node with fake slots.

export const MAX_TOKENS_PER_CALL = 120_000; // only measured Voyage limit
export const MAX_INPUTS_PER_CALL = 1_000;
const CHARS_PER_TOKEN = 3; // conservative (English ≈ 4); over-splits, never under

export interface SlotCall {
  (slot: number, batch: string[]): Promise<{
    status: number;
    vectors?: number[][];
    usage_tokens?: number;
    retry_after_ms?: number;
    error?: string;
  }>;
}

export interface DispatchResult {
  vectors: number[][];
  usage_tokens: number;
  calls: number;
  rerouted: number;
}

export class NoHealthySlot extends Error {}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN) + 1;
}

// Greedy batching in input order; a single oversize input still gets its own
// batch (Voyage truncates or rejects it — surfaced as that batch's error).
export function makeBatches(input: string[], maxTokens = MAX_TOKENS_PER_CALL, maxInputs = MAX_INPUTS_PER_CALL): number[][] {
  const batches: number[][] = [];
  let cur: number[] = [];
  let curTokens = 0;
  input.forEach((text, i) => {
    const t = estimateTokens(text);
    if (cur.length > 0 && (curTokens + t > maxTokens || cur.length >= maxInputs)) {
      batches.push(cur);
      cur = [];
      curTokens = 0;
    }
    cur.push(i);
    curTokens += t;
  });
  if (cur.length) batches.push(cur);
  return batches;
}

// cooldownUntil[slot] = epoch ms the slot may be used again (0 = healthy).
export async function dispatch(
  input: string[],
  slots: number[],
  call: SlotCall,
  cooldownUntil: Map<number, number>,
  now: () => number = Date.now,
): Promise<DispatchResult> {
  const out: number[][] = new Array(input.length);
  let usage = 0;
  let calls = 0;
  let rerouted = 0;
  let rr = 0;

  const pick = (): number | undefined => {
    for (let k = 0; k < slots.length; k++) {
      const s = slots[(rr + k) % slots.length];
      if ((cooldownUntil.get(s) ?? 0) <= now()) {
        rr = (rr + k + 1) % slots.length;
        return s;
      }
    }
    return undefined;
  };

  const runBatch = async (idx: number[]): Promise<void> => {
    const texts = idx.map((i) => input[i]);
    for (let attempt = 0; attempt < slots.length * 2; attempt++) {
      const slot = pick();
      if (slot === undefined) throw new NoHealthySlot('no_healthy_slot');
      calls++;
      const r = await call(slot, texts);
      if (r.status === 200 && r.vectors && r.vectors.length === idx.length) {
        idx.forEach((i, j) => (out[i] = r.vectors![j]));
        usage += r.usage_tokens ?? 0;
        return;
      }
      if (r.status === 429 || r.status >= 500) {
        cooldownUntil.set(slot, now() + (r.retry_after_ms ?? 30_000));
        rerouted++;
        continue;
      }
      throw new Error(`voyage ${r.status}: ${(r.error ?? '').slice(0, 200)}`);
    }
    throw new NoHealthySlot('no_healthy_slot');
  };

  await Promise.all(makeBatches(input).map(runBatch));
  return { vectors: out, usage_tokens: usage, calls, rerouted };
}
