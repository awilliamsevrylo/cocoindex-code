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
- Rust `ccc` becomes a thin client with `base_url` = the Worker. SOCKS, key
  pool and lease client leave the Rust scope. (Revised in POC 4: ccc's own
  `RemoteEmbedder`, not the engine `ApiEmbedder`, which drops `input_type`.)

Worker source: `workers/voyage-egress/` on this branch.

| POC | Proves | Status | Evidence |
|---|---|---|---|
| 0 | port builds + e2e passes on a pinned engine | PASS | engine `3b617ff`; e2e_cli 46/0, e2e_advanced 21/0, cargo test 4/4 |
| 1 | DO `connect()`+TLS returns a real Voyage vector; egress witnessed | PASS | 7/7 live; dims 1024; egress 104.28.166.239; parser 6/6 + mutation teeth |
| 2 | 13 named DOs = 13 distinct sticky IPs; collision fails closed | PASS | run 1 caught 00/04/05 collision; placement re-homed 04,05 → 4/4, 65 calls 0 err |
| 3 | `/v1/embeddings` router: token budget, per-slot 429 cooldown | PASS | unit 6/6, 4/4 mutants killed; live 9/9 incl. retrieval sanity |
| 4 | Rust `ccc` indexes + searches through the Worker | PASS | unit 6/6, 4/4 mutants killed; live 7/7 (dims 1024, auth.py top hit); e2e 46/0 + 21/0 |
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

## POC 3 — pass criteria (written before code)

OpenAI-compatible `POST /v1/embeddings` on the router (bearer), body
`{model, input: string[] | string, input_type?}` → `{object:"list",
data:[{index, embedding}], model, usage:{total_tokens}}`.

Engine `ApiEmbedder.build_body` sends only `{model, input}` — no
`input_type`. So the router defaults `input_type: "document"`, and
`POST /v1/embeddings/query` forces `"query"`. A `voyage/` model prefix is
stripped before calling Voyage.

1. **Order:** output `data[i].index == i` and vectors match input order
   after the input is split across slots (unit: fake slots return tagged
   vectors; merged order asserted).
2. **Token budget:** no single Voyage call exceeds 120,000 estimated
   tokens or 1,000 inputs (unit: oversize input must split into ≥2 calls).
3. **429 re-route:** a slot answering 429 goes on cooldown (Retry-After,
   else backoff) and its batch is retried on another slot; the request
   still succeeds (unit: fake slot 0 always 429s).
4. **Fail closed:** if every slot is cooling down or collided, return 503
   `no_healthy_slot` — never a partial vector list.
5. **Live:** one real 3-input request through the deployed router →
   3 vectors, dims 1024, indices 0..2.

### POC 3 — result (2026-09-28): PASS

- `src/dispatch.ts` (pure core) + `src/embeddings.ts` (route). Batching
  estimates tokens at 3 chars/token (over-splits, never under) under
  120,000 tokens and 1,000 inputs per call.
- Unit `test/dispatch.test.ts` 6/6. `test/mutate-dispatch.sh`: 4 mutants
  (reverse merge order, 100x budget, disable re-route, drop cooldown) —
  **all killed**, survivors=0.
- Live `test/poc3-live.sh` **9/9**: 3 vectors, dims 1024, indices
  [0,1,2], total_tokens 8; `/v1/embeddings/query` with a bare model id →
  1024 dims; **retrieval sanity** — "how do I request a runtime
  permission" scores "Android runtime permissions" highest; unknown model
  surfaces Voyage's 400; no `pa-` in any response.
- First live run failed 7/9 with `not_found`: the new route was not yet
  being served right after deploy. Fix is in the instrument: gate on the
  route under test (empty body → handler's 400), not on `/healthz`.

## POC 4 — pass criteria (written before code)

`provider: litellm` (the Python config shape) now builds a remote embedder
in ccc: `POST {base}/embeddings` with `{model, input, ...params}`, so the
existing `indexing_params: {input_type: document}` / `query_params:
{input_type: query}` reach the Worker unchanged. Base URL from
`CCC_EMBED_BASE_URL` (default `https://api.voyageai.com/v1`), bearer from
`CCC_EMBED_API_KEY_FILE` / `CCC_EMBED_API_KEY` / `VOYAGE_API_KEY`. Engine
`ApiEmbedder` is not used: it cannot send `input_type`.

1. **Params reach the wire (unit, mock HTTP):** indexing call body carries
   `input_type:"document"`, query call carries `"query"`, `model` verbatim.
   Mutation: drop the params merge → that test dies.
2. **Index through the Worker:** `ccc index` on the sample fixture exits 0,
   chunks > 0; the vec0 table is declared `float[1024]`.
3. **Search through the Worker:** `ccc search "verify password"` top hit is
   `src/auth.py`.
4. **Fail loud:** a wrong bearer makes `ccc index` report the 401, never a
   silent 0-chunk success.
5. **No regression:** local `sentence-transformers` path — `e2e_cli.sh`
   still 46/0.

### POC 4 — result (2026-09-28): PASS, first attempt

- `src/remote_embedder.rs` (`provider: litellm`) + `CodeEmbedder` is now an
  enum over local fastembed | remote. The indexer embeds with the resolved
  `indexing_params` (it passed an empty map before, so `input_type` was
  never sent). The response is re-ordered by `index`, and a short response
  is an error — never a vector shifted onto the wrong chunk.
- Unit 6/6 (one-shot local HTTP mock reads the real wire body).
  `tests/mutate-remote-embedder.sh`: 4 mutants (drop params merge, ignore
  response index, drop length check, keep `voyage/` prefix) — **all
  killed**, survivors=0.
- Live `tests/poc4-worker.sh` **7/7** against the deployed Worker: wrong
  bearer → index surfaces the 401 (rc=1) without echoing the token; index
  rc=0, 5 chunks, vec0 DDL `float[1024]`; "verify password" → `src/auth.py`,
  "request handler dispatch" → `src/handlers.py`.
- No regression: `e2e_cli.sh` 46/0, `e2e_advanced.sh` 21/0 (local fastembed).
- `state_key` is `litellm:<model>`; the endpoint is excluded on purpose
  (Worker and direct Voyage are the same vectors). Model changes still
  re-embed; per-index model pinning is POC 4b.

Caveat carried forward (POC 3): the pool is small (all 104.28.x) and the
fresh control DOs landed on IPs key slots also hold. IPs are not reserved
and a DO can relocate after eviction, so the router must re-check a slot's
egress IP periodically and refuse a slot whose IP now collides — placement
is a snapshot, not a guarantee.
