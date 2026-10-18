#!/bin/bash
# Double-click to install WatchHouse for Premiere Pro and After Effects (macOS).
cd "$(dirname "$0")"
./scripts/install-mac.sh
echo
read -n 1 -s -r -p "Press any key to close this window."
