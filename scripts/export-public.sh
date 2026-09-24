#!/bin/bash
# Build a clean tree for a brand-new public repo.
# This history stays private: it contains the factory flash dump.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dest="${1:-"$root/../watima-public"}"

if [ -e "$dest" ]; then
  echo "refusing to overwrite $dest" >&2
  exit 1
fi

mkdir -p "$dest"
rsync -a \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'firmware/build/' \
  --exclude 'firmware/managed_components/' \
  --exclude 'firmware/sdkconfig' \
  --exclude 'firmware/sdkconfig.old' \
  --exclude 'firmware/dependencies.lock' \
  --exclude 'backend/web/dist/' \
  --exclude 'backend/public/app/' \
  --exclude 'backend/.firebase/' \
  --exclude 'backups/' \
  --exclude 'vendor-waveshare/' \
  --exclude '.gemini' \
  --exclude '.wifi' \
  --exclude 'firmware/main/secrets.h' \
  --exclude 'backend/functions/.env' \
  --exclude 'backend/functions/.secret.local' \
  --exclude 'TODO.md' \
  --exclude 'docs/' \
  --exclude 'assets/*.HEIC' \
  --exclude 'assets/*.heic' \
  --exclude '.DS_Store' \
  "$root/" "$dest/"

# Internal notes are not in this tree. Drop the index that points at them.
python3 - "$dest/README.md" << 'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text()
start = text.find("**Further reading**")
end = text.find("## Status")
if start != -1 and end != -1 and start < end:
    text = text[:start] + text[end:]
    p.write_text(text)
PY

echo "public tree: $dest"
