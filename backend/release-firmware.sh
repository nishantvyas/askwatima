#!/usr/bin/env bash
#
# Publishes a firmware build for OTA.
#
#   ./release-firmware.sh              # stage at 0% - uploaded, nobody gets it
#   ./release-firmware.sh 10           # roll out to 10% of devices
#   ./release-firmware.sh 100          # everyone
#   ./release-firmware.sh pause        # stop the rollout immediately
#
# Rollout percentage is evaluated on the device against a stable bucket derived
# from its MAC, so the same units form the canary cohort every release rather
# than a fresh random draw each time.
set -euo pipefail

PROJECT=watima-7d274
BUCKET=gs://watima-7d274-firmware
FW=../firmware/build/watima.bin
DESC=../firmware/build/project_description.json

cd "$(dirname "$0")"

if [ "${1:-}" = "pause" ]; then
  gcloud firestore documents update "firmware/current" \
    --project="$PROJECT" --update-mask=paused \
    --data='{"paused":{"booleanValue":true}}' 2>/dev/null \
    || python3 ./fwctl.py pause
  echo "rollout PAUSED"
  exit 0
fi

PCT="${1:-0}"
[ -f "$FW" ] || { echo "no build at $FW - run idf.py build first"; exit 1; }

VERSION=$(python3 -c "import json;print(json.load(open('$DESC'))['project_version'])")
SIZE=$(stat -f%z "$FW")
SHA=$(shasum -a 256 "$FW" | cut -d' ' -f1)
PATHNAME="watima-${VERSION}.bin"

echo "version : $VERSION"
echo "size    : $SIZE bytes"
echo "sha256  : $SHA"
echo "rollout : ${PCT}%"

gcloud storage cp "$FW" "$BUCKET/$PATHNAME" --project="$PROJECT" -q
python3 ./fwctl.py publish "$VERSION" "$SIZE" "$SHA" "$PATHNAME" "$PCT"
echo "published."
