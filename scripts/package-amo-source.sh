#!/usr/bin/env bash
# Create dist/trace-browser-extension-amo-source.zip for Mozilla AMO source submission (tracked files only).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p dist
OUT="$ROOT/dist/trace-browser-extension-amo-source.zip"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git archive --format=zip -o "$OUT" HEAD
  echo "Wrote $OUT"
  echo "Tip: commit README.mozilla.md and build changes before packaging so the archive is current."
else
  echo "Error: not a git repository. Run this from the repository root." >&2
  exit 1
fi
