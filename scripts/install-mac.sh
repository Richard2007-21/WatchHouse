#!/bin/bash
# Installs WatchHouse for Premiere Pro and After Effects on macOS.
#   ./scripts/install-mac.sh          copy the extension (for users)
#   ./scripts/install-mac.sh --link   symlink this folder (for development)
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/WatchHouse"

# Unsigned extensions need PlayerDebugMode (CSXS 9 = 2020, 12 = 2025+).
for v in 9 10 11 12; do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1
done

mkdir -p "$(dirname "$DEST")"
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  echo "WatchHouse is already installed at: $DEST"
  echo "Run ./scripts/uninstall-mac.sh first to replace it."
  exit 1
fi

if [ "${1:-}" = "--link" ]; then
  ln -s "$SRC" "$DEST"
  echo "Linked $SRC -> $DEST"
else
  mkdir -p "$DEST"
  for item in CSXS client host lib LICENSE; do
    cp -R "$SRC/$item" "$DEST/"
  done
  echo "Copied to $DEST"
fi
echo "Restart Premiere Pro / After Effects, then open Window > Extensions > WatchHouse."
