#!/usr/bin/env bash
# Сканер истории на утечки секретов. Код возврата 1, если найдено.
# Требует полного клона (fetch-depth: 0 в CI).
# Вендор-бандлы исключены: в минифицированном чужом коде паттерны
# совпадают случайно (подтверждено на extension/pdf-font.mjs).
set -euo pipefail
PATTERNS="sk-[a-z0-9]{20,}|ghp_[a-z0-9]{30,}|github_pat_[a-zA-Z0-9_]{20,}|xox[baprs]-[a-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|api[_-]?key\s*=\s*['\"][a-z0-9]{20,}|secret\s*=\s*['\"][a-z0-9]{20,}"

# Свой код: вся история, кроме вендор-артефактов и локов
MATCHES=$(git log -p --all -- . \
  ':(exclude)*-vendor.mjs' \
  ':(exclude)extension/pdf-font.mjs' \
  ':(exclude)*.min.js' \
  ':(exclude)*.lock' \
  ':(exclude)package-lock.json' \
  | grep -iE "($PATTERNS)" || true)

if [ -n "$MATCHES" ]; then
  echo "!! Похоже на утечку секретов в истории коммитов:" >&2
  echo "$MATCHES" | head -20 >&2
  exit 1
fi
echo "OK: секреты в истории не найдены (vendor-бандлы исключены)"
