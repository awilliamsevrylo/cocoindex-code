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
| 4b | per-index model: two models, one daemon; mismatch refused | PASS | unit 8/8, 4/4 mutants killed; live 11/11 (384 + 1024 in one daemon) |
| 4c | renamed `cccrust`; own `~/.cccrust` + `.cccrust/`; never reads Python config | PASS | isolation 7/7 incl. poison control; e2e 46/0 + 21/0 |
| 5 | client in-flight bounded; Worker spreads load across slots | PASS | 1K files peak 8 (control 732); live 26 reqs → 13/13 slots, 2 each; 7/7 + 5/5 mutants |
| 6 | re-run never re-embeds finished chunks | PASS | reset re-run spend 0 (control 200); kill -9 resume 403/403 limit; 100 identical files → 2; 4/4 mutants |
| 7 | fault suite (429, oversize, slow, 401, leak) has teeth | PASS | e2e 8/8 incl. retries=0 control + leak positive control; 9/9 mutants |
| 8 | measured throughput picks slot count | PASS | cap 32 = 479 chunks/s, 13.1x 1-key direct; 3 product fixes (7e510af, d5159ef, 8ccfc94) |
| 9 | Android docs corpus fully indexed | 9a PASS · 9b after POC 10 | snapshot 22,104 files, 270,828 chunks, 676 s, 6/6 positives (voyage-4) |

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

## POC 4b — pass criteria (written before code)

Andrew: "dynamic model selection per … vector database". Each index pins
its own embedding model; one daemon serves projects on different models.

- Project `.cocoindex_code/settings.yml` may carry `embedding: {provider?,
  model, indexing_params?, query_params?}`; absent keys inherit global.
  Params default: global's when provider+model match global, else the
  curated table (`voyage/*` → document/query), else none.
- `ccc init --index-model M [--index-provider P]` writes that override
  (also on an already-initialized project). Global `--model` unchanged.
- Each index db records `model` (the embedder identity) and `dims` in a
  `ccc_index_meta` table; `ccc status` prints them.

1. **Two models, one daemon:** project A (global: local bge-small, 384)
   and project B (override: `voyage/voyage-4-large` via the Worker, 1024)
   both index and search in the same daemon; A's vec0 is `float[384]`,
   B's is `float[1024]`; each meta row names its own model.
2. **Refuse on mismatch:** B's override is changed to a model whose
   initial index fails (bad bearer) → search refuses with the recorded vs
   configured model and "run `ccc index`", never querying 1024-d vectors
   with a different model.
3. **Unit:** effective-settings merge (inherit / override / curated
   params) and meta check (match, mismatch, legacy no-meta = allowed).
   Mutation: drop the mismatch check → a test dies.
4. **No regression:** `e2e_cli.sh` 46/0, `e2e_advanced.sh` 21/0.

### POC 4b — result (2026-09-28): PASS

- `src/index_model.rs`: `effective_embedding` merge, `EmbedderCache` (one
  embedder per distinct settings, the global one seeded), `ccc_index_meta`
  write/read, `check_compatible`. Daemon resolves the embedder per project
  on every index/search, so a settings.yml edit applies without restart.
- `ccc init --index-model M [--index-provider P]` pins the override
  (`voyage/…` → provider litellm); `ccc status` prints `Index model: …`.
- Unit 8/8 (18/18 total). `tests/mutate-index-model.sh`: 4 mutants (drop
  mismatch check, ignore override, leak global params, refuse legacy) —
  **all killed**.
- Live `tests/poc4b-models.sh` **11/11**, one daemon (same pid): A
  `float[384]` bge-small, B `float[1024]` voyage-4-large via the Worker,
  each meta names its model; B re-pinned to voyage-code-4 → search refuses
  naming both models; A unaffected.
- Instrument fix, recorded: first run failed A's top-1 check — bge-small
  ranks `handlers.py` (imports `verify_password`) above `auth.py`. The
  pre-change binary ranks identically (measured), so A is checked top-2,
  as `e2e_cli.sh` does for the local model. Not a regression.
- No regression: e2e 46/0 + 21/0; POC 4 witness still 7/7.
- Debt flagged: `daemon.rs` (775) and `main.rs` (551) were already over
  the 300-line rule from the upstream port; +28 / +14 lines here.

## POC 4c — pass criteria (written before code)

Andrew: "change the top level command to cccrust not ccc and have it live
in its own top level config … not read from ~/.cocoindex_code".

- Binary `cccrust`. Global dir `~/.cccrust/` (`global_settings.yml`,
  daemon socket/pid/log); overrides `CCCRUST_DIR`, `CCCRUST_RUNTIME_DIR`.
  No `COCOINDEX_CODE_*` variable is read anywhere.
- Per-project dir `.cccrust/` (settings + dbs), so a repo indexed by both
  Python `ccc` and `cccrust` never shares `target_sqlite.db`. Added to
  default excludes and `.gitignore` handling.

1. **Isolation (negative control):** with `HOME` sandboxed, a poisoned
   `$HOME/.cocoindex_code/global_settings.yml` (invalid provider) plus
   `COCOINDEX_CODE_DIR` pointing at it → `cccrust init` + `index` +
   `search` succeed and write only under `$HOME/.cccrust` and
   `proj/.cccrust`; nothing is created in `.cocoindex_code`.
2. **Positive control:** the same poison placed in `$HOME/.cccrust`
   makes `cccrust` fail — proves the instrument can see a config read.
3. `grep -rn 'COCOINDEX_CODE\|\.cocoindex_code' rust/src` = 0 hits.
4. **No regression:** e2e 46/0 + 21/0 and POC 4 / 4b witnesses under the
   new names.

### POC 4c — result (2026-09-28): PASS

- `tests/poc4c-isolation.sh` **7/7** with a sandboxed HOME: poisoned
  `~/.cocoindex_code` + `COCOINDEX_CODE_DIR` ignored (init/index/search ok,
  `auth.py` hit); writes only `~/.cccrust` and `proj/.cccrust`; the Python
  dir is untouched. **Control:** the same poison in `~/.cccrust` →
  rc=1 `Unknown provider: "poisoned-provider-zz"`. Source grep = 0.
- Regression, under the new names: cargo test 18/18, e2e 46/0 + 21/0,
  POC 4 7/7, POC 4b 11/11, both mutation scripts survivors=0.
- Two test expectations were stale on the old name (`ccc init` hint,
  `ccc index` in the mismatch message) — fixed the tests, not the code.

## POC 5 — pass criteria (written before code)

`mount_each!` runs every file concurrently, and each file makes one embed
call, so a 50K-page corpus would open 50K simultaneous requests. The bound
belongs on the thing that costs: in-flight HTTP requests to the embedder.
A semaphore in `RemoteEmbedder`, size `CCC_EMBED_MAX_INFLIGHT` (default 16
≈ 13 slots + slack). The engine's `max_inflight_components` is not used: it
counts components, not requests, and a parent holding a permit while its
children wait is a deadlock shape.

1. **Unit (mock that counts concurrency):** 64 parallel `embed_batch`
   calls, cap 8, server holds each 40 ms → peak in-flight **== 8**
   (≤ proves the bound; == proves real concurrency, so a serial
   implementation cannot pass). Mutation: remove the permit → dies.
