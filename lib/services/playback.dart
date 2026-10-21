import 'dart:async';
import 'dart:io';

import 'package:video_player/video_player.dart';

import '../models/project.dart';

/// Mantém um player por faixa e toca todas juntas respeitando os deslocamentos.
class Playback {
  final Map<Track, VideoPlayerController> controllers = {};
  final List<Timer> _timers = [];
  bool playing = false;

  Future<void> sync(CollabProject p) async {
    final removed = controllers.keys.where((t) => !p.tracks.contains(t)).toList();
    for (final t in removed) {
      await controllers.remove(t)?.dispose();
    }
    for (final t in p.tracks) {
      if (!controllers.containsKey(t)) {
        final c = VideoPlayerController.file(File(t.path));
        controllers[t] = c;
        await c.initialize();
        if (t.durationMs == 0) t.durationMs = c.value.duration.inMilliseconds;
      }
    }
    applyVolumes();
  }

  void applyVolumes() {
    controllers.forEach((t, c) {
      c.setVolume(t.muted ? 0 : t.volume.clamp(0.0, 1.0));
    });
  }

  Future<void> playAll({int fromMs = 0}) async {
    await stopAll();
    playing = true;
    applyVolumes();
    final starts = <Future<void>>[];
    controllers.forEach((t, c) {
      final local = fromMs - t.offsetMs;
      if (local >= 0) {
        starts.add(c.seekTo(Duration(milliseconds: local)));
      } else {
        starts.add(c.seekTo(Duration.zero));
      }
    });
    await Future.wait(starts);
    controllers.forEach((t, c) {
      final local = fromMs - t.offsetMs;
      if (local >= 0) {
        if (local < t.durationMs) c.play();
      } else {
        _timers.add(Timer(Duration(milliseconds: -local), () {
          if (playing) c.play();
        }));
      }
    });
  }

  Future<void> stopAll() async {
    playing = false;
    for (final t in _timers) {
      t.cancel();
    }
    _timers.clear();
    for (final c in controllers.values) {
      await c.pause();
    }
  }

  Future<void> dispose() async {
    await stopAll();
    for (final c in controllers.values) {
      await c.dispose();
    }
    controllers.clear();
  }
}
