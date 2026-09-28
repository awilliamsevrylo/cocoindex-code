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
| 4 | watch | `node fanout/cli.mjs watch … --until-done` | waits; relaunches lost lanes |
| 5 | assemble | `bash corpus/assemble.sh` | merged local tree + `MANIFEST.tsv` |
| 6 | index | `bash rust/tests/poc9-corpus.sh` | `cccrust` index + known-positive queries |

Stages 1–4 are built by sibling work; the paths above are the contract.

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
  on the next run, and the manifest is synced to Wasabi so a recycled VM
  restores it before crawling.
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
