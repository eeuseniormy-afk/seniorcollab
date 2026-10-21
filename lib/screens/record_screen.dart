import 'dart:async';

import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../main.dart';
import '../models/project.dart';
import '../services/media.dart';
import '../services/playback.dart';
import '../widgets/collab_preview.dart';

/// Grava um take novo enquanto os takes anteriores tocam no fone.
class RecordScreen extends StatefulWidget {
  const RecordScreen({super.key, required this.project});
  final CollabProject project;

  @override
  State<RecordScreen> createState() => _RecordScreenState();
}

class _RecordScreenState extends State<RecordScreen> {
  List<CameraDescription> _cameras = [];
  CameraController? _cam;
  int _camIndex = 0;
  final _playback = Playback();
  String? _error;

  int? _countdown;
  bool _recording = false;
  bool _saving = false;
  final _sw = Stopwatch();
  int _playStartMs = 0;
  Timer? _ticker;
  Timer? _autoStop;

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    try {
      await _playback.sync(widget.project);
      _cameras = await availableCameras();
      if (_cameras.isEmpty) {
        setState(() => _error = 'Nenhuma câmera encontrada.');
        return;
      }
      final front = _cameras.indexWhere((c) => c.lensDirection == CameraLensDirection.front);
      _camIndex = front >= 0 ? front : 0;
      await _openCamera();
    } catch (e) {
      setState(() => _error = 'Não consegui abrir a câmera: $e');
    }
  }

  Future<void> _openCamera() async {
    final old = _cam;
    _cam = null;
    if (mounted) setState(() {});
    await old?.dispose();
    final c = CameraController(
      _cameras[_camIndex],
      ResolutionPreset.veryHigh,
      enableAudio: true,
    );
    await c.initialize();
    if (!mounted) {
      await c.dispose();
      return;
    }
    setState(() => _cam = c);
  }

  Future<void> _flip() async {
    if (_cameras.length < 2 || _recording) return;
    _camIndex = (_camIndex + 1) % _cameras.length;
    await _openCamera();
  }

  Future<void> _startCountdown() async {
    if (_cam == null || _recording || _countdown != null) return;
    for (var i = 3; i > 0; i--) {
      setState(() => _countdown = i);
      await Future.delayed(const Duration(seconds: 1));
      if (!mounted) return;
    }
    setState(() => _countdown = null);
    await _start();
  }

  Future<void> _start() async {
    final cam = _cam!;
    await WakelockPlus.enable();
    await cam.startVideoRecording();
    _sw
      ..reset()
      ..start();
    if (widget.project.tracks.isNotEmpty) {
      _playStartMs = _sw.elapsedMilliseconds;
      await _playback.playAll();
    } else {
      _playStartMs = 0;
    }
    setState(() => _recording = true);
    _ticker = Timer.periodic(const Duration(milliseconds: 200), (_) {
      if (mounted) setState(() {});
    });
    final total = widget.project.durationMs;
    if (total > 0) {
      _autoStop = Timer(Duration(milliseconds: total + 600), _stop);
    }
  }

  Future<void> _stop() async {
    if (!_recording || _saving) return;
    _autoStop?.cancel();
    _ticker?.cancel();
    setState(() => _saving = true);
    try {
      final file = await _cam!.stopVideoRecording();
      await _playback.stopAll();
      _sw.stop();
      final n = widget.project.tracks.length + 1;
      final track = await importToProject(file.path, 'Take $n');
      track.offsetMs = -(_playStartMs + widget.project.latencyMs);
      if (widget.project.tracks.isEmpty) track.offsetMs = 0;
      if (!mounted) return;
      Navigator.of(context).pop(track);
    } catch (e) {
      setState(() {
        _saving = false;
        _recording = false;
        _error = 'Erro ao salvar o take: $e';
      });
    } finally {
      await WakelockPlus.disable();
    }
  }

  @override
  void dispose() {
    _ticker?.cancel();
    _autoStop?.cancel();
    _cam?.dispose();
    _playback.dispose();
    WakelockPlus.disable();
    super.dispose();
  }

  String _fmt(int ms) {
    final s = ms ~/ 1000;
    return '${(s ~/ 60).toString().padLeft(2, '0')}:${(s % 60).toString().padLeft(2, '0')}';
  }

  Widget _cameraCell() {
    final cam = _cam;
    if (cam == null || !cam.value.isInitialized) {
      return const ColoredBox(
          color: Colors.black, child: Center(child: CircularProgressIndicator()));
    }
    final ps = cam.value.previewSize ?? const Size(1920, 1080);
    return FittedBox(
      fit: BoxFit.cover,
      clipBehavior: Clip.hardEdge,
      child: SizedBox(width: ps.height, height: ps.width, child: CameraPreview(cam)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final total = widget.project.durationMs;
    return Scaffold(
      backgroundColor: Colors.black,
      body: SafeArea(
        child: Column(
          children: [
            Row(
              children: [
                IconButton(
                  icon: const Icon(Icons.close),
                  onPressed: _recording ? null : () => Navigator.of(context).pop(),
                ),
                const Spacer(),
                Text(
                  _recording
                      ? '● ${_fmt(_sw.elapsedMilliseconds)}${total > 0 ? ' / ${_fmt(total)}' : ''}'
                      : 'Novo take',
                  style: TextStyle(
                    color: _recording ? SC.accent : Colors.white,
                    fontWeight: FontWeight.w700,
                    fontSize: 16,
                  ),
                ),
                const Spacer(),
                IconButton(
                  icon: const Icon(Icons.cameraswitch_rounded),
                  onPressed: _recording ? null : _flip,
                ),
              ],
            ),
            Expanded(
              child: Center(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  child: _error != null
                      ? Text(_error!, style: const TextStyle(color: Colors.white70))
                      : Stack(
                          alignment: Alignment.center,
                          children: [
                            CollabPreview(
                              project: widget.project,
                              controllers: _playback.controllers,
                              extra: _cameraCell(),
                            ),
                            if (_countdown != null)
                              Text('$_countdown',
                                  style: const TextStyle(
                                    fontSize: 120,
                                    fontWeight: FontWeight.w900,
                                    color: Colors.white,
                                    shadows: [Shadow(blurRadius: 24, color: Colors.black)],
                                  )),
                          ],
                        ),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 20),
              child: Column(
                children: [
                  GestureDetector(
                    onTap: _saving ? null : (_recording ? _stop : _startCountdown),
                    child: AnimatedContainer(
                      duration: const Duration(milliseconds: 200),
                      width: 78,
                      height: 78,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        border: Border.all(color: Colors.white, width: 4),
                      ),
                      child: Center(
                        child: AnimatedContainer(
                          duration: const Duration(milliseconds: 200),
                          width: _recording ? 30 : 60,
                          height: _recording ? 30 : 60,
                          decoration: BoxDecoration(
                            color: SC.accent,
                            borderRadius: BorderRadius.circular(_recording ? 6 : 30),
                          ),
                          child: _saving
                              ? const Padding(
                                  padding: EdgeInsets.all(6),
                                  child: CircularProgressIndicator(
                                      strokeWidth: 2, color: Colors.white))
                              : null,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    widget.project.tracks.isEmpty
                        ? 'Toque para gravar o primeiro take'
                        : 'Use fone de ouvido para não vazar o som dos outros takes',
                    style: const TextStyle(color: Colors.white54, fontSize: 12),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
