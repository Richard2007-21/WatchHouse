#!/bin/bash
# Builds dist/WatchHouse.zip for a GitHub release: the extension, the install
# scripts and the READMEs, in one folder "WatchHouse".
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
STAGE="$DIST/stage/WatchHouse"
rm -rf "$DIST/stage" "$DIST/WatchHouse.zip"
mkdir -p "$STAGE/scripts"
for item in CSXS client host lib LICENSE README.md README.de.md CHANGELOG.md "Install WatchHouse.command"; do
  cp -R "$ROOT/$item" "$STAGE/"
done
cp "$ROOT"/scripts/install-mac.sh "$ROOT"/scripts/uninstall-mac.sh "$ROOT"/scripts/install-windows.ps1 "$ROOT"/scripts/install-windows.cmd "$STAGE/scripts/"
(cd "$DIST/stage" && zip -qry "$DIST/WatchHouse.zip" WatchHouse -x '*.DS_Store')
rm -rf "$DIST/stage"
echo "Built $DIST/WatchHouse.zip"
