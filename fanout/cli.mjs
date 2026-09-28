#!/usr/bin/env node
// fanout CLI — see README.md. Commands:
//   run     <spec.json> [--transport local]    start/resume every lane
//   status  <spec.json> [--heal]               per-lane table; --heal relaunches dead lanes
//   watch   <spec.json> [--every 10m]          status --heal in a loop (doubles as keepalive)
//   stop    <spec.json> [--lane i]             kill lane workers
//   collect <spec.json>                        run spec.collect locally
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as fx from './lib.mjs';

const argv = process.argv.slice(2);
const [cmd, specPath] = argv;
const flag = (k) => argv.includes(k);
const opt = (k, d) => { const i = argv.indexOf(k); return i > 0 ? argv[i + 1] : d; };
if (!cmd || !specPath) {
  console.error('usage: cli.mjs run|status|watch|stop|collect <spec.json> [--heal] [--every 10m] [--lane i] [--transport gcloud|local]');
  process.exit(2);
}
const spec = fx.normalizeSpec(JSON.parse(readFileSync(specPath, 'utf8')), dirname(resolve(specPath)));
const exec = opt('--transport', spec.transport || 'gcloud') === 'local' ? fx.localTransport() : fx.gcloudTransport();
const stateDir = join(process.env.FANOUT_STATE_DIR || join(homedir(), '.local/state/fanout'), spec.name);
mkdirSync(stateDir, { recursive: true });
const statePath = join(stateDir, 'state.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { relaunches: {} };
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const { dir, items } = fx.loadItems(spec.items);
const shards = fx.shard(items, spec.lanes);
state.spec = { name: spec.name, lanes: spec.lane.map((l) => l.singleton), image: spec.image, items: spec.items,
  dirMode: Boolean(dir), total: items.length, perLane: shards.map((s) => s.length) };
save();

// Lanes are independent: run them all at once, and a failure on one lane
// never stops the others.
async function eachLane(fn, only = null) {
  return Promise.all(spec.lane.map(async (_l, i) => {
    if (only !== null && i !== only) return null;
    try { return await fn(i); } catch (e) { return { lane: spec.lane[i].singleton, error: String(e.message).slice(0, 300) }; }
  }));
}

async function doRun() {
  log(`fanout ${spec.name}: ${items.length} items${dir ? ` (files of ${dir})` : ''} over ${spec.lanes} lanes; per lane ${shards.map((s) => s.length).join('/')}`);
  const res = await eachLane((i) => fx.startLane(exec, spec, i, shards[i], { dir }));
  for (const r of res) log(r.error ? `${r.lane} ERROR ${r.error}` : `${r.lane} ${r.launched ? 'launched' : r.reason}: done ${r.done ?? '?'}/${r.total} todo ${r.todo ?? '?'} setup=${r.setup ?? '-'}`);
  state.lastRun = new Date().toISOString(); save();
  return res;
}

async function doStatus(heal) {
  const st = await eachLane((i) => fx.laneStatus(exec, spec, i));
  let totOk = 0, totFail = 0, complete = 0, alive = 0;
  const rows = [];
  for (let i = 0; i < st.length; i++) {
    const s = st[i], n = shards[i].length;
    if (s.error) { rows.push([spec.lane[i].singleton, 'ERR', '-', '-', '-', '-', s.error]); continue; }
    totOk += s.ok; totFail += s.fail; if (s.alive) alive++;
    const left = n - s.ok, relaunched = state.relaunches[s.lane] || 0;
    let action = '';
    if (left <= 0 && !s.alive) complete++;
    else if (!s.alive && heal && relaunched < spec.maxAttempts) {
      const r = await fx.startLane(exec, spec, i, shards[i], { dir }).catch((e) => ({ error: e.message }));
      action = r.error ? `heal ERROR ${r.error.slice(0, 120)}` : r.launched ? `healed (todo ${r.todo})` : r.reason;
      if (r.launched) state.relaunches[s.lane] = relaunched + 1;
    } else if (!s.alive && left > 0) action = relaunched >= spec.maxAttempts ? `gave up after ${relaunched} relaunches` : 'dead (use --heal)';
    const dup = s.okLines - s.ok;
    rows.push([s.lane, s.alive ? 'alive' : `dead rc=${s.rc ?? '-'}`, `${s.ok}/${n}`, String(s.fail), dup ? `${dup} dup` : '', action, s.last]);
  }
  const w = [0, 1, 2, 3, 4, 5].map((c) => Math.max(...rows.map((r) => String(r[c]).length)));
  for (const r of rows) console.log(r.slice(0, 6).map((c, k) => String(c).padEnd(w[k])).join('  ') + '  | ' + String(r[6]).slice(0, 110));
  const summary = { at: new Date().toISOString(), ok: totOk, total: items.length, failOnly: totFail, alive, lanesComplete: complete };
  console.log(`TOTAL ok ${totOk}/${items.length}  fail-only ${totFail}  alive ${alive}/${spec.lanes}  complete ${complete}/${spec.lanes}`);
  state.lastStatus = summary; save();
  return summary;
}

function parseEvery(s) { const m = /^(\d+)(s|m|h)?$/.exec(s || '10m'); return Number(m[1]) * ({ s: 1, m: 60, h: 3600 }[m[2] || 'm']) * 1000; }

if (cmd === 'run') { await doRun(); await doStatus(false); }
else if (cmd === 'status') await doStatus(flag('--heal'));
else if (cmd === 'watch') {
  const every = parseEvery(opt('--every', '10m'));
  if (every > 20 * 60000) log('warning: --every above 20m lets idle lanes sleep (keepalive window is ~30m)');
  for (;;) {
    const s = await doStatus(true);
    const exhausted = spec.lane.every((l) => (state.relaunches[l.singleton] || 0) >= spec.maxAttempts);
    if (s.alive === 0 && (s.ok >= s.total || s.lanesComplete === spec.lanes || exhausted)) { log('watch: nothing left to run'); break; }
    await new Promise((r) => setTimeout(r, every));
  }
} else if (cmd === 'stop') {
  const only = opt('--lane', null);
  for (const r of await eachLane((i) => fx.stopLane(exec, spec, i), only === null ? null : Number(only))) if (r) log(r.error || r);
} else if (cmd === 'collect') {
  if (!spec.collect) { console.error('spec has no collect command'); process.exit(2); }
  const r = spawnSync('bash', ['-c', spec.collect], { stdio: 'inherit', cwd: dirname(resolve(specPath)),
    env: { ...process.env, FANOUT_NAME: spec.name, FANOUT_STATE: stateDir, FANOUT_LANES: spec.lane.map((l) => l.singleton).join(' '), FANOUT_REMOTE_BASE: spec.remoteBase } });
  process.exit(r.status ?? 1);
} else { console.error(`unknown command ${cmd}`); process.exit(2); }
