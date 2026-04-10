#!/usr/bin/env bash
set -euo pipefail

HOST="${XMPP_HOST:-root@172.234.238.175}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_SSH_KEY="$ROOT_DIR/../.ssh/id_rsa"
SSH_KEY="${XMPP_SSH_KEY:-$DEFAULT_SSH_KEY}"
REMOTE_DIR="${XMPP_REMOTE_DIR:-/root/.openclaw/workspace/oc-xmpp}"

SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes)

cat <<EOF
== XMPP VPN rollout staging helper ==
Host: $HOST
Remote dir: $REMOTE_DIR

This helper will:
1. run local build and tests
2. sync the plugin tree to the remote host
3. run remote npm install + build

It does NOT edit openclaw.json or restart the gateway.
Use docs/VPN-HOST-ROLLOUT.md for the full staged rollout.
EOF

echo
echo "[1/4] Local build"
cd "$ROOT_DIR"
npm run build

echo
echo "[2/4] Local tests"
npm test

if [[ ! -f "$SSH_KEY" ]]; then
  echo "SSH key not found: $SSH_KEY" >&2
  echo "Set XMPP_SSH_KEY to a readable private key path and retry." >&2
  exit 1
fi

echo
echo "[3/4] Sync to host"
"${SSH[@]}" "$HOST" "mkdir -p '$REMOTE_DIR'"
tar -C "$ROOT_DIR" --exclude=node_modules --exclude=dist --exclude=.git -cf - . \
  | "${SSH[@]}" "$HOST" "tar -C '$REMOTE_DIR' -xf -"

echo
echo "[4/4] Remote install + build"
"${SSH[@]}" "$HOST" "cd '$REMOTE_DIR' && npm install && npm run build"

echo
echo "Staging complete. Next steps:"
echo "- back up /root/.openclaw/openclaw.json"
echo "- enable narrow XMPP config"
echo "- restart gateway"
echo "- run through docs/CANARY.md"
