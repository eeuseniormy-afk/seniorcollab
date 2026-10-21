// Sincronia precisa na gravação.
// 1) Os outros takes tocam por Web Audio, agendados num instante exato do relógio de áudio (T0).
// 2) O microfone também é capturado pelo mesmo relógio (AudioWorklet).
// 3) Depois de gravar, cruzamos o som do arquivo gravado com essa captura para saber,
//    ao milissegundo, onde o take começa em relação ao T0.
// 4) Descontamos a latência do fone/microfone (calibrada com palmas ou cliques).

const WORKLET = `
class SCCapture extends AudioWorkletProcessor {
  constructor() { super(); this.on = false; this.buf = new Float32Array(4096); this.n = 0; this.start = 0;
    this.port.onmessage = (e) => { if (e.data === 'start') { this.on = true; this.n = 0; } else if (e.data === 'stop') { this.flush(); this.on = false; } }; }
  flush() { if (this.n) { this.port.postMessage({ f: this.start, d: this.buf.slice(0, this.n) }); this.n = 0; } }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (this.on && ch) {
      if (this.n === 0) this.start = currentFrame;
      if (this.n + ch.length > this.buf.length) { this.flush(); this.start = currentFrame; }
      this.buf.set(ch, this.n); this.n += ch.length;
    }
    return true;
  }
}
registerProcessor('sc-capture', SCCapture);`;

const loaded = new WeakSet();
async function ensureWorklet(ctx) {
  if (loaded.has(ctx)) return;
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  loaded.add(ctx);
}

