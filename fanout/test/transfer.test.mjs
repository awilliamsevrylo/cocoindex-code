// fanout/test/transfer.test.mjs — regression tests for the byte-transfer layer.
// Every test names the fix it dies for; each one FAILS on a5b81e3's lib.mjs.
// Run: node --test fanout/test/*.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, readdirSync, statSync, utimesSync } from 'node:fs';
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
  let partCalls = 0;
  // Deterministic routing: part 0 lands on host A, everything else on host B.
  const exec = async (l, cmd, t) => {
    const isPart = cmd.includes("printf '%s'") && cmd.includes('.fxpart.');
    const host = isPart && partCalls++ === 0 ? hosts[0] : hosts[1];
    return local(l, cmd.split(root).join(host), t);
  };
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

test('T4: upload bytes are 0600 from first part through atomic target', async () => {
  const local = fx.localTransport();
  const d = tmp(), seen = [];
  const exec = async (l, cmd, t) => {
    const out = await local(l, cmd, t);
    for (const name of readdirSync(d)) {
      if (/\.fxpart\.|\.fxtmp\.|^secret\.conf$/.test(name)) seen.push([name, statSync(join(d, name)).mode & 0o777]);
    }
    return out;
  };
  await fx.upload(exec, lane, join(d, 'secret.conf'), Buffer.from('secret-value\n'.repeat(8000)));
  assert.ok(seen.length > 1, 'sampled transfer files during multiple calls');
  assert.deepEqual([...new Set(seen.map(([, mode]) => mode))], [0o600], `world-readable sample: ${JSON.stringify(seen)}`);
});

test('T5: checksum failure removes this upload parts and staging file', async () => {
  const local = fx.localTransport();
  const d = tmp(), p = join(d, 'secret.conf');
  const corrupt = async (l, cmd, t) => local(l, cmd.includes('base64 -d')
    ? cmd.replaceAll('base64 -d ', 'base64 -d | { cat; printf x; } ')
    : cmd, t);
  await assert.rejects(fx.upload(corrupt, lane, p, Buffer.from('top-secret\n')), /checksum mismatch/);
  assert.deepEqual(leftovers(d), [], 'failed upload left decodable parts or a staging file');
});

test('T6: a chmod failure is propagated by pushUploads', async () => {
  const local = fx.localTransport();
  const d = tmp(), src = join(tmp(), 'secret.conf');
  writeFileSync(src, 'secret\n');
  const deny = async (l, cmd, t) => local(l, /chmod 600/.test(cmd) ? cmd.replace(/chmod 600 [^\n]+/, 'false') : cmd, t);
  await assert.rejects(fx.pushUploads(deny, { lane: [lane], uploads: { 'secret.conf': src }, uploadHome: d }, 0), /chmod/);
  assert.equal(statSync(join(d, 'secret.conf')).mode & 0o777, 0o600, 'atomic upload was private even before chmod failed');
  assert.deepEqual(leftovers(d), []);
});

test('T7: a later upload reaps stale foreign nonce parts', async () => {
  const d = tmp(), p = join(d, 'items.txt');
  const old = `${p}.fxpart.deadbeefdeadbeef.00000000`;
  writeFileSync(old, Buffer.from('abandoned secret').toString('base64'));
  const then = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(old, then, then);
  await fx.upload(fx.localTransport(), lane, p, Buffer.from('fresh\n'));
  assert.deepEqual(leftovers(d), [], 'stale foreign nonce wedged the path');
});

test('T8: shasum fallback recognizes an already committed identical upload', async () => {
  const local = fx.localTransport();
  const exec = (l, cmd, t) => local(l, `sha256sum(){ return 1; }\n${cmd}`, t);
  const d = tmp(), p = join(d, 'items.txt'), body = Buffer.from('same bytes\n');
  await fx.upload(exec, lane, p, body);
  await fx.upload(exec, lane, p, body);
  assert.ok(readFileSync(p).equals(body));
  assert.deepEqual(leftovers(d), []);
});

test('T9: a thrown download slice removes its snapshot', async () => {
  const local = fx.localTransport();
  const d = tmp(), p = join(d, 'items.txt');
  writeFileSync(p, Buffer.alloc(80 * 1024, 1));
  const fail = async (l, cmd, t) => { if (cmd.includes('tail -c +')) throw new Error('transport split'); return local(l, cmd, t); };
  await assert.rejects(fx.download(fail, lane, p), /transport split/);
  assert.deepEqual(leftovers(d), [], 'download exception leaked its snapshot');
});

test('T9b: a lost snapshot response still removes the remote snapshot', async () => {
  const local = fx.localTransport();
  const d = tmp(), p = join(d, 'items.txt');
  writeFileSync(p, Buffer.alloc(80 * 1024, 2));
  let lost = false;
  const fail = async (l, cmd, t) => {
    if (!lost && cmd.includes('cp ') && cmd.includes('.fxsnp.')) {
      lost = true;
      await local(l, cmd, t);
      throw new Error('snapshot response lost');
    }
    return local(l, cmd, t);
  };
  await assert.rejects(fx.download(fail, lane, p), /snapshot response lost/);
  assert.deepEqual(leftovers(d), [], 'response loss after snapshot creation leaked bytes');
});

test('T10: a hung transport call rejects on a client-side deadline [fix: AbortSignal.timeout(timeoutMs + 30s)]', async () => {
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
