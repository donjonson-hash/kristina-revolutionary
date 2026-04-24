#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Backup script for Kristina AI
# Автоматические бэкапы баз данных SQLite
# ═══════════════════════════════════════════════════════════════

set -e

# Настройки
BACKUP_DIR="$(dirname "$0")/backups"
DATE=$(date +%Y%m%d_%H%M%S)
DB_FILES=("kristina_memory.db" "freelance.db" "kristina_knowledge.db")
KEEP_DAYS=7

# Создаём директорию для бэкапов
mkdir -p "$BACKUP_DIR"

echo "🔄 Starting backup at $(date)"

# Бэкапим каждую базу
for db in "${DB_FILES[@]}"; do
    if [ -f "$db" ]; then
        echo "   📦 Backing up $db..."
        cp "$db" "$BACKUP_DIR/${db%.db}_${DATE}.db"
    else
        echo "   ⚠️  $db not found, skipping"
    fi
done

# Архивируем
ARCHIVE="$BACKUP_DIR/kristina_backup_${DATE}.tar.gz"
tar -czf "$ARCHIVE" -C "$BACKUP_DIR" *_${DATE}.db 2>/dev/null || true
echo "   📁 Archive created: $ARCHIVE"

# Удаляем старые бэкапы (старше $KEEP_DAYS дней)
echo "   🧹 Cleaning old backups..."
find "$BACKUP_DIR" -name "*.db" -mtime +$KEEP_DAYS -delete 2>/dev/null || true
find "$BACKUP_DIR" -name "*.tar.gz" -mtime +$KEEP_DAYS -delete 2>/dev/null || true

# Удаляем временные .db файлы (оставляем только архивы)
find "$BACKUP_DIR" -name "kristina_*.db" -mtime +1 -delete 2>/dev/null || true

# Статистика
BACKUP_COUNT=$(find "$BACKUP_DIR" -name "*.tar.gz" | wc -l)
echo "✅ Backup complete! Total archives: $BACKUP_COUNT"
echo "📂 Location: $BACKUP_DIR"
