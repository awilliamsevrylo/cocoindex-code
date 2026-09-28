// fanout/lib.mjs — generic, resumable fan-out of a work list across N gcloud
// Cloud Shell lanes (gcloud-ssh-mcp `shell_exec`). Items are opaque lines
// (URLs, repo names, paths) or the files of a local directory. Each lane
// keeps an append-only MANIFEST.tsv (`item\tok|FAIL\t...`); a (re)start pulls
// the lane's finished set and uploads only the remainder. Every remote step
// is idempotent, so the transport may retry any call.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

export const MIN_LANES = 5;
export const CHUNK_B64 = 48 * 1024; // base64 chars per upload call
const RAW_SLICE = 36 * 1024; // raw bytes per download call (= 48 KB base64)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// ── transports: exec(lane, command, timeoutMs) -> combined output text ──
export function gcloudTransport(credPath = join(homedir(), '.local/state/gcloud-ssh-mcp.json')) {
  const cred = JSON.parse(readFileSync(credPath, 'utf8')); // never printed
  return async function exec(lane, command, timeoutMs = 300000) {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(cred.url, {
          method: 'POST',
          headers: { ...cred.headers, 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'shell_exec' },
          body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
            params: { name: 'shell_exec', arguments: { command, singleton: lane.singleton, image: lane.image, timeoutMs: Math.min(timeoutMs, 300000) } } }),
        });
        const text = await res.text();
        let j; try { j = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status} from gcloud-ssh-mcp`); }
        if (j.error) throw new Error(`rpc ${j.error.code}: ${String(j.error.message).slice(0, 200)}`);
        return (j.result?.content || []).map((c) => c.text).join('\n');
      } catch (e) { last = e; await sleep(2000 * 2 ** attempt); }
    }
    throw new Error(`lane ${lane.singleton}: transport failed: ${last.message}`);
  };
}

// Runs commands with local bash — the test seam, and a way to dry-run a spec.
export function localTransport() {
  return async (_lane, command) => {
    const r = spawnSync('bash', ['-c', command], { encoding: 'utf8', maxBuffer: 1 << 28 });
    return (r.stdout || '') + (r.stderr || '');
  };
}

// Wraps a command in markers so banners / trailers the transport adds are
// ignored, and returns {rc, text}. Commands must not call `exit`.
export async function run(exec, lane, cmd, timeoutMs = 120000) {
  const out = await exec(lane, `echo __FX_BEGIN__\n{\n${cmd}\n} 2>&1\necho "__FX_RC__ $?"\n`, timeoutMs);
  const b = out.indexOf('__FX_BEGIN__\n'), m = out.lastIndexOf('__FX_RC__ ');
  if (b < 0 || m < b) throw new Error(`lane ${lane.singleton}: no result markers: ${out.slice(-300)}`);
  return { rc: parseInt(out.slice(m + 10), 10), text: out.slice(b + 13, m).replace(/\n$/, '') };
}

// ── items + sharding ──
export const hash32 = (s) => createHash('sha1').update(s).digest().readUInt32BE(0);
export const laneOf = (item, lanes) => hash32(item) % lanes;
export function shard(items, lanes) {
  const out = Array.from({ length: lanes }, () => []);
  for (const it of items) out[laneOf(it, lanes)].push(it);
  return out;
}
function listFiles(root, sub = '') {
  const out = [];
  for (const e of readdirSync(join(root, sub), { withFileTypes: true })) {
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(root, rel));
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

// ── byte transfer in ≤48 KB calls (idempotent parts, sha256-verified) ──
export async function upload(exec, lane, path, buf, { gzip = false } = {}) {
  const b64 = (gzip ? gzipSync(buf) : Buffer.from(buf)).toString('base64');
  const parts = Math.max(1, Math.ceil(b64.length / CHUNK_B64));
  const pre = `${path}.fxpart`;
  for (let i = 0; i < parts; i++) {
    const piece = b64.slice(i * CHUNK_B64, (i + 1) * CHUNK_B64);
    const clear = i === 0 ? `rm -f ${shq(pre)}.*; ` : '';
    const r = await run(exec, lane, `mkdir -p ${shq(dirname(path))} && ${clear}printf '%s' '${piece}' > ${shq(`${pre}.${String(i).padStart(5, '0')}`)}`);
    if (r.rc) throw new Error(`upload ${path} part ${i} on ${lane.singleton}: ${r.text}`);
  }
  const r = await run(exec, lane, `cat ${shq(pre)}.* | base64 -d ${gzip ? '| gunzip -c ' : ''}> ${shq(path)} && rm -f ${shq(pre)}.* && (sha256sum ${shq(path)} 2>/dev/null || shasum -a 256 ${shq(path)}) | cut -c1-64`);
  if (r.rc || r.text.trim() !== sha256(buf)) throw new Error(`upload ${path} on ${lane.singleton}: checksum mismatch (${r.text.slice(0, 120)})`);
  return { bytes: buf.length, calls: parts + 1 };
}
export async function download(exec, lane, path) {
  const s = await run(exec, lane, `if [ -f ${shq(path)} ]; then wc -c < ${shq(path)}; else echo -1; fi`);
  const size = parseInt(s.text.trim(), 10);
  if (!(size >= 0)) return null;
  const bufs = [];
  for (let off = 0; off < size; off += RAW_SLICE) {
    const r = await run(exec, lane, `tail -c +${off + 1} ${shq(path)} | head -c ${RAW_SLICE} | base64 | tr -d '\\n'`);
    bufs.push(Buffer.from(r.text.trim(), 'base64'));
  }
  const buf = Buffer.concat(bufs);
  if (buf.length !== size) throw new Error(`download ${path} on ${lane.singleton}: got ${buf.length} of ${size} bytes`);
  return buf;
}
export function tarFiles(dir, files) {
  const r = spawnSync('tar', ['czf', '-', '--no-xattrs', '-C', dir, '-T', '-'],
    { input: files.join('\n') + '\n', env: { ...process.env, COPYFILE_DISABLE: '1' }, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`tar failed: ${String(r.stderr).slice(0, 300)}`);
  return r.stdout;
}

// ── spec ──
const script = (v, base) => (v && typeof v === 'object' && v.file ? readFileSync(resolve(base, v.file), 'utf8') : v || '');
export function normalizeSpec(spec, specDir = '.') {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(spec.name || '')) throw new Error('spec.name must match [a-z0-9._-]+');
  const lanes = spec.lanes ?? MIN_LANES;
  if (lanes < MIN_LANES && !spec.allowFewerLanes) throw new Error(`spec.lanes must be >= ${MIN_LANES} (got ${lanes})`);
  if (!spec.items || !spec.worker) throw new Error('spec needs items and worker');
  const image = spec.image || 'node:22-slim';
  const names = spec.laneNames || Array.from({ length: lanes }, (_, i) => `${spec.lanePrefix || spec.name}-${i}`);
  return {
    remoteBase: '/tmp/home/fanout', syncEverySec: 300, maxAttempts: 5, env: {}, ...spec, lanes, image,
    items: resolve(specDir, spec.items),
    setup: script(spec.setup, specDir), worker: script(spec.worker, specDir), sync: script(spec.sync, specDir),
    lane: names.map((singleton) => ({ singleton, image })),
  };
}
export const laneRoot = (spec, i) => `${spec.remoteBase}/${spec.name}/lane-${i}`;

// ── lane scripts ──
const ALIVE = `alive(){ [ -n "$1" ] || return 1; if [ -d /proc ]; then [ -r /proc/$1/cmdline ] && tr '\\0' ' ' < /proc/$1/cmdline | grep -q run.sh; else kill -0 "$1" 2>/dev/null; fi; }`;
function runScript(spec, i, root) {
  const env = { ITEMS_FILE: `${root}/items.txt`, OUT_DIR: `${root}/out`, IN_DIR: `${root}/in`,
    LANE: spec.lane[i].singleton, LANE_INDEX: String(i), FANOUT_NAME: spec.name, ...spec.env };
  return ['#!/usr/bin/env bash', ...Object.entries(env).map(([k, v]) => `export ${k}=${shq(v)}`),
    `cd ${shq(root)}`, 'mkdir -p "$OUT_DIR" "$IN_DIR"', 'rm -f done', 'SP=',
    `if [ -s sync.sh ]; then ( while sleep ${Number(spec.syncEverySec)}; do bash sync.sh >> sync.log 2>&1; done ) & SP=$!; fi`,
    'echo "[fanout] start $(date -u +%FT%TZ) items=$(wc -l < "$ITEMS_FILE")"',
    'bash worker.sh; rc=$?',
    'if [ -s sync.sh ]; then bash sync.sh >> sync.log 2>&1; fi',
    '[ -n "$SP" ] && kill "$SP" 2>/dev/null',
    'echo "[fanout] end rc=$rc $(date -u +%FT%TZ)"', 'echo "$rc" > done', ''].join('\n');
}
const pidCheck = (root) => `cd ${shq(root)} 2>/dev/null && ${ALIVE} && p=$(cat pid 2>/dev/null)`;

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
    await run(exec, lane, `chmod 600 ${shq(dst)}`);
  }
  return names.length;
}

export async function ensureSetup(exec, spec, i) {
  const lane = spec.lane[i], root = laneRoot(spec, i);
  await pushUploads(exec, spec, i);
  if (!spec.setup) return 'none';
  const tag = sha256(spec.setup).slice(0, 12);
  await upload(exec, lane, `${root}/setup.sh`, Buffer.from(spec.setup));
  const r = await run(exec, lane, `cd ${shq(root)} && if [ -f setup.ok.${tag} ]; then echo cached; elif bash setup.sh > setup.log 2>&1; then touch setup.ok.${tag}; echo ran; else echo "setup failed:"; tail -8 setup.log; false; fi`, 300000);
  if (r.rc) throw new Error(`lane ${lane.singleton}: ${r.text}`);
  return r.text.trim();
}
// The lane's finished items, pulled as gzip in ≤48 KB slices.
export async function okSet(exec, spec, i) {
  const lane = spec.lane[i], root = laneRoot(spec, i);
  await run(exec, lane, `m=${shq(`${root}/out/MANIFEST.tsv`)}; if [ -f "$m" ]; then awk -F'\\t' '$2=="ok"{print $1}' "$m" | sort -u | gzip -c > ${shq(`${root}/ok.gz`)}; else rm -f ${shq(`${root}/ok.gz`)}; fi`);
  const buf = await download(exec, lane, `${root}/ok.gz`);
  return new Set(buf ? gunzipSync(buf).toString('utf8').split('\n').filter(Boolean) : []);
}
// (Re)start one lane on its unfinished items. No-op while its worker is alive.
export async function startLane(exec, spec, i, items, { dir = null } = {}) {
  const lane = spec.lane[i], root = laneRoot(spec, i);
  const pre = await run(exec, lane, `mkdir -p ${shq(`${root}/out`)} ${shq(`${root}/in`)} && ${pidCheck(root)}; if alive "$p"; then echo alive; else echo idle; fi`);
  if (pre.text.trim().endsWith('alive')) return { lane: lane.singleton, total: items.length, launched: false, reason: 'alive' };
  const setup = await ensureSetup(exec, spec, i);
  const ok = await okSet(exec, spec, i);
  const todo = remainder(items, ok);
  const base = { lane: lane.singleton, total: items.length, done: items.length - todo.length, todo: todo.length, setup };
  if (!todo.length) return { ...base, launched: false, reason: 'complete' };
  await upload(exec, lane, `${root}/items.txt`, Buffer.from(todo.join('\n') + '\n'), { gzip: true });
  if (dir) {
    await upload(exec, lane, `${root}/in.tgz`, tarFiles(dir, todo));
    const x = await run(exec, lane, `cd ${shq(root)} && tar xzf in.tgz -C in && rm -f in.tgz`);
    if (x.rc) throw new Error(`lane ${lane.singleton}: untar: ${x.text}`);
  }
  await upload(exec, lane, `${root}/worker.sh`, Buffer.from(spec.worker));
  await upload(exec, lane, `${root}/sync.sh`, Buffer.from(spec.sync));
  await upload(exec, lane, `${root}/run.sh`, Buffer.from(runScript(spec, i, root)));
  const r = await run(exec, lane, `${pidCheck(root)}; if alive "$p"; then echo "alive $p"; else rm -f done; S=; command -v setsid >/dev/null && S=setsid; $S nohup bash run.sh >> run.log 2>&1 < /dev/null & echo $! > pid; echo "started $!"; fi`);
  return { ...base, launched: r.text.includes('started'), reason: r.text.trim() };
}
// One status line per lane: alive, done rc, unique ok, ok lines, fail-only items, last log line.
export async function laneStatus(exec, spec, i) {
  const lane = spec.lane[i], root = laneRoot(spec, i);
  const m = 'out/MANIFEST.tsv';
  const r = await run(exec, lane, `a=0; d=-; ok=0; okl=0; fl=0; last=; if ${pidCheck(root)}; then alive "$p" && a=1; [ -f done ] && d=$(cat done);
