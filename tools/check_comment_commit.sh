#!/usr/bin/env bash
# Comment-only commits must not delete anything. A commit whose message starts with "comments:"
# fails the gate if its diff removes even one line. This is what stops "adding a note" from
# quietly deleting real code.
set -euo pipefail
msg=$(git log -1 --pretty=%s)
if [[ "$msg" == comments:* ]]; then
  removed=$(git diff --numstat HEAD~1 HEAD | awk '{s+=$2} END {print s+0}')
  if [[ "$removed" != "0" ]]; then
    echo "comments-only commit removed $removed line(s); refusing"
    git diff --numstat HEAD~1 HEAD
    exit 1
  fi
  echo "comments-only commit: 0 lines removed"
fi
