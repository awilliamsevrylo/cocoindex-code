// Unit tests for the pure placement core (no workerd needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignDistinct, rehomeName } from '../src/placement.ts';

const fakeIps = (table: Record<string, string>) => async (name: string) => table[name] ?? 'ERR';

test('collision re-homes the later slot to its next name', async () => {
  const r = await assignDistinct(
    3,
    fakeIps({
      'voyage-key-00': '1.1.1.1',
      'voyage-key-01': '1.1.1.1', // collides with 00
      'voyage-key-01-b1': '2.2.2.2',
      'voyage-key-02': '3.3.3.3',
    }),
  );
  assert.deepEqual(r.unresolved, []);
  assert.deepEqual(
    r.homes.map((h) => [h.slot, h.name, h.egress_ip]),
    [
      [0, 'voyage-key-00', '1.1.1.1'],
      [1, 'voyage-key-01-b1', '2.2.2.2'],
      [2, 'voyage-key-02', '3.3.3.3'],
    ],
  );
});

test('every placed IP is unique', async () => {
  const table: Record<string, string> = {};
  for (let s = 0; s < 6; s++) table[rehomeName(s, 0)] = `10.0.0.${s % 2}`; // heavy collisions
  for (let s = 0; s < 6; s++) for (let a = 1; a < 8; a++) table[rehomeName(s, a)] = `10.${s}.${a}.1`;
  const r = await assignDistinct(6, fakeIps(table));
  const ips = r.homes.map((h) => h.egress_ip);
  assert.equal(new Set(ips).size, ips.length);
});

test('a slot that cannot find a free IP is unresolved, never shared', async () => {
  const r = await assignDistinct(2, async () => '9.9.9.9', 3);
  assert.equal(r.homes.length, 1);
  assert.deepEqual(r.unresolved, [1]);
});

test('ERR lookups are skipped, not placed', async () => {
  const r = await assignDistinct(1, fakeIps({ 'voyage-key-00-b1': '4.4.4.4' }), 3);
  assert.deepEqual(r.homes.map((h) => h.name), ['voyage-key-00-b1']);
});
