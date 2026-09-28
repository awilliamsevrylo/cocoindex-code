# corpus/aosp — AOSP git prose docs

**Class: DOCUMENTATION.** What these files do, measured 2026-09-28.

| file | role |
|---|---|
| `repos.mjs` | regenerates `repos.tsv` (every repo in the GitHub `aosp-mirror` org) and the fanout items file `corpus/jobs/aosp-docs-items.txt` (`<repo>@<branch>` per line) |
| `repos.tsv` | `name  sizeMB  default_branch  pushed  archived` — 100 repos, the same set the first sweep used |
| `sweep.sh` | per-lane worker: blobless depth-1 clone → list doc paths → sparse checkout of just those → copy to `$OUT_DIR/<repo>/` |
| `../jobs/aosp-docs.json` | fanout spec: 5 lanes, `node:22-slim`, syncs to `wasabimb:drew-aosp-docs-20260928/aosp-docs-v2/<lane>/` |
| `../jobs/aosp-docs-setup.sh` | lane setup: git + rclone + tar, then the sparse fork checkout |

## Run

```bash
node corpus/aosp/repos.mjs                         # refresh the repo list
node fanout/cli.mjs run corpus/jobs/aosp-docs.json # 5 lanes, resumable
ITEMS_FILE=items.txt OUT_DIR=/tmp/aosp bash corpus/aosp/sweep.sh   # standalone
```

## Resume

`$OUT_DIR/MANIFEST.tsv`, one line per attempt:
`item  ok|FAIL  status  branch  doc_files  doc_bytes`. Items marked `ok` are
skipped on the next run; FAIL items are retried.

| status | col 2 | meaning |
|---|---|---|
| `OK` | ok | docs harvested |
| `NO_DOCS` | ok | cloned; no path matched the doc rules |
| `SKIP_META` | ok | `.allstar`, `.github`, `*.github.io` |
| `SKIP_DEAD` | ok | `ls-remote` returned no refs, twice |
| `CLONE_FAIL` | FAIL | reachable, but the clone failed 3× with backoff |
| `COPY_FAIL` | FAIL | doc paths listed, 0 files harvested |

A listed branch that no longer exists falls back to the remote HEAD
(verified: `platform_external_giflib@no-such-branch` → `main`, OK).

## The first sweep's 17 CLONE_FAILs — root cause

The failing repos were not dead:

- **No wrong branch or mirror path.** `git ls-remote` and a blobless clone
  succeeded for every one of the 17, re-probed 2026-09-28.
- **The repos:**
  - lane 05: netcat, safe-iop, webkit, manifest, apps_im, apps_updater, prebuilt;
  - lane 08: development, emma, jdiff, opencore, sqlite, zlib, calculator,
    music, contactsprovider, wlan_ti.
- **Lane order:** each lane's MANIFEST shows those repos failing as one
  consecutive block, then all turning OK on the resumed run.

The resumed fanout ran `command -v git || apk add … git` in a `node:22-slim`
container. `apk` does not exist there, so git came from the apt branch only
on some paths. The sweep loop started with no git, and every clone in that
window failed instantly.

**Fix:**
- `sweep.sh` refuses to start without `git` and `tar` (exit 3).
- `aosp-docs-setup.sh` installs them with apt before any worker runs.

## Other fixes vs the /tmp original

- **Blob fetches:** `git ls-tree -r -l` on a blobless clone lazily fetches
  every blob to report sizes. webkit stalled for minutes. The sweep now lists
  names only and measures bytes after the sparse checkout.
- **Output path:** `OUT_DIR` is made absolute, because the harvest subshell
  `cd`s into the clone. With a relative path the first run hit a COPY_FAIL.
- **Asset rules:** `.gif` and `.pdf` added to the asset exclusions.
  `*/README*` in subdirectories now counts as a doc.
