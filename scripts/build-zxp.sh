#!/bin/bash
# Builds a signed .zxp package for distribution (e.g. GitHub releases).
# Needs Adobe's ZXPSignCmd: https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD
#   ZXPSIGN=/path/to/ZXPSignCmd CERT_PASSWORD=secret ./scripts/build-zxp.sh
# Without a certificate a self-signed one is created in dist/cert.p12.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ZXPSIGN="${ZXPSIGN:-ZXPSignCmd}"
PASS="${CERT_PASSWORD:?Set CERT_PASSWORD}"
VERSION="$(sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p' "$ROOT/CSXS/manifest.xml")"
DIST="$ROOT/dist"
STAGE="$DIST/stage/WatchHouse"
CERT="${CERT:-$DIST/cert.p12}"
OUT="$DIST/WatchHouse-$VERSION.zxp"

rm -rf "$DIST/stage" "$OUT"
mkdir -p "$STAGE"
for item in CSXS client host lib LICENSE; do
  cp -R "$ROOT/$item" "$STAGE/"
done

if [ ! -f "$CERT" ]; then
  "$ZXPSIGN" -selfSignedCert DE NRW WatchHouse WatchHouse "$PASS" "$CERT"
fi
"$ZXPSIGN" -sign "$STAGE" "$OUT" "$CERT" "$PASS" -tsa http://timestamp.digicert.com
rm -rf "$DIST/stage"
echo "Built $OUT"
