import 'package:flutter/foundation.dart';
import '../models/chat_message.dart';
import '../models/user.dart';
import '../services/api_service.dart';
import '../services/websocket_service.dart';

class ChatProvider extends ChangeNotifier {
  final ApiService _apiService = ApiService();
  final WebSocketService _wsService = WebSocketService();
  
  List<ChatMessage> _messages = [];
  User? _currentUser;
  bool _isLoading = false;
  bool _isConnected = false;
  String? _error;

  // Getters
  List<ChatMessage> get messages => _messages;
  User? get currentUser => _currentUser;
  bool get isLoading => _isLoading;
  bool get isConnected => _isConnected;
  String? get error => _error;
  bool get isAuthenticated => _currentUser != null;

  // Auth
  Future<bool> login(String username, String password) async {
    try {
      _isLoading = true;
      _error = null;
      notifyListeners();

      final response = await _apiService.login(username, password);
      final token = response['access_token'];
      final expiresIn = response['expires_in'];
      
      _apiService.setToken(token);
      _currentUser = User.fromJson(
        {'username': username},
        token,
        expiresIn,
      );
      
      // Подключаем WebSocket
      _connectWebSocket();
      
      // Загружаем историю
      await loadHistory();
      
      _isLoading = false;
      notifyListeners();
      return true;
    } catch (e) {
      _error = e.toString();
      _isLoading = false;
      notifyListeners();
      return false;
    }
  }

  Future<bool> register(String username, String password, String? email) async {
    try {
      _isLoading = true;
      _error = null;
      notifyListeners();

      final response = await _apiService.register(username, password, email);
      final token = response['access_token'];
      final expiresIn = response['expires_in'];
      
      _apiService.setToken(token);
      _currentUser = User.fromJson(
        {'username': username, 'email': email},
        token,
        expiresIn,
      );
      
      _connectWebSocket();
      
      _isLoading = false;
      notifyListeners();
      return true;
    } catch (e) {
      _error = e.toString();
      _isLoading = false;
      notifyListeners();
      return false;
    }
  }

  void logout() {
    _wsService.disconnect();
    _apiService.clearToken();
    _currentUser = null;
    _messages = [];
    _isConnected = false;
    notifyListeners();
  }

  // WebSocket
  void _connectWebSocket() {
    if (_currentUser != null) {
      _wsService.connect(_currentUser!.token);
      _isConnected = true;
      
      _wsService.messageStream?.listen((message) {
        _messages.add(message);
        notifyListeners();
      });
    }
  }

  // Chat
  Future<void> sendMessage(String text) async {
    if (text.trim().isEmpty) return;
    
    // Добавляем сообщение пользователя локально
    final userMessage = ChatMessage(
      id: DateTime.now().millisecondsSinceEpoch.toString(),
      role: 'user',
      content: text,
      timestamp: DateTime.now(),
    );
    _messages.add(userMessage);
    notifyListeners();

    // Отправляем через WebSocket или HTTP
    if (false) { // WebSocket отключен
      _wsService.sendMessage(text);
    } else {
      try {
        final response = await _apiService.sendMessage(text);
        _messages.add(response);
        notifyListeners();
      } catch (e) {
        _error = e.toString();
        notifyListeners();
      }
    }
  }

  Future<void> loadHistory() async {
    try {
      _messages = await _apiService.getHistory();
      notifyListeners();
    } catch (e) {
      print('Error loading history: $e');
    }
  }

  void clearError() {
    _error = null;
    notifyListeners();
  }
}
