// fanout/lib.mjs — generic, resumable fan-out of a work list across N gcloud
// Cloud Shell lanes (gcloud-ssh-mcp `shell_exec`). Items are opaque lines
// (URLs, repo names, paths) or the files of a local directory. Each lane
// keeps an append-only MANIFEST.tsv (`item\tok|FAIL\t...`); a (re)start pulls
// the lane's finished set and uploads only the remainder. Every remote step
// is idempotent, so the transport may retry any call.
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { shq, run, upload, download, tarFiles, gcloudTransport, localTransport, CHUNK_B64 } from './transfer.mjs';
export { shq, run, upload, download, tarFiles, gcloudTransport, localTransport, CHUNK_B64 } from './transfer.mjs';

export const MIN_LANES = 5;

// ── items + sharding ──
export const hash32 = (s) => createHash('sha1').update(s).digest().readUInt32BE(0);
export const laneOf = (item, lanes) => hash32(item) % lanes;
export function shard(items, lanes) {
  const out = Array.from({ length: lanes }, () => []);
  for (const it of items) out[laneOf(it, lanes)].push(it);
  return out;
}
function listFiles(root, sub = '', base = null) {
  // Compare resolved paths against the RESOLVED root: on macOS /var is a symlink
  // to /private/var, so a raw startsWith(root) silently drops every valid link.
  base ??= realpathSync(root);
  const out = [];
  for (const e of readdirSync(join(root, sub), { withFileTypes: true })) {
    // A symlink is followed only while it resolves to a *file* that is still
    // inside the root. A symlinked directory is skipped: following one can walk
    // a cycle forever, or pull in a whole tree the caller never named, and the
    // item list would silently grow. The README says exactly this.
    if (e.isSymbolicLink()) {
      let real; try { real = realpathSync(join(root, sub, e.name)); } catch { continue; } // dangling
      if (!real.startsWith(base + '/')) continue; // escapes the root
      if (!statSync(real).isFile()) continue;     // dir symlink / socket / fifo
      out.push(sub ? `${sub}/${e.name}` : e.name);
      continue;
    }
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(root, rel, base));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}
// A file of lines -> {dir:null, items}; a directory -> {dir, items: relative paths}.
export function loadItems(src) {
  const dir = statSync(src).isDirectory() ? src : null;
  const raw = dir ? listFiles(src).sort() : readFileSync(src, 'utf8').split('\n').map((s) => s.replace(/\r$/, ''));
  const items = [...new Set(raw.filter(Boolean))];
  const bad = items.find((s) => s.includes('\t'));
  if (bad) throw new Error(`items may not contain tabs: ${bad.slice(0, 80)}`);
  return { dir, items };
}
export const remainder = (items, ok) => items.filter((i) => !ok.has(i));

// ── spec ──
const script = (v, base) => (v && typeof v === 'object' && v.file ? readFileSync(resolve(base, v.file), 'utf8') : v || '');
export function normalizeSpec(spec, specDir = '.') {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(spec.name || '')) throw new Error('spec.name must match [a-z0-9._-]+');
  const lanes = spec.lanes ?? MIN_LANES;
  if (lanes < MIN_LANES && !spec.allowFewerLanes) throw new Error(`spec.lanes must be >= ${MIN_LANES} (got ${lanes})`);
  if (!spec.items || !spec.worker) throw new Error('spec needs items and worker');
  const image = spec.image || 'node:22-slim';
  const names = spec.laneNames || Array.from({ length: lanes }, (_, i) => `${spec.lanePrefix || spec.name}-${i}`);
  // M1: a laneNames list of the wrong length is silent item loss in one
  // direction (fewer names: the tail of `shard()` is never iterated) and a
  // TypeError in the other (more names: `shards[i]` is undefined). Refuse.
  if (names.length !== lanes) throw new Error(`spec.laneNames has ${names.length} entries but spec.lanes is ${lanes}`);
  return {
    remoteBase: '/tmp/home/fanout', syncEverySec: 300, maxAttempts: 5, env: {}, ...spec, lanes, image,
    items: resolve(specDir, spec.items),
    setup: script(spec.setup, specDir), worker: script(spec.worker, specDir), sync: script(spec.sync, specDir),
    lane: names.map((singleton) => ({ singleton, image })),
  };
}
export const laneRoot = (spec, i) => `${spec.remoteBase}/${spec.name}/lane-${i}`;

