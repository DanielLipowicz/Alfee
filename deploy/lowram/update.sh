#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE_NAME="alfee"
REQUIRED_NODE_VERSION="v18.9.1"
REQUIRED_SQLITE3_VERSION="5.1.7"

cd "${APP_DIR}"
OLD_HEAD="$(git rev-parse HEAD)"

verify_node_version() {
  local current_node_version
  current_node_version="$(node -v)"
  if [[ "${current_node_version}" != "${REQUIRED_NODE_VERSION}" ]]; then
    echo "ERROR: Required Node version is ${REQUIRED_NODE_VERSION}. Installed: ${current_node_version}"
    exit 1
  fi
}

ensure_sqlite3_compat() {
  local installed_sqlite3_version
  installed_sqlite3_version="$(node -p 'try { require("sqlite3/package.json").version } catch (_) { "" }')"
  if [[ "${installed_sqlite3_version}" != "${REQUIRED_SQLITE3_VERSION}" ]]; then
    echo "Installing sqlite3@${REQUIRED_SQLITE3_VERSION} for Node ${REQUIRED_NODE_VERSION} compatibility..."
    npm_config_jobs=1 NODE_OPTIONS=--max-old-space-size=192 npm install --omit=dev --no-audit --no-fund "sqlite3@${REQUIRED_SQLITE3_VERSION}"
  fi
}

npm_ci_prod() {
  npm_config_jobs=1 NODE_OPTIONS=--max-old-space-size=192 npm ci --omit=dev --no-audit --no-fund
  ensure_sqlite3_compat
}

verify_dependencies() {
  node -e 'const pkg=require("./package.json"); const requiredSqliteVersion="5.1.7"; for (const name of Object.keys(pkg.dependencies||{})) { try { require.resolve(name); } catch (err) { console.error("Missing dependency:", name); process.exit(1); } } const sqliteVersion=require("sqlite3/package.json").version; if (sqliteVersion !== requiredSqliteVersion) { console.error("sqlite3 version mismatch:", sqliteVersion, "required:", requiredSqliteVersion); process.exit(1); } try { require("sqlite3"); } catch (err) { console.error("sqlite3 load failed:", err.message); process.exit(1); } console.log("Dependency check OK");'
}

echo "[1/5] Verifying Node version..."
verify_node_version

echo "[2/5] Pulling latest code..."
git pull --ff-only
NEW_HEAD="$(git rev-parse HEAD)"

echo "[3/5] Checking if dependency reinstall is required..."
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
  ensure_sqlite3_compat
fi

echo "[4/5] Ensuring runtime directories..."
mkdir -p data uploads

echo "[5/5] Restarting service..."
sudo systemctl restart "${SERVICE_NAME}"

echo "Done."
echo "Recent logs:"
sudo journalctl -u "${SERVICE_NAME}" -n 50 --no-pager
