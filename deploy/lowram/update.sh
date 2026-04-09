#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE_NAME="alfee"

cd "${APP_DIR}"
OLD_HEAD="$(git rev-parse HEAD)"

NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
if [[ "${NODE_MAJOR}" -lt 24 ]]; then
  echo "ERROR: Node >= 24 is required. Installed: $(node -v)"
  exit 1
fi

npm_ci_prod() {
  npm_config_jobs=1 NODE_OPTIONS=--max-old-space-size=192 npm ci --omit=dev --no-audit --no-fund
}

verify_dependencies() {
  node -e 'const pkg=require("./package.json"); for (const name of Object.keys(pkg.dependencies||{})) { try { require.resolve(name); } catch (err) { console.error("Missing dependency:", name); process.exit(1); } } try { require("sqlite3"); } catch (err) { console.error("sqlite3 load failed:", err.message); process.exit(1); } console.log("Dependency check OK");'
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
elif ! verify_dependencies >/dev/null 2>&1; then
  REASON="dependencies missing or broken"
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
