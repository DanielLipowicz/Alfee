#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE_NAME="alfee"

cd "${APP_DIR}"
OLD_HEAD="$(git rev-parse HEAD)"

echo "[1/4] Pulling latest code..."
git pull --ff-only
NEW_HEAD="$(git rev-parse HEAD)"

echo "[2/4] Checking if dependency reinstall is required..."
if git diff --name-only "${OLD_HEAD}" "${NEW_HEAD}" | grep -Eq '(^|/)package(-lock)?\.json$'; then
  echo "package files changed, running npm ci..."
  npm_config_jobs=1 NODE_OPTIONS=--max-old-space-size=192 npm ci --omit=dev --no-audit --no-fund
else
  echo "package files unchanged, skipping npm ci."
fi

echo "[3/4] Ensuring runtime directories..."
mkdir -p data uploads

echo "[4/4] Restarting service..."
sudo systemctl restart "${SERVICE_NAME}"

echo "Done."
echo "Recent logs:"
sudo journalctl -u "${SERVICE_NAME}" -n 50 --no-pager
