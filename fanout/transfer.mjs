// fanout/transfer.mjs — bounded, retry-safe byte transfer primitives.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export const CHUNK_B64 = 48 * 1024;
const RAW_SLICE = 36 * 1024;
const STALE_MINUTES = 60;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function gcloudTransport(credPath = join(homedir(), '.local/state/gcloud-ssh-mcp.json')) {
  const cred = JSON.parse(readFileSync(credPath, 'utf8'));
  return async function exec(lane, command, timeoutMs = 300000) {
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(cred.url, {
          method: 'POST', signal: AbortSignal.timeout(Math.min(timeoutMs, 300000) + 30000),
          headers: { ...cred.headers, 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'shell_exec' },
          body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
            params: { name: 'shell_exec', arguments: { command, singleton: lane.singleton, image: lane.image, timeoutMs: Math.min(timeoutMs, 300000) } } }),
        });
        const text = await res.text();
        let j; try { j = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status} from gcloud-ssh-mcp`); }
        if (j.error) throw new Error(`rpc ${j.error.code}: ${String(j.error.message).slice(0, 200)}`);
        return (j.result?.content || []).map((c) => c.text).join('\n');
      } catch (e) {
        last = e;
        if (e.name === 'TimeoutError' || e.name === 'AbortError') break;
        await sleep(2000 * 2 ** attempt);
      }
    }
    throw new Error(`lane ${lane.singleton}: transport failed: ${last.message}`);
  };
}

export function localTransport() {
  return async (_lane, command) => {
    const r = spawnSync('bash', ['-c', command], { encoding: 'utf8', maxBuffer: 1 << 28 });
    return (r.stdout || '') + (r.stderr || '');
  };
}

export async function run(exec, lane, cmd, timeoutMs = 120000) {
  const out = await exec(lane, `echo __FX_BEGIN__\n{\n${cmd}\n} 2>&1\necho "__FX_RC__ $?"\n`, timeoutMs);
  const b = out.indexOf('__FX_BEGIN__\n'), m = out.lastIndexOf('__FX_RC__ ');
  if (b < 0 || m < b) throw new Error(`lane ${lane.singleton}: no result markers: ${out.slice(-300)}`);
  return { rc: parseInt(out.slice(m + 10), 10), text: out.slice(b + 13, m).replace(/\n$/, '') };
}

const partName = (i) => String(i).padStart(8, '0');
const sumFor = (path) => ` (sha256sum ${shq(path)} 2>/dev/null || shasum -a 256 ${shq(path)}) | cut -c1-64`;
const cleanupFor = (pre, tmp, live) => `umask 077; rm -f ${shq(pre)}.* ${shq(tmp)} ${shq(live)}`;
function reapFor(path, keep) {
  return `p=${shq(path)}; keep=${shq(keep)}; for f in "$p".fxpart.*.*; do [ -e "$f" ]||continue; rest=\${f#"$p".fxpart.}; n=\${rest%%.*}; [ "$n" = "$keep" ]&&continue; l="$p.fxlive.$n"; probe="$f"; [ -e "$l" ]&&probe="$l"; if [ -n "$(find "$probe" -mmin +${STALE_MINUTES} -print 2>/dev/null)" ]; then rm -f "$p.fxpart.$n".* "$p.fxtmp.$n" "$l"; fi; done; for f in "$p".fxtmp.*; do [ -e "$f" ]||continue; n=\${f##*.fxtmp.}; [ "$n" = "$keep" ]&&continue; l="$p.fxlive.$n"; probe="$f"; [ -e "$l" ]&&probe="$l"; [ -n "$(find "$probe" -mmin +${STALE_MINUTES} -print 2>/dev/null)" ]&&rm -f "$f" "$l"; done`;
}

