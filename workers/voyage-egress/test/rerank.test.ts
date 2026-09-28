// Path allowlist for the slot DO's forward(): exactly /v1/embeddings and
// /v1/rerank, default /v1/embeddings. A disallowed path must be rejected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_UPSTREAM_PATHS, resolveUpstreamPath } from '../src/rerank.ts';

test('allowlist is exactly the two paths', () => {
  assert.deepEqual([...ALLOWED_UPSTREAM_PATHS], ['/v1/embeddings', '/v1/rerank']);
});

test('default path is /v1/embeddings (embeddings unchanged)', () => {
  assert.equal(resolveUpstreamPath(undefined), '/v1/embeddings');
  assert.equal(resolveUpstreamPath('/v1/embeddings'), '/v1/embeddings');
});

test('rerank path is allowed', () => {
  assert.equal(resolveUpstreamPath('/v1/rerank'), '/v1/rerank');
});

test('a disallowed path is rejected', () => {
  for (const bad of [
    '/v1/anything',
    '/v1/embeddings/extra',
    '/v1/rerank/extra',
    '/admin',
    '',
    '/v1/embeddings/../secret',
    'https://evil.example/v1/embeddings',
  ]) {
    assert.equal(resolveUpstreamPath(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});
