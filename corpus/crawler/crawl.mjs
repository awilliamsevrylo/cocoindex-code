#!/usr/bin/env node
// Chromium crawler for developer.android.com. One browser page parked on the
// origin; URLs are fetched in-page in batches (see extract.js) and only the
// resulting Markdown is written. Resumable: MANIFEST.tsv lists finished URLs,
// which are skipped on the next run.
// Usage: node crawl.mjs <urlfile> <outdir> [--conc N] [--batch N] [--limit N]
// Importable: `import { urlToFile } from './crawl.mjs'` does not launch Chromium.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Same path scheme as the Jina crawl, so the index layout does not change.
export function urlToFile(u) {
  const p = new URL(u).pathname.replace(/^\//, '').replace(/\/$/, '') || 'index';
  return p.split('/').map((s) => s.replace(/[^a-zA-Z0-9._-]/g, '_')).join('/') + '.md';
}

async function main() {
  const require = createRequire(import.meta.url);
  const { chromium } = await import('playwright');
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
  const [urlFile, outDir] = process.argv.slice(2);
  if (!urlFile || !outDir) { console.error('usage: crawl.mjs <urlfile> <outdir>'); process.exit(2); }
  const CONC = arg('--conc', 8), BATCH = arg('--batch', 64), LIMIT = arg('--limit', Infinity);

  const manifest = join(outDir, 'MANIFEST.tsv');
  mkdirSync(outDir, { recursive: true });
  const done = new Set(existsSync(manifest)
    ? readFileSync(manifest, 'utf8').split('\n').map((l) => l.split('\t')).filter((f) => f[1] === 'ok').map((f) => f[0])
    : []);
  const todo = readFileSync(urlFile, 'utf8').split('\n').map((s) => s.trim())
    .filter((u) => u.startsWith('https://') && !done.has(u)).slice(0, LIMIT);
  console.log(`crawl: ${todo.length} to fetch, ${done.size} already done, conc=${CONC} batch=${BATCH}`);

  const inject = [
    require.resolve('turndown/dist/turndown.js'),
    require.resolve('turndown-plugin-gfm/dist/turndown-plugin-gfm.js'),
    require.resolve('@mozilla/readability/Readability.js'),
    join(HERE, 'extract.js'),
  ].map((f) => readFileSync(f, 'utf8'));

  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
  // A fresh page (new renderer heap) every RECYCLE batches caps any per-page
  // growth: one long-lived page decayed 327 → 130 pages/min over 450 URLs.
  const RECYCLE = arg('--recycle', 8);
  let page = null;
  async function freshPage() {
    if (page) await page.close();
    page = await browser.newPage();
    await page.goto('https://developer.android.com/robots.txt', { waitUntil: 'domcontentloaded' });
    for (const src of inject) await page.addScriptTag({ content: src });
  }

  const t0 = Date.now();
  let ok = 0, bad = 0;
  const statuses = {};
  const clean = (s) => String(s).replace(/[\t\r\n]+/g, ' ');
  for (let i = 0, b = 0; i < todo.length; i += BATCH, b++) {
    if (b % RECYCLE === 0) await freshPage();
    const res = await page.evaluate(([u, c]) => window.__crawl(u, c), [todo.slice(i, i + BATCH), CONC]);
    for (const r of res) {
      statuses[r.status] = (statuses[r.status] ?? 0) + 1;
      if (r.ok) {
        const f = join(outDir, urlToFile(r.url));
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, r.md);
        appendFileSync(manifest, `${r.url}\tok\t${r.status}\t${r.via}\t${r.md.length}\n`);
        ok++;
      } else {
        appendFileSync(manifest, `${r.url}\tFAIL\t${r.status}\t${clean(r.err ?? '')}\t0\n`);
        bad++;
      }
    }
    const min = (Date.now() - t0) / 60000;
    console.log(`[${ok + bad}/${todo.length}] ok=${ok} fail=${bad} ${(ok / min).toFixed(0)} pages/min statuses=${JSON.stringify(statuses)}`);
  }
  await browser.close();
  const min = (Date.now() - t0) / 60000;
  console.log(`SUMMARY ok=${ok} fail=${bad} minutes=${min.toFixed(2)} pages_per_min=${(ok / Math.max(min, 1e-9)).toFixed(1)} statuses=${JSON.stringify(statuses)}`);
}

// realpath both sides: /tmp is a symlink on macOS and import.meta.url is resolved.
const isMain = () => { try { return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (process.argv[1] && isMain()) await main();
