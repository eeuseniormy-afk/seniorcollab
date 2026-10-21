import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';

import '../models/project.dart';
import '../services/layout.dart';

/// Mostra como o vídeo final vai ficar, no formato escolhido.
/// [extra] ocupa a próxima célula (usado pela câmera ao gravar um take novo).
class CollabPreview extends StatelessWidget {
  const CollabPreview({
    super.key,
    required this.project,
    required this.controllers,
    this.extra,
  });

  final CollabProject project;
  final Map<Track, VideoPlayerController> controllers;
  final Widget? extra;

  @override
  Widget build(BuildContext context) {
    final f = project.format;
    final visible = project.tracks.where((t) => t.showVideo).toList();
    final n = visible.length + (extra != null ? 1 : 0);
    final cells = computeCells(n, f, project.layout, gap: project.separar);

    return AspectRatio(
      aspectRatio: f.aspect,
      child: LayoutBuilder(builder: (context, box) {
        final sx = box.maxWidth / f.width;
        final sy = box.maxHeight / f.height;
        final children = <Widget>[];
        for (var i = 0; i < n; i++) {
          final c = cells[i];
          Widget content;
          if (i < visible.length) {
            final ctrl = controllers[visible[i]];
            content = ctrl != null && ctrl.value.isInitialized
                ? _Cover(controller: ctrl)
                : const ColoredBox(color: Colors.black26);
          } else {
            content = extra!;
          }
          children.add(Positioned(
            left: c.x * sx,
            top: c.y * sy,
            width: c.w * sx,
            height: c.h * sy,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(project.separar && n > 1 ? 4 : 0),
              child: content,
            ),
          ));
        }
        return Container(
          decoration: BoxDecoration(
            color: const Color(0xFF101418),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: Colors.white12),
          ),
          clipBehavior: Clip.antiAlias,
          child: n == 0
              ? const Center(
                  child: Text('Grave o primeiro take',
                      style: TextStyle(color: Colors.white54)))
              : Stack(children: children),
        );
      }),
    );
  }
}

class _Cover extends StatelessWidget {
  const _Cover({required this.controller});
  final VideoPlayerController controller;

  @override
  Widget build(BuildContext context) {
    final size = controller.value.size;
    return FittedBox(
      fit: BoxFit.cover,
      clipBehavior: Clip.hardEdge,
      child: SizedBox(
        width: size.width == 0 ? 16 : size.width,
        height: size.height == 0 ? 9 : size.height,
        child: VideoPlayer(controller),
      ),
    );
  }
}