/** Captura do microfone com o carimbo de tempo do relógio de áudio. */
export class MicCapture {
  static async create(ctx, stream) {
    await ensureWorklet(ctx);
    const c = new MicCapture();
    c.ctx = ctx;
    c.src = ctx.createMediaStreamSource(stream);
    c.node = new AudioWorkletNode(ctx, 'sc-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
    c.sink = ctx.createGain(); c.sink.gain.value = 0;
    c.src.connect(c.node); c.node.connect(c.sink); c.sink.connect(ctx.destination);
    c.chunks = []; c.maxFrames = ctx.sampleRate * 40;
    c.node.port.onmessage = (e) => { if (c.frames() < c.maxFrames) c.chunks.push(e.data); };
    return c;
  }
  frames() { return this.chunks.reduce((a, c) => a + c.d.length, 0); }
  start(maxSeconds = 40) { this.chunks = []; this.maxFrames = this.ctx.sampleRate * maxSeconds; this.node.port.postMessage('start'); }
  async stop() { this.node.port.postMessage('stop'); await new Promise(r => setTimeout(r, 120)); }
  /** Junta tudo: { startTime (s no relógio de áudio), data, sr } */
  take() {
    if (!this.chunks.length) return null;
    const first = this.chunks[0].f, sr = this.ctx.sampleRate;
    const last = this.chunks[this.chunks.length - 1];
    const len = last.f + last.d.length - first;
    const data = new Float32Array(len);
    for (const c of this.chunks) data.set(c.d, c.f - first);
    return { startTime: first / sr, data, sr };
  }
  close() { try { this.src.disconnect(); this.node.disconnect(); this.sink.disconnect(); } catch (_) {} }
}

// ---------- FFT / correlação ----------
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = 2 * Math.PI / len * (inverse ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
function decimate(x, factor) {
  const n = Math.floor(x.length / factor), out = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; const o = i * factor; for (let k = 0; k < factor; k++) s += x[o + k]; out[i] = s / factor; }
  // tira o nível DC e branqueia levemente (diferença de primeira ordem) para picos mais nítidos
  let m = 0; for (let i = 0; i < n; i++) m += out[i]; m /= n || 1;
  let prev = 0;
  for (let i = 0; i < n; i++) { const v = out[i] - m; out[i] = v - 0.95 * prev; prev = v; }
  return out;
}

/**
 * Onde o trecho `a` (arquivo gravado) aparece dentro de `w` (captura do mic)?
 * Devolve { lag (s), confidence } com lag tal que a[t] ≈ w[t + lag].
 */
export function findLag(a, aStart, w, sr, maxLagS = 4) {
  const target = 8000;
  const f = Math.max(1, Math.round(sr / target));
  const rate = sr / f;
  const segLen = Math.min(Math.floor(8 * sr), a.length - aStart);
  if (segLen < sr * 1.5) return null;
  const A = decimate(a.subarray(aStart, aStart + segLen), f);
  const Wfull = decimate(w, f);
  const span = Math.min(Wfull.length, A.length + Math.ceil(maxLagS * rate) + Math.ceil(aStart / f));
  const W = Wfull.subarray(0, span);
  let N = 1; while (N < A.length + W.length) N <<= 1;
  const ar = new Float64Array(N), ai = new Float64Array(N), wr = new Float64Array(N), wi = new Float64Array(N);
  ar.set(A); wr.set(W);
  fft(ar, ai, false); fft(wr, wi, false);
  for (let i = 0; i < N; i++) {           // conj(A) * W
    const r = ar[i] * wr[i] + ai[i] * wi[i];
    const im = ar[i] * wi[i] - ai[i] * wr[i];
    ar[i] = r; ai[i] = im;
  }
  fft(ar, ai, true);
  const maxK = Math.min(W.length - 1, N - 1);
  let best = -Infinity, bestK = 0, sum = 0, cnt = 0;
  for (let k = 0; k <= maxK; k++) { const v = ar[k]; sum += Math.abs(v); cnt++; if (v > best) { best = v; bestK = k; } }
  const mean = sum / (cnt || 1);
  // refinamento sub-amostra (parábola)
  let frac = 0;
  if (bestK > 0 && bestK < maxK) {
    const y0 = ar[bestK - 1], y1 = ar[bestK], y2 = ar[bestK + 1];
    const d = y0 - 2 * y1 + y2; if (d !== 0) frac = 0.5 * (y0 - y2) / d;
  }
  const posInW = (bestK + frac) / rate;           // onde a[aStart] cai em w
  return { lag: posInW - aStart / sr, confidence: best / (mean || 1e-9) };
}

// ---------- latência do aparelho (fone + mic), salva no aparelho ----------
const LKEY = 'sc.latencyMs';
export function savedLatency() {
  const v = Number(localStorage.getItem(LKEY));
  return isFinite(v) && localStorage.getItem(LKEY) !== null ? v : null;
}
export function setLatency(ms) { localStorage.setItem(LKEY, String(Math.round(ms))); }
export function defaultLatency(ctx) {
  const base = ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000;
  return Math.round(Math.max(25, base + 20));
}

/**
 * Calibração: toca 12 cliques; o usuário bate palma junto (com fone) ou o mic escuta (sem fone).
 * Devolve a latência de ida e volta em ms, ou lança erro se não ouviu bem.
 */
export async function calibrate(ctx, capture, onBeat) {
  const n = 12, gap = 0.6;
  capture.start(n * gap + 3);
  await new Promise(r => setTimeout(r, 150));
  const T0 = ctx.currentTime + 0.6;
  const clicks = [];
  for (let i = 0; i < n; i++) {
    const t = T0 + i * gap;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = i % 4 === 0 ? 1760 : 1320;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.7, t + 0.002); g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.08);
    clicks.push(t);
    setTimeout(() => onBeat?.(i), Math.max(0, (t - ctx.currentTime) * 1000));
  }
  await new Promise(r => setTimeout(r, (T0 - ctx.currentTime + n * gap + 0.5) * 1000));
  await capture.stop();
  const cap = capture.take();
  if (!cap) throw new Error('O microfone não captou nada.');
  const { data, sr, startTime } = cap;
  // envelope
  const hop = Math.round(sr * 0.002);
  const env = [];
  for (let i = 0; i + hop <= data.length; i += hop) { let m = 0; for (let k = 0; k < hop; k++) { const v = Math.abs(data[i + k]); if (v > m) m = v; } env.push(m); }
  const sorted = [...env].sort((a, b) => a - b);
  const noise = sorted[Math.floor(sorted.length * 0.5)] || 0;
  const peak = sorted[Math.floor(sorted.length * 0.995)] || 0;
  const thr = Math.max(noise * 6, peak * 0.3, 0.01);
  const onsets = [];
  let last = -1e9;
  for (let i = 0; i < env.length; i++) {
    const t = startTime + (i * hop) / sr;
    if (env[i] > thr && t - last > 0.25) { onsets.push(t); last = t; }
  }
  const diffs = [];
  for (const c of clicks.slice(2)) {
    let bestD = null;
    for (const o of onsets) { const d = o - c; if (d > -0.15 && d < 0.45 && (bestD === null || Math.abs(d - 0.1) < Math.abs(bestD - 0.1))) bestD = d; }
    if (bestD !== null) diffs.push(bestD);
  }
  if (diffs.length < 5) throw new Error('Não ouvi as palmas/cliques direito. Tente num lugar mais silencioso e bata palmas bem junto do clique.');
  diffs.sort((a, b) => a - b);
  const mid = diffs.slice(Math.floor(diffs.length * 0.2), Math.ceil(diffs.length * 0.8));
  const med = mid.reduce((a, b) => a + b, 0) / mid.length;
  return Math.round(Math.max(0, med * 1000));
}
