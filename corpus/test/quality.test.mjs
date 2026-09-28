// check-quality.mjs: one 0.2-recall page inside a >0.9 mean must fail the
// gate (per-page floor), and a mid-body widget JSON line must not truncate
// the scored reference. Driven through the CLI so it runs against any revision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CORPUS, tmp, write, sh } from './helpers.mjs';

const W = (p, n) => Array.from({ length: n }, (_, i) => `${p}word${String.fromCharCode(97 + (i % 26))}${Math.floor(i / 26)}`);
const ours = (title, body) => `<!-- source: x -->\n\n# ${title}\n\n${body}\n\n\`\`\`kotlin\nval a = 1\n\`\`\`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n`;
const ref = (title, body) => `Title: ${title}\n\nMarkdown Content:\n# ${title}\n\n${body}\n\nWas this helpful?\n`;

function sample(pages) {
  const t = tmp('quality-');
  const out = join(t, 'out'), refd = join(t, 'ref');
  const rows = [];
  for (const [name, oursBody, refBody] of pages) {
    const url = `https://developer.android.com/guide/${name}`;
    rows.push(`${url}\tok\t200\tdevsite\t100`);
    write(join(out, `guide/${name}.md`), ours(name, oursBody));
    write(join(refd, `guide/${name}.md`), refBody);
  }
  write(join(out, 'MANIFEST.tsv'), rows.join('\n') + '\n');
  return sh('node', [join(CORPUS, 'crawler/check-quality.mjs'), out, refd]);
}

test('floor: one 0.2-recall page inside a 0.95 mean fails', () => {
  const body = W('p', 50).join(' ');
  const pages = Array.from({ length: 15 }, (_, i) => [`good${i}`, body, ref(`good${i}`, body)]);
  // 20% of the reference words present -> recall ~0.2
  const refWords = W('q', 50);
  pages.push(['bad', refWords.slice(0, 10).join(' '), ref('bad', refWords.join(' '))]);
  const r = sample(pages);
  assert.match(r.out, /mean body word recall vs ref 0\.9[5-9]/, r.out);
  assert.notEqual(r.rc, 0, `gate passed with a 0.2 page hidden in the mean:\n${r.out}`);
});

test('mid-body widget JSON line does not truncate the scored reference', () => {
  const head = W('h', 20), tail = W('t', 20);
  // The crawled page has only the head section; the reference has the tail
  // after a stray JSON line and a later heading -> recall must reflect it.
  const refText = `Title: x\n\nMarkdown Content:\n# page\n\n${head.join(' ')}\n\n`
    + '{"easyToUnderstand": 1}\n\n## Later section\n\n' + `${tail.join(' ')}\n\nWas this helpful?\n`;
  const r = sample([['page', `${head.join(' ')} page`, refText]]);
  assert.notEqual(r.rc, 0, `tail after a mid-body JSON line was never scored:\n${r.out}`);
  assert.match(r.out, /mean body word recall vs ref 0\.[0-7]/, r.out);
});

test('a clean sample passes', () => {
  const body = W('p', 40).join(' ');
  const r = sample([['a', body, ref('a', body)], ['b', body, ref('b', body)]]);
  assert.equal(r.rc, 0, r.out);
});
