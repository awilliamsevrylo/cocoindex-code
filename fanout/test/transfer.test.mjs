// fanout/test/transfer.test.mjs — regression tests for the byte-transfer layer.
// Every test names the fix it dies for; each one FAILS on a5b81e3's lib.mjs.
// Run: node --test fanout/test/*.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import * as fx from '../lib.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'fx-tr-'));
const lane = { singleton: 'tr-lane', image: 'local' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Any staging file a transfer leaves behind is a bug: parts, fxtmp, or snapshot.
const leftovers = (dir) => readdirSync(dir).filter((n) => /\.fxpart\.|\.fxtmp\.|\.fxsnp\./.test(n));

test('T1: a duplicated finalize is a no-op that keeps a verified file [fix: nonce parts + sha-verified mv]', async () => {
  const local = fx.localTransport();
  // At-least-once transport: the first finalize runs, its response is lost, the
  // retry's response is what the caller sees. Re-running finalize must not
  // re-derive the file from parts it already deleted.
  const dup = async (l, cmd, t) => { if (cmd.includes('base64 -d')) await local(l, cmd, t); return local(l, cmd, t); };
  for (const gzip of [true, false]) {
    const d = tmp();
    const p = join(d, 'items.txt');
    const buf = Buffer.from('a\nb\nc\n'.repeat(20000));
    await fx.upload(dup, lane, p, buf, { gzip });
    assert.ok(readFileSync(p).equals(buf), `gzip=${gzip}: retried finalize must leave the good file intact`);
    assert.deepEqual(leftovers(d), [], 'no part or staging files left behind');
  }
});

test('T2: two concurrent uploads of one path both succeed with consistent bytes [fix: per-upload nonce]', async () => {
  const local = fx.localTransport();
  // Yield between calls so the two uploads interleave the way two processes do.
  const exec = async (l, cmd, t) => { await sleep(Math.random() * 5); return local(l, cmd, t); };
  for (let trial = 0; trial < 3; trial++) {
    const d = tmp();
    const p = join(d, 'items.txt');
    const a = Buffer.from(randomBytes(200 * 1024).toString('hex'));
    const b = Buffer.from(randomBytes(200 * 1024).toString('hex'));
    const rs = await Promise.allSettled([
      fx.upload(exec, { singleton: 'A' }, p, a, { gzip: true }),
      fx.upload(exec, { singleton: 'B' }, p, b, { gzip: true }),
    ]);
    for (const r of rs) assert.equal(r.status, 'fulfilled', r.reason && r.reason.message);
    const got = readFileSync(p);
    assert.ok(got.equals(a) || got.equals(b), 'the survivor is exactly one writer\'s bytes');
    assert.deepEqual(leftovers(d), [], 'each upload cleaned only its own parts');
  }
});

test('T3: a part set split across hosts fails closed and never truncates the target [fix: part guard + tmp staging]', async () => {
  const local = fx.localTransport();
  const root = tmp(), hosts = [tmp(), tmp()];
  let n = 0;
  // Deterministic routing: part 0 lands on host A, everything after on host B.
  const exec = async (l, cmd, t) => local(l, cmd.split(root).join(hosts[n++ === 0 ? 0 : 1]), t);
  const p = join(root, 'items.txt');
  const sentinel = Buffer.from('PRIOR CONTENT MUST SURVIVE\n');
  writeFileSync(join(hosts[1], 'items.txt'), sentinel); // where the finalize call lands
  const buf = Buffer.from(randomBytes(150 * 1024).toString('hex'));
  await assert.rejects(fx.upload(exec, lane, p, buf, { gzip: true }), /checksum mismatch/);
  assert.ok(readFileSync(join(hosts[1], 'items.txt')).equals(sentinel), 'a failed upload must not touch the target');
  // Parts are removed only after a verified mv, so a refusal legitimately keeps
  // its own namespaced parts — but it must never leave a staging file or, worse,
  // a truncated target (a5b81e3 decoded the partial set straight into `path`).
  assert.deepEqual(leftovers(hosts[1]).filter((n) => n.includes('.fxtmp.')), [], 'no staging file left behind');
});

test('T4: a hung transport call rejects on a client-side deadline [fix: AbortSignal.timeout(timeoutMs + 30s)]', async () => {
  const srv = createServer(() => {}); // accepts, never answers
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const cred = join(tmp(), 'cred.json');
  writeFileSync(cred, JSON.stringify({ url: `http://127.0.0.1:${srv.address().port}/mcp`, headers: {} }));
  let state = 'pending';
  const t0 = Date.now();
  const call = fx.gcloudTransport(cred)(lane, 'true', 5000).then(() => { state = 'resolved'; }, (e) => { state = `rejected: ${e.message}`; });
  await Promise.race([call, sleep(60000)]);
  const ms = Date.now() - t0;
  srv.closeAllConnections?.();
  srv.close();
  assert.match(state, /^rejected/, `still "${state}" after ${ms}ms with a server that never answers`);
});

test('LOW: an env key that is not a shell identifier is refused [fix: ^[A-Z_][A-Z0-9_]*$ validation]', async () => {
  const spec = fx.normalizeSpec({ name: 'envbad', items: 'i.txt', worker: 'echo w', env: { 'BAD KEY': 'x' }, remoteBase: tmp() });
  await assert.rejects(fx.startLane(fx.localTransport(), spec, 0, ['a']), /spec\.env key must match/);
});

test('LOW: a file that grows mid-download still yields its snapshot [fix: cp snapshot before sizing]', async () => {
  const local = fx.localTransport();
  const d = tmp();
  const g = join(d, 'grow.tsv');
  const body = Buffer.from(randomBytes(60 * 1024).toString('hex'));
  writeFileSync(g, body);
  const slow = async (l, cmd, t) => { if (cmd.includes('tail -c +')) appendFileSync(g, 'item\tok\n'.repeat(2000)); return local(l, cmd, t); };
  const got = await fx.download(slow, lane, g);
  assert.equal(got.length, body.length, 'served the snapshot, not the grown file');
  assert.ok(got.equals(body), 'snapshot bytes are the original bytes');
  assert.deepEqual(leftovers(d), [], 'snapshot removed');
});

test('LOW: part indexes stay in numeric order when globbed [fix: padStart(8)]', async () => {
  const local = fx.localTransport();
  const cmds = [];
  const rec = async (l, cmd, t) => { cmds.push(cmd); return local(l, cmd, t); };
  const d = tmp();
  await fx.upload(rec, lane, join(d, 'p.bin'), randomBytes(40 * 1024));
  const names = [...new Set(cmds.flatMap((c) => [...c.matchAll(/fxpart\.[0-9a-f]+\.(\d+)/g)].map((m) => m[1])))];
  assert.ok(names.length >= 2, `expected a multi-part upload, saw ${names.length} part names`);
  for (const n of names) assert.match(n, /^\d{8}$/, `part index ${n} is not wide enough (a 5-digit index misorders past 99999)`);
  assert.deepEqual([...names].sort(), Array.from({ length: names.length }, (_, i) => String(i).padStart(8, '0')), 'glob order == numeric order');
});
