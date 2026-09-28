#!/usr/bin/env node
// Regenerate the AOSP repo list: every repo in the GitHub `aosp-mirror` org,
// one line per repo: name<TAB>sizeMB<TAB>default_branch<TAB>pushed<TAB>archived.
// Measured 2026-09-28: 100 repos, identical to the set the first sweep used.
// Also writes the fanout items file corpus/jobs/aosp-docs-items.txt.
// Usage: node repos.mjs [repos.tsv] [items.txt]
// Auth: $GITHUB_TOKEN if set, else `gh auth token`, else anonymous (60 req/h).
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), 'repos.tsv');
let token = process.env.GITHUB_TOKEN || '';
if (!token) { try { token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim(); } catch {} }
const headers = { accept: 'application/vnd.github+json', 'user-agent': 'aosp-docs-repos' };
if (token) headers.authorization = `Bearer ${token}`;

const rows = [];
for (let page = 1; ; page++) {
  const r = await fetch(`https://api.github.com/orgs/aosp-mirror/repos?per_page=100&type=all&page=${page}`, { headers });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const batch = await r.json();
  if (!batch.length) break;
  for (const x of batch) {
    rows.push([x.name, Math.floor(x.size / 1024), x.default_branch, (x.pushed_at || '').slice(0, 10), x.archived].join('\t'));
  }
}
rows.sort((a, b) => a.localeCompare(b));
writeFileSync(out, rows.join('\n') + '\n');
// The fanout items file: one `<repo>@<branch>` per line (fanout items may not
// contain tabs). Written next to the job spec that consumes it.
const items = rows.map((r) => { const [name, , branch] = r.split('\t'); return `${name}@${branch}`; });
const itemsOut = process.argv[3] || join(dirname(fileURLToPath(import.meta.url)), '..', 'jobs', 'aosp-docs-items.txt');
writeFileSync(itemsOut, items.join('\n') + '\n');
console.log(`repos: ${rows.length} -> ${out}\nitems: ${items.length} -> ${itemsOut}`);
