// fanout lane-lifecycle tests — lane identity, the pid gate, the manifest's
// unterminated last line, lane names, liveness, the setup cache, the lane-count
// gate and watch's exit status. Every one of these fails on a5b81e3.
// Run: node --test fanout/test/*.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as fx from '../lib.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'fx-life-'));
const lane = { singleton: 'test-lane', image: 'local' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkSpec = (name, over = {}) => ({ name, lane: [lane], lanes: 1, image: 'local',
  maxAttempts: 5, items: 'i.txt', worker: 'true', setup: '', sync: '', ...over });

// ── the container model, in a test ──
// Every call is answered by SOME container, and which one is decided by the
// harness; the cid comes from the same probe the library uses, so a fake
// container's identity is the real one. `$HOME` (and so lane.id) is shared by
// all of them, exactly as /tmp/home is shared by every gcloud Cloud Shell.
const mine = [];
const mktarget = (spec, i, { cid, home, probe = null }) => {
  const root = fx.laneRoot(spec, i);
  const t = { root, home, cid, core: cid ? join(root, 'c', cid) : null, spec, i, calls: 0, exec: null };
  t.exec = (_l, command) => {
    t.calls++;
    if (probe && t.calls > probe) { t.cid = null; t.core = null; }   // the container moves mid-sequence
    return fx.localTransport()({ ..._l, singleton: _l.singleton }, `export FANOUT_CID=${fx.shq(t.cid || 'cNONE')}; export HOME=${fx.shq(home)};\n${command}`);
  };
  mine.push(t);
  return t;
};
after(() => { for (const t of mine) rmSync(t.home, { recursive: true, force: true }); });

// A command run inside the SAME fake container as the mock: the identity the
// library would see, without re-deriving it from this host.
const inC = (t) => `export FANOUT_CID=${fx.shq(t.cid || 'cNONE')}; export HOME=${fx.shq(t.home)}; `;

test('T3: a lane that has moved to another container is UNKNOWN, and heal refuses', async () => {
  const home = tmp();
  const spec = fx.normalizeSpec(mkSpec('t3', { remoteBase: home, allowFewerLanes: true }));
  const t = mktarget(spec, 0, { cid: 'cAAA', home });
  const r = await fx.startLane(t.exec, spec, 0, ['a', 'b']);
  assert.equal(r.launched, true);
  assert.equal(r.id, 'OURS', 'the first setup mints the identity, then reports OURS');
  assert.ok(existsSync(join(fx.laneRoot(spec, 0), 'lane.id')));
  for (let k = 0; k < 60 && (await fx.laneStatus(t.exec, spec, 0)).alive; k++) await sleep(100);
  assert.equal((await fx.laneStatus(t.exec, spec, 0)).id, 'OURS');

  // The same lane name is now answered by a DIFFERENT container. $HOME is
  // shared, so it can read lane.id; it has no core dir of its own.
  t.cid = 'cBBB';
  const st = await fx.laneStatus(t.exec, spec, 0);
  assert.equal(st.id, 'UNKNOWN', 'a token match without this container\'s own dir is not identity');
  assert.equal(st.alive, false);
  const refused = await fx.startLane(t.exec, spec, 0, ['a', 'b']);
  assert.equal(refused.launched, false, 'an UNKNOWN lane must never be relaunched');
  assert.equal(refused.reason, 'UNKNOWN lane');
  assert.ok(!existsSync(join(fx.laneRoot(spec, 0), 'c', 'cBBB')), 'the refused heal created no second container dir');
});

test('T3: a container that answers half the calls never produces a relaunch', async () => {
  const home = tmp();
  const spec = fx.normalizeSpec(mkSpec('t3b', { remoteBase: home, allowFewerLanes: true }));
  // The identity was minted on an earlier run; every call now answers as a
  // container that has no core dir of its own.
  const t = mktarget(spec, 0, { cid: 'cAAA', home });
  mkdirSync(fx.laneRoot(spec, 0), { recursive: true });
  writeFileSync(join(fx.laneRoot(spec, 0), 'lane.id'), fx.laneToken(spec, 0) + '\n');
  const st = await fx.laneStatus(t.exec, spec, 0);
  assert.equal(st.id, 'UNKNOWN', 'a container with no core dir is not the lane');
  const after = await fx.startLane(t.exec, spec, 0, ['a', 'b']);
  assert.equal(after.launched, false, 'the swapped container is never relaunched');
  assert.equal(after.reason, 'UNKNOWN lane');
});

test('B-manifest-parse: an unterminated final MANIFEST line is not an ok item', async () => {
  const home = tmp();
  const spec = fs_spec(home, 'b');
  const t = mktarget(spec, 0, { cid: 'cA', home });
  mkdirSync(t.core, { recursive: true });
  const M = join(t.core, 'out/MANIFEST.tsv');
  mkdirSync(join(t.core, 'out'), { recursive: true });
  writeFileSync(join(t.root, 'lane.id'), fx.laneToken(spec, 0) + '\n');
  writeFileSync(M, 'https://a/1\tok\th1\nhttps://a/2\tok\th2\nhttps://a/3\tok\th3');
  const ok = await fx.okSet(t.exec, spec, 0);
  assert.equal(ok.size, 2, 'a line with no terminator is not a completed item');
  assert.ok(ok.has('https://a/1') && ok.has('https://a/2'), 'terminated lines still count');
  assert.ok(!ok.has('https://a/3'), 'the unterminated line is re-sent');
  assert.equal((await fx.laneStatus(t.exec, spec, 0)).ok, 2, 'laneStatus agrees with okSet');
  writeFileSync(M, 'https://a/1\tok\th1\nhttps://a/2\tok\th2\nhttps://a/3\tok\th3\n');
  assert.equal((await fx.okSet(t.exec, spec, 0)).size, 3, 'once terminated it counts');
});

test('B2-status-gate: a MANIFEST with no pid file is still read (H1)', async () => {
  const home = tmp();
  const spec = fs_spec(home, 'b2');
  const t = mktarget(spec, 0, { cid: 'cA', home });
  mkdirSync(join(t.core, 'out'), { recursive: true });
  writeFileSync(join(t.root, 'lane.id'), fx.laneToken(spec, 0) + '\n');
  writeFileSync(join(t.core, 'out/MANIFEST.tsv'),
    'https://a/1\tok\th1\nhttps://a/2\tok\th2\nhttps://a/3\tok\th3\nhttps://a/1\tok\th1\nhttps://a/9\tFAIL\tboom\n');
  writeFileSync(join(t.core, 'done'), '0\n');
  assert.ok(!existsSync(join(t.core, 'pid')), 'no pid file: the worker is gone, its results are not');
  const st = await fx.laneStatus(t.exec, spec, 0);
  assert.equal(st.id, 'OURS');
  assert.equal(st.ok, 3, 'a finished lane is not reported 0/N');
  assert.equal(st.okLines, 4, 'the duplicate line is visible');
  assert.equal(st.fail, 1, 'the FAIL-only item is counted');
  assert.equal(st.alive, false);
  assert.equal(st.rc, 0, 'the done rc is readable without a pid');
});

test('M3: a foreign pid in the pid file is not a live lane (D1)', async () => {
  const home = tmp();
  const spec = fx.normalizeSpec(mkSpec('m3', { remoteBase: home, allowFewerLanes: true }));
  const t = mktarget(spec, 0, { cid: 'cA', home });
  mkdirSync(t.core, { recursive: true });
  writeFileSync(join(t.root, 'lane.id'), fx.laneToken(spec, 0) + '\n');
  writeFileSync(join(t.core, 'pid'), `${process.pid}\n`);   // a live process, but not this lane's
  writeFileSync(join(t.core, 'pid.token'), 'stale-token\n');
  spec.lane[0].startToken = 'a-different-token';
  assert.equal((await fx.laneStatus(t.exec, spec, 0)).alive, false, 'a stale/foreign pid must not read alive');
  assert.equal((await fx.startLane(t.exec, spec, 0, ['a', 'b'])).launched, true, 'so the lane is relaunchable');
});

test('M3: startLane does not double-launch a lane whose own worker is running', async () => {
  const home = tmp();
  const spec = fx.normalizeSpec(mkSpec('m3b', { remoteBase: home, allowFewerLanes: true,
    worker: 'while :; do sleep 1; done' }));
  const t = mktarget(spec, 0, { cid: 'cA', home });
  const items = ['x1', 'x2', 'x3', 'x4'];
  assert.equal((await fx.startLane(t.exec, spec, 0, items)).launched, true);
  for (let k = 0; k < 40 && !(await fx.laneStatus(t.exec, spec, 0)).alive; k++) await sleep(100);
  assert.equal((await fx.laneStatus(t.exec, spec, 0)).alive, true);
  assert.equal((await fx.startLane(t.exec, spec, 0, items)).reason, 'alive');
  const started = await fx.run(t.exec, spec.lane[0], `${inC(t)} grep -c '\\[fanout\\] start' ${fx.shq(join(t.core, 'run.log'))} || true`);
  assert.equal(started.text.trim(), '1', 'exactly one worker');
  await fx.stopLane(t.exec, spec, 0);
});

test('A-lanes: a laneNames list of the wrong length is refused (M1)', () => {
  assert.throws(() => fx.normalizeSpec({ name: 'x', lanes: 5, laneNames: ['a', 'b', 'c'], items: 'i.txt', worker: 'true' }), /3 entries but spec.lanes is 5/);
  assert.throws(() => fx.normalizeSpec({ name: 'x', lanes: 5, laneNames: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], items: 'i.txt', worker: 'true' }), /7 entries but spec.lanes is 5/);
  const ok = fx.normalizeSpec({ name: 'x', lanes: 5, laneNames: ['a', 'b', 'c', 'd', 'e'], items: 'i.txt', worker: 'true' });
  const sh = fx.shard(Array.from({ length: 200 }, (_, i) => `i${i}`), ok.lanes);
  assert.equal(sh.length, ok.lane.length, 'every shard has a lane to be worked by');
});

