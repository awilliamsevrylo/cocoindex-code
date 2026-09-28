// fanout library tests — no gcloud: the local bash transport stands in for a
// lane, with the lane root under a temp dir. Run: node --test fanout/test/*.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import * as fx from '../lib.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'fx-test-'));
const lane = { singleton: 'test-lane', image: 'local' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('sharding is deterministic and balanced within 15% over 10K items', () => {
  const items = Array.from({ length: 10000 }, (_, i) => `https://example.com/doc/${i}`);
  const a = fx.shard(items, 5), b = fx.shard([...items].reverse(), 5);
  for (let i = 0; i < 5; i++) assert.deepEqual([...a[i]].sort(), [...b[i]].sort(), 'same item -> same lane regardless of order');
  for (const s of a) assert.ok(Math.abs(s.length - 2000) <= 300, `lane size ${s.length} outside 2000±15%`);
  assert.equal(a.flat().length, 10000);
  const again = fx.shard(items, 7);
  assert.equal(again.flat().length, 10000);
});

test('spec refuses fewer than 5 lanes', () => {
  assert.throws(() => fx.normalizeSpec({ name: 'x', lanes: 3, items: 'i.txt', worker: 'true' }), />= 5/);
  assert.equal(fx.normalizeSpec({ name: 'x', items: 'i.txt', worker: 'true' }).lanes, 5);
});

test('chunked uploader round-trips a 200 KB item list byte-exact', async () => {
  const exec = fx.localTransport();
  const lines = Array.from({ length: 2600 }, (_, i) => `item-${i}-${randomBytes(30).toString('hex')} 'q' "dq" $HOME \`x\``);
  const buf = Buffer.from(lines.join('\n') + '\n');
  assert.ok(buf.length >= 200 * 1024, `fixture is ${buf.length} bytes`);
  const d = tmp();
  const plain = await fx.upload(exec, lane, join(d, 'a/items.txt'), buf);
  assert.ok(plain.calls > 3, 'split into several ≤48 KB calls');
  assert.ok(readFileSync(join(d, 'a/items.txt')).equals(buf));
  await fx.upload(exec, lane, join(d, 'b/items.txt'), buf, { gzip: true });
  assert.ok(readFileSync(join(d, 'b/items.txt')).equals(buf));
  const back = await fx.download(exec, lane, join(d, 'a/items.txt'));
  assert.ok(back.equals(buf), 'download returns the same bytes');
  assert.equal(await fx.download(exec, lane, join(d, 'nope')), null);
});

test('dir mode: tar shard of a directory round-trips byte-exact', async () => {
  const exec = fx.localTransport();
  const src = tmp();
  const files = {};
  for (let i = 0; i < 40; i++) {
    const rel = `pkg${i % 4}/sub dir/file ${i}.bin`;
    mkdirSync(join(src, `pkg${i % 4}/sub dir`), { recursive: true });
    files[rel] = randomBytes(1000 + i * 37);
    writeFileSync(join(src, rel), files[rel]);
  }
  const { dir, items } = fx.loadItems(src);
  assert.equal(dir, src);
  assert.equal(items.length, 40);
  const pick = items.filter((_, i) => i % 3 === 0);
  const dst = tmp();
  await fx.upload(exec, lane, join(dst, 'in.tgz'), fx.tarFiles(src, pick));
  const r = await fx.run(exec, lane, `cd ${fx.shq(dst)} && mkdir -p in && tar xzf in.tgz -C in && rm in.tgz`);
  assert.equal(r.rc, 0, r.text);
  for (const rel of pick) assert.ok(readFileSync(join(dst, 'in', rel)).equals(files[rel]), rel);
  const count = (p) => readdirSync(p, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(join(p, e.name)) : 1), 0);
  assert.equal(count(join(dst, 'in')), pick.length, 'only the shard, nothing else');
});