2. **End to end:** `cccrust index` over 1,000 generated files against a
   local mock `/v1/embeddings` (Node, records peak concurrency): cap 8 →
   peak ≤ 8 and every file indexed. **Control:** cap 1000 on the same run →
   peak > 8 — proves the instrument sees concurrency and the cap is what
   holds it down.
3. **No regression:** e2e 46/0 + 21/0, POC 4 7/7.

**Revision (before any Worker code):** a fork's read of `dispatch.ts:65`
found the round-robin pointer is created per request. cccrust sends one
request per file (≈ one batch), so every request starts at slot 00 — 16
concurrent client requests would all land on one key/IP. Verified by
reading the source. Added criteria for the Worker side:

4. **Spread (unit):** 13 concurrent single-batch requests through one
   shared dispatcher, each fake call held 20 ms → 13 **distinct** slots
   used, max in-flight per slot == 1. Mutation: per-request pointer →
   dies.
5. **Per-slot cap (unit):** 40 concurrent single-batch requests, 13 slots,
   cap 2 per slot → no slot ever above 2, all 40 complete (they queue,
   not fail). Mutation: drop the wait → dies.
6. **Live:** 26 concurrent requests to the deployed Worker →
   `voyage_egress.slot` values cover ≥ 10 distinct slots.

### POC 5 — result (2026-09-28): PASS

Client (`cccrust`):
- `RemoteEmbedder` holds a semaphore shared by every clone
  (`CCC_EMBED_MAX_INFLIGHT`, default 16), permit held until the body is
  read. Unit: 64 calls, cap 8 → peak **== 8**; control cap 1000 → peak
  > 8. Mutant "drop permit" killed (5/5 client mutants, survivors=0).
- `tests/poc5-bounded.sh` (local Node mock, zero spend) **4/4**: 1,000
  files, cap 8 → rc=0, 1,000/1,000 files, mock peak **8**, 6 s.
  Control, cap 100000 → peak **732**, so the instrument sees concurrency.

Worker (`voyage-egress`):
- `src/scheduler.ts` `SlotScheduler` at module scope: least-loaded healthy
  slot, ties rotate, ≤ 2 in flight per key, waiters queue instead of
  stacking; permit released in `finally`. Response gains
  `voyage_egress.slots`.
- Unit 19/19 (3 new). `test/mutate-dispatch.sh` 7/7 mutants killed,
  including "fresh scheduler per request" (the original bug),
  "no per-slot cap" and "leak permit on a throwing call".
- Deployed router `79407bcf`. Live `test/poc5-spread.sh` **3/3**: 26/26
  concurrent requests served by **13/13 distinct slots, 2 each**. Before
  this fix every single-batch request started at slot 00.
- Regression: POC 3 live 9/9, POC 4 7/7.

Instrument trap found and fixed: the Rust mutation scripts restored the
source with `mv`, which puts back an OLDER mtime, so cargo kept the
mutant's build — a clean `cargo test` then failed with peak 64. Both
scripts now `touch` after restoring.

## POC 6 — pass criteria (written before code)

The ledger is a content-addressed vector cache in `RemoteEmbedder`: key =
sha256(model, params, text) → f32 vector, in `~/.cccrust/embed_cache.db`
(SQLite, WAL), written as soon as each HTTP batch returns. Checked before
every call, so it covers crash-resume, `reset` + re-index, identical chunks
across files, and duplicates inside one batch. The engine's per-file memo
is unchanged. `CCC_EMBED_CACHE=off` disables it (the control).

Witness against the local mock, which counts inputs it receives (the
"spend"):

1. **Re-run pays zero:** index 200 unique files → mock inputs = 200 (+1
   dimension probe). `cccrust reset -f` (drops the project dbs AND the
   engine memo) and index again → **0** inputs; 200 files still indexed.
2. **Control:** same with `CCC_EMBED_CACHE=off` → the second run pays
   ≥ 200 again, so the counter can see spend.
3. **Crash mid-run:** 400 files, mock holds 60 ms, cap 2; `kill -9` the
   daemon partway; index again to completion → inputs over BOTH runs
   ≤ 400 + 1 + cap (only batches in flight at the kill are paid twice),
   and all 400 files indexed.
4. **Dedupe across files:** 100 files with identical content → inputs
   ≤ 2 (one text + the probe).
5. **Unit:** the key changes with model, params and text; a cache hit
   makes no HTTP call; duplicates in one batch are sent once. Mutation:
   drop the lookup → dies; drop params from the key → dies.

### POC 6 — result (2026-09-28): PASS after one revision

- `src/embed_cache.rs` (sha256 length-prefixed key → LE f32 blob, SQLite
  WAL at `~/.cccrust/embed_cache.db`), `src/cached_embed.rs` (lookup →
  claim → fetch owned → write-through → wait), `src/single_flight.rs`.
- **Revision:** first witness run failed criterion 4 — 100 identical files
  paid **101**. The cache was right but every file missed at the same
  moment (all concurrent). Added single-flight: the first caller of a key
  fetches it, concurrent callers wait on its result; a failed fetch wakes
  waiters empty-handed and they fetch for themselves. The same mechanism
  covers duplicates inside one batch, so the separate check was removed.
- `tests/poc6-ledger.sh` **6/6** (mock counts inputs = spend):
  first run 201 (200 + probe); after `cccrust reset -f` **0**, 200 files;
  control `CCC_EMBED_CACHE=off` re-run **200**; 100 identical files
  **2**; `kill -9` of the daemon after 104 of 400 → resume total **403**
  (limit 400 + 1 + cap 2), 400/400 files.
- Unit 27/27. `tests/mutate-embed-cache.sh` 4/4 killed (params dropped
  from key, no length prefix, skipped lookup, no single-flight). The
  script now refuses a non-compiling mutant as a dead instrument (one
  first draft "survived" only because it did not compile).
- Regression: e2e 46/0 + 21/0, POC 4 7/7, 4b 11/11, 4c 7/7, 5 4/4, all
  mutation scripts survivors=0.

## POC 7 — pass criteria (written before code)

Today any non-200 fails the whole file. Policy (`src/retry.rs`, pure
`classify(status, body) → Retry(delay) | Split | Fail`, unit-tested):

- 429 / 500 / 502 / 503 / 504, connect errors, timeouts → retry with
  exponential backoff + jitter, honoring `Retry-After`; at most
  `CCC_EMBED_RETRIES` (default 8), cap 60 s.
- 400/413 whose body says the batch is too large (tokens/too long/size)
  and batch > 1 input → split in halves and recurse ("halve and retry").
- Any other 4xx (401, bad model) → fail at once, no retry, body surfaced.
- Per-request timeout `CCC_EMBED_TIMEOUT_S` (default 120).

Witness `tests/poc7-faults.sh` — mock fault modes, zero spend:

1. **429 storm:** every 3rd request 429 (`Retry-After: 0.2`) → 300 files
   all indexed, rc 0, mock served ≥ 50 429s.
2. **Oversize:** mock rejects > 8 inputs with 400 "too many tokens";
   files of ~30 chunks → all indexed, mock saw the rejections and no
   accepted batch > 8.
