// regen.sh completeness gate: source-list baselines are independent of the
// generated corpus, and a missing Android URL list is named explicitly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CORPUS, tmp, write, sh } from './helpers.mjs';

function gate({ urls, baseline = 10, md = 0 }) {
  const t = tmp('regen-gate-');
  const dest = join(t, 'dest');
  const items = join(t, 'aosp-items.txt');
  write(items, 'repo-a\nrepo-b\n');
  if (urls !== null) write(join(t, 'urls.txt'), urls);
  for (let i = 0; i < md; i++) write(join(dest, `android-docs/p${i}.md`), '# page\n');
  const r = sh('bash', [join(CORPUS, 'regen.sh'), '--from', 'gate', '--to', 'gate'], {
    env: { CORPUS_DEST: dest, CCC_BIN: '/usr/bin/false', GATE_MIN_PCT: '98',
      ANDROID_URLS_FILE: join(t, 'urls.txt'), AOSP_ITEMS_FILE: items,
      ANDROID_URL_BASELINE: String(baseline) },
  });
  return r;
}

test('gate cannot report over 100% when a generated URL list is truncated', () => {
  const r = gate({ urls: 'https://x/1\nhttps://x/2\n', baseline: 10, md: 5 });
  assert.notEqual(r.rc, 0, r.out);
  assert.match(r.out, /android URL list vs baseline: 2\/10 = 20%/);
  assert.match(r.out, /android md on disk vs expected URLs: 5\/10 = 50%/);
  assert.doesNotMatch(r.out, /250%/);
});

test('gate names a missing Android URL list', () => {
  const r = gate({ urls: null });
  assert.notEqual(r.rc, 0, r.out);
  assert.match(r.out, /FAIL android URL list missing:/);
});
