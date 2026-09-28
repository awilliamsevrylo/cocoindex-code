// Slot placement: which Durable Object name carries which key slot.
// connect() egress is sticky per DO name but only best-effort distinct, so
// two slot names can land on the same IP (POC 2 measured slots 00/04/05
// sharing one). Placement re-homes a colliding slot to a new name ("-bN")
// until every slot has its own IP. The result is pinned in one reserved
// VoyageSlot instance (PLACEMENT_DO) — same class, so still one DO class
// per script.

export interface SlotHome {
  slot: number;
  name: string;
  egress_ip: string;
}

export const PLACEMENT_DO = 'voyage-placement';

export function baseName(slot: number): string {
  return `voyage-key-${String(slot).padStart(2, '0')}`;
}

export function rehomeName(slot: number, attempt: number): string {
  return attempt === 0 ? baseName(slot) : `${baseName(slot)}-b${attempt}`;
}

// Pure core: choose one DO name per slot so every slot's egress IP is unique.
// Earlier slots keep priority; a colliding slot walks to its next name. A slot
// that cannot find a free IP is reported unresolved — never given a shared IP.
export async function assignDistinct(
  slots: number,
  ipOf: (name: string) => Promise<string>,
  maxAttempts = 8,
): Promise<{ homes: SlotHome[]; unresolved: number[] }> {
  const taken = new Set<string>();
  const homes: SlotHome[] = [];
  const unresolved: number[] = [];
  for (let slot = 0; slot < slots; slot++) {
    let placed = false;
    for (let attempt = 0; attempt < maxAttempts && !placed; attempt++) {
      const name = rehomeName(slot, attempt);
      const ip = await ipOf(name);
      if (ip && ip !== 'ERR' && !taken.has(ip)) {
        taken.add(ip);
        homes.push({ slot, name, egress_ip: ip });
        placed = true;
      }
    }
    if (!placed) unresolved.push(slot);
  }
  return { homes, unresolved };
}
