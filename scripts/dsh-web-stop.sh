#!/usr/bin/env bash
# Stop DSH Web and the redirect service.

set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PID_FILE="$DSH_HOME/dsh-web-pids.txt"

if [ ! -f "$PID_FILE" ]; then
    echo "PID file not found: $PID_FILE"
    echo "DSH Web may not be running via dsh-web-start.sh"
    exit 0
fi

read DSH_PID REDIRECT_PID < "$PID_FILE"

echo "Stopping redirect service (PID: $REDIRECT_PID)..."
kill "$REDIRECT_PID" 2>/dev/null || echo "  (already stopped)"

echo "Stopping DSH Web (PID: $DSH_PID)..."
kill "$DSH_PID" 2>/dev/null || echo "  (already stopped)"

rm -f "$PID_FILE"
echo "DSH Web stopped."
