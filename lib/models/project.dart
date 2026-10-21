import 'package:flutter/foundation.dart';

/// Presets de equalização aplicados na exportação.
enum EqPreset { natural, voz, brilho, grave, instrumento }

extension EqPresetLabel on EqPreset {
  String get label => switch (this) {
        EqPreset.natural => 'Natural',
        EqPreset.voz => 'Voz',
        EqPreset.brilho => 'Brilho',
        EqPreset.grave => 'Grave',
        EqPreset.instrumento => 'Instrumento',
      };
}

/// Formatos de saída para redes sociais.
enum OutputFormat { vertical916, quadrado11, retrato45, paisagem169 }

extension OutputFormatInfo on OutputFormat {
  String get label => switch (this) {
        OutputFormat.vertical916 => '9:16  Reels, TikTok, Shorts',
        OutputFormat.quadrado11 => '1:1  Feed quadrado',
        OutputFormat.retrato45 => '4:5  Feed Instagram',
        OutputFormat.paisagem169 => '16:9  YouTube',
      };

  String get short => switch (this) {
        OutputFormat.vertical916 => '9:16',
        OutputFormat.quadrado11 => '1:1',
        OutputFormat.retrato45 => '4:5',
        OutputFormat.paisagem169 => '16:9',
      };

  int get width => this == OutputFormat.paisagem169 ? 1920 : 1080;

  int get height => switch (this) {
        OutputFormat.vertical916 => 1920,
        OutputFormat.quadrado11 => 1080,
        OutputFormat.retrato45 => 1350,
        OutputFormat.paisagem169 => 1080,
      };

  double get aspect => width / height;
}

/// Como as pessoas aparecem na tela.
enum LayoutMode { automatico, ladoALado, empilhado, grade }

extension LayoutModeLabel on LayoutMode {
  String get label => switch (this) {
        LayoutMode.automatico => 'Automático',
        LayoutMode.ladoALado => 'Lado a lado',
        LayoutMode.empilhado => 'Empilhado',
        LayoutMode.grade => 'Grade',
      };
}

class Track {
  Track({
    required this.path,
    required this.name,
    this.hasAudio = true,
    this.durationMs = 0,
    this.volume = 1.0,
    this.offsetMs = 0,
    this.muted = false,
    this.showVideo = true,
    this.noiseReduction = false,
    this.compressor = false,
    this.reverb = 0.0,
    this.eq = EqPreset.natural,
  });

  final String path;
  String name;
  bool hasAudio;
  int durationMs;

  /// 0.0 a 2.0
  double volume;

  /// Positivo atrasa a faixa, negativo adianta (corta o início).
  int offsetMs;
  bool muted;
  bool showVideo;
  bool noiseReduction;
  bool compressor;

  /// 0.0 a 1.0
  double reverb;
  EqPreset eq;

  /// Fim da faixa na linha do tempo do projeto.
  int get endMs => durationMs + offsetMs;
}

class CollabProject extends ChangeNotifier {
  final List<Track> tracks = [];
  OutputFormat format = OutputFormat.vertical916;
  LayoutMode layout = LayoutMode.automatico;

  /// Compensação de latência aplicada a cada take novo (ms).
  int latencyMs = 0;

  static const int maxTracks = 6;

  bool get canAddTrack => tracks.length < maxTracks;

  int get durationMs {
    var end = 0;
    for (final t in tracks) {
      if (t.endMs > end) end = t.endMs;
    }
    return end;
  }

  void add(Track t) {
    tracks.add(t);
    notifyListeners();
  }

  void removeAt(int i) {
    tracks.removeAt(i);
    notifyListeners();
  }

  void changed() => notifyListeners();
}
