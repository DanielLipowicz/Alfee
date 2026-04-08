#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE_NAME="alfee"

cd "${APP_DIR}"
OLD_HEAD="$(git rev-parse HEAD)"

npm_ci_prod() {
  npm_config_jobs=1 NODE_OPTIONS=--max-old-space-size=192 npm ci --omit=dev --no-audit --no-fund
}

echo "[1/4] Pulling latest code..."
git pull --ff-only
NEW_HEAD="$(git rev-parse HEAD)"

echo "[2/4] Checking if dependency reinstall is required..."
REASON=""
if git diff --name-only "${OLD_HEAD}" "${NEW_HEAD}" | grep -Eq '(^|/)package(-lock)?\.json$'; then
  REASON="package files changed"
elif [[ ! -d node_modules ]]; then
  REASON="node_modules missing"
elif ! node -e "require.resolve('express')" >/dev/null 2>&1; then
  REASON="express missing from node_modules"
fi

if [[ -n "${REASON}" ]]; then
  echo "${REASON}, running npm ci..."
  npm_ci_prod
else
  echo "package files unchanged and node_modules healthy, skipping npm ci."
fi

echo "[3/4] Ensuring runtime directories..."
mkdir -p data uploads

echo "[4/4] Restarting service..."
sudo systemctl restart "${SERVICE_NAME}"

echo "Done."
echo "Recent logs:"
sudo journalctl -u "${SERVICE_NAME}" -n 50 --no-pager
