import 'dart:io';

import 'package:flutter/material.dart';
import 'package:gal/gal.dart';
import 'package:share_plus/share_plus.dart';
import 'package:video_player/video_player.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../main.dart';
import '../models/project.dart';
import '../services/render_service.dart';

class ExportScreen extends StatefulWidget {
  const ExportScreen({super.key, required this.project});
  final CollabProject project;

  @override
  State<ExportScreen> createState() => _ExportScreenState();
}

class _ExportScreenState extends State<ExportScreen> {
  final _render = RenderService();
  bool _running = false;
  double _progress = 0;
  String? _out;
  String? _error;
  VideoPlayerController? _player;
  bool _saved = false;

  CollabProject get p => widget.project;

  Future<void> _start() async {
    await _player?.dispose();
    setState(() {
      _player = null;
      _running = true;
      _progress = 0;
      _out = null;
      _error = null;
      _saved = false;
    });
    await WakelockPlus.enable();
    final r = await _render.render(p, onProgress: (v) {
      if (mounted) setState(() => _progress = v);
    });
    await WakelockPlus.disable();
    if (!mounted) return;
    if (r.path != null) {
      final c = VideoPlayerController.file(File(r.path!));
      await c.initialize();
      await c.setLooping(true);
      await c.play();
      setState(() {
        _out = r.path;
        _player = c;
        _running = false;
      });
    } else {
      setState(() {
        _error = r.error;
        _running = false;
      });
    }
  }

  Future<void> _save() async {
    final path = _out;
    if (path == null) return;
    try {
      if (!await Gal.hasAccess()) await Gal.requestAccess();
      await Gal.putVideo(path, album: 'SeniorCollab');
      setState(() => _saved = true);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Não consegui salvar: $e')));
      }
    }
  }

  Future<void> _share() async {
    final path = _out;
    if (path == null) return;
    await SharePlus.instance.share(ShareParams(files: [XFile(path)], text: 'Feito no SeniorCollab'));
  }

  @override
  void dispose() {
    if (_running) _render.cancel();
    _player?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Exportar', style: TextStyle(fontWeight: FontWeight.w700))),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text('Formato', style: TextStyle(fontWeight: FontWeight.w700)),
          for (final f in OutputFormat.values)
            RadioListTile<OutputFormat>(
              contentPadding: EdgeInsets.zero,
              value: f,
              groupValue: p.format,
              title: Text(f.label),
              subtitle: Text('${f.width} × ${f.height}',
                  style: const TextStyle(color: SC.muted, fontSize: 12)),
              onChanged: _running ? null : (v) => setState(() => p.format = v!),
            ),
          const SizedBox(height: 8),
          const Text('Layout', style: TextStyle(fontWeight: FontWeight.w700)),
          const SizedBox(height: 6),
          Wrap(
            spacing: 8,
            children: [
              for (final l in LayoutMode.values)
                ChoiceChip(
                  label: Text(l.label),
                  selected: p.layout == l,
                  onSelected: _running ? null : (_) => setState(() => p.layout = l),
                ),
            ],
          ),
          const SizedBox(height: 20),
          if (_running) ...[
            LinearProgressIndicator(value: _progress == 0 ? null : _progress),
            const SizedBox(height: 8),
            Text('Renderizando… ${(_progress * 100).round()}%',
                style: const TextStyle(color: SC.muted)),
            TextButton(onPressed: _render.cancel, child: const Text('Cancelar')),
          ] else
            FilledButton.icon(
              style: FilledButton.styleFrom(
                backgroundColor: SC.accent,
                minimumSize: const Size.fromHeight(54),
              ),
              onPressed: _start,
              icon: const Icon(Icons.movie_creation_rounded),
              label: Text(_out == null ? 'Renderizar vídeo' : 'Renderizar de novo'),
            ),
          if (_error != null) ...[
            const SizedBox(height: 16),
            const Text('A exportação falhou.',
                style: TextStyle(color: SC.accent, fontWeight: FontWeight.w700)),
            const SizedBox(height: 6),
            SelectableText(_error!, style: const TextStyle(color: SC.muted, fontSize: 11)),
          ],
          if (_player != null) ...[
            const SizedBox(height: 20),
            Center(
              child: ConstrainedBox(
                constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.5),
                child: AspectRatio(
                  aspectRatio: _player!.value.aspectRatio,
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(12),
                    child: VideoPlayer(_player!),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: _saved ? null : _save,
                    icon: Icon(_saved ? Icons.check_rounded : Icons.download_rounded),
                    label: Text(_saved ? 'Salvo na galeria' : 'Salvar na galeria'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: FilledButton.icon(
                    onPressed: _share,
                    icon: const Icon(Icons.share_rounded),
                    label: const Text('Compartilhar'),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
