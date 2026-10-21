export const FORMATS = {
  '9:16': { label: '9:16 · Reels, TikTok, Shorts', w: 1080, h: 1920 },
  '1:1':  { label: '1:1 · Feed quadrado', w: 1080, h: 1080 },
  '4:5':  { label: '4:5 · Feed retrato', w: 1080, h: 1350 },
  '16:9': { label: '16:9 · YouTube', w: 1920, h: 1080 },
};
export const LAYOUTS = { auto: 'Automático', lado: 'Lado a lado', empilhado: 'Empilhado', grade: 'Grade' };

const even = (v) => Math.floor(v / 2) * 2;

/** Mesma conta do app: posição de cada pessoa na tela. */
export function computeCells(n, fmtKey, mode, gap = true, scale = 1) {
  if (n <= 0) return [];
  const f = FORMATS[fmtKey];
  const w = f.w * scale, h = f.h * scale;
  const portrait = h >= w;
  let cols, rows;
  if (mode === 'lado') { cols = n; rows = 1; }
  else if (mode === 'empilhado') { cols = 1; rows = n; }
  else if (mode === 'grade') { cols = n === 1 ? 1 : 2; rows = Math.ceil(n / cols); }
  else {
    if (n === 1) { cols = 1; rows = 1; }
    else if (n === 2) { cols = portrait ? 1 : 2; rows = portrait ? 2 : 1; }
    else if (n === 3) {
      cols = portrait ? 1 : 3; rows = portrait ? 3 : 1;
      if (fmtKey === '1:1' || fmtKey === '4:5') { cols = 2; rows = 2; }
    } else { cols = portrait ? 2 : 3; rows = Math.ceil(n / cols); }
  }
  const m = gap && n > 1 ? even(Math.min(w, h) * 0.016) : 0;
  const cw = even((w - (cols + 1) * m) / cols);
  const ch = even((h - (rows + 1) * m) / rows);
  const usedH = rows * ch + (rows + 1) * m;
  const top = even((h - usedH) / 2);
  const cells = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    const inRow = r === rows - 1 ? n - r * cols : cols;
    const rowW = inRow * cw + (inRow - 1) * m;
    const off = even((w - rowW) / 2);
    cells.push({ x: off + c * (cw + m), y: top + m + r * (ch + m), w: cw, h: ch, gap: m });
  }
  return cells;
}