test('M4: the setup cache tag follows the content of spec.uploads', async () => {
  const root = tmp(), home = tmp(), cred = join(tmp(), 'rclone.conf');
  writeFileSync(cred, 'key=OLD\n');
  const mk = () => { const s = fx.normalizeSpec(mkSpec('m4', { remoteBase: root, allowFewerLanes: true,
    setup: 'echo RAN >> setup-runs.txt', uploads: { 'rclone.conf': cred }, uploadHome: home })); return s; };
  const t = mktarget(mk(), 0, { cid: 'cA', home });
  const spec = t.spec;
  assert.equal(await fx.ensureSetup(t.exec, spec, 0), 'ran');
  assert.equal(await fx.ensureSetup(t.exec, spec, 0), 'cached', 'unchanged inputs stay cached');
  writeFileSync(cred, 'key=ROTATED\n');
  assert.equal(await fx.ensureSetup(t.exec, spec, 0), 'ran', 'a rotated credential re-runs setup');
  assert.equal(readFileSync(join(fx.laneRoot(spec, 0), 'setup-runs.txt'), 'utf8').trim().split('\n').length, 2);
  assert.equal(readFileSync(join(home, 'rclone.conf'), 'utf8').trim(), 'key=ROTATED');
});

test('M7: startLane itself enforces maxAttempts', async () => {
  const home = tmp();
  const spec = fx.normalizeSpec(mkSpec('m7', { remoteBase: home, allowFewerLanes: true, maxAttempts: 2 }));
  const t = mktarget(spec, 0, { cid: 'cA', home });
  assert.ok(spec.maxAttempts === 2);
  await assert.rejects(fx.startLane(t.exec, spec, 0, ['a'], { attempts: 2 }), fx.LaneGaveUp);
  await assert.rejects(fx.startLane(t.exec, spec, 0, ['a'], { attempts: 5 }), /gave up after 5 relaunches/);
});

