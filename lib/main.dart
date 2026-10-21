import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'screens/home_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);
  runApp(const SeniorCollabApp());
}

class SC {
  static const bg = Color(0xFF0E1116);
  static const surface = Color(0xFF181C24);
  static const accent = Color(0xFFFF4D6D);
  static const accent2 = Color(0xFF7C5CFF);
  static const text = Color(0xFFF2F4F8);
  static const muted = Color(0xFF8A93A6);
}

class SeniorCollabApp extends StatelessWidget {
  const SeniorCollabApp({super.key});

  @override
  Widget build(BuildContext context) {
    final scheme = ColorScheme.fromSeed(
      seedColor: SC.accent,
      brightness: Brightness.dark,
      primary: SC.accent,
      secondary: SC.accent2,
      surface: SC.surface,
    );
    return MaterialApp(
      title: 'SeniorCollab',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: scheme,
        scaffoldBackgroundColor: SC.bg,
        appBarTheme: const AppBarTheme(
          backgroundColor: SC.bg,
          elevation: 0,
          centerTitle: false,
        ),
      ),
      home: const HomeScreen(),
    );
  }
}
