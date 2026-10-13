#!/usr/bin/env bash
#
# Stops the QA environment started by start.sh and deletes its data.
#
#   scripts/qa-environment/stop.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/qa-environment/compose.sh
. "$SCRIPT_DIR/compose.sh"

compose down --volumes --remove-orphans
# The uuids of the seeded people die with the directory
rm -f "$GENERATED_DIR/people.json"
echo "==> QA environment '$QA_PROJECT' stopped"
