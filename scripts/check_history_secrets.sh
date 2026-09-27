#!/usr/bin/env bash
# Сканер истории на утечки секретов. Код возврата 1, если найдено.
# Требует полного клона (fetch-depth: 0 в CI).
set -euo pipefail
PATTERNS="sk-[a-z0-9]{20,}|ghp_[a-z0-9]{30,}|github_pat_[a-zA-Z0-9_]{20,}|xox[baprs]-[a-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|api[_-]?key\s*=\s*['\"][a-z0-9]{20,}|secret\s*=\s*['\"][a-z0-9]{20,}"
if git log -p --all | grep -iE "($PATTERNS)"; then
  echo "!! Похоже на утечку секретов в истории коммитов" >&2
  exit 1
fi
echo "OK: секреты в истории не найдены"
