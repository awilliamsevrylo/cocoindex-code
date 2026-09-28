# fanout — resumable work fan-out over gcloud Cloud Shell lanes

DOCUMENTATION. Generic: the items are opaque lines (URLs, repo names, paths)
or the files of a local directory. Nothing here is Android-specific. The
transport is gcloud-ssh-mcp `shell_exec`, a direct POST using the credentials
in `~/.local/state/gcloud-ssh-mcp.json`, which are never printed.

```
node fanout/cli.mjs run     spec.json            # start or resume every lane
node fanout/cli.mjs status  spec.json [--heal]   # per-lane table; --heal relaunches dead lanes
node fanout/cli.mjs watch   spec.json --every 10m  # status --heal loop, also the keepalive
node fanout/cli.mjs stop    spec.json [--lane 2]
node fanout/cli.mjs collect spec.json            # runs spec.collect locally
# add --reshard only when intentionally changing a recorded lane count
node --test fanout/test/*.mjs                    # no gcloud needed
```

## Spec

```json
{
  "name": "android-docs",
  "lanes": 5,
  "image": "mcr.microsoft.com/playwright:v1.55.0-noble",
  "items": "urls.txt",
  "setup":  { "file": "setup.sh" },
  "worker": "node ~/crawler/crawl.mjs \"$ITEMS_FILE\" \"$OUT_DIR\"",
  "sync":   "rclone copy \"$OUT_DIR\" wasabi:bucket/$LANE",
  "collect": "rclone copy wasabi:bucket ./corpus",
  "env": { "CONC": "8" }
}
```

| key | meaning |
|---|---|
| `lanes` | default **5**; fewer is refused unless `allowFewerLanes` |
| `image` | container image, applied when a lane's container is first created |
| `items` | a file with one item per line, or a **directory**: its files become the items, and each lane gets its shard as a tar unpacked into `$IN_DIR` |
| `setup` | run once per lane; skipped while its text hash is unchanged. A string, or `{file}` |
| `worker` | per lane: reads `$ITEMS_FILE`, appends `item<TAB>ok\|FAIL<TAB>...` to `$OUT_DIR/MANIFEST.tsv` |
| `sync` | optional; runs every `syncEverySec` (300) while the worker runs, then once at the end |
| `lanePrefix` / `laneNames` | lane singleton names (default `<name>-<i>`) |
| `maxAttempts` | heal relaunches per lane before `status` gives up (5) |

Changing `lanes` re-shards every item. Once local state records a lane count,
commands refuse a different count unless `--reshard` explicitly accepts the
redo. `--reshard` does not rename or migrate old `lane-<i>` directories.

Directory item mode follows a symlink only when it resolves to a regular file
inside the source root. Escaping, dangling, special-file, and directory
symlinks are skipped; directory symlinks are never walked.

Worker env: `ITEMS_FILE`, `OUT_DIR`, `IN_DIR`, `LANE`, `LANE_INDEX`,
`FANOUT_NAME`, plus `spec.env`.

## How it resumes

- **Deterministic sharding:** `sha1(item) % lanes`, so a re-run puts every
  item on the same lane, whose `MANIFEST.tsv` already knows it.
- **Start and heal:** each (re)start pulls the lane's `ok` set (gzip, in ≤48 KB
  slices) and uploads only the remainder. `FAIL` items are retried. A lane
  whose worker is alive is never started twice.
- **Transfers** use sha256-checked base64 parts of ≤48 KB per call, with
  idempotent part files, so the transport may retry any call.
- **Lane identity:** the setup container owns a private token and container
  directory. If a singleton name is answered by a container that cannot prove
  both, its state is `UNKNOWN`. `UNKNOWN` never means dead and is never healed
  or relaunched automatically; inspect the routing/container first.
- **Keepalive:** a lane's VM stays awake ~30 min after the last call. `watch`
  with `--every` ≤ 20m keeps it up and heals recycled lanes. `watch` exits `0`
  only when all items complete, `1` when work is stalled/given up with items
  unfinished, and `2` for CLI/spec usage errors.
- **Local state** (lane map, last status, relaunch counts) lives in
  `~/.local/state/fanout/<name>/state.json`.

## Worker contract

- The worker **must skip items already `ok` in its own MANIFEST**. Items can be
  re-sent after a crash, before the manifest line lands. The one-liner
  `grep -qF "$it<TAB>ok" "$OUT_DIR/MANIFEST.tsv" && continue` is enough.
- Write the manifest line **after** the output is on disk.
- Items may not contain tabs.
