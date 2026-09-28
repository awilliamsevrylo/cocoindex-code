// Slot scheduler shared by every request in an isolate. Picks the healthy
// slot with the fewest calls in flight (ties rotate), and never puts more
// than `perSlot` concurrent calls on one key. When every healthy slot is at
// its cap the caller waits for a release instead of stacking onto a busy key.
// Per-isolate: two isolates each enforce their own cap (best effort, like the
// cooldown map), which is still far below "every request on slot 00".

export class NoHealthySlot extends Error {}

export const WAIT_POLL_MS = 50;

export class SlotScheduler {
  private inflight = new Map<number, number>();
  private waiters: Array<() => void> = [];
  private rr = 0;
  readonly perSlot: number;

  // No parameter property: Node's strip-types test runner rejects them.
  constructor(perSlot = 2) {
    this.perSlot = perSlot;
  }

  load(slot: number): number {
    return this.inflight.get(slot) ?? 0;
  }

  // Resolves to a slot (and counts it in flight). Rejects with NoHealthySlot
  // when every slot is cooling down — never waits on a cooldown.
  async acquire(slots: number[], cooldownUntil: Map<number, number>, now: () => number): Promise<number> {
    for (;;) {
      const healthy = slots.filter((s) => (cooldownUntil.get(s) ?? 0) <= now());
      if (healthy.length === 0) throw new NoHealthySlot('no_healthy_slot');
      let best: number | undefined;
      for (let k = 0; k < healthy.length; k++) {
        const s = healthy[(this.rr + k) % healthy.length];
        if (this.load(s) >= this.perSlot) continue;
        if (best === undefined || this.load(s) < this.load(best)) best = s;
      }
      if (best !== undefined) {
        this.rr = (this.rr + 1) % Math.max(healthy.length, 1);
        this.inflight.set(best, this.load(best) + 1);
        return best;
      }
      // A wait resolved only by ANOTHER request's release() leaves this request
      // with no I/O of its own; workerd cancels it as hung (measured: 4/13
      // requests threw under 13-way load). The timer keeps the wait owned by
      // this request and re-polls even if the wakeup is lost.
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, WAIT_POLL_MS);
      });
    }
  }

  release(slot: number): void {
    this.inflight.set(slot, Math.max(0, this.load(slot) - 1));
    const w = this.waiters.shift();
    if (w) w();
  }
}
