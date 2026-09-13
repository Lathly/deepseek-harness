#!/usr/bin/env bash
# Write the current DSH web access URLs to ~/.dsh/web-auth-url.txt.
#
# The stable bookmark (via the Tailscale serve proxy + redirect service)
# is the phone entry point; the loopback token URL is for the desktop.
# DSH writes the launch token to ~/.dsh/web-launch-token at startup,
# so a systemd timer re-runs this script to pick up restarts.

set -euo pipefail

URL_FILE="${DSH_WEB_URL_FILE:-$HOME/.dsh/web-auth-url.txt}"

if [ ! -f "$HOME/.dsh/web-launch-token" ]; then
    echo "No web-launch-token found. Is DSH web running?" >&2
    echo "Expected file: $HOME/.dsh/web-launch-token" >&2
    exit 1
fi

TOKEN=$(cat "$HOME/.dsh/web-launch-token")
PORT="${DSH_WEB_PORT:-3080}"
TAILSCALE_HOST=$(tailscale hostname 2>/dev/null || echo "pop-os.taildc49b0.ts.net")

cat > "$URL_FILE" <<EOF
bookmark: https://${TAILSCALE_HOST}/
loopback: http://127.0.0.1:${PORT}/?token=${TOKEN}
EOF

echo "URLs written to $URL_FILE"
echo "Phone bookmark: https://${TAILSCALE_HOST}/"
