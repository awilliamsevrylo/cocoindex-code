#!/usr/bin/env node
// Regenerate the developer.android.com URL list for the android-docs job.
// Walks the sitemap index, keeps in-scope doc paths, dedupes, sorts, and
// writes one URL per line (the fanout `items` file). Re-runnable from scratch.
// Usage: node android-docs-urls.mjs [out=android-docs-urls.txt]
import { writeFileSync } from 'node:fs';

export const PREFIXES = ['/reference/', '/tools/', '/develop/', '/guide/', '/training/', '/topic/',
  '/design/', '/studio/', '/games/', '/kotlin/', '/jetpack/', '/privacy-and-security/', '/about/'];
const INDEX = 'https://developer.android.com/sitemap.xml';

// English only: the sitemap lists every page again per ?hl=<locale>
// (64,925 of 118,850 locs on 2026-09-28). The canonical URL has no query.
export const inScope = (u) => {
  let url;
  try { url = new URL(u); } catch { return false; }
  if (url.search) return false;
  const p = url.pathname;
  return PREFIXES.some((x) => p.startsWith(x) || p === x.slice(0, -1));
};
const locs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));

async function get(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.text();
      if (r.status < 500 && r.status !== 429) throw new Error(`HTTP ${r.status} ${url}`);
    } catch (e) {
      if (attempt === 3) throw e;
    }
    await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
  }
  throw new Error(`gave up ${url}`);
}

export async function androidDocsUrls({ log = console.log } = {}) {
  const children = locs(await get(INDEX));
  log(`sitemap children: ${children.length}`);
  const seen = new Set();
  let total = 0;
  for (const c of children) {
    const ls = locs(await get(c));
    total += ls.length;
    for (const u of ls) if (inScope(u)) seen.add(u);
    log(`${c.split('/').pop()} locs=${ls.length} inscope_running=${seen.size}`);
  }
  log(`TOTAL locs=${total} inscope_unique=${seen.size}`);
  // Byte order (not locale), so `LC_ALL=C comm` against another list works.
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2] || 'android-docs-urls.txt';
  const urls = await androidDocsUrls();
  writeFileSync(out, urls.join('\n') + '\n');
  console.log(`wrote ${urls.length} urls to ${out}`);
}
