#!/usr/bin/env bash
# Create dist/trace-browser-extension-amo-source.zip for Mozilla AMO source submission (tracked files only).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p dist
OUT="$ROOT/dist/trace-browser-extension-amo-source.zip"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
    echo "Error: working tree has uncommitted changes. Commit the release candidate before creating the AMO source archive." >&2
    exit 1
  fi
  git archive --format=zip -o "$OUT" HEAD
  echo "Wrote $OUT"
else
  echo "Error: not a git repository. Run this from the repository root." >&2
  exit 1
fi
