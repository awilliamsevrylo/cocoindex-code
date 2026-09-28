// Mock OpenAI-compatible /v1/embeddings for cccrust witnesses.
// Deterministic vectors (hash of text), holds each request HOLD_MS, and
// records concurrency + totals. GET /stats -> {peak, requests, inputs}.
// Usage: node mock-embeddings.mjs <portfile> [dims=16] [holdMs=30]
import http from 'node:http';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const [portFile, dimsArg = '16', holdArg = '30'] = process.argv.slice(2);
const DIMS = Number(dimsArg);
const HOLD_MS = Number(holdArg);
let now = 0, peak = 0, requests = 0, inputs = 0;

function vec(text) {
  const h = createHash('sha256').update(text).digest();
  return Array.from({ length: DIMS }, (_, i) => (h[i % h.length] - 128) / 128);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/stats') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ peak, requests, inputs, now }));
  }
  if (req.method === 'POST' && req.url === '/reset') {
    peak = now; requests = 0; inputs = 0;
    return res.end('{}');
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    now += 1; peak = Math.max(peak, now); requests += 1;
    let input;
    try { input = JSON.parse(body).input; } catch { input = null; }
    const list = typeof input === 'string' ? [input] : input;
    if (!Array.isArray(list)) { now -= 1; res.statusCode = 400; return res.end('{"error":"bad input"}'); }
    inputs += list.length;
    setTimeout(() => {
      now -= 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: list.map((t, index) => ({ index, embedding: vec(t) })) }));
    }, HOLD_MS);
  });
});

server.listen(0, '127.0.0.1', () => writeFileSync(portFile, String(server.address().port)));
setTimeout(() => process.exit(0), 30 * 60 * 1000).unref();
