#!/usr/bin/env node
// POC 10a quality gate. Scores crawler MD against the POC 10a criteria:
// title H1, zero chrome leaks, code fences, tables, and (when a reference MD
// directory is given, e.g. the Jina crawl) body word recall — gated on BOTH
// a per-page floor (every page >= FLOOR) and the mean (>= MEAN).
//
// Usage: node check-quality.mjs <outdir> [<refdir>]   exit 0 = all pass
//   <outdir>  a crawler output dir (MANIFEST.tsv + <url path>.md)
//   <refdir>  reference MD in the same layout (jina-ref.sh output)
// Both dirs MUST be persisted (e.g. copied to Wasabi next to the corpus): the
// original 10a sample lived only in an ephemeral lane /tmp/home and is gone,
// so its numbers can no longer be re-measured.
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { urlToFile } from './crawl.mjs';

export const FLOOR = 0.80, MEAN = 0.90;
const LEAKS = [/Skip to main content/i, /Send feedback/i, /Was this helpful/i,
  /Content and code samples on this page are subject/i, /cookies? (to|on) /i, /chevron_right/];
// Code counts as content: Jina emits code blocks unfenced, ours are fenced,
// so stripping fences made our own code read as "missing" (run 2: 0.891).
export const words = (s) => (s.replace(/<!--.*?-->/gs, '')
  .replace(/\]\([^)]*\)/g, ']').toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) || []);

// The Jina reference carries its own envelope (Title:/URL Source:/Markdown
// Content:), the page TOC and the feedback widget. Score only the article
// body: its H1 up to the feedback widget, minus next-page nav lines.
// The widget is introduced by "Was this helpful?" or, on some pages, only by
// its JSON line. A JSON-widget line counts as the end ONLY when no body
// heading follows it — one appearing mid-body must not truncate the scored
// reference (that inflated recall).
const WIDGET_JSON = /easyToUnderstand|Need to tell us more/;
export const refBody = (s) => {
  const lines = s.split('\n');
  const start = Math.max(lines.findIndex((l) => /^# \S/.test(l)), 0);
  let lastHeading = start;
  lines.forEach((l, i) => { if (i > start && /^#{1,6} \S/.test(l)) lastHeading = i; });
  let end = lines.findIndex((l, i) => i > start && /^Was this helpful\?/.test(l.trim()));
  if (end < 0) end = lines.findIndex((l, i) => i > lastHeading && WIDGET_JSON.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start, end).filter((l) => !/arrow_forward|arrow_back/.test(l) && !WIDGET_JSON.test(l)).join('\n');
};

export const recallOf = (md, ref) => {
  const ours = new Set(words(md));
  const theirs = [...new Set(words(refBody(ref)))];
  return { r: theirs.filter((w) => ours.has(w)).length / Math.max(theirs.length, 1),
    missing: theirs.filter((w) => !ours.has(w)) };
};

// recalls: number[] -> { mean, min, pass }. Empty = not gated (no refdir).
export const recallGate = (recalls) => {
  if (!recalls.length) return { mean: NaN, min: NaN, pass: false };
  const mean = recalls.reduce((a, b) => a + b, 0) / recalls.length, min = Math.min(...recalls);
  return { mean, min, pass: mean >= MEAN && min >= FLOOR };
};

export function run(outDir, refDir) {
  const rows = readFileSync(join(outDir, 'MANIFEST.tsv'), 'utf8').trim().split('\n')
    .map((l) => l.split('\t')).filter((r) => r[1] === 'ok');
  let h1 = 0, leaks = 0, fences = 0, tables = 0;
  const recalls = [], lowRecall = [];
  for (const [url] of rows) {
    const md = readFileSync(join(outDir, urlToFile(url)), 'utf8');
    if (/^# \S/m.test(md.split('\n').slice(0, 4).join('\n'))) h1++;
    const leak = LEAKS.find((re) => re.test(md));
    if (leak) { leaks++; console.log(`  leak ${leak} in ${url}`); }
    if (md.includes('```')) fences++;
    if (/^\|.*\|$/m.test(md)) tables++;
    const refPath = refDir && join(refDir, urlToFile(url));
    if (refPath && existsSync(refPath)) {
      const { r, missing } = recallOf(md, readFileSync(refPath, 'utf8'));
      recalls.push(r);
      if (r < MEAN) lowRecall.push(`${r.toFixed(2)} ${url}\n      missing: ${missing.slice(0, 25).join(' ')}`);
    }
  }
  const n = rows.length, g = recallGate(recalls);
  const checks = [
    [`H1 title ${h1}/${n}`, h1 === n],
    [`chrome leaks ${leaks}`, leaks === 0],
    [`pages with code fences ${fences}`, fences > 0],
    [`pages with GFM tables ${tables}`, tables > 0],
  ];
  if (refDir) {
    checks.push([`mean body word recall vs ref ${g.mean.toFixed(3)} >= ${MEAN} (n=${recalls.length})`, recalls.length > 0 && g.mean >= MEAN]);
    checks.push([`min page recall ${g.min.toFixed(3)} >= ${FLOOR}`, recalls.length > 0 && g.min >= FLOOR]);
  }
  console.log('── Pass Criteria ──');
  for (const [k, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${k}`);
  if (lowRecall.length) console.log('  low-recall pages:\n    ' + lowRecall.join('\n    '));
  const all = checks.every(([, ok]) => ok);
  console.log(all ? '✅ POC 10a: PASS' : '❌ POC 10a: FAIL');
  return all;
}

const isMain = () => { try { return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (process.argv[1] && isMain()) {
  const [outDir, refDir] = process.argv.slice(2);
  if (!outDir) { console.error('usage: check-quality.mjs <outdir> [<refdir>]'); process.exit(2); }
  process.exit(run(outDir, refDir) ? 0 : 1);
}
