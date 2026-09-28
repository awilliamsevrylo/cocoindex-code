// Mock OpenAI-compatible /v1/embeddings for cccrust witnesses.
// Deterministic vectors (hash of text), holds each request HOLD_MS, and
// records concurrency + totals. GET /stats -> {peak, requests, inputs, ...}.
// Usage: node mock-embeddings.mjs <portfile> [dims=16] [holdMs=30]
// Fault modes via env (all off by default):
//   FAULT_429_EVERY=N     every Nth request -> 429, Retry-After: 0.2
//   FAULT_MAX_INPUTS=N    > N inputs -> 400 "Request has too many tokens"
//   FAULT_SLOW_EVERY=N    every Nth request stalls FAULT_SLOW_MS (10000)
//   FAULT_STATUS=S        every request -> status S (e.g. 401)
//   EXPECT_BEARER=T       count requests whose bearer != T (stats.bad_auth)
import http from 'node:http';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const [portFile, dimsArg = '16', holdArg = '30'] = process.argv.slice(2);
const DIMS = Number(dimsArg);
const HOLD_MS = Number(holdArg);
const env = (k) => Number(process.env[k] || 0);
const F429 = env('FAULT_429_EVERY'), FMAX = env('FAULT_MAX_INPUTS');
const FSLOW = env('FAULT_SLOW_EVERY'), FSLOW_MS = env('FAULT_SLOW_MS') || 10_000;
const FSTATUS = env('FAULT_STATUS');
let now = 0, peak = 0, requests = 0, inputs = 0, n429 = 0, n400 = 0, nslow = 0, nstatus = 0, maxAccepted = 0;

function vec(text) {
  const h = createHash('sha256').update(text).digest();
  return Array.from({ length: DIMS }, (_, i) => (h[i % h.length] - 128) / 128);
}
const send = (res, status, obj, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(obj));
};

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/stats') {
    return send(res, 200, { peak, requests, inputs, now, n429, n400, nslow, nstatus, maxAccepted });
  }
  if (req.method === 'POST' && req.url === '/reset') {
    peak = now; requests = 0; inputs = 0; n429 = 0; n400 = 0; nslow = 0; nstatus = 0; maxAccepted = 0;
    return send(res, 200, {});
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    requests += 1;
    let input;
    try { input = JSON.parse(body).input; } catch { input = null; }
    const list = typeof input === 'string' ? [input] : input;
    if (!Array.isArray(list)) return send(res, 400, { error: 'bad input' });
    if (FSTATUS) { nstatus += 1; return send(res, FSTATUS, { error: 'unauthorized (mock)' }); }
    if (F429 && requests % F429 === 0) { n429 += 1; return send(res, 429, { error: 'rate limited' }, { 'retry-after': '0.2' }); }
    if (FMAX && list.length > FMAX) { n400 += 1; return send(res, 400, { error: `Request has too many tokens (${list.length} inputs)` }); }
    const stall = FSLOW && requests % FSLOW === 0;
    if (stall) nslow += 1;
    now += 1; peak = Math.max(peak, now);
    setTimeout(() => {
      now -= 1;
      if (res.destroyed) return; // client timed out and hung up
      inputs += list.length;
      maxAccepted = Math.max(maxAccepted, list.length);
      send(res, 200, { data: list.map((t, index) => ({ index, embedding: vec(t) })) });
    }, stall ? FSLOW_MS : HOLD_MS);
  });
});

server.listen(0, '127.0.0.1', () => writeFileSync(portFile, String(server.address().port)));
setTimeout(() => process.exit(0), 30 * 60 * 1000).unref();
