#!/bin/bash
# Removes WatchHouse from the CEP extensions folder. Project settings
# (*.watchhouse.json next to your projects) are kept.
set -euo pipefail
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/WatchHouse"
if [ -L "$DEST" ]; then
  rm "$DEST"
elif [ -d "$DEST" ]; then
  rm -r "$DEST"
else
  echo "WatchHouse is not installed."
  exit 0
fi
echo "Removed $DEST. Restart Premiere Pro / After Effects."
