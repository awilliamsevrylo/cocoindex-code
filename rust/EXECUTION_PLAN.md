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
| 2 | 13 named DOs = 13 distinct sticky IPs; collision fails closed | PASS | run 1 caught 00/04/05 collision; placement re-homed 04,05 → 4/4, 65 calls 0 err |
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

## POC 2 — pass criteria (written before code)

New route `GET /egress?slot=NN` (bearer): the slot DO `connect()`s
checkip.amazonaws.com and returns its IP. Zero Voyage spend.

1. **Sticky:** 12 slots x 5 rounds, interleaved (round-robin across slots
   each round, so time/ordering cannot explain the result). Every slot
   reports exactly 1 distinct IP across its 5 calls.
2. **Distinct:** the 12 slots report 12 different IPs.
3. **Positive control (instrument has teeth):** 5 calls to 5 fresh,
   never-used DO names (`probe-<random>`) must report >1 distinct IP. If
   fresh names all share one IP, the instrument cannot tell distinct from
   shared and criteria 1–2 prove nothing.
4. **Fail closed on collision:** if two slots share an IP, the witness
   prints the colliding slot ids and exits non-zero. (Runtime refusal of a
   collided slot's key is POC 3's router job; POC 2 proves detection.)

Collision fallback, if criterion 2 fails: re-home the colliding slot to a
new DO name (`voyage-key-NN-bK`) and re-measure. The name-to-key mapping
then lives in a small persisted table, not the name format.

### POC 2 — result (2026-09-28): PASS after the planned fallback

Run 1 (12 slots, base names): control PASS (4/5 distinct), sticky PASS,
**distinct FAIL — 10/12**, slots 00, 04, 05 all on 104.28.166.239. The
instrument caught a real collision, so the fallback ran as written:

- `src/placement.ts` `assignDistinct()` — earlier slots keep priority, a
  colliding slot walks `-b1`, `-b2`…; a slot with no free IP is reported
  **unresolved, never shared**. Pinned in the reserved `voyage-placement`
  instance of the same DO class (still one class per script).
- Unit tests 4/4 (10/10 with parser). Mutation: drop `!taken.has(ip)` →
  3 tests die ("collision re-homes…", "every placed IP is unique",
  "…unresolved, never shared") → TEETH OK.
- Key 13 added 2026-09-28 (Andrew: large voyage-4 quota), backup
  `~/.drew/voyage.keys.bak-20260928-052706`; secret now 13 keys.

`POST /place` → 13 slots, unresolved `[]`; 04 → `-b1` 104.28.165.17,
05 → `-b1` 104.28.160.66. Re-witness `SLOTS=13 PINNED=1
test/poc2-egress.sh` → **4/4 PASS**: control 5/5 distinct, 65 calls 0
errors, sticky 13/13, **distinct 13/13**.

Caveat carried forward (POC 3): the pool is small (all 104.28.x) and the
fresh control DOs landed on IPs key slots also hold. IPs are not reserved
and a DO can relocate after eviction, so the router must re-check a slot's
egress IP periodically and refuse a slot whose IP now collides — placement
is a snapshot, not a guarantee.