// ── lane identity ──
// The transport is a SINGLETON name that gcloud-ssh-mcp resolves to *a*
// container, and a recycled or rescheduled container is a different machine
// answering to the same name. Nothing in a reply says which machine spoke, so a
// lane proves it is itself with a token written at setup and re-read on every
// later call. "I cannot see my files" is therefore UNKNOWN, never "dead" — that
// is the difference between healing a lane and starting a second full crawl of
// the same items under a second identity.
// The container's own identity, as the lane sees it. FANOUT_CID is the seam a
// test (or a dry run) uses to say "answer as this container" while every other
// byte of the command stays the real one.
export const laneCid = `if [ -n "$FANOUT_CID" ]; then echo "$FANOUT_CID"; else n=$(sed 's|.*/||' /proc/self/cgroup 2>/dev/null|head -n1); [ -n "$n" ]||n=$(cat /etc/hostname 2>/dev/null||echo x); echo "c$n"; fi`;
const CID = laneCid;
export const laneToken = (spec, i) => (spec.lane[i].laneId ||= randomBytes(9).toString('hex'));
export function idSh(spec, i, write) {
  // Two conditions, and the second is the one that matters: the token must
  // match AND this container must already own its private dir. $HOME (and so
  // lane.id) is visible from every container, so a token match alone cannot
  // tell "I am the container that was set up" from "I am a different container
  // reading the same file" — the per-cid dir can.
  const fresh = (write || !spec.lane[i].laneIdKnown) ? `[ ! -f "$root/lane.id" ]&&id=FRESH\n` : '';
  return `root=${shq(laneRoot(spec, i))}; c=$(${CID}); core="$root/c/$c"; id=UNKNOWN;\n${fresh}` +
    `if [ "$(cat "$root/lane.id" 2>/dev/null)" = ${shq(laneToken(spec, i))} ]; then [ -d "$core" ]&&id=OURS; fi`;
}
// `core`, never `root`, holds out/ in/ pid done: one container can therefore
// never read or overwrite another's MANIFEST. `was` keeps the id as it was found
// (FRESH / UNKNOWN / OURS) before the block below promotes FRESH to OURS.
const idWrite = (spec, i) => `was=$id; if [ "$id" = FRESH ]; then mkdir -p "$core"&&printf '%s\\n' ${shq(laneToken(spec, i))} > "$root/lane.id"; id=OURS; fi`;
// H3: a MANIFEST line is complete only once its newline has landed. A crash
// mid-append leaves a partial last line, and awk happily reads an unterminated
// final record — so an item whose completion was never recorded would count as
// done and never be re-sent. mm copies the file, dropping that tail.
export const MM = `mm(){ [ -s "$1" ]||{ : > "$2"; return; }; if [ "$(tail -c 1 "$1"|od -An -c|tr -d ' \\n')" = '\\n' ]; then cp "$1" "$2"; else sed '$d' "$1" > "$2"; fi; }`;
// alive <pid> <expected token> <run.sh path>. Three independent tests, because
// `kill -0` alone is not liveness: a recycled pid, or a foreign process, passes
// it. On a /proc host the cmdline must name THIS lane's run.sh. Everywhere, the
// token the caller launched with must match the one the worker wrote — and the
// expected token comes from the CLIENT, never from the file being checked, or
// the check compares the record with itself and can never fail.
export const ALIVE = `alive(){ p=$1; e=$2; r=$3; [ -n "$p" ]||return 1; kill -0 "$p" 2>/dev/null||return 1;\nif [ -d /proc ]; then [ -r "/proc/$p/cmdline" ]&&tr '\\0' ' ' < "/proc/$p/cmdline"|grep -q -- "$r"||return 1; fi\n[ -z "$e" ]||[ "$(cat "$core/pid.token" 2>/dev/null)" = "$e" ]; }`;
export const aliveCheck = (spec, i) => `alive "$(cat "$core/pid" 2>/dev/null)" ${shq(spec.lane[i].startToken || '')} ${shq(`${laneRoot(spec, i)}/run.sh`)}`;
// Runs after idSh. Prints `<id> <user> <pid>`, and on FRESH writes the identity
// before anyone may act on it. `user` is what distinguishes a recycled container
// (same container id, cold STARTUP home) from a genuinely different one.
const probe = (spec, i) => `echo "$id $(id -un) $(cat "$core/pid" 2>/dev/null)"`;
export const preLine = (spec, i, write) => `${idSh(spec, i, write)}\n${idWrite(spec, i)}\n${probe(spec, i)}`;

