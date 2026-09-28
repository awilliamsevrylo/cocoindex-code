# rust-parallel-proxy — execution plan (GOAL)

Goal: parallel remote embedding for the Rust `ccc` — one Voyage key per
distinct egress IP — then index the Android docs corpus.
Tracker: task manager req-100 (task-614..623). One POC proves one thing;
pass criteria are written here BEFORE the code.

Engine: sibling checkout `~/PROJECTS/cocoindex` (Cargo path dep
`../../cocoindex/rust/sdk/cocoindex`). No `v1` branch exists upstream.

## PIVOT NOTE (2026-09-28) — key pool moves into a Cloudflare Worker

Andrew: "do all the voyage stuff outside the actual tool … on a cf worker
proxied". The per-IP rule is now met Cloudflare-side instead of with LAN
SOCKS leases:

- Measured 2026-09-15 (gcloud-ssh-mcp, session 6d3d4f3d §5.4): a Durable
  Object's `connect()` TCP egress is **distinct per DO instance and sticky
  per name** (interleaved A/B: same name 1/5 distinct, unique names 5/5).
  `fetch()` egress is ONE shared IP for every DO — never use it for Voyage.
  Instrument: `connect()` to `checkip.amazonaws.com:80` (non-Cloudflare;
  ipify/ifconfig.me are Cloudflare-fronted and lie). Distinct is
  best-effort, not unique — one collision in 24 calls seen then.
- `api.voyageai.com` = 136.110.181.169, `via: 1.1 google` — not a Cloudflare
  IP, so `connect()` is permitted (Workers block sockets to CF ranges only).
- Rust `ccc` becomes a thin client: engine `ApiEmbedder` with `base_url` =
  the Worker. SOCKS, key pool and lease client leave the Rust scope.

Worker source: `workers/voyage-egress/` on this branch.

| POC | Proves | Status | Evidence |
|---|---|---|---|
| 0 | port builds + e2e passes on a pinned engine | PASS | engine `3b617ff`; e2e_cli 46/0, e2e_advanced 21/0, cargo test 4/4 |
| 1 | DO `connect()`+TLS returns a real Voyage vector; egress witnessed | PASS | 7/7 live; dims 1024; egress 104.28.166.239; parser 6/6 + mutation teeth |
| 2 | 12 named DOs = 12 distinct sticky IPs; collision fails closed | — | |
| 3 | `/v1/embeddings` router: token budget, per-slot 429 cooldown | — | |
| 4 | Rust `ccc` indexes + searches through the Worker | — | |
| 5 | client in-flight requests bounded | — | |
| 6 | re-run never re-embeds finished chunks | — | |
| 7 | fault suite (429, oversize, slow) has teeth | — | |
| 8 | measured throughput picks slot count | — | |
| 9 | Android docs corpus fully indexed | — | |

## POC 0 — result (2026-09-28): PASS, first pin

- Engine `3b617ff5600810a889efe1253ff90f059bfb5b45` (main, 2026-06-22).
- `cargo build`: 434 crates, 59.7 s, exit 0; debug binary 133,374,504 B.
- `e2e_cli.sh` 46/0 (real search + auto-index hits); `e2e_advanced.sh` 21/0;
  `cargo test` 4/4.
- Reuse at the pin: engine `pub trait Embedder`, `ops/api.rs` `ApiEmbedder`
  (feature `embed_api`, `with_base_url`/`with_api_key`), and
  `resources/rate_limit.rs` (governor token bucket).

## POC 1 — pass criteria (written before code)

A Worker + one Durable Object (`VoyageSlot`), PERSONAL account.
`GET /probe?slot=00` with the Worker bearer makes DO `voyage-key-00`:

1. `connect()` to `checkip.amazonaws.com:80`, plain HTTP/1.1 GET, and
   return the body IP as `egress_ip`.
2. `connect({hostname:"api.voyageai.com",port:443},{secureTransport:"on"})`,
   write a hand-built HTTP/1.1 `POST /v1/embeddings` (Content-Length,
   `Connection: close`), read to EOF, parse status + headers + body
   (chunked or Content-Length).
3. Response JSON has `status: 200`, `dims: 1024`, a numeric
   `usage_tokens`, and `egress_ip` matching an IPv4/IPv6 literal.
4. The key comes from a Worker secret; it never appears in any response,
   log line, or file in the repo (grep for the `pa-` prefix = 0 hits).
5. Negative control: without the bearer, `/probe` returns 401.

Failure plan: if TLS over `connect()` to Voyage is refused, record the exact
error and split POC 1 (plain connect → TLS handshake → HTTP parse) before
anything else.

### POC 1 — result (2026-09-28): PASS, first attempt

Deployed to PERSONAL (`fe60f980`): `voyage-slot` (DO host, version
47d6ad31) and `voyage-egress` (router, version b351a06c,
https://voyage-egress.andrwill1995.workers.dev). One DO class per script;
the router binds it via `script_name`.

`test/poc1-probe.sh` → 7/7 PASS:
- healthz 200 on first try; unauthenticated `/probe` → **401**
- slot `voyage-key-00`: Voyage **status 200, dims 1024, usage_tokens 2**
- egress (connect() to checkip.amazonaws.com) **104.28.166.239**
- response body contains no `pa-` token; repo grep for key literals = 0

Parser: `test/rawhttp.test.ts` 6/6; `test/mutate-parser.sh` drops all but
the first chunk → "chunked body is reassembled across chunks" dies → TEETH OK.

Traps hit and recorded:
- DO classes are now declared in a wrangler `exports` block
  (`{"type":"durable-object","storage":"sqlite"}`), not `migrations`.
- `npm install --silent` exited clean but installed nothing (ERESOLVE was
  hidden); re-ran without `--silent` to see it. Installed wrangler 4.142.0,
  workers-types 5.20260928.1, TypeScript 7.0.2.
- TypeScript 7 `tsc` prints "No errors found" and does not exit non-zero
  through a pipe; typecheck gated on the unpiped exit code.
- Node 24 `node --test` uses the spec reporter; count lines only appear
  with `--test-reporter=tap`.
