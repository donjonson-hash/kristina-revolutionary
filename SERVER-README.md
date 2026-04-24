# 🚀 Kristina AI - Развёртывание на сервере

## Быстрый старт (5 минут)

### 1. Подключение к серверу
```bash
ssh -p 3333 root@195.245.112.66
cd /root/kristina_revolutionary
```

### 2. Настройка (один раз)
```bash
./server-setup.sh
```

### 3. Запуск
```bash
./kristina-manager.sh start
```

### 4. Проверка
```bash
./kristina-manager.sh status
```

---

## 📋 Команды управления

### kristina-manager.sh

| Команда | Описание |
|---------|----------|
| `start` | Запустить API + Web |
| `stop` | Остановить всё |
| `restart` | Перезапустить всё |
| `status` | Показать статус |
| `logs` | Показать логи |
| `test` | Тестировать систему |
| `setup` | Настроить firewall |

**Примеры:**
```bash
./kristina-manager.sh start      # Запуск
./kristina-manager.sh status     # Проверка
./kristina-manager.sh logs       # Логи
./kristina-manager.sh restart    # Перезапуск
```

---

## 🔧 Установка как системный сервис

Для автозапуска при загрузке сервера:

```bash
sudo ./install-service.sh
```

После установки управление через `systemctl`:
```bash
sudo systemctl start kristina-api
sudo systemctl stop kristina-api
sudo systemctl restart kristina-api
sudo systemctl status kristina-api
```

---

## 🌐 URL доступа

После запуска:
- **API:** http://195.245.112.66:8001
- **Web:** http://195.245.112.66:8080
- **Мобильное приложение:** Используй IP `195.245.112.66`

---

## 📱 Настройка мобильного приложения

В `mobile_app/kristina_app/lib/services/api_service.dart`:
```dart
static const String baseUrl = 'http://195.245.112.66:8001';
```

В `mobile_app/kristina_app/lib/services/websocket_service.dart`:
```dart
static const String wsUrl = 'ws://195.245.112.66:8001/ws/chat';
```

Пересобрать APK:
```bash
cd mobile_app/kristina_app
flutter build apk --release --target-platform android-arm64
```

---

## 🔍 Отладка

### Проверка процессов
```bash
ps aux | grep -E "python.*mobile_api|http.server"
```

### Проверка портов
```bash
netstat -tlnp | grep -E "8001|8080"
```

### Логи API
```bash
tail -f /var/log/kristina-api.log
tail -f ~/kristina_revolutionary/nohup.out
```

### Проверка API
```bash
curl http://127.0.0.1:8001/status
curl http://195.245.112.66:8001/status
```

---

## 🛡️ Firewall

Если API недоступен извне:

### UFW (Ubuntu/Debian)
```bash
ufw allow 8001/tcp
ufw allow 8080/tcp
ufw reload
```

### FirewallD (CentOS/RHEL)
```bash
firewall-cmd --permanent --add-port=8001/tcp
firewall-cmd --permanent --add-port=8080/tcp
firewall-cmd --reload
```

### Iptables
```bash
iptables -A INPUT -p tcp --dport 8001 -j ACCEPT
iptables -A INPUT -p tcp --dport 8080 -j ACCEPT
```

---

## 🔄 Обновление проекта

```bash
cd /root/kristina_revolutionary
./kristina-manager.sh stop

# Обновить файлы (git pull или scp)
# ...

./server-setup.sh
./kristina-manager.sh start
```

---

## 📊 Мониторинг

### Проверка ресурсов
```bash
./kristina-manager.sh status
```

### Автоматический тест
```bash
./test_server.sh
```

### Health check
```bash
./kristina-manager.sh test
```

---

## 🆘 Частые проблемы

### "Connection refused"
```bash
# Проверить, запущен ли API
./kristina-manager.sh status

# Перезапустить
./kristina-manager.sh restart
```

### API не доступен извне
```bash
# Проверить firewall
ufw status

# Открыть порты
./kristina-manager.sh setup
```

### Ошибки в логах
```bash
# Посмотреть логи API
./kristina-manager.sh logs

# Или напрямую
tail -100 /var/log/kristina-api.log
```

---

## 📞 Поддержка

При проблемах:
1. Проверь статус: `./kristina-manager.sh status`
2. Посмотри логи: `./kristina-manager.sh logs`
3. Запусти тест: `./kristina-manager.sh test`
4. Перезапусти: `./kristina-manager.sh restart`

---

**Удачного использования!** 🎉
