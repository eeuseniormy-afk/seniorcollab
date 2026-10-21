import '../models/project.dart';

class Cell {
  const Cell(this.x, this.y, this.w, this.h);
  final int x, y, w, h;
}

int _even(num v) => (v ~/ 2) * 2;

/// Calcula a posição de cada pessoa na tela, para a prévia e para a exportação.
List<Cell> computeCells(int n, OutputFormat f, LayoutMode mode, {bool gap = true}) {
  if (n <= 0) return const [];
  final w = f.width, h = f.height;
  final portrait = h >= w;

  int cols, rows;
  switch (mode) {
    case LayoutMode.ladoALado:
      cols = n;
      rows = 1;
    case LayoutMode.empilhado:
      cols = 1;
      rows = n;
    case LayoutMode.grade:
      cols = n == 1 ? 1 : 2;
      rows = (n / cols).ceil();
    case LayoutMode.automatico:
      if (n == 1) {
        cols = 1;
        rows = 1;
      } else if (n == 2) {
        cols = portrait ? 1 : 2;
        rows = portrait ? 2 : 1;
      } else if (n == 3) {
        cols = portrait ? 1 : 3;
        rows = portrait ? 3 : 1;
        if (f == OutputFormat.quadrado11 || f == OutputFormat.retrato45) {
          cols = 2;
          rows = 2;
        }
      } else {
        cols = portrait ? 2 : 3;
        rows = (n / cols).ceil();
      }
  }

  // Espaço entre os vídeos (e nas bordas) quando há mais de um.
  final m = (gap && n > 1) ? _even((w < h ? w : h) * 0.016) : 0;
  final cw = _even((w - (cols + 1) * m) / cols);
  final ch = _even((h - (rows + 1) * m) / rows);
  final usedH = rows * ch + (rows + 1) * m;
  final top = _even((h - usedH) / 2);
  final cells = <Cell>[];
  for (var i = 0; i < n; i++) {
    final r = i ~/ cols;
    final c = i % cols;
    // Centraliza a última linha quando ela está incompleta.
    final inRow = (r == rows - 1) ? n - r * cols : cols;
    final rowW = inRow * cw + (inRow - 1) * m;
    final rowOffset = _even((w - rowW) / 2);
    cells.add(Cell(rowOffset + c * (cw + m), top + m + r * (ch + m), cw, ch));
  }
  return cells;
}
