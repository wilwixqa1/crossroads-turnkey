#!/usr/bin/env bash
# The newest session context file must say what code comments were added (or "none needed").
# This makes a skipped comments step fail the gate instead of passing silently.
set -euo pipefail
latest=$(ls docs/sessions/T*_CONTEXT.md | sort | tail -1)
if ! grep -q "^## Code comments" "$latest"; then
  echo "$latest has no '## Code comments' section; close-out step 1 not recorded"
  exit 1
fi
echo "$latest records the code comments step"
