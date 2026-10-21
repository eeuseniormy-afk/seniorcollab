import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../main.dart';
import '../models/project.dart';
import '../services/media.dart';
import 'studio_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  bool _busy = false;

  Future<void> _duet() async {
    final picked = await ImagePicker().pickVideo(source: ImageSource.gallery);
    if (picked == null) return;
    setState(() => _busy = true);
    try {
      final track = await importToProject(picked.path, 'Vídeo original');
      final project = CollabProject()..add(track);
      if (!mounted) return;
      await Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => StudioScreen(project: project, openRecorder: true),
      ));
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Não consegui abrir o vídeo: $e')));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _solo() async {
    final project = CollabProject();
    await Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => StudioScreen(project: project, openRecorder: true),
    ));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 32, 24, 24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ShaderMask(
                shaderCallback: (r) => const LinearGradient(
                  colors: [SC.accent, SC.accent2],
                ).createShader(r),
                child: const Text(
                  'SeniorCollab',
                  style: TextStyle(
                    fontSize: 38,
                    fontWeight: FontWeight.w800,
                    color: Colors.white,
                    letterSpacing: -1,
                  ),
                ),
              ),
              const SizedBox(height: 8),
              const Text(
                'Grave collabs de áudio e vídeo, mixe e exporte pronto para as redes.',
                style: TextStyle(color: SC.muted, fontSize: 16, height: 1.4),
              ),
              const Spacer(),
              _BigCard(
                icon: Icons.people_alt_rounded,
                title: 'Dueto',
                subtitle: 'Escolha um vídeo e grave por cima dele',
                gradient: const [SC.accent, Color(0xFFFF8A5C)],
                onTap: _busy ? null : _duet,
              ),
              const SizedBox(height: 16),
              _BigCard(
                icon: Icons.layers_rounded,
                title: 'Collab comigo',
                subtitle: 'Grave vários takes seus na mesma tela',
                gradient: const [SC.accent2, Color(0xFF3FA9F5)],
                onTap: _busy ? null : _solo,
              ),
              const SizedBox(height: 24),
              if (_busy) const LinearProgressIndicator(),
              const SizedBox(height: 12),
              const Center(
                child: Text(
                  'Dica: use fone de ouvido para gravar em cima de outro take.',
                  style: TextStyle(color: SC.muted, fontSize: 13),
                  textAlign: TextAlign.center,
                ),
              ),
              const SizedBox(height: 8),
              const Center(
                child: Text('© W. Carolino · SeniorMy',
                    style: TextStyle(color: SC.muted, fontSize: 11)),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _BigCard extends StatelessWidget {
  const _BigCard({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.gradient,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final List<Color> gradient;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      borderRadius: BorderRadius.circular(24),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Ink(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              colors: gradient,
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
            ),
          ),
          padding: const EdgeInsets.all(22),
          child: Row(
            children: [
              Icon(icon, size: 40, color: Colors.white),
              const SizedBox(width: 18),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title,
                        style: const TextStyle(
                            fontSize: 22, fontWeight: FontWeight.w700, color: Colors.white)),
                    const SizedBox(height: 4),
                    Text(subtitle,
                        style: const TextStyle(fontSize: 14, color: Colors.white70)),
                  ],
                ),
              ),
              const Icon(Icons.arrow_forward_ios_rounded, color: Colors.white70),
            ],
          ),
        ),
      ),
    );
  }
}
