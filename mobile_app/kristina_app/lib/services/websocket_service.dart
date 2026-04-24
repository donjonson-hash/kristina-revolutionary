import 'dart:async';
import 'dart:convert';
import 'package:web_socket_channel/web_socket_channel.dart';
import '../models/chat_message.dart';
import '../config/api_config.dart';

class WebSocketService {
  static String get wsUrl => ApiConfig.current.wsUrl;
  WebSocketChannel? _channel;
  StreamController<ChatMessage>? _messageController;

  Stream<ChatMessage>? get messageStream => _messageController?.stream;

  void connect(String token) {
    _messageController = StreamController<ChatMessage>.broadcast();
    
    final uri = Uri.parse('$wsUrl?token=$token');
    _channel = WebSocketChannel.connect(uri);
    
    _channel!.stream.listen(
      (data) {
        final json = jsonDecode(data);
        if (json['type'] == 'message') {
          final message = ChatMessage(
            id: json['id'],
            role: 'assistant',
            content: json['content'],
            timestamp: DateTime.parse(json['timestamp']),
            agent: json['agent'],
          );
          _messageController?.add(message);
        }
      },
      onError: (error) {
        print('WebSocket error: $error');
      },
      onDone: () {
        print('WebSocket closed');
      },
    );
  }

  void sendMessage(String message) {
    if (_channel != null) {
      _channel!.sink.add(jsonEncode({
        'message': message,
      }));
    }
  }

  void disconnect() {
    _channel?.sink.close();
    _messageController?.close();
    _channel = null;
    _messageController = null;
  }

  bool get isConnected => _channel != null;
}
