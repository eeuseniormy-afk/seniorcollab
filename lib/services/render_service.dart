import 'dart:async';
import 'dart:io';

import 'package:ffmpeg_kit_flutter_new/ffmpeg_kit.dart';
import 'package:ffmpeg_kit_flutter_new/return_code.dart';

import '../models/project.dart';
import 'layout.dart';
import 'media.dart';

String _s(int ms) => (ms / 1000).toStringAsFixed(3);

String _eq(EqPreset p) => switch (p) {
      EqPreset.natural => '',
      EqPreset.voz =>
        'highpass=f=90,equalizer=f=250:t=q:w=1:g=-3,equalizer=f=3200:t=q:w=1.2:g=3,equalizer=f=10000:t=h:w=4000:g=2',
      EqPreset.brilho => 'treble=g=4:f=6000',
      EqPreset.grave => 'bass=g=4:f=120',
      EqPreset.instrumento =>
        'highpass=f=40,equalizer=f=400:t=q:w=1:g=-2,equalizer=f=5000:t=q:w=1:g=2',
    };

/// Monta os argumentos do FFmpeg para o projeto.
List<String> buildArgs(CollabProject p, String out, {required bool hardware}) {
  final f = p.format;
  final dur = p.durationMs <= 0 ? 1000 : p.durationMs;
  final args = <String>['-y'];
  for (final t in p.tracks) {
    args.addAll(['-i', t.path]);
  }

  final graph = <String>[];
  graph.add('color=c=0x101418:s=${f.width}x${f.height}:r=30:d=${_s(dur)}[bg]');

  // Vídeo
  final visible = <int>[];
  for (var i = 0; i < p.tracks.length; i++) {
    if (p.tracks[i].showVideo) visible.add(i);
  }
  final cells = computeCells(visible.length, f, p.layout);
  var last = 'bg';
  for (var k = 0; k < visible.length; k++) {
    final i = visible[k];
    final t = p.tracks[i];
    final c = cells[k];
    final chain = <String>['setpts=PTS-STARTPTS'];
    if (t.offsetMs < 0) {
      chain.add('trim=start=${_s(-t.offsetMs)}');
      chain.add('setpts=PTS-STARTPTS');
    }
    chain.add('scale=${c.w}:${c.h}:force_original_aspect_ratio=increase');
    chain.add('crop=${c.w}:${c.h}');
    chain.add('setsar=1');
    chain.add('fps=30');
    if (t.offsetMs > 0) {
      chain.add('tpad=start_duration=${_s(t.offsetMs)}:start_mode=clone');
    }
    chain.add('format=yuv420p');
    graph.add('[$i:v]${chain.join(',')}[v$k]');
    final outLabel = k == visible.length - 1 ? 'vout' : 'o$k';
    graph.add('[$last][v$k]overlay=x=${c.x}:y=${c.y}:eof_action=repeat[$outLabel]');
    last = outLabel;
  }
  if (visible.isEmpty) {
    graph.add('[bg]null[vout]');
  }

  // Áudio
  final aLabels = <String>[];
  for (var i = 0; i < p.tracks.length; i++) {
    final t = p.tracks[i];
    if (t.muted || !t.hasAudio || t.volume <= 0) continue;
    final chain = <String>['asetpts=PTS-STARTPTS'];
    if (t.offsetMs < 0) {
      chain.add('atrim=start=${_s(-t.offsetMs)}');
      chain.add('asetpts=PTS-STARTPTS');
    }
    chain.add('aresample=48000');
    chain.add('aformat=sample_fmts=fltp:channel_layouts=stereo');
    if (t.noiseReduction) chain.add('afftdn=nf=-25');
    final eq = _eq(t.eq);
    if (eq.isNotEmpty) chain.add(eq);
    if (t.compressor) {
      chain.add('acompressor=threshold=0.125:ratio=3:attack=10:release=150:makeup=2');
    }
    if (t.reverb > 0.02) {
      final r = t.reverb.clamp(0.0, 1.0);
      final d1 = (0.15 + r * 0.45).toStringAsFixed(2);
      final d2 = (0.10 + r * 0.35).toStringAsFixed(2);
      final d3 = (0.05 + r * 0.25).toStringAsFixed(2);
      chain.add('aecho=0.85:0.85:43|71|113:$d1|$d2|$d3');
    }
    chain.add('volume=${t.volume.toStringAsFixed(2)}');
    if (t.offsetMs > 0) chain.add('adelay=${t.offsetMs}:all=1');
    final label = 'a${aLabels.length}';
    graph.add('[$i:a]${chain.join(',')}[$label]');
    aLabels.add(label);
  }
  if (aLabels.isEmpty) {
    graph.add('anullsrc=r=48000:cl=stereo,atrim=duration=${_s(dur)}[am]');
  } else if (aLabels.length == 1) {
    graph.add('[${aLabels.first}]anull[am]');
  } else {
    graph.add(
        '${aLabels.map((l) => '[$l]').join()}amix=inputs=${aLabels.length}:duration=longest:normalize=0[am]');
  }
  // Volume final no padrão das redes (-14 LUFS) sem estourar.
  graph.add('[am]alimiter=limit=0.89:level=false,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]');

  args.addAll(['-filter_complex', graph.join(';')]);
  args.addAll(['-map', '[vout]', '-map', '[aout]', '-t', _s(dur)]);
  if (hardware) {
    args.addAll([
      '-c:v',
      Platform.isIOS ? 'h264_videotoolbox' : 'h264_mediacodec',
      '-b:v',
      f == OutputFormat.paisagem169 ? '14M' : '12M',
    ]);
  } else {
    args.addAll([
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-profile:v', 'high', '-level', '4.2',
    ]);
  }
  args.addAll([
    '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart',
    out,
  ]);
  return args;
}

class RenderResult {
  RenderResult(this.path, this.error);
  final String? path;
  final String? error;
}

class RenderService {
  int? _sessionId;

  Future<RenderResult> render(
    CollabProject p, {
    required void Function(double) onProgress,
  }) async {
    final dir = await exportDir();
    final stamp = DateTime.now().millisecondsSinceEpoch;
    final out = '${dir.path}/SeniorCollab_${p.format.short.replaceAll(':', 'x')}_$stamp.mp4';
    final dur = p.durationMs <= 0 ? 1000 : p.durationMs;

    for (final hw in [false, true]) {
      final completer = Completer<RenderResult>();
      final session = await FFmpegKit.executeWithArgumentsAsync(
        buildArgs(p, out, hardware: hw),
        (s) async {
          final rc = await s.getReturnCode();
          if (ReturnCode.isSuccess(rc)) {
            completer.complete(RenderResult(out, null));
          } else if (ReturnCode.isCancel(rc)) {
            completer.complete(RenderResult(null, 'Exportação cancelada.'));
          } else {
            final logs = await s.getAllLogsAsString() ?? '';
            final tail = logs.length > 1500 ? logs.substring(logs.length - 1500) : logs;
            completer.complete(RenderResult(null, tail));
          }
        },
        null,
        (stats) {
          final t = stats.getTime();
          if (t > 0) onProgress((t / dur).clamp(0.0, 1.0));
        },
      );
      _sessionId = session.getSessionId();
      final r = await completer.future;
      if (r.path != null || r.error == 'Exportação cancelada.') return r;
      if (hw) return r;
      // Tenta de novo com o codificador do próprio aparelho.
      onProgress(0);
    }
    return RenderResult(null, 'Falha desconhecida.');
  }

  Future<void> cancel() async {
    final id = _sessionId;
    if (id != null) await FFmpegKit.cancel(id);
  }
}
