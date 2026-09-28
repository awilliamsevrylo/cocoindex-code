// Load spreading across CONCURRENT requests (the per-request pointer bug:
// every single-batch request started at slot 0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, SlotScheduler, type SlotCall } from '../src/dispatch.ts';

const SLOTS = Array.from({ length: 13 }, (_, i) => i);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fake slot that records in-flight per slot and holds each call `ms`.
function tracking(ms: number) {
  const now = new Map<number, number>();
  const peak = new Map<number, number>();
  const used = new Set<number>();
  const call: SlotCall = async (slot, batch) => {
    used.add(slot);
    now.set(slot, (now.get(slot) ?? 0) + 1);
    peak.set(slot, Math.max(peak.get(slot) ?? 0, now.get(slot)!));
    await sleep(ms);
    now.set(slot, now.get(slot)! - 1);
    return { status: 200, vectors: batch.map(() => [slot]), usage_tokens: 1 };
  };
  return { call, peak, used };
}

test('13 concurrent single-batch requests use 13 distinct slots', async () => {
  const t = tracking(20);
  const sched = new SlotScheduler(2);
  const cool = new Map<number, number>();
  await Promise.all(SLOTS.map((i) => dispatch([`req ${i}`], SLOTS, t.call, cool, Date.now, sched)));
  assert.equal(t.used.size, 13, `used slots: ${[...t.used].sort((a, b) => a - b)}`);
  assert.equal(Math.max(...t.peak.values()), 1, 'no slot doubled up while others were idle');
});

test('per-slot cap holds under 40 concurrent requests, all complete', async () => {
  const t = tracking(15);
  const sched = new SlotScheduler(2);
  const cool = new Map<number, number>();
  const rs = await Promise.all(
    Array.from({ length: 40 }, (_, i) => dispatch([`r${i}`], SLOTS, t.call, cool, Date.now, sched)),
  );
  assert.equal(rs.length, 40);
  assert.ok(rs.every((r) => r.vectors.length === 1));
  assert.ok(Math.max(...t.peak.values()) <= 2, `peak per slot ${Math.max(...t.peak.values())}`);
  SLOTS.forEach((s) => assert.equal(sched.load(s), 0, `slot ${s} leaked a permit`));
});

// workerd cancels a request whose only pending work is a promise another
// request must resolve. Model that as a LOST wakeup: the queued acquire must
// still make progress on its own timer once capacity frees.
test('a queued acquire progresses without a cross-request wakeup', async () => {
  const sched = new SlotScheduler(1);
  const cool = new Map<number, number>();
  const first = await sched.acquire([0], cool, Date.now);
  const second = sched.acquire([0], cool, Date.now);
  await sleep(5);
  (sched as unknown as { waiters: unknown[] }).waiters.length = 0; // drop the wakeup
  sched.release(first);
  const got = await Promise.race([second, sleep(1000).then(() => 'hung')]);
  assert.equal(got, 0, 'queued acquire never woke');
});

test('a throwing slot call still releases its permit', async () => {
  const sched = new SlotScheduler(1);
  const boom: SlotCall = async () => { throw new Error('socket reset'); };
  await assert.rejects(dispatch(['x'], [0], boom, new Map(), Date.now, sched), /socket reset/);
  assert.equal(sched.load(0), 0);
});
