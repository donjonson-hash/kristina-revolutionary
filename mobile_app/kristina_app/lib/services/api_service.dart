import 'package:dio/dio.dart';
import '../models/chat_message.dart';
import '../models/price_estimate.dart';
import '../config/api_config.dart';

class ApiService {
  static String get baseUrl => ApiConfig.current.baseUrl;
  late final Dio _dio;
  
  ApiService() {
    _dio = Dio(BaseOptions(
      connectTimeout: const Duration(seconds: 10),
      receiveTimeout: const Duration(seconds: 30),
      sendTimeout: const Duration(seconds: 10),
    ));
    
    // Перехватчик для обработки ошибок
    _dio.interceptors.add(InterceptorsWrapper(
      onError: (DioException error, ErrorInterceptorHandler handler) {
        String message;
        switch (error.type) {
          case DioExceptionType.connectionTimeout:
          case DioExceptionType.sendTimeout:
          case DioExceptionType.receiveTimeout:
            message = 'Превышено время ожидания. Проверьте подключение к сети.';
            break;
          case DioExceptionType.connectionError:
            message = 'Не удалось подключиться к серверу. Проверьте URL и firewall.';
            break;
          case DioExceptionType.badResponse:
            if (error.response?.statusCode == 401) {
              message = 'Неверный логин или пароль';
            } else if (error.response?.statusCode == 404) {
              message = 'API метод не найден';
            } else {
              message = 'Ошибка сервера: ${error.response?.statusCode}';
            }
            break;
          default:
            message = 'Ошибка сети: ${error.message}';
        }
        print('API Error: $message');
        return handler.next(error);
      },
    ));
  }

  void setToken(String token) {
    _dio.options.headers['Authorization'] = 'Bearer $token';
  }

  void clearToken() {
    _dio.options.headers.remove('Authorization');
  }

  // Auth
  Future<Map<String, dynamic>> login(String username, String password) async {
    final response = await _dio.post('$baseUrl/auth/login', data: {
      'username': username,
      'password': password,
    });
    return response.data;
  }

  Future<Map<String, dynamic>> register(String username, String password, String? email) async {
    final response = await _dio.post('$baseUrl/auth/register', data: {
      'username': username,
      'password': password,
      'email': email,
    });
    return response.data;
  }

  // Chat
  Future<ChatMessage> sendMessage(String message) async {
    final response = await _dio.post('$baseUrl/chat', data: {
      'message': message,
      'context': {},
    });
    
    return ChatMessage(
      id: response.data['message_id'],
      role: 'assistant',
      content: response.data['response'],
      timestamp: DateTime.parse(response.data['timestamp']),
      agent: response.data['agent'],
      confidence: response.data['confidence'],
    );
  }

  Future<List<ChatMessage>> getHistory({int limit = 50}) async {
    final response = await _dio.get('$baseUrl/chat/history', queryParameters: {
      'limit': limit,
    });
    
    return (response.data as List)
        .map((json) => ChatMessage.fromJson(json))
        .toList();
  }

  // Price
  Future<PriceEstimate> getPriceEstimate(String projectType, {
    String complexity = 'medium',
    String region = 'sweden',
  }) async {
    final response = await _dio.post('$baseUrl/price/estimate', data: {
      'project_type': projectType,
      'complexity': complexity,
      'region': region,
    });
    return PriceEstimate.fromJson(response.data);
  }

  // Status
  Future<Map<String, dynamic>> getStatus() async {
    final response = await _dio.get('$baseUrl/status');
    return response.data;
  }
}
