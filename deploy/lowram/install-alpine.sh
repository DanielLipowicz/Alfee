#!/usr/bin/env sh
set -eu

# Ultra-light deployment for Alpine:
# - no Docker
# - OpenRC service
# - low memory limits for Node

APP_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
SERVICE_NAME="alfee"
INITD_FILE="/etc/init.d/${SERVICE_NAME}"
CONF_FILE="/etc/conf.d/${SERVICE_NAME}"

if [ ! -f "${APP_DIR}/package.json" ] || [ ! -f "${APP_DIR}/server.js" ]; then
  echo "ERROR: Run this script from inside the Alfee repository."
  exit 1
fi

if ! command -v apk >/dev/null 2>&1; then
  echo "ERROR: This installer supports Alpine Linux (apk) only."
  exit 1
fi

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

echo "[1/8] Installing system dependencies..."
as_root apk add --no-cache ca-certificates curl git nodejs npm python3 build-base libstdc++ linux-headers

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node was not installed."
  exit 1
fi

echo "[2/8] Verifying Node version..."
NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
if [ "${NODE_MAJOR}" -lt 20 ]; then
  echo "ERROR: Node >= 20 is required. Installed: $(node -v)"
  exit 1
fi

echo "[3/8] Installing app dependencies (production only)..."
cd "${APP_DIR}"
npm_config_jobs=1 npm_config_progress=false npm_config_loglevel=warn NODE_OPTIONS=--max-old-space-size=128 npm ci --omit=dev --no-audit --no-fund

verify_dependencies() {
  node -e 'const pkg=require("./package.json"); for (const name of Object.keys(pkg.dependencies||{})) { try { require.resolve(name); } catch (err) { console.error("Missing dependency:", name); process.exit(1); } } try { require("sqlite3"); } catch (err) { console.error("sqlite3 load failed:", err.message); process.exit(1); } console.log("Dependency check OK");'
}

echo "[4/8] Creating runtime directories..."
mkdir -p data uploads

if [ ! -f "${APP_DIR}/.env" ]; then
  echo "[5/8] Creating .env from example..."
  cp .env.example .env
fi

echo "[6/8] Verifying installed modules..."
if ! verify_dependencies; then
  echo "sqlite3 load failed. Rebuilding sqlite3 from source for current Node..."
  npm_config_jobs=1 npm_config_progress=false npm_config_loglevel=warn NODE_OPTIONS=--max-old-space-size=128 npm rebuild sqlite3 --build-from-source
  verify_dependencies
fi

echo "[7/8] Writing OpenRC service..."
as_root sh -c "cat > '${INITD_FILE}'" <<EOF
#!/sbin/openrc-run
name="Alfee app"
description="Alfee Node.js app (low RAM mode)"

command="/usr/bin/node"
command_args="${APP_DIR}/server.js"
command_user="root"
directory="${APP_DIR}"
pidfile="/run/\${RC_SVCNAME}.pid"
command_background="yes"
output_log="/var/log/alfee.log"
error_log="/var/log/alfee.err"

depend() {
  need net
}

start_pre() {
  if [ -f "${CONF_FILE}" ]; then
    . "${CONF_FILE}"
  fi
  export NODE_ENV="\${NODE_ENV:-production}"
  export PORT="\${PORT:-20120}"
  export NODE_OPTIONS="\${NODE_OPTIONS:---max-old-space-size=96}"

  if [ -f "${APP_DIR}/.env" ]; then
    while IFS= read -r line; do
      case "\$line" in
        ''|\#*) continue ;;
      esac
      key=\${line%%=*}
      val=\${line#*=}
      export "\$key=\$val"
    done < "${APP_DIR}/.env"
  fi
}
EOF

as_root chmod +x "${INITD_FILE}"

echo "[8/8] Writing OpenRC config and starting service..."
as_root sh -c "cat > '${CONF_FILE}'" <<EOF
# Alfee OpenRC runtime config
NODE_ENV=production
PORT=20120
NODE_OPTIONS=--max-old-space-size=96
EOF

as_root touch /var/log/alfee.log /var/log/alfee.err
as_root rc-update add "${SERVICE_NAME}" default
as_root rc-service "${SERVICE_NAME}" restart || as_root rc-service "${SERVICE_NAME}" start

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
echo "  rc-service ${SERVICE_NAME} restart"
echo
echo "Check status/logs:"
echo "  rc-service ${SERVICE_NAME} status"
echo "  tail -n 100 /var/log/alfee.log"
echo "  tail -n 100 /var/log/alfee.err"