test('LOW-1: dir mode follows a file symlink in the root and refuses escaping ones', () => {
  const src = tmp();
  mkdirSync(join(src, 'sub'), { recursive: true });
  writeFileSync(join(src, 'real.txt'), 'x\n');
  writeFileSync(join(src, 'outside.txt'), 'y\n');
  symlinkSync(join(src, 'real.txt'), join(src, 'link.txt'));   // inside -> followed
  symlinkSync('/etc/hosts', join(src, 'sub', 'escape.txt'));   // outside -> refused
  symlinkSync(src, join(src, 'loop'));                         // dir symlink -> not walked
  const { items } = fx.loadItems(src);
  assert.ok(items.includes('link.txt'), 'a file symlink inside the root is an item');
  assert.ok(!items.some((p) => p.startsWith('sub/')), 'a symlink escaping the root is not an item');
  assert.ok(!items.includes('loop'), 'a directory symlink is not walked (cycle guard)');
});

test('cli: a recorded lane count is refused when it changes (M6)', () => {
  const dir = tmp();
  const items = join(dir, 'i.txt');
  writeFileSync(items, Array.from({ length: 12 }, (_, i) => `i${i}`).join('\n') + '\n');
  const specPath = join(dir, 'spec.json');
  const five = { name: 'm6', lanes: 5, items, worker: 'true', remoteBase: join(dir, 'r') };
  writeFileSync(specPath, JSON.stringify(five));
  const env = { ...process.env, FANOUT_STATE_DIR: join(dir, 'state') };
  const run = (extra = []) => { try { return { rc: 0, out: execFileSync('node', ['fanout/cli.mjs', 'status', specPath, '--transport', 'local', ...extra], { env, encoding: 'utf8' }) }; }
    catch (e) { return { rc: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; } };
  assert.equal(run().rc, 0, 'the first run records the count');
  writeFileSync(specPath, JSON.stringify({ ...five, lanes: 7 }));
  const bad = run();
  assert.notEqual(bad.rc, 0, bad.out);
  assert.match(bad.out, /recorded 5/);
  writeFileSync(specPath, JSON.stringify({ ...five, lanes: 7 }));
  assert.equal(run(['--reshard']).rc, 0, '--reshard is the documented way through');
});

test('cli: watch exits non-zero when the fleet stops with items unfinished', () => {
  const dir = tmp();
  const items = join(dir, 'i.txt');
  writeFileSync(items, 'a\nb\n');
  writeFileSync(join(dir, 'worker.sh'), 'echo "failing on purpose" >&2\nexit 1\n');
  const specPath = join(dir, 'spec.json');
  writeFileSync(specPath, JSON.stringify({ name: 'w', lanes: 1, allowFewerLanes: true, items,
    worker: { file: join(dir, 'worker.sh') }, maxAttempts: 1, remoteBase: join(dir, 'r') }));
  const env = { ...process.env, FANOUT_STATE_DIR: join(dir, 'state') };
  let rc = 0, out = '';
  try { out = execFileSync('node', ['fanout/cli.mjs', 'watch', specPath, '--transport', 'local', '--every', '1s'], { env, encoding: 'utf8', timeout: 30000 }); }
  catch (e) { rc = e.status; out = String(e.stdout || '') + String(e.stderr || ''); }
  assert.equal(rc, 1, `watch must not report a stalled fleet as success (out: ${out.slice(-400)})`);
  assert.match(out, /nothing left to run/);
  assert.match(out, /stalled:/);
});

// A spec whose lane root and item file live under a temp HOME, with the
// identity already recorded (so a missing lane.id is UNKNOWN, not FRESH).
function fs_spec(home, name) {
  const s = fx.normalizeSpec(mkSpec(name, { remoteBase: home, allowFewerLanes: true }));
  s.lane[0].laneIdKnown = true;
  return s;
}