if [ -f ${m} ]; then ok=$(awk -F'\\t' '$2=="ok"{print $1}' ${m} | sort -u | wc -l | tr -d ' '); okl=$(awk -F'\\t' '$2=="ok"' ${m} | wc -l | tr -d ' ');
fl=$(awk -F'\\t' '$2=="ok"{o[$1]=1} $2!="ok"{f[$1]=1} END{n=0; for(k in f) if(!(k in o)) n++; print n}' ${m}); fi
last=$(tail -n 1 run.log 2>/dev/null | cut -c1-300 | base64 | tr -d '\\n'); fi
printf 'S\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$a" "$d" "$ok" "$okl" "$fl" "$last"`);
  const f = (r.text.split('\n').find((l) => l.startsWith('S\t')) || 'S\t0\t-\t0\t0\t0\t').split('\t');
  return { lane: lane.singleton, alive: f[1] === '1', rc: f[2] === '-' ? null : Number(f[2]), ok: Number(f[3]),
    okLines: Number(f[4]), fail: Number(f[5]), last: Buffer.from(f[6] || '', 'base64').toString('utf8').trim() };
}
export async function stopLane(exec, spec, i) {
  // Group kill where setsid made run.sh a group leader (Linux lanes); the
  // tree walk covers hosts without setsid (macOS), where killing only
  // run.sh would leave the worker writing.
  const KT = `kt(){ local c; for c in $(pgrep -P "$1" 2>/dev/null; cat /proc/$1/task/*/children 2>/dev/null); do kt "$c"; done; kill "$1" 2>/dev/null; }`;
  const r = await run(exec, spec.lane[i], `${KT}; ${pidCheck(laneRoot(spec, i))}; if [ -n "$p" ]; then kill -- -"$p" 2>/dev/null; kt "$p"; echo "stopped $p"; else echo "no pid"; fi`);
  return r.text.trim();
}
