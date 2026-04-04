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

echo "[1/6] Installing system dependencies..."
sudo apt-get update
sudo apt-get install -y --no-install-recommends ca-certificates curl gnupg git nodejs npm

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node was not installed."
  exit 1
fi

NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
if [[ "${NODE_MAJOR}" -lt 18 ]]; then
  echo "[2/6] Node <18 detected, upgrading to Node 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y --no-install-recommends nodejs
fi

echo "[3/6] Installing app dependencies (production only)..."
cd "${APP_DIR}"
npm_config_jobs=1 NODE_OPTIONS=--max-old-space-size=192 npm ci --omit=dev --no-audit --no-fund

echo "[4/6] Creating runtime directories..."
mkdir -p data uploads

if [[ ! -f "${APP_DIR}/.env" ]]; then
  echo "[5/6] Creating .env from example..."
  cp .env.example .env
fi

echo "[6/6] Writing and starting systemd service..."
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
echo "  GOOGLE_CALLBACK_URL=http://frog01.mikr.us:20120/auth/google/callback"
echo
echo "Then restart:"
echo "  sudo systemctl restart ${SERVICE_NAME}"
echo
echo "Check status/logs:"
echo "  sudo systemctl status ${SERVICE_NAME} --no-pager"
echo "  journalctl -u ${SERVICE_NAME} -n 100 --no-pager"
