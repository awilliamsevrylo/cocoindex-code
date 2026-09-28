# corpus/ — Android docs corpus pipeline

**Class: DOCUMENTATION.** What the scripts here do, as of 2026-09-28.

## One command

```bash
bash corpus/regen.sh                      # everything, resumable
bash corpus/regen.sh --from assemble      # skip crawling; pull + index
bash corpus/regen.sh --from assemble --dry-run   # list what would be pulled
```

A failed stage stops the run and prints the `--from <stage>` to resume.

## Stages

| # | stage | command | output |
|---|---|---|---|
| 1 | urls | `node corpus/jobs/android-docs-urls.mjs` | in-scope URL list from the sitemap |
| 2 | android | `node fanout/cli.mjs run corpus/jobs/android-docs.json` | Chromium crawl on gcloud lanes → Wasabi `android-docs-pw/<lane>/` |
| 3 | aosp | `node fanout/cli.mjs run corpus/jobs/aosp-docs.json` | AOSP git prose docs → Wasabi `aosp-docs-v2/<lane>/` |
| 4 | watch | `node fanout/cli.mjs watch <spec>`, once per job spec, concurrently | waits; relaunches lost lanes; fails if either watch fails |
| 5 | assemble | `bash corpus/assemble.sh` | merged local tree + `MANIFEST.tsv` |
| 6 | index | `bash rust/tests/poc9-corpus.sh` | `cccrust` index + known-positive queries |
| 7 | gate | built into `regen.sh` | completeness: URL list vs android `.md` on disk; AOSP items vs AOSP manifest `ok` rows; files on disk vs `cccrust status` Files. Fails below `GATE_MIN_PCT` (98) with per-source numbers |

Stages 1–4 are built by sibling work; the paths above are the contract.
Commands are built as argv arrays (no `bash -c` string rebuild), so
`-- assemble args` containing spaces pass through intact.

## Failure contract

- **assemble.sh** writes the merged `MANIFEST.tsv` to a temp file and moves it
  into place only when every lane listing, copy and manifest read succeeded,
  at least one lane exists, and the row count did not shrink (`--allow-shrink`
  overrides). Otherwise the old manifest is kept and the exit is non-zero.
  `--dry-run` creates nothing.
- **aosp/sweep.sh**: `SKIP_DEAD` needs two `ls-remote` calls, `DEAD_RECHECK_SEC`
  (30) apart, that both SUCCEED and return no refs. A failed `ls-remote` is
  `NET_FAIL` (retried). A harvest with a copy error or fewer files than listed
  is `COPY_FAIL`. Harvest goes to a temp dir and replaces the old output only
  when complete. Repo names must match `^[A-Za-z0-9._-]+$` (`BAD_NAME`).
- **crawler/check-quality.mjs** gates recall on a per-page floor (every page
  ≥ 0.80) AND the mean (≥ 0.90). Its `<outdir>` and `<refdir>` arguments must be
  PERSISTED (e.g. to Wasabi): the original 10a sample lived in an ephemeral
  lane `/tmp/home` and is gone.
- Tests: `node --test corpus/test/*.test.mjs`; `CORPUS_DIR=<other corpus/>`
  runs the same tests against another revision.

## Output layout

- Bucket: `wasabimb:drew-aosp-docs-20260928`
  - new: `android-docs-pw/<lane>/**`, `aosp-docs-v2/<lane>/**`
  - legacy (Jina-era): `aosp-shard-NN/{android-docs,aosp-docs}/**`
- Local: `~/PROJECTS/aosp-docs/` (`CORPUS_DEST` overrides)
  - `android-docs/<url path>.md` — first line `<!-- source: URL -->`
  - `aosp-docs/<repo>/...` — prose docs from AOSP git
  - `MANIFEST.tsv` — every lane manifest row, prefixed `kind`, `lane`
- `assemble.sh --source legacy` reads the old layout into the new local tree.
- Old local `aosp-shard-*` dirs are **kept**; `--prune-legacy` removes them
  (local only, off by default, skipped on dry-run or any copy failure).

## How resume works — a rerun pays only for new work

- **Crawl:** each lane writes `MANIFEST.tsv`; URLs marked `ok` are skipped
  on the next run. The manifest is synced lane → Wasabi, but as of a5b81e3
  nothing pulls it BACK: a recycled VM starts with an empty manifest and
  recrawls its shard (adv-open-a finding 4; the fix belongs in `fanout/`).
- **Assemble:** `rclone copy --update` — never `sync`, so nothing local is
  deleted; unchanged files are not re-transferred.
- **Index:** `cccrust` keeps a per-file memo (content fingerprint + model), so
  unchanged files are not re-chunked. The content-addressed embed cache
  (`~/.cccrust/embed_cache.db`) means an identical chunk is never
  embedded twice, even across projects.

## Credentials (paths only)

- Wasabi rclone config: `~/.drew/rclone-wasabimb.conf` (0600; `RCLONE_CONF`)
- gcloud lanes: `~/.local/state/gcloud-ssh-mcp.json`
- Voyage Worker bearer: `~/.drew/voyage-egress.token`