3. **Slow:** every 5th request stalls 10 s, timeout 2 s → all indexed.
4. **Hard 4xx fails fast:** mock 401 → index rc≠0 with the 401 in the
   message, mock saw ≤ 2 requests (no retry storm).
5. **Ledger consistent after faults:** re-run of case 1 after reset pays 0.
6. **No key leak:** bearer string absent from daemon.log and all output.
7. **Mutation:** retry disabled → case 1 dies; split disabled → case 2
   dies; 401 retried → unit dies.

### POC 7 — result (2026-09-28): PASS

- `src/retry.rs` (pure policy, 6 unit tests) + `src/http_fetch.rs` (the
  attempt loop; in-flight permit held per attempt, so a sleeping retry
  never blocks other files; per-request timeout).
- `tests/poc7-faults.sh` **8/8**: 429 every 3rd request → 300/300 files,
  150 429s absorbed; re-run after reset paid **0**; **control** retries=0
  → rc=1; oversize (>8 inputs → 400) → 20/20 files, 60 rejections,
  largest accepted batch 8; stalls of 10 s with a 2 s timeout → 100/100,
  25 stalls; 401 → rc=1 after **1** request, "failed (401) after 1
  attempt"; bearer found **0** times in 5 daemon logs + all output, and
  the leak grep's positive control (daemon banner) found 5.
- `tests/mutate-remote-embedder.sh` now spans 3 files: **9/9** killed
  (incl. never-retry, retry-all-4xx, never-split, ignore-Retry-After).
- Instrument false positive caught: the first 401 check grepped bare
  "401" and matched the tmp dir `hard401/`. The real message was right;
  the check now matches `failed (401) after 1 attempt`.
- `settings.rs` crossed 300 lines with POC 4b/4c edits; path helpers moved
  to `settings_paths.rs` (re-exported, callers unchanged).
- Regression: cargo 33/33, e2e 46/0 + 21/0, 4c 7/7.

## POC 8 — pass criteria (written before code)

Slice: 1,000 files sampled deterministically (sorted, every k-th) from
the corpus snapshot pulled to `~/PROJECTS/aosp-docs` (23,139 files
at the time). Real Voyage via the Worker, `voyage-4-large`. Each run gets
a fresh `CCCRUST_DIR` (empty embed cache) so no run is free.

Arms, same slice, measured wall time + chunks + client retry lines (the
`embed retry` WARN in daemon.log) + Worker 429 re-routes:

- **A — 1 key direct:** `CCC_EMBED_BASE_URL=https://api.voyageai.com/v1`,
  one key from `~/.drew/voyage.keys` via a 0600 temp file, cap 1.
  (The Python baseline shape: one request at a time.)
- **B — Worker, cap 4 / 16 / 32** (13 slots × ≤2 in flight = 26 max).

Pass = every arm indexes 1,000/1,000 files with rc 0, numbers recorded
as chunks/s and retries, and the default `CCC_EMBED_MAX_INFLIGHT` is set
from the measured knee (smallest cap within 10% of the best chunks/s),
not from a guess. The report says which arm won and by how much.

**Revision after the first live arm (w16, rc=1, 0 files):** real API
reference pages broke two Worker assumptions.
- A 120K-*estimated* batch was **126,899** real tokens — 3 chars/token
  under-counts dense reference text. Voyage answered 400 "max allowed
  tokens per submitted batch is 120000".
- The Worker wrapped that 400 as **502**, so the client retried a
  non-retryable error 9 times (the POC 7 policy was right; the status
  was wrong).
Fix criteria (Worker):
  a. a Voyage 400 naming the token/batch limit splits that batch in half
     and retries the halves (unit: fake slot rejects > N inputs → all
     vectors returned, in order); a single oversize input still fails;
  b. other Voyage 4xx surface as the same 4xx (not 502), so clients fail
     fast (unit + live bad-model check returns 400);
  c. budget lowered to 100,000 estimated tokens per call (headroom, not
     a guess: 126,899 / 120,000 = 1.06 measured overshoot);
  d. mutation: drop the split → (a) dies; map 4xx → 502 → (b) dies.

Caveat carried forward (POC 3): the pool is small (all 104.28.x) and the
fresh control DOs landed on IPs key slots also hold. IPs are not reserved
and a DO can relocate after eviction, so the router must re-check a slot's
egress IP periodically and refuse a slot whose IP now collides — placement
is a snapshot, not a guarantee.

## POC 8 — result (2026-09-28): PASS

Final arms, same 1,000-file slice, fresh `CCCRUST_DIR` each, after the
three product fixes below (source: `workers/voyage-egress/test/poc8-results.tsv`):

| arm | model | cap | files | chunks | secs | chunks/s | client retries |
|---|---|---|---|---|---|---|---|
| direct (1 key) | voyage-4-large | 1 | 1000 | 14,857 | 406 | 36.6 | 0 |
| worker | voyage-4-large | 16 | 1000 | 14,857 | 53 | 280.3 | 0 |
| worker | voyage-4-large | 32 | 1000 | 14,857 | 31 | 479.3 | 1 |
| worker | voyage-4-large | 64 | 1000 | 14,857 | 30 | 495.2 | 1 |
| worker | voyage-4 | 32 | 1000 | 14,857 | 54 | 275.1 | 0 |
| worker | voyage-4 | 64 | 1000 | 14,857 | 37 | 401.5 | 1 |

- [x] every arm 1,000/1,000 files, rc 0
- [x] knee: best 495.2 (cap 64); smallest cap within 10% = **32** (479.3)
  → `DEFAULT_MAX_INFLIGHT` 16 → 32 (`remote_embedder.rs`)
- [x] winner: Worker cap 32 is **13.1x** the 1-key direct baseline
  (479.3 vs 36.6 chunks/s); cap 64 buys only +3%
- voyage-4 (asked for by Andrew for the big fan-out) is **slower** here
  than voyage-4-large: 275 vs 479 at cap 32, 402 vs 495 at cap 64. Voyage
  answered voyage-4 13/13 at 360 inputs directly, so it is per-request
  latency (max 10.9 s vs 6.4 s for v4-large at 13-way), not throttling.

Defects the arms found, each fixed **in product code with a regression
test**, not worked around in the POC script:

1. Worker wrapped Voyage's 400 as 502; no oversize split — `7e510af`.
2. Client: Voyage's real body ("max allowed tokens ... TOO_MANY_TOKENS_IN_BATCH")
   matched none of `says_too_large()`'s phrases → Fail after 1 attempt
   (direct arm rc 1). Extensionless READMEs (6/1000) not indexed — `d5159ef`.
3. Worker: 2,511 retries (all 500) on voyage-4 arms. `wrangler tail`:
   "runtime canceled this request because ... code had hung" — a waiter
   in `SlotScheduler.acquire` blocked on another request's release().
   Wait now owns a 50 ms re-poll timer — `8ccfc94`. Live: 13/13, 13/13,
   40/40 at 360-input batches (was 8–9/13).

The mutation for each: phrase list removed → 6/7; README patterns removed
→ walk test fails; scheduler timer removed → 22/23.

## POC 9 — pass criteria (written before code)

**Proves:** `cccrust` indexes the real Android docs corpus through the
Worker, is searchable, and a re-run after the crawl grows pays only for
new files.

