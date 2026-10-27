#!/usr/bin/env bash
# Updates the game on the VPS to the latest main and restarts it (deploy/README.md):
#   sudo /opt/ursim/deploy/update.sh
# Games run in the players' browsers, so a restart doesn't interrupt them.
set -euo pipefail
cd /opt/ursim
as_ursim() { sudo -u ursim -H "$@"; }

as_ursim git pull --ff-only
as_ursim npm ci --include=dev
as_ursim npm run build
as_ursim npm run build:server
systemctl restart ursim
echo "Running $(as_ursim git log -1 --format='%h %s')"
