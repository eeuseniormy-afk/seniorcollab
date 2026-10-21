import 'dart:io';

import 'package:ffmpeg_kit_flutter_new/ffprobe_kit.dart';
import 'package:path_provider/path_provider.dart';

import '../models/project.dart';

class MediaInfo {
  MediaInfo(this.durationMs, this.hasAudio, this.hasVideo);
  final int durationMs;
  final bool hasAudio;
  final bool hasVideo;
}

Future<MediaInfo> probe(String path) async {
  final session = await FFprobeKit.getMediaInformation(path);
  final info = session.getMediaInformation();
  if (info == null) return MediaInfo(0, true, true);
  final dur = double.tryParse(info.getDuration() ?? '') ?? 0;
  var audio = false, video = false;
  for (final s in info.getStreams()) {
    final type = s.getType();
    if (type == 'audio') audio = true;
    if (type == 'video') video = true;
  }
  return MediaInfo((dur * 1000).round(), audio, video);
}

/// Copia o arquivo para a pasta do app (o original da galeria pode sumir).
Future<Track> importToProject(String sourcePath, String name) async {
  final dir = await projectDir();
  final ext = sourcePath.contains('.') ? sourcePath.split('.').last : 'mp4';
  final dest = '${dir.path}/${DateTime.now().millisecondsSinceEpoch}.$ext';
  await File(sourcePath).copy(dest);
  final info = await probe(dest);
  return Track(
    path: dest,
    name: name,
    hasAudio: info.hasAudio,
    durationMs: info.durationMs,
  );
}

Future<Directory> projectDir() async {
  final base = await getApplicationDocumentsDirectory();
  final dir = Directory('${base.path}/takes');
  if (!dir.existsSync()) dir.createSync(recursive: true);
  return dir;
}

Future<Directory> exportDir() async {
  final base = await getApplicationDocumentsDirectory();
  final dir = Directory('${base.path}/exports');
  if (!dir.existsSync()) dir.createSync(recursive: true);
  return dir;
}
