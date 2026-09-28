// Parser tests for the hand-rolled HTTP/1.1 layer. These run under plain Node
// (no workerd), so they import only the pure functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dechunk, parseResponse } from '../src/rawhttp-parse.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

test('content-length body is cut at the declared length', () => {
  const raw = enc.encode('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello-trailing-junk');
  const r = parseResponse(raw);
  assert.equal(r.status, 200);
  assert.equal(dec.decode(r.body), 'hello');
});

test('chunked body is reassembled across chunks', () => {
  const raw = enc.encode(
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{"a"\r\n3\r\n:1}\r\n0\r\n\r\n',
  );
  const r = parseResponse(raw);
  assert.deepEqual(JSON.parse(dec.decode(r.body)), { a: 1 });
});

test('headers are lower-cased and retry-after is readable', () => {
  const raw = enc.encode('HTTP/1.1 429 Too Many\r\nRetry-After: 7\r\nContent-Length: 0\r\n\r\n');
  const r = parseResponse(raw);
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '7');
});

test('chunk extensions after ";" are ignored', () => {
  assert.equal(dec.decode(dechunk(enc.encode('3;ext=1\r\nabc\r\n0\r\n\r\n'))), 'abc');
});

test('truncated chunked body throws instead of returning partial data', () => {
  assert.throws(() => dechunk(enc.encode('a\r\nshort\r\n')), /truncated/);
});

test('missing header terminator throws', () => {
  assert.throws(() => parseResponse(enc.encode('HTTP/1.1 200 OK\r\nX: y')), /no header terminator/);
});
