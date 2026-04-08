#!/usr/bin/env sh
set -eu

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
SERVICE_NAME="alfee"

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

npm_ci_prod() {
  npm_config_jobs=1 npm_config_progress=false npm_config_loglevel=warn NODE_OPTIONS=--max-old-space-size=128 npm ci --omit=dev --no-audit --no-fund
}

echo "[1/5] Pulling latest code..."
git pull --ff-only
NEW_HEAD="$(git rev-parse HEAD)"

echo "[2/5] Checking if dependency reinstall is required..."
REASON=""
if git diff --name-only "${OLD_HEAD}" "${NEW_HEAD}" | grep -Eq '(^|/)package(-lock)?\.json$'; then
  REASON="package files changed"
elif [ ! -d node_modules ]; then
  REASON="node_modules missing"
elif ! node -e "require.resolve('express')" >/dev/null 2>&1; then
  REASON="express missing from node_modules"
fi

if [ -n "${REASON}" ]; then
  echo "${REASON}, running npm ci..."
  npm_ci_prod
else
  echo "package files unchanged and node_modules healthy, skipping npm ci."
fi

echo "[3/5] Ensuring runtime directories..."
mkdir -p data uploads

echo "[4/5] Verifying runtime dependencies..."
if ! node -e "require('express'); require('sqlite3'); console.log('Dependency check OK')"; then
  echo "Dependency check failed. Reinstalling production dependencies..."
  rm -rf node_modules
  npm_ci_prod

  if ! node -e "require('express'); require('sqlite3'); console.log('Dependency check OK')"; then
    echo "Default sqlite3 binary failed. Trying compatible prebuilt sqlite3@5.1.7..."
    npm_config_jobs=1 npm_config_progress=false npm_config_loglevel=warn NODE_OPTIONS=--max-old-space-size=128 npm install --omit=dev --no-audit --no-fund sqlite3@5.1.7
    node -e "require('express'); require('sqlite3'); console.log('Dependency check OK')"
  fi
fi

echo "[5/5] Restarting service..."
as_root rc-service "${SERVICE_NAME}" restart

echo "Done."
echo "Recent logs:"
as_root tail -n 50 /var/log/alfee.log
as_root tail -n 50 /var/log/alfee.err
