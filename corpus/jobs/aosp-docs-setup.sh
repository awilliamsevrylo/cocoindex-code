#!/usr/bin/env bash
# fanout setup for the aosp-docs job: runs once per lane (re-run when this text
# changes). Image: node:22-slim. Installs git + rclone, then pulls the sweep
# worker from the fork (sparse corpus/aosp). The rclone config is uploaded by
# the fanout lib to $HOME/rclone.conf (from ~/.drew/rclone-wasabimb.conf, 0600).
# git must exist BEFORE the worker runs: the first sweep's 17 CLONE_FAILs were
# a loop that started before git was installed (see corpus/aosp/README.md).
set -euo pipefail
REPO=${CORPUS_REPO:-https://github.com/awilliamsevrylo/cocoindex-code.git}
BRANCH=${CORPUS_BRANCH:-rust-parallel-proxy}
DIR=/tmp/home/ccc
need=""
command -v git >/dev/null || need="$need git"
command -v rclone >/dev/null || need="$need rclone"
command -v tar >/dev/null || need="$need tar"
if [ -n "$need" ]; then
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $need ca-certificates >/dev/null
fi
git --version && rclone version | head -1
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" reset -q --hard FETCH_HEAD
else
  git clone -q --depth 1 --branch "$BRANCH" --filter=blob:none --sparse "$REPO" "$DIR"
fi
git -C "$DIR" sparse-checkout add corpus/aosp
[ -s "$DIR/corpus/aosp/sweep.sh" ] || { echo "sweep.sh missing after checkout"; exit 1; }
[ -s "$HOME/rclone.conf" ] && chmod 600 "$HOME/rclone.conf" && echo "rclone.conf present" || echo "WARN no \$HOME/rclone.conf — sync will fail"
echo "setup ok $(git -C "$DIR" log --oneline -1)"
