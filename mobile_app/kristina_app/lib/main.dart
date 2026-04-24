import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'providers/chat_provider.dart';
import 'screens/login_screen.dart';

void main() {
  runApp(const KristinaApp());
}

class KristinaApp extends StatelessWidget {
  const KristinaApp({super.key});

  @override
  Widget build(BuildContext context) {
    return ChangeNotifierProvider(
      create: (_) => ChatProvider(),
      child: MaterialApp(
        title: 'Kristina AI',
        debugShowCheckedModeBanner: false,
        theme: ThemeData(
          primarySwatch: Colors.purple,
          useMaterial3: true,
        ),
        home: const LoginScreen(),
      ),
    );
  }
}
