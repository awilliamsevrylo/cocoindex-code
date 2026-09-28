# rust-parallel-proxy — execution plan (GOAL)

Goal: parallel remote embedding for the Rust `ccc` — one Voyage key per
distinct-exit SOCKS proxy — then index the Android docs corpus.
Tracker: task manager req-100 (task-614..623). One POC proves one thing;
pass criteria are written here BEFORE the code.

Engine: sibling checkout `~/PROJECTS/cocoindex` (Cargo path dep
`../../cocoindex/rust/sdk/cocoindex`). No `v1` branch exists upstream.

| POC | Proves | Status | Evidence |
|---|---|---|---|
| 0 | port builds + e2e passes on a pinned engine | PASS | engine `3b617ff`; e2e_cli 46/0, e2e_advanced 21/0, cargo test 4/4 |
| 1 | remote Voyage embedder stores 1024-dim vectors | — | |
| 2 | batcher never exceeds 120K tokens/request | — | |
| 3 | key pool: 429 cools one key, others continue | — | |
| 4 | vpn-node lease client honours the contract | — | |
| 5 | N workers, each key on its own distinct exit | — | |
| 6 | resume ledger: re-run never re-embeds | — | |
| 7 | mock-fault integration suite has teeth | — | |
| 8 | measured throughput picks worker count | — | |
| 9 | Android docs corpus fully indexed | — | |

## POC 0 — pass criteria

1. Engine pinned to the last `main` commit on or before the port commit
   date (1649b5e, 2026-06-21). Candidate: `3b617ff`.
2. `cargo build --manifest-path rust/Cargo.toml` exits 0.
3. `rust/tests/e2e_cli.sh` and `e2e_advanced.sh` report `FAILED: 0`.
4. Record: engine SHA, build time, binary size, PASSED counts.

If the pinned engine does not build, walk forward one engine commit at a
time; record each attempt. Two failed pins → split POC 0.

### POC 0 — result (2026-09-28): PASS, first pin

- Engine `3b617ff5600810a889efe1253ff90f059bfb5b45` (main, 2026-06-22) —
  reproduce with `git -C ../cocoindex checkout 3b617ff`.
- `cargo build`: 434 crates, 59.7 s wall, exit 0; debug binary 133,374,504 B.
- `e2e_cli.sh` PASSED 46 FAILED 0 — includes real search + auto-index hits.
- `e2e_advanced.sh` PASSED 21 FAILED 0 (model swap, multi-project, MCP).
- `cargo test` 4/4.
- Reuse found at the pin (drives POC 1/3): engine `resources/embedder.rs`
  (`pub trait Embedder`, async `embed_batch`), `ops/api.rs` `ApiEmbedder`
  (feature `embed_api`, owns its own `reqwest::Client` — no injection
  hook, so per-worker proxy clients need our own embedder), and
  `resources/rate_limit.rs` (governor token bucket).
