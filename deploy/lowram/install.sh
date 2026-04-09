#!/usr/bin/env bash
set -euo pipefail

# Ultra-light deployment for tiny VPS:
# - no Docker
# - systemd service
# - Node memory cap

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE_NAME="alfee"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
NODE_BIN="/usr/bin/node"
RUN_USER="${SUDO_USER:-$USER}"
RUN_GROUP="$(id -gn "$RUN_USER")"

if [[ ! -f "${APP_DIR}/package.json" || ! -f "${APP_DIR}/server.js" ]]; then
  echo "ERROR: Run this script from inside the Alfee repository."
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "ERROR: This installer supports Debian/Ubuntu (apt-get) only."
  exit 1
fi

echo "[1/7] Installing system dependencies..."
sudo apt-get update
sudo apt-get install -y --no-install-recommends ca-certificates curl gnupg git nodejs npm python3 make g++

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node was not installed."
  exit 1
fi

NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
if [[ "${NODE_MAJOR}" -lt 24 ]]; then
  echo "[2/7] Node <24 detected, upgrading to Node 24..."
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y --no-install-recommends nodejs
fi

echo "[3/7] Installing app dependencies (production only)..."
cd "${APP_DIR}"
npm_config_jobs=1 NODE_OPTIONS=--max-old-space-size=192 npm ci --omit=dev --no-audit --no-fund

verify_dependencies() {
  node -e 'const pkg=require("./package.json"); for (const name of Object.keys(pkg.dependencies||{})) { try { require.resolve(name); } catch (err) { console.error("Missing dependency:", name); process.exit(1); } } try { require("sqlite3"); } catch (err) { console.error("sqlite3 load failed:", err.message); process.exit(1); } console.log("Dependency check OK");'
}

echo "[4/7] Creating runtime directories..."
mkdir -p data uploads

if [[ ! -f "${APP_DIR}/.env" ]]; then
  echo "[5/7] Creating .env from example..."
  cp .env.example .env
fi

echo "[6/7] Verifying installed modules..."
if ! verify_dependencies; then
  echo "sqlite3 load failed. Rebuilding sqlite3 from source for current Node..."
  npm_config_jobs=1 NODE_OPTIONS=--max-old-space-size=192 npm rebuild sqlite3 --build-from-source
  verify_dependencies
fi

echo "[7/7] Writing and starting systemd service..."
sudo tee "${SERVICE_FILE}" >/dev/null <<EOF
[Unit]
Description=Alfee Node.js app (low RAM mode)
After=network.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_GROUP}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
Environment=NODE_ENV=production
Environment=PORT=20120
Environment=NODE_OPTIONS=--max-old-space-size=96
ExecStart=${NODE_BIN} ${APP_DIR}/server.js
Restart=always
RestartSec=3
MemoryMax=180M
NoNewPrivileges=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE_NAME}"

if command -v ufw >/dev/null 2>&1; then
  sudo ufw allow 20120/tcp || true
fi

echo
echo "Done."
echo "Now edit ${APP_DIR}/.env and set at least:"
echo "  PORT=20120"
echo "  SESSION_SECRET=<strong-random-secret>"
echo "  GOOGLE_CALLBACK_URL=https://twoja-domena/auth/google/callback"
echo "  TRUST_PROXY=1"
echo "  SESSION_COOKIE_SECURE=auto"
echo
echo "Then restart:"
echo "  sudo systemctl restart ${SERVICE_NAME}"
echo
echo "Check status/logs:"
echo "  sudo systemctl status ${SERVICE_NAME} --no-pager"
echo "  journalctl -u ${SERVICE_NAME} -n 100 --no-pager"
