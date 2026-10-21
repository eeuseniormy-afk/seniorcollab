import 'package:flutter_test/flutter_test.dart';
import 'package:seniorcollab/models/project.dart';
import 'package:seniorcollab/services/layout.dart';

void main() {
  test('layout cabe na tela', () {
    for (final f in OutputFormat.values) {
      for (final m in LayoutMode.values) {
        for (var n = 1; n <= 6; n++) {
          final cells = computeCells(n, f, m);
          expect(cells.length, n);
          for (final c in cells) {
            expect(c.x + c.w <= f.width, true);
            expect(c.y + c.h <= f.height, true);
          }
        }
      }
    }
  });
}
