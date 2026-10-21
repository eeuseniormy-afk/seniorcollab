import 'package:flutter/material.dart';

import '../main.dart';
import '../models/project.dart';
import '../services/playback.dart';

class MixerScreen extends StatefulWidget {
  const MixerScreen({super.key, required this.project, required this.playback});
  final CollabProject project;
  final Playback playback;

  @override
  State<MixerScreen> createState() => _MixerScreenState();
}

class _MixerScreenState extends State<MixerScreen> {
  CollabProject get p => widget.project;

  void _changed() {
    widget.playback.applyVolumes();
    p.changed();
    setState(() {});
  }

  Future<void> _toggle() async {
    if (widget.playback.playing) {
      await widget.playback.stopAll();
    } else {
      await widget.playback.playAll();
    }
    setState(() {});
  }

  @override
  void dispose() {
    widget.playback.stopAll();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Mixer', style: TextStyle(fontWeight: FontWeight.w700)),
        actions: [
          IconButton(
            icon: Icon(widget.playback.playing ? Icons.stop_rounded : Icons.play_arrow_rounded),
            onPressed: _toggle,
            tooltip: 'Ouvir',
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(12, 0, 12, 32),
        children: [
          for (var i = 0; i < p.tracks.length; i++) _trackCard(i, p.tracks[i]),
          const Padding(
            padding: EdgeInsets.all(8),
            child: Text(
              'Na exportação o áudio final é nivelado em -14 LUFS, o volume que Instagram, TikTok e YouTube esperam.',
              style: TextStyle(color: SC.muted, fontSize: 12),
            ),
          ),
        ],
      ),
    );
  }

  Widget _trackCard(int i, Track t) {
    return Card(
      color: SC.surface,
      margin: const EdgeInsets.only(top: 12),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                CircleAvatar(
                  radius: 14,
                  backgroundColor: i == 0 ? SC.accent : SC.accent2,
                  child: Text('${i + 1}', style: const TextStyle(fontSize: 12)),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(t.name,
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                ),
                FilterChip(
                  label: const Text('Mudo'),
                  selected: t.muted,
                  onSelected: (v) {
                    t.muted = v;
                    _changed();
                  },
                ),
                const SizedBox(width: 6),
                FilterChip(
                  label: const Text('Vídeo'),
                  selected: t.showVideo,
                  onSelected: (v) {
                    t.showVideo = v;
                    _changed();
                  },
                ),
              ],
            ),
            if (!t.hasAudio)
              const Padding(
                padding: EdgeInsets.only(top: 8),
                child: Text('Este vídeo não tem áudio.', style: TextStyle(color: SC.muted)),
              ),
            _label('Volume', '${(t.volume * 100).round()}%'),
            Slider(
              value: t.volume,
              min: 0,
              max: 2,
              divisions: 40,
              onChanged: (v) {
                t.volume = v;
                _changed();
              },
            ),
            if (i > 0 || p.tracks.length > 1) ...[
              _label('Sincronia', '${t.offsetMs > 0 ? '+' : ''}${t.offsetMs} ms'),
              Row(
                children: [
                  IconButton(
                    icon: const Icon(Icons.remove),
                    onPressed: () {
                      t.offsetMs -= 10;
                      _changed();
                    },
                  ),
                  Expanded(
                    child: Slider(
                      value: t.offsetMs.clamp(-3000, 3000).toDouble(),
                      min: -3000,
                      max: 3000,
                      onChanged: (v) {
                        t.offsetMs = v.round();
                        _changed();
                      },
                    ),
                  ),
                  IconButton(
                    icon: const Icon(Icons.add),
                    onPressed: () {
                      t.offsetMs += 10;
                      _changed();
                    },
                  ),
                ],
              ),
            ],
            const Divider(height: 20),
            Row(
              children: [
                const Text('Equalização'),
                const Spacer(),
                DropdownButton<EqPreset>(
                  value: t.eq,
                  underline: const SizedBox.shrink(),
                  items: [
                    for (final e in EqPreset.values)
                      DropdownMenuItem(value: e, child: Text(e.label)),
                  ],
                  onChanged: (e) {
                    if (e == null) return;
                    t.eq = e;
                    _changed();
                  },
                ),
              ],
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Redução de ruído'),
              value: t.noiseReduction,
              onChanged: (v) {
                t.noiseReduction = v;
                _changed();
              },
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Compressor'),
              subtitle: const Text('Deixa a voz mais presente e uniforme',
                  style: TextStyle(color: SC.muted, fontSize: 12)),
              value: t.compressor,
              onChanged: (v) {
                t.compressor = v;
                _changed();
              },
            ),
            _label('Reverb', '${(t.reverb * 100).round()}%'),
            Slider(
              value: t.reverb,
              onChanged: (v) {
                t.reverb = v;
                _changed();
              },
            ),
          ],
        ),
      ),
    );
  }

  Widget _label(String a, String b) => Padding(
        padding: const EdgeInsets.only(top: 10),
        child: Row(
          children: [
            Text(a),
            const Spacer(),
            Text(b, style: const TextStyle(color: SC.muted)),
          ],
        ),
      );
}
