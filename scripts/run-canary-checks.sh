#!/usr/bin/env bash
set -euo pipefail

# Lightweight helper for manual XMPP canary runs.
# This does not send XMPP messages by itself. It helps validate the local plugin
# tree, reminds the operator what to test next, and tails useful logs.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_CMD_DEFAULT='journalctl --user -u openclaw-gateway.service -n 200 -f'
LOG_CMD="${XMPP_CANARY_LOG_CMD:-$LOG_CMD_DEFAULT}"

cat <<'EOF'
== XMPP Canary Helper ==

This helper assumes you will perform the actual DM/MUC message sends manually
from test accounts while watching the gateway logs.

Suggested flow:
1. Confirm the plugin builds and tests cleanly.
2. Deploy the intended commit to the canary host.
3. Enable XMPP with a non-production account and a test room.
4. Tail logs in a second terminal.
5. Run through docs/CANARY.md step by step.
EOF

echo
echo "[1/3] Build"
cd "$ROOT_DIR"
npm run build

echo
echo "[2/3] Test"
npm test

echo
echo "[3/3] Log tail command"
printf '%s\n' "$LOG_CMD"

echo
echo "Next: open docs/CANARY.md and run the staged DM/MUC/OMEMO checks."
