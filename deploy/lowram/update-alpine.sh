#!/usr/bin/env sh
set -eu

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
SERVICE_NAME="alfee"
REQUIRED_NODE_VERSION="v18.9.1"
REQUIRED_SQLITE3_VERSION="5.1.7"

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "ERROR: root or sudo is required."
    exit 1
  fi
}

cd "${APP_DIR}"
OLD_HEAD="$(git rev-parse HEAD)"

verify_node_version() {
  CURRENT_NODE_VERSION="$(node -v)"
  if [ "${CURRENT_NODE_VERSION}" != "${REQUIRED_NODE_VERSION}" ]; then
    echo "ERROR: Required Node version is ${REQUIRED_NODE_VERSION}. Installed: ${CURRENT_NODE_VERSION}"
    exit 1
  fi
}

ensure_sqlite3_compat() {
  INSTALLED_SQLITE3_VERSION="$(node -p 'try { require("sqlite3/package.json").version } catch (_) { "" }')"
  if [ "${INSTALLED_SQLITE3_VERSION}" != "${REQUIRED_SQLITE3_VERSION}" ]; then
    echo "Installing sqlite3@${REQUIRED_SQLITE3_VERSION} for Node ${REQUIRED_NODE_VERSION} compatibility..."
    npm_config_jobs=1 npm_config_progress=false npm_config_loglevel=warn NODE_OPTIONS=--max-old-space-size=128 npm install --omit=dev --no-audit --no-fund "sqlite3@${REQUIRED_SQLITE3_VERSION}"
  fi
}

npm_ci_prod() {
  npm_config_jobs=1 npm_config_progress=false npm_config_loglevel=warn NODE_OPTIONS=--max-old-space-size=128 npm ci --omit=dev --no-audit --no-fund
  ensure_sqlite3_compat
}

verify_dependencies() {
  node -e 'const pkg=require("./package.json"); const requiredSqliteVersion="5.1.7"; for (const name of Object.keys(pkg.dependencies||{})) { try { require.resolve(name); } catch (err) { console.error("Missing dependency:", name); process.exit(1); } } const sqliteVersion=require("sqlite3/package.json").version; if (sqliteVersion !== requiredSqliteVersion) { console.error("sqlite3 version mismatch:", sqliteVersion, "required:", requiredSqliteVersion); process.exit(1); } try { require("sqlite3"); } catch (err) { console.error("sqlite3 load failed:", err.message); process.exit(1); } console.log("Dependency check OK");'
}

echo "[1/6] Verifying Node version..."
verify_node_version

echo "[2/6] Pulling latest code..."
git pull --ff-only
NEW_HEAD="$(git rev-parse HEAD)"

echo "[3/6] Checking if dependency reinstall is required..."
REASON=""
if git diff --name-only "${OLD_HEAD}" "${NEW_HEAD}" | grep -Eq '(^|/)package(-lock)?\.json$'; then
  REASON="package files changed"
elif [ ! -d node_modules ]; then
  REASON="node_modules missing"
elif ! verify_dependencies >/dev/null 2>&1; then
  REASON="dependencies missing or broken"
fi

if [ -n "${REASON}" ]; then
  echo "${REASON}, running npm ci..."
  npm_ci_prod
else
  echo "package files unchanged and node_modules healthy, skipping npm ci."
  ensure_sqlite3_compat
fi

echo "[4/6] Ensuring runtime directories..."
mkdir -p data uploads

echo "[5/6] Verifying runtime dependencies..."
if ! verify_dependencies; then
  echo "Dependency check failed. Reinstalling production dependencies..."
  rm -rf node_modules
  npm_ci_prod

  if ! verify_dependencies; then
    echo "sqlite3 check failed. Reinstalling sqlite3@${REQUIRED_SQLITE3_VERSION}..."
    npm_config_jobs=1 npm_config_progress=false npm_config_loglevel=warn NODE_OPTIONS=--max-old-space-size=128 npm install --omit=dev --no-audit --no-fund "sqlite3@${REQUIRED_SQLITE3_VERSION}"
    verify_dependencies
  fi
fi

echo "[6/6] Restarting service..."
as_root rc-service "${SERVICE_NAME}" restart

echo "Done."
echo "Recent logs:"
as_root tail -n 50 /var/log/alfee.log
as_root tail -n 50 /var/log/alfee.err
