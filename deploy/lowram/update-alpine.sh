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

NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
if [ "${NODE_MAJOR}" -lt 20 ]; then
  echo "ERROR: Node >= 20 is required. Installed: $(node -v)"
  exit 1
fi

npm_ci_prod() {
  npm_config_jobs=1 npm_config_progress=false npm_config_loglevel=warn NODE_OPTIONS=--max-old-space-size=128 npm ci --omit=dev --no-audit --no-fund
}

verify_dependencies() {
  node -e 'const pkg=require("./package.json"); for (const name of Object.keys(pkg.dependencies||{})) { try { require.resolve(name); } catch (err) { console.error("Missing dependency:", name); process.exit(1); } } try { require("sqlite3"); } catch (err) { console.error("sqlite3 load failed:", err.message); process.exit(1); } console.log("Dependency check OK");'
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
elif ! verify_dependencies >/dev/null 2>&1; then
  REASON="dependencies missing or broken"
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
if ! verify_dependencies; then
  echo "Dependency check failed. Reinstalling production dependencies..."
  rm -rf node_modules
  npm_ci_prod

  if ! verify_dependencies; then
    echo "sqlite3 load failed. Rebuilding sqlite3 from source for current Node..."
    npm_config_jobs=1 npm_config_progress=false npm_config_loglevel=warn NODE_OPTIONS=--max-old-space-size=128 npm rebuild sqlite3 --build-from-source
    verify_dependencies
  fi
fi

echo "[5/5] Restarting service..."
as_root rc-service "${SERVICE_NAME}" restart

echo "Done."
echo "Recent logs:"
as_root tail -n 50 /var/log/alfee.log
as_root tail -n 50 /var/log/alfee.err
