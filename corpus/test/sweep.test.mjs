// sweep.sh: a network error is a retried FAIL, never SKIP_DEAD; a genuinely
// empty remote is SKIP_DEAD; a good repo is harvested (tmp then mv).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS, tmp, write, sh } from './helpers.mjs';

const git = (cwd, ...a) => sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd });

function sweep(base, items, extraEnv = {}) {
  const t = tmp('sweep-');
  write(join(t, 'items.txt'), items.join('\n') + '\n');
  const out = join(t, 'out');
  const r = sh('bash', [join(CORPUS, 'aosp/sweep.sh')], {
    env: { ITEMS_FILE: join(t, 'items.txt'), OUT_DIR: out, WORK_DIR: join(t, 'work'), AOSP_BASE_URL: base,
      NET_RETRIES: '1', DEAD_RECHECK_SEC: '0', CLONE_RETRIES: '1', ...extraEnv },
  });
  const man = existsSync(join(out, 'MANIFEST.tsv')) ? readFileSync(join(out, 'MANIFEST.tsv'), 'utf8') : '';
  return { ...r, out, rows: man.trim().split('\n').filter(Boolean).map((l) => l.split('\t')) };
}

test('unreachable remote (network error) is a FAIL, never SKIP_DEAD', () => {
  const r = sweep('http://127.0.0.1:9', ['livelooking@main']);
  assert.equal(r.rows.length, 1, r.out);
  assert.equal(r.rows[0][1], 'FAIL', `recorded ${r.rows[0].join(' ')} — a network error must be retried`);
  assert.notEqual(r.rows[0][2], 'SKIP_DEAD');
  assert.notEqual(r.rc, 0);
});

test('unsafe repo names are BAD_NAME before any path mutation', () => {
  const t = tmp('sweep-escape-');
  const marker = join(t, 'marker');
  write(marker, 'must survive\n');
  const r = sweep(`file://${t}`, ['../../marker@main'], { WORK_DIR: join(t, 'work') });
  assert.equal(r.rows.length, 1, r.out);
  assert.deepEqual(r.rows[0].slice(1, 3), ['FAIL', 'BAD_NAME'], r.out);
  assert.ok(existsSync(marker), 'unsafe item escaped the sweep work/output roots');
  assert.notEqual(r.rc, 0);
});

test('reachable remote with no refs is SKIP_DEAD (ok)', () => {
  const t = tmp('sweep-remote-');
  git(t, 'init', '-q', '--bare', 'empty.git');
  const r = sweep(`file://${t}`, ['empty@main']);
  assert.equal(r.rows.length, 1, r.out);
  assert.deepEqual(r.rows[0].slice(1, 3), ['ok', 'SKIP_DEAD'], r.out);
});

test('a repo with docs is harvested completely and replaces old output', () => {
  const t = tmp('sweep-remote-');
  const src = join(t, 'src');
  write(join(src, 'README.md'), '# readme\n');
  write(join(src, 'docs/guide.md'), '# guide\n');
  write(join(src, 'code.c'), 'int x;\n');
  git(src, 'init', '-q', '-b', 'main'); git(src, 'add', '.'); git(src, 'commit', '-qm', 'x');
  git(t, 'clone', '-q', '--bare', 'src', 'good.git');
  const r = sweep(`file://${t}`, ['good@main']);
  assert.equal(r.rows.at(-1)[2], 'OK', r.out);
  assert.equal(r.rows.at(-1)[4], '2', r.out);
  assert.ok(existsSync(join(r.out, 'good/docs/guide.md')));
  assert.ok(!existsSync(join(r.out, 'good/code.c')));
});
