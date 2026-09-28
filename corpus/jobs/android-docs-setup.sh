#!/usr/bin/env bash
# fanout setup for the android-docs job: runs once per lane (re-run when this
# text changes). Image: mcr.microsoft.com/playwright (Chromium preinstalled).
# Pulls the crawler from the fork (sparse corpus/crawler) and installs deps ON
# the lane. rclone + its config: the config is uploaded by the fanout lib to
# $HOME/rclone.conf (from ~/.drew/rclone-wasabimb.conf, 0600, never printed).
set -euo pipefail
REPO=https://github.com/awilliamsevrylo/cocoindex-code.git
BRANCH=rust-parallel-proxy
DIR=/tmp/home/ccc
command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git >/dev/null)
command -v rclone >/dev/null || (apt-get update -qq && apt-get install -y -qq rclone >/dev/null)
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" reset -q --hard FETCH_HEAD
else
  git clone -q --depth 1 --branch "$BRANCH" --filter=blob:none --sparse "$REPO" "$DIR"
fi
git -C "$DIR" sparse-checkout set corpus/crawler
cd "$DIR/corpus/crawler" && npm ci --no-audit --no-fund >/dev/null
node -e "import('playwright').then(p=>console.log('chromium', p.chromium.executablePath()))"
[ -s "$HOME/rclone.conf" ] && chmod 600 "$HOME/rclone.conf" && echo "rclone.conf present" || echo "WARN no \$HOME/rclone.conf — sync will fail"
echo "setup ok $(git -C "$DIR" log --oneline -1)"
