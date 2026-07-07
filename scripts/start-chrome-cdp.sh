#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
export CHROME_USER_DATA_DIR="${CHROME_USER_DATA_DIR:-/tmp/chrome-profile}"
export CHROME_REMOTE_DEBUGGING_ADDRESS="${CHROME_REMOTE_DEBUGGING_ADDRESS:-127.0.0.1}"
export CHROME_REMOTE_DEBUGGING_PORT="${CHROME_REMOTE_DEBUGGING_PORT:-9222}"
export CHROME_CDP_PROXY_ADDRESS="${CHROME_CDP_PROXY_ADDRESS:-0.0.0.0}"
export CHROME_CDP_PROXY_PORT="${CHROME_CDP_PROXY_PORT:-9223}"
export CHROME_WINDOW_SIZE="${CHROME_WINDOW_SIZE:-1920,1080}"
export CHROME_URL="${CHROME_URL:-about:blank}"

mkdir -p "$CHROME_USER_DATA_DIR" /tmp/.X11-unix

if command -v pulseaudio >/dev/null 2>&1; then
  pulseaudio --start --exit-idle-time=-1 || true
fi

Xvfb "$DISPLAY" -screen 0 "${CHROME_WINDOW_SIZE}x24" -ac +extension RANDR >/tmp/xvfb.log 2>&1 &
xvfb_pid="$!"

# Chrome races Xvfb startup and dies with "Missing X server" if launched before
# the display socket exists — wait for it (up to 5s).
x_socket="/tmp/.X11-unix/X${DISPLAY#:}"
for _ in $(seq 1 50); do
  [ -S "$x_socket" ] && break
  sleep 0.1
done
if [ ! -S "$x_socket" ]; then
  echo "Xvfb failed to create $x_socket:" >&2
  cat /tmp/xvfb.log >&2 || true
  exit 1
fi

cat >/tmp/chrome-cdp-nginx.conf <<EOF
pid /tmp/nginx.pid;
error_log /dev/stderr warn;

events {}

http {
  access_log off;
  client_body_temp_path /tmp/nginx-client-body;
  proxy_temp_path /tmp/nginx-proxy;
  fastcgi_temp_path /tmp/nginx-fastcgi;
  uwsgi_temp_path /tmp/nginx-uwsgi;
  scgi_temp_path /tmp/nginx-scgi;

  server {
    listen ${CHROME_CDP_PROXY_ADDRESS}:${CHROME_CDP_PROXY_PORT};

    location / {
      proxy_http_version 1.1;
      proxy_set_header Host 127.0.0.1:${CHROME_REMOTE_DEBUGGING_PORT};
      proxy_set_header Upgrade \$http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_pass http://127.0.0.1:${CHROME_REMOTE_DEBUGGING_PORT};
    }
  }
}
EOF

nginx -c /tmp/chrome-cdp-nginx.conf -g 'daemon off;' &
nginx_pid="$!"

cleanup() {
  kill "$nginx_pid" >/dev/null 2>&1 || true
  if [ -n "${chrome_pid:-}" ]; then
    kill "$chrome_pid" >/dev/null 2>&1 || true
  fi
  kill "$xvfb_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# Optional UA override. For Google-session logins this MUST match the UA the
# bot replays (GOOGLE_SESSION_USER_AGENT in src/lib/chromium.ts) — Google binds
# the session to the login device; a UA mismatch between login and replay makes
# it invalidate the session faster.
extra_args=()
if [ -n "${CHROME_USER_AGENT:-}" ]; then
  extra_args+=(--user-agent="$CHROME_USER_AGENT")
fi

google-chrome-stable \
  "${extra_args[@]}" \
  --remote-debugging-address="$CHROME_REMOTE_DEBUGGING_ADDRESS" \
  --remote-debugging-port="$CHROME_REMOTE_DEBUGGING_PORT" \
  --remote-allow-origins='*' \
  --user-data-dir="$CHROME_USER_DATA_DIR" \
  --window-size="$CHROME_WINDOW_SIZE" \
  --auto-accept-this-tab-capture \
  --autoplay-policy=no-user-gesture-required \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --no-sandbox \
  "$CHROME_URL" &
chrome_pid="$!"

wait -n "$nginx_pid" "$chrome_pid"
