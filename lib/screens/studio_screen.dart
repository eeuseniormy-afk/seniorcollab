import 'dart:io';

import 'package:flutter/material.dart';

import '../main.dart';
import '../models/project.dart';
import '../services/playback.dart';
import '../widgets/collab_preview.dart';
import 'export_screen.dart';
import 'mixer_screen.dart';
import 'record_screen.dart';

class StudioScreen extends StatefulWidget {
  const StudioScreen({super.key, required this.project, this.openRecorder = false});
  final CollabProject project;
  final bool openRecorder;

  @override
  State<StudioScreen> createState() => _StudioScreenState();
}

class _StudioScreenState extends State<StudioScreen> {
  final _playback = Playback();
  bool _loading = true;

  CollabProject get p => widget.project;

  @override
  void initState() {
    super.initState();
    if (p.latencyMs == 0) p.latencyMs = Platform.isIOS ? 40 : 120;
    _reload().then((_) {
      if (widget.openRecorder && mounted) _record();
    });
  }

  Future<void> _reload() async {
    setState(() => _loading = true);
    await _playback.sync(p);
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _record() async {
    if (!p.canAddTrack) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Máximo de 6 faixas por collab.')),
      );
      return;
    }
    await _playback.stopAll();
    if (!mounted) return;
    final track = await Navigator.of(context).push<Track>(
      MaterialPageRoute(builder: (_) => RecordScreen(project: p)),
    );
    if (track != null) {
      p.add(track);
      await _reload();
    }
  }

  Future<void> _togglePlay() async {
    if (_playback.playing) {
      await _playback.stopAll();
    } else {
      await _playback.playAll();
    }
    setState(() {});
  }

  Future<void> _mixer() async {
    await _playback.stopAll();
    if (!mounted) return;
    await Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => MixerScreen(project: p, playback: _playback),
    ));
    await _reload();
  }

  Future<void> _export() async {
    await _playback.stopAll();
    if (!mounted) return;
    await Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => ExportScreen(project: p),
    ));
    setState(() {});
  }

  Future<void> _remove(int i) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text('Apagar ${p.tracks[i].name}?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('Apagar')),
        ],
      ),
    );
    if (ok == true) {
      await _playback.stopAll();
      p.removeAt(i);
      await _reload();
    }
  }

  @override
  void dispose() {
    _playback.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Estúdio', style: TextStyle(fontWeight: FontWeight.w700)),
        actions: [
          TextButton.icon(
            onPressed: p.tracks.isEmpty ? null : _export,
            icon: const Icon(Icons.ios_share_rounded),
            label: const Text('Exportar'),
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 120),
              children: [
                Center(
                  child: ConstrainedBox(
                    constraints: BoxConstraints(
                      maxHeight: MediaQuery.of(context).size.height * 0.48,
                    ),
                    child: CollabPreview(project: p, controllers: _playback.controllers),
                  ),
                ),
                const SizedBox(height: 12),
                _chips<OutputFormat>(
                  OutputFormat.values,
                  p.format,
                  (f) => f.short,
                  (f) => setState(() => p.format = f),
                ),
                const SizedBox(height: 6),
                _chips<LayoutMode>(
                  LayoutMode.values,
                  p.layout,
                  (l) => l.label,
                  (l) => setState(() => p.layout = l),
                ),
                const SizedBox(height: 16),
                Row(
                  children: [
                    Text('Faixas (${p.tracks.length})',
                        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                    const Spacer(),
                    IconButton.filledTonal(
                      onPressed: p.tracks.isEmpty ? null : _togglePlay,
                      icon: Icon(_playback.playing ? Icons.stop_rounded : Icons.play_arrow_rounded),
                    ),
                    const SizedBox(width: 8),
                    IconButton.filledTonal(
                      onPressed: p.tracks.isEmpty ? null : _mixer,
                      icon: const Icon(Icons.tune_rounded),
                      tooltip: 'Mixer e efeitos',
                    ),
                  ],
                ),
                for (var i = 0; i < p.tracks.length; i++)
                  Card(
                    color: SC.surface,
                    margin: const EdgeInsets.only(top: 8),
                    child: ListTile(
                      leading: CircleAvatar(
                        backgroundColor: i == 0 ? SC.accent : SC.accent2,
                        child: Text('${i + 1}'),
                      ),
                      title: Text(p.tracks[i].name),
                      subtitle: Text(
                        '${(p.tracks[i].durationMs / 1000).toStringAsFixed(1)} s'
                        '${p.tracks[i].muted ? ' · mudo' : ''}'
                        '${p.tracks[i].showVideo ? '' : ' · só áudio'}',
                        style: const TextStyle(color: SC.muted),
                      ),
                      trailing: IconButton(
                        icon: const Icon(Icons.delete_outline_rounded),
                        onPressed: () => _remove(i),
                      ),
                    ),
                  ),
                const SizedBox(height: 8),
                const Text(
                  'A prévia é aproximada. A sincronia fina e os efeitos entram na exportação.',
                  style: TextStyle(color: SC.muted, fontSize: 12),
                ),
              ],
            ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _loading ? null : _record,
        backgroundColor: SC.accent,
        foregroundColor: Colors.white,
        icon: const Icon(Icons.fiber_manual_record_rounded),
        label: Text(p.tracks.isEmpty ? 'Gravar' : 'Gravar novo take'),
      ),
      floatingActionButtonLocation: FloatingActionButtonLocation.centerFloat,
    );
  }

  Widget _chips<T>(List<T> values, T selected, String Function(T) label, void Function(T) onTap) {
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          for (final v in values)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: ChoiceChip(
                label: Text(label(v)),
                selected: v == selected,
                onSelected: (_) => onTap(v),
              ),
            ),
        ],
      ),
    );
  }
}