// Mock transport: answers the okSet download from a scripted manifest and
// records every uploaded file, so resume is checked without any lane at all.
function mockExec(manifest) {
  const uploads = {};
  const exec = async (_lane, command) => {
    const wrap = (s, rc = 0) => `banner\n__FX_BEGIN__\n${s}\n__FX_RC__ ${rc}\n`;
    const gz = (await import('node:zlib')).gzipSync(Buffer.from(manifest.filter((r) => r[1] === 'ok').map((r) => r[0]).join('\n') + '\n'));
    if (command.includes('echo alive; else echo idle')) return wrap('idle');
    if (command.includes('wc -c <')) return wrap(String(gz.length));
    if (command.includes('tail -c +')) return wrap(gz.toString('base64'));
    const part = /printf '%s' '([^']*)' > '([^']*)\.fxpart\.(\d+)'/.exec(command);
    if (part) { (uploads[part[2]] ||= []).push(part[1]); return wrap(''); }
    const fin = /cat '([^']*)\.fxpart'\.\*/.exec(command);
    if (fin) {
      let b = Buffer.from(uploads[fin[1]].join(''), 'base64');
      if (command.includes('gunzip')) b = (await import('node:zlib')).gunzipSync(b);
      uploads[fin[1]] = b;
      return wrap(createHash('sha256').update(b).digest('hex'));
    }
    if (command.includes('nohup bash run.sh')) return wrap('started 4242');
    return wrap('');
  };
  return { exec, uploads };
}

test('resume uploads only the unfinished items', async () => {
  const items = Array.from({ length: 30 }, (_, i) => `repo-${i}`);
  const manifest = [['repo-1', 'ok'], ['repo-2', 'FAIL'], ['repo-5', 'ok'], ['repo-7', 'ok'], ['repo-7', 'ok']];
  const { exec, uploads } = mockExec(manifest);
  const spec = fx.normalizeSpec({ name: 'resume', items: 'i.txt', worker: 'echo w' });
  const r = await fx.startLane(exec, spec, 0, items);
  assert.equal(r.launched, true);
  const sent = uploads[`${fx.laneRoot(spec, 0)}/items.txt`].toString('utf8').split('\n').filter(Boolean);
  assert.equal(sent.length, 27, 'three finished items dropped');
  for (const done of ['repo-1', 'repo-5', 'repo-7']) assert.ok(!sent.includes(done), `${done} re-sent`);
  assert.ok(sent.includes('repo-2'), 'FAIL items are retried');
  assert.equal(r.done, 3);
});

test('end to end on the local transport: run, kill mid-way, resume, no item twice', async () => {
  const exec = fx.localTransport();
  const base = tmp();
  const items = Array.from({ length: 24 }, (_, i) => `item ${i}`);
  const worker = 'while IFS= read -r it; do grep -qF "$it	ok" "$OUT_DIR/MANIFEST.tsv" 2>/dev/null && continue; sleep 0.15; printf "%s\\tok\\t%s\\n" "$it" "$(printf %s "$it" | sha256sum | cut -c1-16)" >> "$OUT_DIR/MANIFEST.tsv"; done < "$ITEMS_FILE"';
  const spec = fx.normalizeSpec({ name: 'e2e', items: 'i.txt', worker, remoteBase: base, syncEverySec: 1, sync: 'cp "$OUT_DIR/MANIFEST.tsv" "$OUT_DIR/../synced.tsv" 2>/dev/null || true' });
  const r = await fx.startLane(exec, spec, 0, items);
  assert.equal(r.launched, true);
  await sleep(1200);
  assert.match(await fx.stopLane(exec, spec, 0), /stopped/);
  await sleep(300);
  const mid = await fx.laneStatus(exec, spec, 0);
  assert.equal(mid.alive, false);
  assert.ok(mid.ok > 0 && mid.ok < 24, `partial progress expected, got ${mid.ok}`);
  const r2 = await fx.startLane(exec, spec, 0, items);
  assert.equal(r2.todo, 24 - mid.ok, 'resume sends only the remainder');
  for (let k = 0; k < 60; k++) { const s = await fx.laneStatus(exec, spec, 0); if (!s.alive && s.rc === 0) break; await sleep(200); }
  const fin = await fx.laneStatus(exec, spec, 0);
  assert.equal(fin.ok, 24);
  assert.equal(fin.okLines, 24, 'no item recorded twice');
  assert.equal(fin.rc, 0);
  const done = await fx.startLane(exec, spec, 0, items);
  assert.equal(done.reason, 'complete');
});
