// assemble.sh: a failed listing/copy must never replace the merged manifest,
// must exit non-zero, and --dry-run must not create directories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS, tmp, write, stubBin, sh } from './helpers.mjs';

const GOOD = 'kind\tlane\trow\nandroid-docs\tl0\thttps://x\tok\n';

function runAssemble(mode, { seed = GOOD, args = [], rows = 1, dest } = {}) {
  const t = tmp('assemble-');
  const bin = stubBin(join(t, 'bin'), 'rclone', 'rclone-stub.sh');
  write(join(t, 'conf'), 'x\n');
  dest = dest ?? join(t, 'dest');
  if (seed !== null) write(join(dest, 'MANIFEST.tsv'), seed);
  const r = sh('bash', [join(CORPUS, 'assemble.sh'), ...args], {
    env: { PATH: `${bin}:${process.env.PATH}`, RCLONE_CONF: join(t, 'conf'), CORPUS_DEST: dest,
      STUB_MODE: mode, STUB_ROWS: String(rows) },
  });
  const man = existsSync(join(dest, 'MANIFEST.tsv')) ? readFileSync(join(dest, 'MANIFEST.tsv'), 'utf8') : null;
  return { ...r, man, dest };
}

test('failed rclone lsf: exit non-zero and keep the previous MANIFEST.tsv', () => {
  const r = runAssemble('lsf-fail');
  assert.notEqual(r.rc, 0, r.out);
  assert.equal(r.man, GOOD);
});

test('failed rclone copy: exit non-zero and keep the previous MANIFEST.tsv', () => {
  const r = runAssemble('copy-fail');
  assert.notEqual(r.rc, 0, r.out);
  assert.equal(r.man, GOOD);
});

test('shrinking manifest is refused unless --allow-shrink', () => {
  const big = 'kind\tlane\trow\n' + Array.from({ length: 5 }, (_, i) => `aosp-docs\tl\tr${i}\n`).join('');
  const r = runAssemble('ok', { seed: big });
  assert.notEqual(r.rc, 0, r.out);
  assert.equal(r.man, big);
  const ok = runAssemble('ok', { seed: big, args: ['--allow-shrink'] });
  assert.equal(ok.rc, 0, ok.out);
  assert.equal(ok.man.trim().split('\n').length, 3); // header + one row per kind
});

test('successful run writes the merged manifest and exits 0', () => {
  const r = runAssemble('ok', { rows: 3 });
  assert.equal(r.rc, 0, r.out);
  assert.equal(r.man.trim().split('\n').length, 7); // header + 3 rows x 2 kinds
});

test('--dry-run creates no directories', () => {
  const dest = join(tmp('assemble-dry-'), 'never-created');
  const r = runAssemble('ok', { seed: null, args: ['--dry-run'], dest });
  assert.equal(r.rc, 0, r.out);
  assert.equal(existsSync(dest), false, 'dry-run created CORPUS_DEST');
});