export async function upload(exec, lane, path, buf, { gzip = false } = {}) {
  const want = sha256(buf);
  const b64 = (gzip ? gzipSync(buf) : Buffer.from(buf)).toString('base64');
  const parts = Math.max(1, Math.ceil(b64.length / CHUNK_B64));
  const nonce = randomBytes(8).toString('hex');
  const pre = `${path}.fxpart.${nonce}`, tmp = `${path}.fxtmp.${nonce}`, live = `${path}.fxlive.${nonce}`;
  const have = Array.from({ length: parts }, (_, i) => `[ -e ${shq(`${pre}.${partName(i)}`)} ]`).join(' && ');
  const decode = `  if ${have} && cat ${shq(pre)}.* | base64 -d ${gzip ? '| gunzip -c ' : ''}> ${shq(tmp)}`
    + ` && [ "$(${sumFor(tmp)})" = '${want}' ] && mv -f ${shq(tmp)} ${shq(path)}; then`;
  const clean = `rm -f ${shq(pre)}.* ${shq(tmp)} ${shq(live)}`;
  const finalize = [
    'umask 077', `touch ${shq(live)}`, `if [ ! -e ${shq(path)} ]; then`, decode,
    `    ${clean}; echo done`, '  else', `    ${clean}; echo notok`, '  fi',
    `elif [ "$(${sumFor(path)})" = '${want}' ]; then`, `  ${clean}; echo uptodate`, 'else', decode,
    `    ${clean}; echo done`, '  else', `    ${clean}; echo notok`, '  fi', 'fi',
  ].join('\n');
  try {
    const init = await run(exec, lane, `umask 077; mkdir -p ${shq(dirname(path))}; ${reapFor(path, nonce)}; : > ${shq(live)}`);
    if (init.rc) throw new Error(`upload ${path} init on ${lane.singleton}: ${init.text}`);
    for (let i = 0; i < parts; i++) {
      const piece = b64.slice(i * CHUNK_B64, (i + 1) * CHUNK_B64);
      const r = await run(exec, lane, `umask 077; touch ${shq(live)}; printf '%s' '${piece}' > ${shq(`${pre}.${partName(i)}`)}`);
      if (r.rc) throw new Error(`upload ${path} part ${i} on ${lane.singleton}: ${r.text}`);
    }
    const r = await run(exec, lane, finalize);
    if (r.rc || !/^(done|uptodate)$/.test(r.text.trim())) throw new Error(`upload ${path} on ${lane.singleton}: checksum mismatch (${r.text.slice(0, 120)})`);
    return { bytes: buf.length, calls: parts + 2 };
  } catch (error) {
    try {
      const r = await run(exec, lane, cleanupFor(pre, tmp, live));
      if (r.rc) throw new Error(r.text);
    } catch (cleanup) {
      throw new Error(`${error.message}; cleanup failed: ${cleanup.message}`);
    }
    throw error;
  }
}

export async function download(exec, lane, path) {
  const snap = `${path}.fxsnp.${randomBytes(8).toString('hex')}`;
  let failed = null;
  try {
    const s = await run(exec, lane, `umask 077; if [ -f ${shq(path)} ]; then cp ${shq(path)} ${shq(snap)} && chmod 600 ${shq(snap)} && wc -c < ${shq(snap)}; else echo -1; fi`);
    if (s.rc) throw new Error(`download ${path} snapshot on ${lane.singleton}: ${s.text.slice(0, 120)}`);
    const size = parseInt(s.text.trim(), 10);
    if (!(size >= 0)) return null;
    const bufs = [];
    for (let off = 0; off < size; off += RAW_SLICE) {
      const r = await run(exec, lane, `tail -c +${off + 1} ${shq(snap)} | head -c ${RAW_SLICE} | base64 | tr -d '\\n'`);
      if (r.rc) throw new Error(`download ${path} slice on ${lane.singleton}: ${r.text.slice(0, 120)}`);
      bufs.push(Buffer.from(r.text.trim(), 'base64'));
    }
    const buf = Buffer.concat(bufs);
    if (buf.length !== size) throw new Error(`download ${path} on ${lane.singleton}: got ${buf.length} of ${size} bytes`);
    return buf;
  } catch (error) {
    failed = error;
    throw error;
  } finally {
    try {
      const r = await run(exec, lane, `rm -f ${shq(snap)}`);
      if (r.rc) throw new Error(r.text);
    } catch (cleanup) {
      if (failed) failed.message += `; snapshot cleanup failed: ${cleanup.message}`;
      else throw cleanup;
    }
  }
}

export function tarFiles(dir, files) {
  const r = spawnSync('tar', ['czf', '-', '--no-xattrs', '-C', dir, '-T', '-'],
    { input: files.join('\n') + '\n', env: { ...process.env, COPYFILE_DISABLE: '1' }, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`tar failed: ${String(r.stderr).slice(0, 300)}`);
  return r.stdout;
}