function runScript(spec, i, root) {
  const extra = Object.entries(spec.env || {});
  for (const [k] of extra) {
    // The key lands in `export <k>=` unquoted, so it is the one part of this
    // line a shell reads as syntax. Quoting it is not possible; refuse instead.
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new Error(`spec.env key must match [A-Z_][A-Z0-9_]*: ${JSON.stringify(k)}`);
  }
  const env = { ITEMS_FILE: `${root}/items.txt`, OUT_DIR: `${root}/out`, IN_DIR: `${root}/in`,
    LANE: spec.lane[i].singleton, LANE_INDEX: String(i), FANOUT_NAME: spec.name, ...Object.fromEntries(extra) };
  return ['#!/usr/bin/env bash', ...Object.entries(env).map(([k, v]) => `export ${k}=${shq(v)}`),
    `cd ${shq(root)}`, 'mkdir -p "$OUT_DIR" "$IN_DIR"', 'SP=',
    `if [ -s sync.sh ]; then ( while sleep ${Number(spec.syncEverySec)}; do bash sync.sh >> sync.log 2>&1; done ) & SP=$!; fi`,
    'echo "[fanout] start $(date -u +%FT%TZ) items=$(wc -l < "$ITEMS_FILE")"',
    'bash worker.sh; rc=$?',
    'if [ -s sync.sh ]; then bash sync.sh >> sync.log 2>&1; fi',
    '[ -n "$SP" ] && kill "$SP" 2>/dev/null',
    'echo "[fanout] end rc=$rc $(date -u +%FT%TZ)"', 'echo "$rc" > done', ''].join('\n');
}

// spec.uploads: { "<name under $HOME>": "<local path, ~ ok>" } — secrets and
// configs a lane needs (e.g. rclone.conf). Written 0600 before setup; content
// never printed. Re-sent on every setup so a rotated credential propagates.
export async function pushUploads(exec, spec, i) {
  const lane = spec.lane[i];
  const names = Object.keys(spec.uploads || {});
  for (const name of names) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`uploads key must be a plain file name: ${name}`);
    const src = spec.uploads[name].replace(/^~(?=\/)/, homedir());
    const dst = `${spec.uploadHome || '/tmp/home'}/${name}`;
    await upload(exec, lane, dst, readFileSync(src));
    const mode = await run(exec, lane, `chmod 600 ${shq(dst)}`);
    if (mode.rc) throw new Error(`upload ${dst} on ${lane.singleton}: chmod 600 failed (${mode.text.slice(0, 120)})`);
  }
  return names.length;
}

// M4: the setup tag is the sha256 of setup TEXT *and* of every upload's
// content. Keyed on the text alone, a rotated credential skipped setup and the
// lane kept a config derived from the key that had just been replaced.
export function setupTag(spec) {
  const h = createHash('sha256').update(spec.setup);
  for (const name of Object.keys(spec.uploads || {}).sort()) {
    h.update(name).update('\0').update(readFileSync(spec.uploads[name].replace(/^~(?=\/)/, homedir())));
  }
  return h.digest('hex').slice(0, 12);
}

export async function ensureSetup(exec, spec, i) {
  const lane = spec.lane[i], root = laneRoot(spec, i);
  const pre = await run(exec, lane, preLine(spec, i, true));
  const f = pre.text.trim().split(' ');
  if (f[0] === 'UNKNOWN') return 'UNKNOWN (this is not the lane that was set up; refusing to run setup here)';
  await pushUploads(exec, spec, i);
  if (!spec.setup) return 'none';
  const tag = setupTag(spec);
  await upload(exec, lane, `${root}/setup.sh`, Buffer.from(spec.setup));
  const r = await run(exec, lane, setupBody(spec, i, tag), 300000);
  if (r.rc) throw new Error(`lane ${lane.singleton}: ${r.text}`);
  return f[0] === 'FRESH' ? `${r.text.trim()} (FIRST SETUP: this container IS the lane's home)` : r.text.trim();
}
const setupBody = (spec, i, tag) => `\n${idSh(spec, i, false)}\n[ "$id" = UNKNOWN ]&&{ echo "UNKNOWN: refusing to set up a lane that is not ours"; } || {\n${idWrite(spec, i)}\ncd "$root" && if [ -f setup.ok.${tag} ]; then echo cached; elif bash setup.sh > setup.log 2>&1; then touch setup.ok.${tag}; echo ran; else echo "setup failed:"; tail -8 setup.log; false; fi\n}`.trimEnd();

