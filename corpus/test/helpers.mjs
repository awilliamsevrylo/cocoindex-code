// Shared test helpers. CORPUS_DIR selects the code under test (default: this
// repo's corpus/), so the same tests can be run against an older revision:
//   CORPUS_DIR=/tmp/old/corpus node --test corpus/test/*.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const CORPUS = resolve(process.env.CORPUS_DIR || join(HERE, '..'));
export const FIXTURES = join(HERE, 'fixtures');

export const tmp = (p = 'corpus-test-') => mkdtempSync(join(tmpdir(), p));

export function write(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

// A bin dir holding a copy of a fixture script under `name`, for PATH stubbing.
export function stubBin(dir, name, fixture) {
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(FIXTURES, fixture), join(dir, name));
  chmodSync(join(dir, name), 0o755);
  return dir;
}

export function sh(cmd, args, { env = {}, cwd } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000 });
  return { rc: r.status, out: `${r.stdout}${r.stderr}` };
}
