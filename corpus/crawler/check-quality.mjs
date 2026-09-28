#!/usr/bin/env node
// POC 10a quality gate. Scores crawler MD against the POC 10a criteria:
// title H1, zero chrome leaks, code fences, tables, and (when a reference MD
// directory is given, e.g. the Jina crawl) body word recall.
// Usage: node check-quality.mjs <outdir> [<refdir>]   exit 0 = all pass
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [outDir, refDir] = process.argv.slice(2);
const LEAKS = [/Skip to main content/i, /Send feedback/i, /Was this helpful/i,
  /Content and code samples on this page are subject/i, /cookies? (to|on) /i, /chevron_right/];
const rows = readFileSync(join(outDir, 'MANIFEST.tsv'), 'utf8').trim().split('\n')
  .map((l) => l.split('\t')).filter((r) => r[1] === 'ok');
const urlToFile = (u) => (new URL(u).pathname.replace(/^\//, '').replace(/\/$/, '') || 'index')
  .split('/').map((s) => s.replace(/[^a-zA-Z0-9._-]/g, '_')).join('/') + '.md';
// Code counts as content: Jina emits code blocks unfenced, ours are fenced,
// so stripping fences made our own code read as "missing" (run 2: 0.891).
const words = (s) => (s.replace(/<!--.*?-->/gs, '')
  .replace(/\]\([^)]*\)/g, ']').toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) || []);

// The Jina reference carries its own envelope (Title:/URL Source:/Markdown
// Content:), the page TOC and the feedback widget. First 10a run: every word
// "missing" from ours on the two worst pages was that chrome, not body text.
// Score only the reference's article body: its H1 up to "Was this helpful?",
// minus the next-page nav line.
const refBody = (s) => {
  const lines = s.split('\n');
  const start = lines.findIndex((l) => /^# \S/.test(l));
  // The widget is not always introduced by "Was this helpful?" (run 2: agde,
  // reference pages) — its JSON line is the reliable end marker.
  let end = lines.findIndex((l, i) => i > start
    && (/^Was this helpful\?/.test(l.trim()) || /easyToUnderstand|Need to tell us more/.test(l)));
  if (end < 0) end = lines.length;
  return lines.slice(Math.max(start, 0), end).filter((l) => !/arrow_forward|arrow_back/.test(l)).join('\n');
};

let h1 = 0, leaks = 0, fences = 0, tables = 0, recallSum = 0, recallN = 0;
const lowRecall = [];
for (const [url] of rows) {
  const md = readFileSync(join(outDir, urlToFile(url)), 'utf8');
  if (/^# \S/m.test(md.split('\n').slice(0, 4).join('\n'))) h1++;
  const leak = LEAKS.find((re) => re.test(md));
  if (leak) { leaks++; console.log(`  leak ${leak} in ${url}`); }
  if (md.includes('```')) fences++;
  if (/^\|.*\|$/m.test(md)) tables++;
  const refPath = refDir && join(refDir, urlToFile(url));
  const ref = refPath && existsSync(refPath) ? readFileSync(refPath, 'utf8') : null;
  if (ref) {
    const ours = new Set(words(md));
    const theirs = [...new Set(words(refBody(ref)))];
    const r = theirs.filter((w) => ours.has(w)).length / Math.max(theirs.length, 1);
    recallSum += r; recallN++;
    if (r < 0.9) lowRecall.push(`${r.toFixed(2)} ${url}\n      missing: ${theirs.filter((w) => !ours.has(w)).slice(0, 25).join(' ')}`);
  }
}
const n = rows.length, recall = recallN ? recallSum / recallN : NaN;
const checks = [
  [`H1 title ${h1}/${n}`, h1 === n],
  [`chrome leaks ${leaks}`, leaks === 0],
  [`pages with code fences ${fences}`, fences > 0],
  [`pages with GFM tables ${tables}`, tables > 0],
  [`mean body word recall vs ref ${recall.toFixed(3)} (n=${recallN})`, !refDir || recall >= 0.9],
];
console.log('── Pass Criteria ──');
for (const [k, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${k}`);
if (lowRecall.length) console.log('  low-recall pages:\n    ' + lowRecall.join('\n    '));
const all = checks.every(([, ok]) => ok);
console.log(all ? '✅ POC 10a: PASS' : '❌ POC 10a: FAIL');
process.exit(all ? 0 : 1);
