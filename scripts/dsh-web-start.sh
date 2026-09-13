#!/usr/bin/env bash
# Start DSH Web and the redirect service together.
# This script:
# 1. Starts DSH Web
# 2. Captures the authenticated URL
# 3. Writes it to ~/.dsh/web-auth-url.txt
# 4. Starts the redirect service on port 3090

set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
URL_FILE="$DSH_HOME/web-auth-url.txt"
REDIRECT_PORT=3090

echo "Starting DSH Web..."

# Start DSH Web in the background
# We capture its output to extract the authenticated URL
DSH_LOG=$(mktemp)
dsh web > "$DSH_LOG" 2>&1 &
DSH_PID=$!

# Wait for DSH to be ready and extract the URL
echo "Waiting for DSH to start..."
MAX_WAIT=30
WAITED=0
URL=""
while [ $WAITED -lt $MAX_WAIT ]; do
    if grep -q "dsh web:" "$DSH_LOG" 2>/dev/null; then
        # Extract the URL from DSH's output
        URL=$(grep "dsh web:" "$DSH_LOG" | head -1 | sed 's/.*dsh web: //' | sed 's/ (LAN:.*//')
        break
    fi
    sleep 1
    WAITED=$((WAITED + 1))
done

if [ -z "$URL" ]; then
    echo "DSH did not become ready within ${MAX_WAIT}s"
    cat "$DSH_LOG"
    exit 1
fi

echo "DSH started: $URL"

# Now write the authenticated URL file with all access variants
TOKEN=$(echo "$URL" | sed 's/.*token=//')
PORT=$(echo "$URL" | sed 's/.*:\([0-9]*\)\/.*/\1/')
TAILSCALE_HOST=$(tailscale hostname 2>/dev/null || echo "pop-os.taildc49b0.ts.net")

cat > "$URL_FILE" <<EOF
loopback: http://127.0.0.1:${PORT}/?token=${TOKEN}
tailscale-host: http://${TAILSCALE_HOST}:${PORT}/?token=${TOKEN}
tailscale-ip: http://100.69.236.5:${PORT}/?token=${TOKEN}
EOF

echo "Wrote auth URLs to $URL_FILE"
echo "Phone bookmark URL: http://${TAILSCALE_HOST}:${REDIRECT_PORT}/dsh"

# Start the redirect service
echo "Starting redirect service on port ${REDIRECT_PORT}..."
python3 "$(dirname "$0")/dsh-web-redirect.py" --port $REDIRECT_PORT &
REDIRECT_PID=$!

echo "DSH PID: $DSH_PID"
echo "Redirect PID: $REDIRECT_PID"
echo "PIDs written to $DSH_HOME/dsh-web-pids.txt"
echo "$DSH_PID $REDIRECT_PID" > "$DSH_HOME/dsh-web-pids.txt"

# Wait for DSH to exit (keep the script running)
wait $DSH_PID