// The lane's finished items, pulled as gzip in ≤48 KB slices.
export async function okSet(exec, spec, i) {
  const lane = spec.lane[i], root = laneRoot(spec, i);
  const script = `\nif [ "$id" = UNKNOWN ]; then echo "__FX_NONE__"; else ${MM}; mm "$core/out/MANIFEST.tsv" "$core/ok.mm"; awk -F'\\t' '$2=="ok"{print $1}' "$core/ok.mm" 2>/dev/null | sort -u | gzip -c > "$core/ok.gz"; rm -f "$core/ok.mm"; echo "$core/ok.gz"; fi`;
  const r = await run(exec, lane, `${idSh(spec, i, false)}${script}`);
  const gz = r.text.trim().split('\n').pop();
  if (!gz || gz === '__FX_NONE__') return new Set();
  const buf = await download(exec, lane, gz);
  return new Set(buf ? gunzipSync(buf).toString('utf8').split('\n').filter(Boolean) : []);
}

// M7: maxAttempts is enforced in the library, not only in the CLI — every
// caller of startLane gets the bound.
export class LaneGaveUp extends Error {}

// (Re)start one lane on its unfinished items. No-op while its worker is alive.
export async function startLane(exec, spec, i, items, { dir = null, attempts = 0 } = {}) {
  const lane = spec.lane[i], root = laneRoot(spec, i);
  const pre = await run(exec, lane, preLine(spec, i, true));
  const st = pre.text.trim().split(' ');
  const id = st[0], base = { lane: lane.singleton, total: items.length, id };
  if (id === 'FRESH' && st[2] && st[3] && st[1] !== process.env.USER && st[1] !== process.env.USERNAME) {
    throw new Error(`lane ${lane.singleton}: ${st[1]} is not the setup user (${process.env.USER}); fresh container with an orphaned identity — inspect before launching`);
  }
  if (attempts >= spec.maxAttempts) throw new LaneGaveUp(`lane ${lane.singleton}: gave up after ${attempts} relaunches`);
  // M3: is the lane's OWN worker running? `spec.lane[i].startToken` is the token
  // the previous launch used (the CLI persists it); unset, the check falls back
  // to pid + cmdline.
  const live = await run(exec, lane, `${idSh(spec, i, false)}\n${ALIVE}; ${aliveCheck(spec, i)} && echo alive || echo idle`);
  if (live.text.trim().endsWith('alive')) return { ...base, launched: false, reason: 'alive' };
  const setup = await ensureSetup(exec, spec, i);
  if (/^UNKNOWN/.test(setup)) return { ...base, launched: false, reason: 'UNKNOWN lane' };
  const ok = await okSet(exec, spec, i);
  const todo = remainder(items, ok);
  const out = { ...base, done: items.length - todo.length, todo: todo.length, setup };
  if (!todo.length) return { ...out, launched: false, reason: 'complete' };
  await upload(exec, lane, `${root}/items.txt`, Buffer.from(todo.join('\n') + '\n'), { gzip: true });
  if (dir) {
    await upload(exec, lane, `${root}/in.tgz`, tarFiles(dir, todo));
    const x = await run(exec, lane, `mkdir -p "$core/in" && tar xzf ${shq(`${root}/in.tgz`)} -C "$core/in" && rm -f ${shq(`${root}/in.tgz`)}`);
    if (x.rc) throw new Error(`lane ${lane.singleton}: untar: ${x.text}`);
  }
  await upload(exec, lane, `${root}/worker.sh`, Buffer.from(spec.worker));
  await upload(exec, lane, `${root}/sync.sh`, Buffer.from(spec.sync));
  await upload(exec, lane, `${root}/run.sh`, Buffer.from(runScript(spec, i, root)));
  // M3: the worker's pid is written WITH the random token it was launched
  // under, so the next call can tell "the lane's run.sh" from "a pid that now
  // belongs to something else". The child writes both, then execs run.sh, so
  // the recorded pid IS the worker's.
  const tok = (spec.lane[i].startToken = randomBytes(9).toString('hex'));
  // The token is written by the PARENT, immediately after the job is backgrounded
  // — inside `run()`, so it is on disk before this call returns. Deriving the pid
  // from a `sh -c` wrapper instead was tried and measured hollow: the parent
  // reported "started", and the child left no pid, no log and no process behind.
  // `cd "$root"` is load-bearing: run.sh and its siblings live at the lane root,
  // `bash run.sh` is relative, and the shell that runs this has no lane cwd of
  // its own. Without it the job dies instantly and the line still prints
  // "started" — and the worker's own $OUT_DIR/$IN_DIR ride the symlinks into
  // $core, so the results still land on THIS container's private tree.
  const launch = `cd "$root" && rm -f "$core/pid" "$core/pid.token"\nS=; command -v setsid >/dev/null && S=setsid; $S nohup bash run.sh </dev/null >> "$core/run.log" 2>&1 & echo $! > "$core/pid"; printf '%s\\n' ${shq(tok)} > "$core/pid.token"; echo "started $!"`;
  const r = await run(exec, lane, `${idSh(spec, i, false)}\n[ "$id" = UNKNOWN ]&&{ echo "UNKNOWN: refusing to launch on a lane that is not ours"; } || {\nmkdir -p "$core/out" "$core/in"; ln -sfn "$core/out" "$root/out" 2>/dev/null; ln -sfn "$core/in" "$root/in" 2>/dev/null; rm -f "$core/done" "$root/done"; ln -s "$core/done" "$root/done"\n${launch}\n}`.trimEnd());
  return { ...out, launched: r.text.includes('started'), reason: r.text.trim().split('\n').slice(-1)[0] };
}
// One status line per lane: identity, alive, done rc, unique ok, ok lines,
// fail-only items, last log line. The MANIFEST is read whenever one exists —
// the pid gate applies to the worker, not to its results (H1).
export async function laneStatus(exec, spec, i) {
  const lane = spec.lane[i], root = laneRoot(spec, i);
  const body = `\na=0; d=-; ok=0; okl=0; fl=0; last=;\nm=$core/out/MANIFEST.tsv; t=$core/run.log; ${MM}\n${ALIVE}\n${aliveCheck(spec, i)}&&a=1\n[ -f "$core/done" ]&&d=$(cat "$core/done")\nif [ -f "$m" ]; then mm "$m" "$core/ok.mm"; ok=$(awk -F'\\t' '$2=="ok"{print $1}' "$core/ok.mm"|sort -u|wc -l|tr -d ' '); okl=$(awk -F'\\t' '$2=="ok"' "$core/ok.mm"|wc -l|tr -d ' ');\nfl=$(awk -F'\\t' '$2=="ok"{o[$1]=1} $2!="ok"{f[$1]=1} END{n=0; for(k in f) if(!(k in o)) n++; print n}' "$core/ok.mm"); rm -f "$core/ok.mm"; fi\nlast=$(tail -n 1 "$t" 2>/dev/null|cut -c1-300|base64|tr -d '\\n')\nprintf 'S\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$a" "$d" "$ok" "$okl" "$fl" "$last"`;
  const r = await run(exec, lane, `${idSh(spec, i, false)}\nif [ "$id" = UNKNOWN ]; then printf 'S\\tUNKNOWN\\n'; else${body}\nfi`);
  const raw = r.text.split('\n').find((l) => l.startsWith('S\t')) || 'S\tUNKNOWN';
  const f = raw.split('\t');
  if (f[1] === 'UNKNOWN') return { lane: lane.singleton, id: 'UNKNOWN', alive: false, rc: null, ok: 0, okLines: 0, fail: 0, last: '' };
  return { lane: lane.singleton, id: 'OURS', alive: f[1] === '1', rc: f[2] === '-' ? null : Number(f[2]), ok: Number(f[3]),
    okLines: Number(f[4]), fail: Number(f[5]), last: Buffer.from(f[6] || '', 'base64').toString('utf8').trim() };
}
export async function stopLane(exec, spec, i) {
  // Group kill where setsid made run.sh a group leader (Linux lanes); the
  // tree walk covers hosts without setsid (macOS), where killing only
  // run.sh would leave the worker writing.
  const KT = `kt(){ local c; for c in $(pgrep -P "$1" 2>/dev/null; cat /proc/$1/task/*/children 2>/dev/null); do kt "$c"; done; kill "$1" 2>/dev/null; }`;
  const r = await run(exec, spec.lane[i], `${KT}; ${idSh(spec, i, false)}; p=$(cat "$core/pid" 2>/dev/null); if [ "$id" = UNKNOWN ]; then echo "UNKNOWN lane"; elif [ -n "$p" ]; then kill -- -"$p" 2>/dev/null; kt "$p"; rm -f "$core/pid" "$core/pid.token"; echo "stopped $p"; else echo "no pid"; fi`);

  return r.text.trim().split('\n').pop();
}

