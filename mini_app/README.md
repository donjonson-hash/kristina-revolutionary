# 📱 Kristina AI - Mini App Telegram

Telegram Mini App для взаимодействия с AI-ассистентом Кристиной.

## 🎯 Функционал

- 🔐 Авторизация через JWT
- 💬 Чат с Кристиной в реальном времени
- 📜 История сообщений
- 💰 Расчёт стоимости UX-проектов
- 📎 Загрузка документов (PDF, DOCX, TXT)
- 🎨 Адаптивный дизайн под Telegram
- 📳 Haptic Feedback (виброотклик)

## 🚀 Быстрый старт

### 1. Запуск сервера
```bash
cd /home/avatar/kristina-project/kristina_revolutionary
source venv_local/bin/activate
python mobile_api.py
```

Сервер запустится на порту 8001.

### 2. Настройка в Telegram

В @BotFather выполните:
```
/mybots
-> Выберите бота
-> Bot Settings
-> Menu Button
-> Configure menu button
-> Enter URL: http://YOUR_SERVER:8001
```

Или создайте Web App:
```
/newapp
-> Выберите бота
-> Название: Kristina AI
-> Описание: UX-дизайнер из Стокгольма
-> URL: http://YOUR_SERVER:8001/mini_app/index.html
```

### 3. Тестирование

Откройте бота в Telegram и нажмите кнопку меню или отправьте команду `/app`.

## 🏗️ Структура

```
mini_app/
├── index.html      # Главный файл Mini App
├── README.md       # Эта документация
└── ...
```

## 🔌 API Endpoints

### Без авторизации
- `GET /` - Информация об API
- `GET /chat/direct?message=...&user_id=...` - Гостевой чат
- `POST /auth/register` - Регистрация
- `POST /auth/login` - Авторизация
- `POST /price/estimate` - Оценка проекта

### С авторизацией (Bearer Token)
- `POST /chat` - Чат с Кристиной
- `GET /chat/history` - История сообщений
- `POST /upload` - Загрузка документа

### WebSocket
- `WS /ws/chat?token=...` - Реальное время

## 📱 Использование

### Через браузер
```
http://localhost:8001/mini_app/index.html
```

### Через Telegram
1. Откройте бота @your_bot
2. Нажмите кнопку "Открыть приложение"
3. Войдите или зарегистрируйтесь
4. Начните общение!

## ⚙️ Конфигурация

В `index.html` можно настроить:
```javascript
const API_URL = window.location.origin;  // URL API сервера
```

## 🎨 Кастомизация

### Цвета
Основные цвета в CSS:
- Фон: `linear-gradient(135deg, #6D5BD0 0%, #B0C4DE 100%)`
- Акцент: `#6D5BD0`
- Текст: `#333` / `white`

### Шрифты
- Системный шрифт: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto`

## 🔒 Безопасность

- JWT токены хранятся в `localStorage`
- Автоматическое обновление при 401 ошибке
- HTTPS рекомендуется для продакшена

## 🐛 Отладка

В консоли браузера:
```javascript
// Проверить токен
localStorage.getItem('kristina_token')

// Очистить данные
localStorage.clear()

// Проверить API
tg.WebApp.ready()
tg.WebApp.expand()
```

## 📚 Документация

- [Telegram Web Apps Docs](https://core.telegram.org/bots/webapps)
- [FastAPI Docs](https://fastapi.tiangolo.com/)

## 🤝 Поддержка

При проблемах:
1. Проверьте, что сервер запущен
2. Проверьте консоль браузера (F12)
3. Проверьте логи сервера
4. Очистите localStorage и перезайдите

---

**Kristina AI** © 2026
