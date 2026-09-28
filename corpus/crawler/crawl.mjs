#!/usr/bin/env node
// Chromium crawler for developer.android.com. One browser page parked on the
// origin; URLs are fetched in-page in batches (see extract.js) and only the
// resulting Markdown is written. Resumable: MANIFEST.tsv lists finished URLs,
// which are skipped on the next run.
// Usage: node crawl.mjs <urlfile> <outdir> [--conc N] [--batch N] [--limit N]
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const [urlFile, outDir] = process.argv.slice(2);
if (!urlFile || !outDir) { console.error('usage: crawl.mjs <urlfile> <outdir>'); process.exit(2); }
const CONC = arg('--conc', 8), BATCH = arg('--batch', 64), LIMIT = arg('--limit', Infinity);

// Same path scheme as the Jina crawl, so the index layout does not change.
export function urlToFile(u) {
  const p = new URL(u).pathname.replace(/^\//, '').replace(/\/$/, '') || 'index';
  return p.split('/').map((s) => s.replace(/[^a-zA-Z0-9._-]/g, '_')).join('/') + '.md';
}

const manifest = join(outDir, 'MANIFEST.tsv');
mkdirSync(outDir, { recursive: true });
const done = new Set(existsSync(manifest)
  ? readFileSync(manifest, 'utf8').split('\n').filter((l) => /\tok\t/.test(l)).map((l) => l.split('\t')[0])
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
const page = await browser.newPage();
await page.route('**/*', (r) => (['image', 'font', 'media', 'stylesheet'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
await page.goto('https://developer.android.com/robots.txt', { waitUntil: 'domcontentloaded' });
for (const src of inject) await page.addScriptTag({ content: src });

const t0 = Date.now();
let ok = 0, bad = 0;
const statuses = {};
for (let i = 0; i < todo.length; i += BATCH) {
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
      appendFileSync(manifest, `${r.url}\tFAIL\t${r.status}\t${r.err ?? ''}\t0\n`);
      bad++;
    }
  }
  const min = (Date.now() - t0) / 60000;
  console.log(`[${ok + bad}/${todo.length}] ok=${ok} fail=${bad} ${(ok / min).toFixed(0)} pages/min statuses=${JSON.stringify(statuses)}`);
}
await browser.close();
const min = (Date.now() - t0) / 60000;
console.log(`SUMMARY ok=${ok} fail=${bad} minutes=${min.toFixed(2)} pages_per_min=${(ok / Math.max(min, 1e-9)).toFixed(1)} statuses=${JSON.stringify(statuses)}`);
