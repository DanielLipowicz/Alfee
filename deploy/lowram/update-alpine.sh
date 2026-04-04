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
as_root rc-service "${SERVICE_NAME}" restart

echo "Done."
echo "Recent logs:"
as_root tail -n 50 /var/log/alfee.log
as_root tail -n 50 /var/log/alfee.err