Model: **voyage-4** (Andrew, 2026-09-28: "try voyage-4 for the large
fanout"), set per index with `cccrust init --index-model voyage/voyage-4`
— the POC 4b override, not a global change. POC 8 measured it at 275
chunks/s (cap 32) vs 479 for voyage-4-large; accepted cost of the ask.

Durable harness: `rust/tests/poc9-corpus.sh` + `rust/tests/poc9-queries.tsv`
(query → expected path substring). Re-runnable after every corpus pull.

9a — index the current snapshot (`~/PROJECTS/aosp-docs`, 23,139 files):
- [ ] `cccrust index` rc 0; files, chunks and wall seconds recorded
- [ ] status reports index model `voyage/voyage-4`
- [ ] instrument check first: every expected path in the queries file
      exists on disk (a missing file would make a miss meaningless)
- [ ] ≥ 5 of 6 known-positive queries put their expected file in the top 5,
      including one extensionless README (the POC 8 include fix) and one
      kernel `.rst`
- [ ] negative control: a query for a term absent from the corpus does not
      return the expected files of the positives in its top 5

9b — after the crawl lanes finish (full pull):
- [ ] re-pull, re-run `poc9-corpus.sh`; rc 0
- [ ] cost of re-run ∝ new files: Worker requests on the re-run ≤ the
      new-file share of the first run's requests + 10% (memo + embed cache)
- [ ] same query set still ≥ 5/6

### POC 9a — result (2026-09-28): PASS

`bash rust/tests/poc9-corpus.sh` on the snapshot (23,139 files):
- [x] index rc 0 in **676 s**; 22,104 files, **270,828 chunks** (~400 chunks/s)
- [x] status reports `voyage/voyage-4`
- [x] instrument: all 6 expected files exist on disk
- [x] known positives in top 5: **6/6** — fragment lifecycle, compose
      lifecycle, permissions overview, IBinder reference, kernel
      `cgroup-v2.rst`, extensionless `giflib/README`
- [x] negative control (nonsense query) returned kernel yaml/xml noise,
      none of the 6 positives
- client retries: 4 (Worker 502s, all recovered)

Unindexed files accounted for: 23,139 − 22,104 = 1,035. Of those, 1,015 match
no include pattern and 7 are dotfiles. The biggest prose group in that set is
extensionless kernel ABI docs (`Documentation/ABI/**/sysfs-*`); the rest is
gif/pdf/emz/dot/Makefile. **Open:** whether to add a project-level include
for `**/Documentation/ABI/**` — this is a corpus policy, not a default.

9b waits on the crawl lanes: 14,690 of 53,978 pages at 11:25 UTC; 8 lost
lanes were relaunched 11:08 UTC from their Wasabi manifests.

## POC 10 — Chromium crawler replaces the keyless Jina crawl (criteria before code)

**PIVOT NOTE (2026-09-28):** there is no Jina key, so the free-tier crawl runs at
~65 pages/min (≈10 h left for 37.6K pages). Andrew: use a proper
Chromium/Playwright crawler fanned out across ~5 gcloud instances, with
DOMParser + in-page sub-fetches to aggregate, a structure-aware extractor,
and an open-source HTML→MD converter as the fallback.

Measured before code: static HTML already carries the full article —
`h1.devsite-page-title` + `div.devsite-article-body` — with `.nocontent`,
breadcrumb and `devsite-*` chrome around it (guide page 29 KB of 323 KB;
reference page 64 KB of 2.3 MB). A full page navigation per URL is waste.

Design: one Chromium page per instance, parked on developer.android.com.
In-page `fetch()` pulls N URLs concurrently (same origin, real browser
headers), `DOMParser` parses each, the extractor takes the article nodes
and drops the chrome, and turndown + GFM (tables, fenced code) converts
them to MD. Readability (@mozilla/readability) + turndown is the fallback
when the devsite nodes are absent. Output keeps the existing layout
(`<path>.md`, first line `<!-- source: URL -->`), so the index harness is unchanged.

Durable home: `corpus/android-docs/` in this repo (not /tmp).

**10a — extractor quality (one instance, 24 sample URLs across guide,
reference, compose, training, studio, kotlin):**
- [ ] 24/24 produce MD with an H1 matching the page title
- [ ] 0 chrome leaks: none of "Skip to main content", "Send feedback",
      "Was this helpful", breadcrumb separators, cookie text
- [ ] code preserved: pages with `<pre>` yield ≥ as many ``` fences
- [ ] tables preserved: a reference page with `<table>` yields `|` rows
- [ ] vs the Jina MD already crawled for the same URLs: body word recall
      ≥ 0.90 (tokens of Jina's body found in ours), measured and printed

**10b — throughput on one instance (500 URLs):**
- [ ] pages/min measured; failures < 1%; any 429/403 counted and printed
- [ ] concurrency picked from the measurement (4/8/16 arms), not guessed

**10c — 5-instance fan-out over the remaining URLs, resumable:**
- [ ] each instance skips URLs already saved (its manifest), so a relaunch
      after a VM recycle never re-fetches finished pages
- [ ] results sync to Wasabi under `android-docs-pw/`; census reports
      saved/expected per instance
- [ ] total saved ≥ 98% of 53,978; failures listed with status

Then POC 9b runs on the new corpus.

### POC 10a — result (2026-09-28): REVOKED / UNREPRODUCIBLE

**Status: REVOKED 2026-09-28 (fix round 1c, commit `76ad389`).** The PASS below
is historical and must not be cited. Reasons:
- **The sample is gone.** `out10a`/`ref10a` lived only in the ephemeral lane
  `/tmp/home`; both `pw-crawl-00` and `pw-crawl-01` measured EMPTY on
  re-check (adv-corpus verifier, steps 5 and 12). Nothing can be re-scored.
- **Self-loosened instrument.** Recall went 0.780 → 0.891 → 0.987 through the
  orchestrator's own gate changes (`4c9b40c`, `6fb96c7`), not extractor
  changes. The `6fb96c7` end-marker also cut the reference at a mid-body
  widget JSON line, which inflates recall (reproduced by the verifier).
- **Mean-only gate.** A 0.2-recall page hides inside a ≥0.9 mean; the
  pass/fail line never looked at single pages.

**New gate** (`corpus/crawler/check-quality.mjs`, `76ad389`): every page
recall ≥ **0.80** (floor) AND mean ≥ **0.90**; the widget JSON ends the
reference only after its last heading. The out/ref sample dirs are argv and
must be **persisted to Wasabi** before a re-run counts. Re-run pending.

Historical record (superseded):

On `pw-crawl-00`, Playwright v1.55.0 image, 24 URLs across 12 doc sections,
compared against fresh keyless Jina fetches of the same URLs (`check-quality.mjs`):
- [x] H1 title 24/24 · [x] chrome leaks 0 · [x] code fences on 17 pages ·
      [x] GFM tables on 13 pages · [x] mean body word recall **0.987**
- The first two runs scored 0.780 and then 0.891. Both misses were the
  **instrument**, not the extractor:
  - The recall was measured against Jina's envelope, TOC and feedback widget.
  - Code was stripped from ours, while Jina emits it unfenced.
  - Fixed in `4c9b40c` and `6fb96c7`; the missing-word list is printed.
- The gate has teeth (negative controls): halving every page's body gives
  0.597 → FAIL, and injecting "Send feedback" gives 1 leak → FAIL.

### POC 10b — result (2026-09-28): PASS

The first bench ran at **39.4 pages/min** at conc 4. That was a defect, not the network:
- One long-lived page decayed from 327 to 130 pages/min over 450 URLs while
  the renderer grew to 3.3 GB.
- Reference pages are ~2.2 MB, almost all nav. DOMParser takes ~60 ms on the
  full page vs 3 ms on `<head>`+`<article>` (66 KB).
- Fix `725032a`: parse only that slice, and recycle the page every 8 batches.
  10a re-gated after the fix: still 0.987 (under the old, since-revoked gate;
  see POC 10a above).

Disjoint 450-URL slice per arm, one instance (2 vCPU):

| conc | ok | fail | min | pages/min | statuses |
|---|---|---|---|---|---|
| 4 | 449 | 1 | 1.38 | 324.6 | 200×449, 404×1 |
| 8 | 450 | 0 | 0.93 | 485.8 | 200×450 |
| 16 | 450 | 0 | 0.63 | 714.7 | 200×450 |
| 32 | 450 | 0 | 0.59 | 760.5 | 200×450 |
| 48 | 450 | 0 | 0.67 | 668.2 | 200×450 |

- [x] failures 1/2,250 = 0.04% (a real 404); **0 × 429, 0 × 403**
- [x] conc from the knee: best 760.5 at 32; the smallest conc within 10% is
      **16** (714.7), so it goes in `corpus/jobs/android-docs.json`
      (`CONC=16`, `BATCH=128`)
- Estimate: 5 lanes × ~700 pages/min → 53,925 URLs in about 15–20 min,
  vs about 10 h for the keyless Jina crawl.

URL list: `corpus/jobs/android-docs-urls.mjs` regenerates
`android-docs-urls.txt` from the sitemap index, **53,925** URLs, English
only. The sitemap repeats every page for each `?hl=` locale: 64,925 of
118,850 in-scope locations. Byte-order identical to the original 53,978
shard list, minus 53 URLs the sitemap no longer lists.

## POC 11 — voyage-code secondary index + dual search (criteria before code)

Andrew: keep this in the product, not in one-off proof scripts. Secondary
indexing, dual search, and fusion are **core library features** under
`rust/src/`, exposed by the normal `cccrust` CLI, project `settings.yml`,
the daemon protocol, and the MCP `search` tool. Rust tests own the proof;
shell/Node scripts may collect live evidence but cannot satisfy a pass
criterion by themselves.

Measured before design:

- Live request through the endpoint and bearer paths in
  `~/.cccrust/global_settings.yml` (paths printed, values not printed): one
  document input to `voyage/voyage-code-4` returned HTTP 200, one
  **1024-dimension** vector, 19 prompt tokens. `voyage-code-4` is live;
  the `voyage-code-3` fallback was not needed.
- One project can hold independent SQLite vec0 databases: the database path
  is an input to `open_target_db`, and each database owns its own
  `ccc_index_meta`. Use stable role-based paths
  `.cccrust/target_sqlite.db` and
  `.cccrust/target_sqlite.secondary.db`; never put the model id in a path.
- The current `process_file` combines split + embed. Calling `run_index`
  twice would re-walk and re-chunk. The implementation must extract a
  shared `PreparedChunk` stream and feed both embedders from it; a second
  index is not allowed to run a second chunker pass.
- The persistent embed cache is already safe across models: its key is
  `sha256("v1", model, params, text)`. The secondary model and each model's
  document/query parameters therefore occupy distinct keys.
- `daemon.rs` is 775 lines and `main.rs` is 557 lines. Both already violate
  the 300-line limit. New behavior belongs in new modules such as
  `index_profiles.rs`, `multi_index.rs`, `dual_search.rs`, and `fusion.rs`;
  do not grow those two files beyond thin dispatch wiring.

Project config (the existing `embedding:` remains the primary):

```yaml
embedding:
  provider: litellm
  model: voyage/voyage-4
  indexing_params: {input_type: document}
  query_params: {input_type: query}
secondary_embedding:
  provider: litellm
  model: voyage/voyage-code-4
  indexing_params: {input_type: document}
  query_params: {input_type: query}
dual_search:
  enabled_by_default: true
  rrf_k: 60
  weights:
    primary: 1.0
    secondary: 1.0
```

`cccrust init --secondary-model voyage/voyage-code-4
[--secondary-provider litellm]` writes the secondary block. All fields are
editable in `settings.yml`: secondary provider/model/params, whether dual
is the default, RRF `k`, and both per-index weights. A project without
`secondary_embedding` keeps today's single-index behavior and files.

### POC 11a — secondary index is a first-class core feature

**Proves:** one ordinary `cccrust index` run builds primary and secondary
indexes from one shared chunk plan, with separate model metadata and
model-scoped cached vectors.

**Core design:**

- `index_profiles.rs` resolves the named `primary` and optional `secondary`
  profiles, their effective embedding settings, stable database paths, and
  per-profile metadata. Invalid duplicate roles, missing model/provider,
  or a configured secondary equal to the primary fail before indexing.
- `multi_index.rs` owns the first-class index operation. It walks and chunks
  every changed file once into `PreparedChunk` values, sends the same values
  to both profile embedders, and commits each model's vectors to its own
  database. Both embedders share one request budget, so total Worker
  concurrency across profiles never exceeds `DEFAULT_MAX_INFLIGHT`.
- `cccrust index` uses this operation whenever `secondary_embedding` exists;
  there is no separate corpus script or hidden POC command. Incremental
  re-runs and full clean re-embeds use the same command.
- `cccrust status` prints one row per role: database path, model, dimensions,
  files, and chunks. The daemon `ProjectStatus` response carries the same
  structured per-index rows rather than flattening them into one count.
- The core index report records per role: model, dimensions, files, chunks,
  upstream inputs, upstream prompt tokens, cache hits, wall seconds, and
  chunks/s. Cost totals come from parsed embedding responses, not log grep.

**Pass criteria (all machine checked before POC 11b):**

- [ ] Config round-trip tests preserve every `secondary_embedding` and
      `dual_search` field; omitted fields deserialize to no secondary,
      dual-on-when-secondary-exists, `rrf_k=60`, and weights 1.0/1.0.
- [ ] A Rust integration test installs the current crate into a temporary
      prefix, runs `cccrust init --secondary-model
      voyage/voyage-code-4`, then runs that installed binary's ordinary
      `cccrust index`; it creates exactly the primary and secondary target
      DBs without invoking a witness script.
- [ ] With deterministic fake embedders, both DBs contain exactly the same
      set of `(file_path,start_line,end_line,content)` chunks, their
      `ccc_index_meta` rows name different models and expected dimensions,
      and at least one same-chunk vector differs between DBs.
- [ ] A counting chunker sees exactly one chunk operation per changed file
      while both DBs are built. A mutant that runs one independent indexer
      per profile makes the test count two and fails.
- [ ] The total fake HTTP server peak across both models is
      `<= DEFAULT_MAX_INFLIGHT`, while its positive control with the shared
      gate disabled exceeds that value.
- [ ] `cache_key(primary_model, params, text) !=
      cache_key(secondary_model, params, text)` and a two-model cache test
      observes one upstream fetch per model, then zero on the second run.
- [ ] `cccrust status` and daemon `ProjectStatus` report both roles with the
      exact model, dimensions, chunk count, and database path read back from
      each database; deleting one DB reports that role missing rather than
      copying the other role's values.
- [ ] The index report's prompt-token total equals the sum of a mock
      server's per-response `usage.prompt_tokens`; a cache-only re-run
      reports zero new upstream tokens.
- [ ] Primary-only projects retain their existing DB paths, output, and e2e
      results; all existing Rust unit/integration tests remain green.
- [ ] **Reachability gate:** reachable from the installed `cccrust` binary with no script —
      init, index, and status all exercise the secondary index through normal
      commands.

**Run:** `cargo test secondary_index -- --nocapture` plus a temporary-prefix
`cargo install --path rust` binary test. Witness scripts may exercise the
live Worker only after these tests pass.

### POC 11b — weighted dual search + reciprocal-rank fusion

**Proves:** core search embeds the query with both models' query parameters,
searches both databases, and returns a deterministic, provenance-preserving
merged ranking through CLI, daemon, and MCP.

**Core design:**

- `dual_search.rs` resolves search mode (`configured`, `primary`,
  `secondary`, `dual`), validates each DB against its model metadata,
  embeds the query separately with each profile's `query_params`, applies
  all language/path filters to both searches, and passes ranked candidates
  to `fusion.rs`.
- Stale/partial secondary behavior: when the secondary index is partial or stale
  (e.g. chunk count lags the primary), dual search executes against what
  exists in the secondary, logs a visible warning naming the state (`warning:
  secondary index partial: N/M chunks`), and records `secondary_coverage:
  {indexed, expected}` in search response metadata. If the secondary database
  is missing entirely, dual search degrades gracefully to primary-only with a
  prominent warning, rather than aborting or returning partial results
  silently.
- Dual is recommended and is the default when a secondary exists. CLI
  `cccrust search --dual` forces dual; `--primary-only` and
  `--secondary-only` force an eval/debug arm. These mutually exclusive flags
  override `dual_search.enabled_by_default`. With no secondary, configured
  mode is primary and an explicit secondary/dual request fails clearly.
- Weighted reciprocal-rank fusion is exactly
  `sum(weight[index] / (rrf_k + rank[index]))`, with one-based ranks and
  default `rrf_k=60`. `rrf_k` must be positive; weights must be finite and
  non-negative, with at least one positive configured weight.
- Dedupe key is exactly `(file_path,start_line,end_line)`. A fused result
  retains one content payload plus `index_matches`, one entry per index that
  found it: role, one-based rank, and that index's similarity score. Its
  public `score` is the fused score in dual mode and similarity in a single
  mode.
- Daemon protocol change: `Request::Search` adds `mode: SearchMode`; search
  response/result payloads add `search_mode`, final score, and
  `index_matches`. Bump the package/protocol version so stale daemons restart.
- MCP change: the `search` input schema adds `search_mode` with
  `configured|primary|secondary|dual`; each JSON result returns
  `score`, `search_mode`, and `index_matches`. CLI text keeps the existing
  result header and adds a deterministic provenance line such as
  `Indexes: primary rank=2 score=...; secondary rank=1 score=...`.

**Pass criteria (all machine checked before POC 11c):**

- [ ] A table-driven unit test covers single-index results, overlap,
      primary-only/secondary-only candidates, ties, zero weight, non-default
      weights, non-default `k`, and pagination. Expected fused scores are
      asserted numerically from the formula, not snapshot text.
- [ ] Fusion is invariant to the order in which index result lists arrive;
      ties break by `(best_rank,file_path,start_line,end_line)` so repeated
      runs are byte-identical. A mutant using arrival order fails.
- [ ] Duplicate chunks from both DBs produce one output row with two
      `index_matches`; distinct line ranges in the same file remain distinct.
- [ ] A mock-wire test observes exactly two query embedding requests in dual
      mode: the primary model with its configured query params and the
      secondary model with its configured query params. Document params in
      either request fail the test.
- [ ] A Rust e2e fixture has a known answer outside the returned top list for
      primary-only and secondary-only (e.g. ranks 11–20) but inside the top-10
      dual list. To prevent synthetic gaming of RRF at k=60 (where rank-6 in
      both lists scores 2/(60+6)=0.0303, beating rank-1 in one list at
      1/(60+1)=0.0164):
      (1) the fixture's gold chunk must be a genuine grounded code/doc answer,
      not synthetic noise vectors;
      (2) containment floor: the promoted fused winner must be within top-20 of
      at least one single index and have positive cosine similarity > 0.40 in
      both indexes;
      (3) dual top-10 must contain the top single-index results minus at most
      the promoted items (no displacement of high-scoring results by low-cosine
      overlap).
- [ ] Dual search against a partial secondary index returns merged results from
      available chunks, emits the partial-index warning, and includes coverage
      metadata; dual search with missing secondary DB degrades to primary-only
      search with a warning without exiting nonzero.
- [ ] Installed-CLI tests prove configured default dual, explicit `--dual`,
      `--primary-only`, and `--secondary-only`; conflicting flags exit
      nonzero, and dual without a configured secondary exits nonzero with a
      named remediation.
- [ ] Daemon msgpack round-trip tests and an MCP JSON-RPC test preserve
      `search_mode`, final score, per-index ranks, and per-index similarity
      scores. MCP `tools/list` advertises the new enum and default behavior.
- [ ] Existing single-index CLI/MCP output remains parseable, including the
      existing `--- Result N (score: X) ---` header used by the android-docs
      evaluator.
- [ ] All new implementation lives in core `rust/src/` modules under 300
      lines each; `daemon.rs` and `main.rs` receive dispatch wiring only and
      do not absorb fusion/index orchestration logic.
- [ ] **Reachability gate:** reachable from the installed `cccrust` binary with no script —
      dual indexing/search, mode overrides, weights, and provenance are
      exercised through the installed CLI and MCP server.

**Run:** `cargo test fusion dual_search mcp -- --nocapture` plus the
installed-binary e2e fixture. A script may format the live comparison, but
it is not the implementation or the pass authority.

### POC 11c — full Android corpus on voyage-4 + voyage-code-4

**Proves:** the installed product builds and evaluates both real indexes at
corpus scale through the Worker, and dual search does not lose overall
hit@5 against the better single model.

**Live configuration:** `~/PROJECTS/aosp-docs` with primary
`voyage/voyage-4`, secondary `voyage/voyage-code-4`, dual default on,
`rrf_k=60`, and weights 1.0/1.0. Use the Worker endpoint already configured
for cccrust and the product's `DEFAULT_MAX_INFLIGHT`; use a fresh
`CCCRUST_DIR`/embed cache for the measured full run so both model token
counts are real rather than inherited cache hits.

**Pass criteria:**

- [ ] `cccrust index` from the installed binary exits 0 and builds both full
      corpus DBs through the Worker. No POC-only indexer, direct curl loop,
      or one-off embedding script is used.
- [ ] `cccrust status` reports primary `voyage/voyage-4` and secondary
      `voyage/voyage-code-4`, both 1024 dimensions, with identical file,
      chunk, and `(file,line-range)` identity counts.
- [ ] The aggregate live Worker concurrency for the two-index run never
      exceeds `DEFAULT_MAX_INFLIGHT` (=32). Measurement method: the client
      embedder records peak in-flight requests via an atomic counter
      (`AtomicUsize`) tracked across all concurrent worker threads, and prints
      `peak_inflight_concurrency: N` in the core index report; asserted
      `<= DEFAULT_MAX_INFLIGHT`.
- [ ] The six POC 9 known positives are first checked to exist on disk, then
      dual search finds at least 5/6 in the top five, including the
      extensionless giflib README and kernel `.rst` case.
- [ ] Eval runner extension (deliverable of 11c/11d): extend
      `~/PROJECTS/agent-skills/skills/android-docs/eval/run.mjs` to accept a
      `--mode` flag (`--primary-only`, `--secondary-only`, `--dual`, or
      `--dual --rerank`) that it passes through to `cccrust search`, and write
      output to `results-<mode>.tsv` (e.g. `results-primary-only.tsv`,
      `results-secondary-only.tsv`, `results-dual.tsv`). Run `run.mjs` three
      ways to produce separate TSV artifacts for all three modes.
- [ ] The report prints `n`, hit@1, and hit@5 for every query style
      (`symbol`, `english`, `error`, `concept`, `compare`, `keyword`,
      `platform`, `paraphrase`) and overall for each of the three modes; the
      six control rows must remain 6/6 hit@5 or the runner is invalid.
      Both raw baseline totals (59/106 hit@5, 35/106 hit@1) and
      corrected-expectation totals (62/106 hit@5, 37/106 hit@1, accounting for
      the 3 known-wrong eval paths in SKILL.md:135: espresso.md substring,
      CursorWindowAllocationException, DeadObjectException) are reported
      side-by-side.
- [ ] Overall dual hit@5 is `>= max(primary hit@5, secondary hit@5)`. If it
      is lower, POC 11c does not pass: retain all measurements and report the
      finding honestly instead of changing the gate or hiding a style.
- [ ] The report also lists every per-style dual regression versus the better
      single model, even when the overall hit@5 gate passes.
- [ ] Record total wall seconds, files, chunks, chunks/s, cache hits,
      upstream inputs, and `usage.prompt_tokens` separately for primary and
      secondary and combined. Token totals must reconcile exactly with the
      core index report.
- [ ] Re-run the same ordinary `cccrust index` without clearing cache: both
      DBs remain complete and new upstream prompt tokens are zero, proving
      the full-corpus operation is first-class and resumable.
- [ ] **Reachability gate:** reachable from the installed `cccrust` binary with no script —
      the complete corpus build and all three search modes use normal installed
      commands; scripts only orchestrate/query and summarize the evidence.

**Run:** installed `cccrust index`, POC 9 queries in dual mode, then the
android-docs evaluator in primary/secondary/dual modes. Commit and push the
criteria before any POC 11 product code starts.

### POC 11d — Voyage rerank over the fused dual results (criteria before code)

Andrew, verbatim: "Why don't you use the voyage re rankers on the results?
once dumb merged". The pipeline is therefore dual search → cheap merge (RRF,
POC 11b) → Voyage rerank of the merged top-N → final order. This slots after
11b's fusion and before 11c's reporting; POC 11c's eval gains a 4th arm.

**Measured before design (2026-09-28):**

- The deployed `voyage-egress` Worker (`workers/voyage-egress/src/index.ts`,
  85 lines) routes only `/healthz`, `/egress`, `/place`, `/placement`,
  `/v1/embeddings`, `/v1/embeddings/query`, and `/probe`. There is **no rerank
  route**; Voyage's `POST /v1/rerank` is unreachable through the Worker today.
- Voyage reranker model ids live in the docs today: `rerank-3` (preview,
  32,000-token context), `rerank-3-lite` (preview), `rerank-2.5` (32,000),
  `rerank-2.5-lite` (32,000), plus legacy `rerank-2` (16,000), `rerank-2-lite`
  (8,000), `rerank-1` (8,000), `rerank-lite-1` (4,000). The API reference's
  recommended ids are `rerank-2.5` and `rerank-2.5-lite`; the preview `rerank-3`
  family is described as highest accuracy. Default model below is
  `rerank-2.5`, with `rerank-2.5-lite` as the latency-oriented alternative.
- **Limits** (API reference): max **1,000 documents** per request; query max
  **8,000 tokens** for `rerank-2.5`/`rerank-2.5-lite` (4,000 for `rerank-2`,
  2,000 for `rerank-2-lite`/`rerank-1`); query + any single document max
  **32,000 tokens** (16,000 / 8,000 / 4,000 for the older families); total
  tokens per request, defined as `query_tokens × N + sum(document_tokens)`,
  max **600,000** for `rerank-2.5`, `rerank-2.5-lite`, `rerank-2`,
  `rerank-2-lite` (300,000 for `rerank-1`/`rerank-lite-1`). `truncation`
  defaults to `true`; `false` raises an error instead of trimming.
- **Wire shape.** Request `POST /v1/rerank`, `Authorization: Bearer <key>`,
  body `{query, documents[], model, top_k?, return_documents?, truncation?}`.
  Response `200` is `{object: "list", data: [{index, relevance_score,
  document?}], model, usage: {total_tokens}}` with `data` sorted by descending
  relevance; `document` appears only when `return_documents` is `true`. Errors
  are `4xx` with `{"detail": "..."}`. The Python docs say `results`; the REST
  field is **`data`** — parse `data`.
- **One live call, measured** (direct `api.voyageai.com`, key path only, key
  never printed; no Worker route was added for this): 50 documents, query
  "how do I request a runtime permission on Android", `model=rerank-2.5`,
  `top_k=10`, `return_documents=false` → **HTTP 200, 540 ms wall**,
  `usage.total_tokens=1580`, 10 results returned in descending score order,
  model echoed `rerank-2.5`, response keys `object,data,model,usage`.
  Follow-up repeat latency distribution is **UNMEASURED**: the earlier claim
  that `~/.drew/voyage.keys` was concurrently rotated and flapped 401 was false
  (stat confirms mtime 2026-09-28T05:27:06Z, mode 600, 27 lines: 13 `pa-` keys,
  9 comments, 5 blanks; `cccrust` does not read this file anyway, using
  `CCC_EMBED_API_KEY_FILE` -> `~/.drew/voyage-egress.token`). The 401 errors
  occurred because the tester iterated comment/blank lines as API keys against
  `api.voyageai.com`. A single 50-document call is evidence of endpoint syntax
  and data shape, not latency; p50/p95 latency is **UNMEASURED** until the
  eval run through the deployed Worker pool.

**Core design:**

- New Worker route `POST /v1/rerank` in the router, dispatched through the same
  slot Durable Objects the embeddings route uses, so rerank inherits the
  13-key / 13-egress-IP pool, the retry/429 policy, and bearer auth. Rerank
  calls never go direct to `api.voyageai.com` from the client; the one direct
  call above was a measurement, not a design.
- `rust/src/rerank.rs` (new module, <300 lines) owns the client call, request
  building, score merge, and fallback. `main.rs`/`daemon.rs` get dispatch
  wiring only.
- Settings block, all fields editable in `settings.yml`:

```yaml
rerank:
  enabled: true
  model: voyage/rerank-2.5     # or rerank-2.5-lite for latency
  candidates: 50               # fused results sent to Voyage
  top_k: 10                    # results returned / shown after rerank
  document_max_chars: 2000     # per-chunk truncation before send
  timeout_s: 15                # upstream timeout in seconds before fallback
```

- CLI: `--rerank` / `--no-rerank` override `rerank.enabled`, mutually
  exclusive, like POC 11b's mode flags.
- Protocol version bump: bump the package/protocol version for 11d (as in 11b)
  so stale running daemons restart cleanly. Daemon `Request::Search` and the MCP
  `search` input gain a `rerank: Option<bool>` field.
- Result header format and score semantics:
  CLI output header remains `--- Result N (score: X) ---`. When rerank is
  active, `(score: X)` displays the Voyage `relevance_score` (a floating point
  score in [0.0, 1.0], matching what downstream analyzers parse). The subsequent
  provenance line explicitly reports:
  `Fused rank: M (rrf_score: Z); Indexes: primary rank=A score=B; secondary rank=C score=D`.
  When rerank is disabled or falls back, `(score: X)` retains the fused RRF
  score and the provenance line omits `Fused rank`.
  Daemon and MCP responses include structured fields: `rerank_score: Option<f32>`,
  `fused_score: f64`, `fused_rank: usize`, and `index_matches`.
- The documents sent are the **chunk texts** of the fused top-`candidates`
  results, each truncated to `document_max_chars` (and to the model's
  query+document token ceiling), preserving the fused order as the input
  `index` mapping. Scores map back by `data[].index`.
- `top_k` slices the reranked list; the fused order is retained for the
  remainder and for anything beyond `candidates`.

**Pass criteria:**

*Worker*

- [ ] A new `POST /v1/rerank` route exists and shares the slot DO dispatch with
      `/v1/embeddings`; no second key pool, no direct client egress.
- [ ] 429 cooldown and re-route apply exactly as they do for embeddings; a
      mocked upstream returning 429 causes a slot cooldown and a later
      successful attempt on another slot.
- [ ] A 4xx from Voyage is relayed to the client with its `detail` body and
      status, not swallowed into an empty result.
- [ ] An oversized document set (e.g. 2,500 documents, or total tokens over
      600,000) is split into parts that each stay within the documented limits,
      and part scores are merged into one ranking. Split is **by documents,
      not by query** — scores are comparable within one query, so the merge is
      a stable sort over `(relevance_score desc, original_index asc)`.
- [ ] Tests cover the mocked upstream (shape, 429 cooldown, 4xx relay, split
      and merge) plus **one live call** through the deployed Worker recording
      HTTP status, latency, and `usage.total_tokens`.

*Rust core library (`rust/src/rerank.rs`, <300 lines)*

- [ ] Configurable in `settings.yml` as `rerank: {enabled, model, candidates,
      top_k, document_max_chars, timeout_s}`; omitted block deserializes to
      disabled with the documented defaults (default `timeout_s: 15`); a config
      round-trip test preserves every field.
- [ ] Protocol version bump: package/protocol version is incremented, and an
      integration test asserts an older-protocol client receives a version
      mismatch or triggers daemon restart.
- [ ] CLI flags `--rerank` / `--no-rerank` exist, conflict with each other,
      and are reachable from the installed `cccrust` binary with no script.
- [ ] Daemon and MCP `search` expose the rerank switch and return
      `rerank_score` per result; `tools/list` advertises it; msgpack/JSON
      round-trips preserve it.
- [ ] Chunk text is what gets sent, truncated to the configured character cap
      and the model's token limits; a test asserts no document exceeds the cap.
- [ ] Result header format preserves `--- Result N (score: X) ---` with `X`
      populated by `relevance_score` when reranked (or fused RRF score on
      fallback/no-rerank), followed by the provenance line with fused rank/score
      and per-index matches. Downstream parsers in `android-docs/eval` continue
      to parse without errors.
- [ ] All new implementation lives in `rust/src/rerank.rs` (and thin wiring);
      no module exceeds 300 lines; `daemon.rs`/`main.rs` do not absorb rerank
      orchestration.

*Failure policy*

- [ ] If rerank fails, errors, or exceeds `timeout_s` (default 15s), the
      response is the **fused order** plus a visible warning naming the failure
      (`warning: rerank failed (<error>), falling back to fused RRF order`) —
      never an empty result, never an aborted search.
- [ ] A test proves the fallback: a fake rerank client that errors or times out
      yields the fused ranking byte-identical to the no-rerank path, with the
      warning present, and the same test with a healthy client proves rerank
      actually reorders (positive control).

*Eval (POC 11c gains a 4th arm)*

- [ ] Use extended `~/PROJECTS/agent-skills/skills/android-docs/eval/run.mjs`
      with `--dual --rerank` to write `results-dual-rerank.tsv`. The report
      prints `n`, hit@1, and hit@5 per query style and overall for all four
      modes. The current single-index baseline in
      `~/PROJECTS/agent-skills/skills/android-docs/eval/results.tsv` is
      **59/106 hit@5, 35/106 hit@1**, error-string style **3/12**; the six
      control rows must remain 6/6 hit@5 or the runner is invalid.
      Both raw baseline totals (59/106 hit@5, 35/106 hit@1) and
      corrected-expectation totals (62/106 hit@5, 37/106 hit@1, accounting for
      the 3 known-wrong eval paths in SKILL.md:135: espresso.md substring,
      CursorWindowAllocationException, DeadObjectException) are reported
      side-by-side.
- [ ] **PASS** if `dual+rerank hit@1 > baseline hit@1 (35/106)`. Report the
      result honestly either way — a lower number is a retained measurement,
      not a reason to move the gate (the gate is monotonically fair across arms).
- [ ] The report also lists every per-style regression of dual+rerank versus
      the best of the four arms, even when the overall gate passes.
- [ ] Added latency per query is reported as **p50 and p95**, and rerank
      tokens per query (from `usage.total_tokens`) are reported alongside
      them.

*Cost note*

- Per-query rerank cost is exactly `Q×N + sum(chunk_tokens)` where `Q` is
  query tokens, `N = rerank.candidates`, and each chunk is truncated to the
  configured cap. The measured 50-document, ~30-token-document call cost
  **1,580 total tokens** in 540 ms. At a 2,000-character cap (~500 tokens per
  chunk) and `N=50` that is ≈ **25,000 tokens per query** (50 × 500 + ~10 query),
  still far under the 600,000 ceiling; at `N=100` it doubles.
- Recommended default: `candidates: 50`, `document_max_chars: 2000`. If the
  measured rerank p95 in the eval above exceeds **1.5 s**, lower `candidates`
  to 25 (halving both tokens and latency) rather than shortening chunks;
  re-measure before changing anything else.

**Run:** `cargo test rerank` plus the Worker's mocked-upstream tests, one live
`POST /v1/rerank` through the deployed Worker, and the android-docs evaluator
in four modes. Scripts may format the evidence; they are not the
implementation or the pass authority.

**Gate:** POC 11d criteria are committed here before any POC 11d product code
starts. POC 11c may report its three existing arms without waiting for 11d;
the dual+rerank arm is 11d's own eval step.
