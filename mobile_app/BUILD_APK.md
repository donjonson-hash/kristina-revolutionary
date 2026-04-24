# 📱 Сборка APK Kristina AI

## ⚙️ Конфигурация API

Все URL настраиваются в одном файле:
```
lib/config/api_config.dart
```

**Текущая конфигурация:** `localNetwork` (IP: 10.110.63.130)

### Переключение окружений

Открой `lib/config/api_config.dart` и измени:

```dart
// Для Android эмулятора
static const ApiConfig current = localAndroid;

// Для iOS симулятора
static const ApiConfig current = localiOS;

// Для реального устройства (текущая)
static const ApiConfig current = localNetwork;

// Для production
static const ApiConfig current = production;
```

---

## 🔨 Сборка APK

### Шаг 1: Перейти в директорию
```bash
cd ~/kristina-project/kristina_revolutionary/mobile_app/kristina_app
```

### Шаг 2: Очистка проекта
```bash
flutter clean
```

### Шаг 3: Установка зависимостей
```bash
flutter pub get
```

### Шаг 4: Проверка кода
```bash
flutter analyze
```

### Шаг 5: Сборка APK (быстрая, только ARM64)
```bash
flutter build apk --release --target-platform android-arm64
```

**Или универсальная сборка (все архитектуры):**
```bash
flutter build apk --release
```

---

## 📦 Результат

APK файл создаётся по пути:
```
build/app/outputs/flutter-apk/app-release.apk
```

**Копирование:**
```bash
# Копируем в home директорию
cp build/app/outputs/flutter-apk/app-release.apk ~/KristinaAI.apk

# Проверяем размер
ls -lh ~/KristinaAI.apk
```

---

## 🚀 Установка на телефон

### Способ 1: ADB (USB)
```bash
# Подключи телефон по USB с включенной отладкой
adb install build/app/outputs/flutter-apk/app-release.apk

# Или переустановить
adb install -r build/app/outputs/flutter-apk/app-release.apk
```

### Способ 2: HTTP сервер
```bash
# На компьютере
python3 -m http.server 8080

# На телефоне открыть:
# http://10.110.63.130:8080/build/app/outputs/flutter-apk/app-release.apk
```

### Способ 3: Telegram / Email
Просто отправь файл на телефон.

---

## ⚠️ Важные моменты

### Перед сборкой проверь:

1. **IP сервера** в `api_config.dart`:
   ```dart
   static const localNetwork = ApiConfig(
     baseUrl: 'http://10.110.63.130:8001',  // ← твой IP
     ...
   );
   ```

2. **API сервер запущен**:
   ```bash
   curl http://10.110.63.130:8001/status
   ```

3. **Firewall открыт**:
   ```bash
   sudo ufw status | grep 8001
   ```

### Для работы на телефоне:

- Телефон и сервер должны быть в **одной Wi-Fi сети**
- На сервере должен быть запущен `mobile_api.py`
- Порт `8001` должен быть открыт в firewall

---

## 🐛 Проблемы и решения

### "Connection refused"
- Проверь, что API запущен: `./kristina-manager.sh status`
- Проверь IP в `api_config.dart`
- Проверь firewall: `sudo ufw allow 8001`

### "Cleartext HTTP traffic not permitted"
- Уже настроено в `AndroidManifest.xml`
- Пересобери: `flutter clean && flutter build apk`

### Большой размер APK
- Используй `--target-platform android-arm64` (только для новых телефонов)
- Для старых телефонов собирай без `--target-platform`

---

## 📊 Размер APK

| Тип сборки | Размер | Совместимость |
|------------|--------|---------------|
| `--target-platform android-arm64` | ~15-20 MB | Только ARM64 (новые телефоны) |
| Без флага (все архитектуры) | ~45-50 MB | Все Android устройства |

---

## 📝 Быстрая команда

Всё в одной команде:
```bash
cd ~/kristina-project/kristina_revolutionary/mobile_app/kristina_app && \
flutter clean && \
flutter pub get && \
flutter build apk --release --target-platform android-arm64 && \
cp build/app/outputs/flutter-apk/app-release.apk ~/KristinaAI.apk && \
echo "✅ APK готов: ~/KristinaAI.apk" && \
ls -lh ~/KristinaAI.apk
```
