# Scout — неделя 1 (каркас)

Персональный тренд-агент в браузере: помнит нишу пользователя и приходит сам.

## Что уже работает
- **Онбординг** (side panel): ниша → темы → частота/тихие часы, сохраняется в `chrome.storage`
- **Дайджест-вью**: секции 🔺📈🔕💡 (данные — заглушка до недели 4)
- **Проактивный каркас** в service worker: alarms (раз/день) → quiet hours → cooldown 12ч → singleton-claim (паттерн dialogue_state.py) → заглушка дайджеста → уведомление
- Кнопка «Проверить сейчас» — ручной триггер того же пайплайна

## Как запустить (unpacked)
1. `chrome://extensions` → Developer mode → Load unpacked → выбрать `scout/extension/`
2. Клик по иконке Scout → откроется side panel → пройди онбординг
3. «Проверить сейчас» → появится заглушка дайджеста + уведомление

## Структура
```
scout/extension/
├── manifest.json    # MV3: storage, alarms, sidePanel, notifications
├── background.js    # service worker: alarms + claim-пайплайн проактивности
├── storage.js       # NicheStore + claims (chrome.storage.local)
├── sidepanel.html   # онбординг 3 шага + дайджест
└── sidepanel.js     # логика панели
```

## Дорожная карта
- Неделя 2: онбординг-полировка, автодополнение тем через /probe (нужен бэкенд-заглушка)
- Неделя 3: сбор сигналов (RSS/Reddit/HN) в TrendQueue
- Неделя 4: бэкенд /digest, реальная генерация вместо заглушки
- Неделя 5: проактивность end-to-end (scheduler → claim → backend → notify → panel)
- Неделя 7: Stripe, magic-link
