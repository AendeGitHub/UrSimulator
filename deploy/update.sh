#!/usr/bin/env bash
# Updates the game on the VPS to the latest main and restarts it (deploy/README.md):
#   sudo /opt/ursim/deploy/update.sh          (waits for an empty server)
#   sudo /opt/ursim/deploy/update.sh --now    (ends the games being played)
set -euo pipefail
cd /opt/ursim
as_ursim() { sudo -u ursim -H "$@"; }

players=$(curl -s localhost:8787/health | grep -o '"players":[0-9]*' | cut -d: -f2 || true)
if [ "${players:-0}" != 0 ] && [ "${1:-}" != --now ]; then
  echo "$players players are online and a restart ends their games. Try later, or add --now."
  exit 1
fi

as_ursim git pull --ff-only
as_ursim npm ci --include=dev
as_ursim npm run build
as_ursim npm run build:server
systemctl restart ursim
echo "Running $(as_ursim git log -1 --format='%h %s')"
