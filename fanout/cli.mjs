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
state.relaunches ||= {};
// M6: `lanes` is the sharding identity. sha1(item) % lanes is only stable while
// the count is, so a changed count silently re-crawls most of the corpus under
// different lane dirs. Record it, and refuse a mismatch unless --reshard.
if (state.lanes != null && state.lanes !== spec.lanes && !flag('--reshard')) {
  console.error(`spec.lanes is ${spec.lanes} but ${statePath} recorded ${state.lanes}. ` +
    'Changing the lane count re-shards every item (lane-<i> dirs are not renamed), so most of the ' +
    'work is redone. Pass --reshard to accept that, or restore the previous count.');
  process.exit(2);
}
state.lanes = spec.lanes;
// M3: the launch token lives in local state so a LATER process (status --heal,
// watch) still knows which token this lane's worker was started with. Without
// it the liveness check would silently degrade to a bare `kill -0`.
state.tokens ||= {};
// A lane whose identity is unknown is marked by the CLI, not the library, so the
// library stays usable on its own. `laneIdKnown` makes setup refuse to mint a
// second identity for a lane that already has one recorded here.
for (const l of spec.lane) {
  l.startToken = state.tokens[l.singleton];
  l.laneIdKnown = Boolean(state.tokens[l.singleton]);
}
// A lane this state dir has already set up is one this machine owns: from then
// on, a lane.id we cannot find means the answering container is NOT ours
// (UNKNOWN), never that the lane should be re-created somewhere else. Only on
// the very first run, where nothing is recorded yet, may a lane be born (FRESH).
const rememberToken = (i, r) => {
  if (spec.lane[i].startToken) { state.tokens[spec.lane[i].singleton] = spec.lane[i].startToken; spec.lane[i].laneIdKnown = true; }
  if (r) save();
};
// M5: `run` is a deliberate fresh start; a lane that still owes relaunches from
// a previous incident should not start out already half-exhausted.
if (cmd === 'run') state.relaunches = {};

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
  const res = await eachLane((i) => fx.startLane(exec, spec, i, shards[i], { dir }).then((r) => (rememberToken(i, false), r)));
  save();
  for (const r of res) log(r.error ? `${r.lane} ERROR ${r.error}` : `${r.lane} ${r.launched ? 'launched' : r.reason}: done ${r.done ?? '?'}/${r.total} todo ${r.todo ?? '?'} setup=${r.setup ?? '-'}`);
  state.lastRun = new Date().toISOString(); save();
  return res;
}

// M5: a heal resets the counter for that lane, the moment the lane is seen
// alive — a lane that has come back and is making progress is a fresh run, and
// a cumulative counter would otherwise exhaust a healable lane for good.
function resetRelaunches(lanes) {
  let changed = false;
  for (const l of lanes) if (state.relaunches[l]) { delete state.relaunches[l]; changed = true; }
  return changed;
}

async function doStatus(heal) {
  const st = await eachLane((i) => fx.laneStatus(exec, spec, i));
  let totOk = 0, totFail = 0, complete = 0, alive = 0, unknown = 0;
  const rows = [], perLane = [];
  for (let i = 0; i < st.length; i++) {
    const s = st[i], n = shards[i].length;
    if (s.error) { rows.push([spec.lane[i].singleton, 'ERR', '-', '-', '-', '-', s.error]); perLane.push({ lane: spec.lane[i].singleton, n, ok: 0, terminal: false }); continue; }
    // An UNKNOWN lane is on a container that is not the one we set up. It is
    // counted ok=0 and is NEVER healed: relaunching it would start a second full
    // shard under a second identity. It must be inspected.
    if (s.id === 'UNKNOWN') { unknown++; perLane.push({ lane: s.lane, n, ok: s.ok, terminal: false });
      rows.push([s.lane, 'UNKNOWN', `${s.ok}/${n}`, String(s.fail), '', 'not ours — inspect (heal refused)', s.last]); continue; }
    totOk += s.ok; totFail += s.fail; if (s.alive) alive++;
    const left = n - s.ok, relaunched = state.relaunches[s.lane] || 0;
    let action = '';
    if (s.alive && resetRelaunches([s.lane])) save();
    if (left <= 0 && !s.alive) complete++;
    else if (!s.alive && heal && relaunched < spec.maxAttempts) {
      const r = await fx.startLane(exec, spec, i, shards[i], { dir, attempts: relaunched }).catch((e) => ({ error: e.message }));
      rememberToken(i, true);
      action = r.error ? `heal ERROR ${r.error.slice(0, 120)}` : r.launched ? `healed (todo ${r.todo})` : r.reason;
      if (r.launched) state.relaunches[s.lane] = relaunched + 1;
    } else if (!s.alive && left > 0) action = relaunched >= spec.maxAttempts ? `gave up after ${relaunched} relaunches` : 'dead (use --heal)';
    const dup = s.okLines - s.ok;
    perLane.push({ lane: s.lane, n, ok: s.ok, relaunched, terminal: left <= 0 || relaunched >= spec.maxAttempts });
    rows.push([s.lane, s.alive ? 'alive' : `dead rc=${s.rc ?? '-'}`, `${s.ok}/${n}`, String(s.fail), dup ? `${dup} dup` : '', action, s.last]);
  }
  const w = [0, 1, 2, 3, 4, 5].map((c) => Math.max(...rows.map((r) => String(r[c]).length)));
  for (const r of rows) console.log(r.slice(0, 6).map((c, k) => String(c).padEnd(w[k])).join('  ') + '  | ' + String(r[6]).slice(0, 110));
  const summary = { at: new Date().toISOString(), ok: totOk, total: items.length, failOnly: totFail, alive, lanesComplete: complete, unknown, perLane };
  console.log(`TOTAL ok ${totOk}/${items.length}  fail-only ${totFail}  alive ${alive}/${spec.lanes}  complete ${complete}/${spec.lanes}  unknown ${unknown}`);
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
    // A lane is TERMINAL when it holds every item of its shard or has spent its
    // relaunches. An UNKNOWN lane is neither, and keeps the loop alive (and
    // says so every tick): the only fix is a human looking at the container, and
    // treating it as finished would silently drop its whole shard.
    if (s.unknown) log(`watch: ${s.unknown} UNKNOWN lane(s) — not ours, heal refused, inspect the container`);
    const open = s.perLane.filter((l) => !l.terminal);
    if (s.alive === 0 && !open.length) {
      if (s.ok >= s.total) { log('watch: nothing left to run'); process.exitCode = 0; }
      else {
        // The fleet stopped for good with work outstanding. That is a failed
        // stage, not a finished one: a caller chaining on rc (regen/assemble)
        // must not roll on into indexing a partial corpus.
        log(`watch: nothing left to run — ${s.lanesComplete}/${spec.lanes} lanes complete, `
          + `stalled: ${s.perLane.filter((l) => l.ok < l.n).map((l) => l.lane).join(' ')}`);
        process.exitCode = 1;
      }
      break;
    }
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
