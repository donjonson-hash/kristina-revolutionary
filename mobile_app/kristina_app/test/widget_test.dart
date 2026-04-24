// This is a basic Flutter widget test.
//
// To perform an interaction with a widget in your test, use the WidgetTester
// utility in the flutter_test package. For example, you can send tap and scroll
// gestures. You can also use WidgetTester to find child widgets in the widget
// tree, read text, and verify that the values of widget properties are correct.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:kristina_app/main.dart';
import 'package:kristina_app/providers/chat_provider.dart';

void main() {
  testWidgets('App loads successfully', (WidgetTester tester) async {
    // Build our app and trigger a frame.
    await tester.pumpWidget(
      ChangeNotifierProvider(
        create: (_) => ChatProvider(),
        child: const KristinaApp(),
      ),
    );

    // Verify that login screen is shown.
    expect(find.text('Kristina AI'), findsOneWidget);
    expect(find.text('Ваш UX-ассистент'), findsOneWidget);
    expect(find.text('Войти'), findsOneWidget);
  });
}
