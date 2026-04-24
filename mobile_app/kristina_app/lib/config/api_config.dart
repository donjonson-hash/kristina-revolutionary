// lib/config/api_config.dart

class ApiConfig {
  final String name;
  final String baseUrl;
  final String wsUrl;
  
  const ApiConfig({
    required this.name,
    required this.baseUrl,
    required this.wsUrl,
  });
  
  // Локальная разработка
  static const localAndroid = ApiConfig(
    name: 'local_android',
    baseUrl: 'http://10.0.2.2:8001',
    wsUrl: 'ws://10.0.2.2:8001/ws/chat',
  );
  
  static const localiOS = ApiConfig(
    name: 'local_ios',
    baseUrl: 'http://127.0.0.1:8001',
    wsUrl: 'ws://127.0.0.1:8001/ws/chat',
  );
  
  // ⛔ НЕ ИСПОЛЬЗОВАТЬ — локальная сеть, не работает извне
  static const localNetwork = ApiConfig(
    name: 'local_network',
    baseUrl: 'http://10.110.63.130:8001',
    wsUrl: 'ws://10.110.63.130:8001/ws/chat',
  );
  
  // ✅ НАШ СЕРВЕР — используем это!
  static const production = ApiConfig(
    name: 'production',
    baseUrl: 'http://195.245.112.66:8001',
    wsUrl: 'ws://195.245.112.66:8001/ws/chat',
  );
  
  // 🔥 АКТИВНАЯ КОНФИГУРАЦИЯ — меняй здесь
  static const ApiConfig current = production;  // <-- ВАЖНО!
}
