# 🐛 Отладка Kristina Mobile App

## Быстрый старт

### 1. Запуск API сервера
```bash
cd ~/kristina-project/kristina_revolutionary
python mobile_api.py
```

Проверь в браузере:
- http://127.0.0.1:8001/status
- http://127.0.0.1:8001/chat/direct?message=Привет

### 2. Запуск мобильного приложения

#### Вариант A: Через скрипт
```bash
cd ~/kristina-project/kristina_revolutionary/mobile_app
chmod +x run_debug.sh
./run_debug.sh
```

#### Вариант B: Вручную
```bash
cd ~/kristina-project/kristina_revolutionary/mobile_app/kristina_app

# Установка зависимостей
flutter pub get

# Запуск на эмуляторе
flutter run

# Или на конкретном устройстве
flutter run -d <device_id>
```

### 3. Настройка URL для разных сценариев

Отредактируй `lib/services/api_service.dart`:

| Устройство | URL |
|------------|-----|
| Android эмулятор | `http://10.0.2.2:8001` |
| iOS симулятор | `http://127.0.0.1:8001` |
| Реальное устройство (та же сеть) | `http://192.168.x.x:8001` |
| Production | `https://your-domain.com` |

### 4. Просмотр логов
```bash
# Все логи Flutter
flutter logs

# Логи конкретного устройства
flutter logs -d <device_id>
```

## Решение проблем

### ❌ "Connection refused"
- Проверь что API запущен
- Проверь URL в `api_service.dart`
- Для Android эмулятора используй `10.0.2.2`, не `127.0.0.1`

### ❌ "Cleartext HTTP traffic not permitted"
- Уже исправлено в `AndroidManifest.xml`: `android:usesCleartextTraffic="true"`
- Пересобери приложение: `flutter clean && flutter run`

### ❌ WebSocket не подключается
- Проверь URL в `websocket_service.dart`
- Убедись что порт 8001 открыт

### ❌ "No connected devices"
```bash
# Список устройств
flutter devices

# Запуск Android эмулятора
flutter emulators --launch <emulator_id>

# Или подключи физическое устройство с USB debugging
```

## Hot Reload

Во время разработки нажми:
- `r` - Hot reload (сохранение состояния)
- `R` - Hot restart (сброс состояния)
- `q` - Выход

## Структура проекта

```
lib/
├── main.dart              # Точка входа
├── services/
│   ├── api_service.dart   # HTTP API
│   └── websocket_service.dart # WebSocket
├── providers/
│   └── chat_provider.dart # Управление состоянием
├── screens/
│   ├── login_screen.dart  # Экран входа
│   ├── chat_screen.dart   # Экран чата
│   └── pricing_screen.dart # Оценка проекта
├── models/
│   ├── chat_message.dart  # Модель сообщения
│   ├── user.dart          # Модель пользователя
│   └── price_estimate.dart # Модель оценки
└── widgets/
    └── message_bubble.dart # Виджет сообщения
```

## Полезные команды

```bash
# Очистка сборки
flutter clean

# Получение зависимостей
flutter pub get

# Анализ кода
flutter analyze

# Форматирование кода
flutter format lib/

# Сборка APK
flutter build apk --debug
flutter build apk --release

# Сборка App Bundle
flutter build appbundle
```
