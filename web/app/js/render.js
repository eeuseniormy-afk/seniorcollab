// Exportação no próprio aparelho: decodifica cada faixa (WebCodecs), monta no layout,
// mixa o áudio com os efeitos e codifica H.264 + AAC em MP4.
import { FORMATS, computeCells } from './layout.js';
import { buildChain, buildMaster, normalize } from './audio.js';
import { getMedia } from './db.js';

const FPS = 30, SR = 48000;
let Mux, MP4Box;
async function libs() {
  if (!Mux) Mux = await import('https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.1/+esm');
  if (!MP4Box) { const m = await import('https://cdn.jsdelivr.net/npm/mp4box@0.5.2/+esm'); MP4Box = m.default?.createFile ? m.default : m; }
}

export const QUALITIES = {
  hd:  { label: 'HD 720p', scale: 2 / 3, bpp: 0.11 },
  fhd: { label: 'Full HD 1080p', scale: 1, bpp: 0.13 },
  uhd: { label: '4K', scale: 2, bpp: 0.09 },
};

export function supportsExport() {
  return 'VideoEncoder' in window && 'VideoDecoder' in window;
}

async function videoConfig(w, h, bitrate) {
  const codecs = ['avc1.640034', 'avc1.640033', 'avc1.640032', 'avc1.640028', 'avc1.4d0034', 'avc1.42003e'];
  for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
    for (const codec of codecs) {
      const cfg = { codec, width: w, height: h, bitrate, framerate: FPS, hardwareAcceleration, latencyMode: 'quality', bitrateMode: 'variable', avc: { format: 'avc' } };
      try { const s = await VideoEncoder.isConfigSupported(cfg); if (s.supported) return cfg; } catch (_) {}
    }
  }
  return null;
}
async function audioConfig() {
  if (!('AudioEncoder' in window)) return null;
  for (const bitrate of [256000, 192000, 128000]) {
    const cfg = { codec: 'mp4a.40.2', sampleRate: SR, numberOfChannels: 2, bitrate };
    try { const s = await AudioEncoder.isConfigSupported(cfg); if (s.supported) return cfg; } catch (_) {}
  }
  return null;
}

/** Lê as amostras de vídeo de um MP4/MOV. */
async function demux(blob) {
  const buf = await blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const mp4 = MP4Box.createFile();
    let track; const samples = [];
    mp4.onError = (e) => reject(new Error('Arquivo de vídeo não reconhecido: ' + e));
    mp4.onReady = (info) => {
      track = info.videoTracks[0];
      if (!track) return reject(new Error('Sem faixa de vídeo.'));
      mp4.setExtractionOptions(track.id, null, { nbSamples: 100000 });
      mp4.start();
    };
    mp4.onSamples = (_id, _u, s) => { for (const x of s) samples.push(x); };
    buf.fileStart = 0;
    mp4.appendBuffer(buf);
    mp4.flush();
    if (!track) return reject(new Error('Formato não suportado (use MP4 ou MOV).'));
    const trak = mp4.getTrackById(track.id);
    const entry = trak.mdia.minf.stbl.stsd.entries[0];
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    let description;
    if (box) {
      const ds = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
      box.write(ds); description = new Uint8Array(ds.buffer, 8);
    }
    // rotação gravada pelo celular (matriz do tkhd)
    let rotation = 0;
    const m = track.matrix;
    if (m && m.length >= 2) {
      const a = m[0] / 65536, b = m[1] / 65536;
      rotation = Math.round(Math.atan2(b, a) * 180 / Math.PI);
      rotation = ((rotation % 360) + 360) % 360;
    }
    resolve({ track, samples, description, rotation, buf });
  });
}

/** Entrega o quadro certo de uma faixa para cada instante da linha do tempo. */
class Source {
  constructor(d, offsetUs) {
    this.d = d; this.offset = offsetUs; this.q = []; this.i = 0; this.flushed = false; this.err = null;
    this.waiters = [];
  }
  async init() {
    const { track, description } = this.d;
    const cfg = { codec: track.codec, codedWidth: track.video.width, codedHeight: track.video.height, description, hardwareAcceleration: 'prefer-hardware' };
    let ok = false;
    try { ok = (await VideoDecoder.isConfigSupported(cfg)).supported; } catch (_) {}
    if (!ok) { delete cfg.hardwareAcceleration; try { ok = (await VideoDecoder.isConfigSupported(cfg)).supported; } catch (_) {} }
    if (!ok) throw new Error(`Este navegador não decodifica ${track.codec}.`);
    this.dec = new VideoDecoder({
      output: (f) => { this.q.push(f); this.q.sort((a, b) => a.timestamp - b.timestamp); this._wake(); },
      error: (e) => { this.err = e; this._wake(); },
    });
    this.dec.configure(cfg);
  }
  _wake() { const w = this.waiters; this.waiters = []; w.forEach(r => r()); }
  _wait() { return new Promise(r => { this.waiters.push(r); setTimeout(r, 30); }); }
  _feed(n) {
    const s = this.d.samples;
    for (let k = 0; k < n && this.i < s.length; k++, this.i++) {
      const x = s[this.i];
      this.dec.decode(new EncodedVideoChunk({
        type: x.is_sync ? 'key' : 'delta',
        timestamp: Math.round(x.cts * 1e6 / x.timescale),
        duration: Math.round(x.duration * 1e6 / x.timescale),
        data: x.data,
      }));
      x.data = null; // libera memória
    }
  }
  /** Quadro para o instante T (µs na linha do tempo do projeto). */
  async frameAt(T) {
    const local = T - this.offset;
    for (let guard = 0; guard < 4000; guard++) {
      if (this.err) throw this.err;
      while (this.q.length >= 2 && this.q[1].timestamp <= local) this.q.shift().close();
      const doneAll = this.flushed && this.dec.decodeQueueSize === 0;
      if (this.q.length >= 2) return this.q[0];
      if (this.q.length === 1 && (this.q[0].timestamp > local || doneAll)) return this.q[0];
      if (this.i < this.d.samples.length) {
        if (this.dec.decodeQueueSize < 6) this._feed(4);
        await this._wait();
      } else if (!this.flushed) {
        this.flushed = true;
        await this.dec.flush().catch(() => {});
      } else if (doneAll) {
        return this.q[0] || null;
      } else {
        await this._wait();
      }
    }
    return this.q[0] || null;
  }
  close() { this.q.forEach(f => f.close()); this.q = []; try { this.dec.close(); } catch (_) {} }
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  if (c.roundRect) c.roundRect(x, y, w, h, r);
  else c.rect(x, y, w, h);
}

function drawCover(c, frame, cell, rotation, radius) {
  const rot = rotation % 180 !== 0;
  const fw = rot ? frame.displayHeight : frame.displayWidth;
  const fh = rot ? frame.displayWidth : frame.displayHeight;
  const s = Math.max(cell.w / fw, cell.h / fh);
  c.save();
  roundRect(c, cell.x, cell.y, cell.w, cell.h, radius);
  c.clip();
  c.translate(cell.x + cell.w / 2, cell.y + cell.h / 2);
  if (rotation) c.rotate(rotation * Math.PI / 180);
  const dw = frame.displayWidth * s, dh = frame.displayHeight * s;
  c.drawImage(frame, -dw / 2, -dh / 2, dw, dh);
  c.restore();
}

export function projectDurationMs(p) {
  let end = 0;
  for (const t of p.tracks) end = Math.max(end, t.offsetMs + t.durationMs);
  return Math.max(0, end);
}

/** Mixa todas as faixas com efeitos, offline, e normaliza. */
async function mixAudio(p, durS, onStatus) {
  const len = Math.max(1, Math.ceil(durS * SR));
  const ctx = new OfflineAudioContext(2, len, SR);
  const { bus, reverbIn } = buildMaster(ctx, ctx.destination);
  let any = false;
  for (const t of p.tracks) {
    if (t.muted || !t.hasAudio) continue;
    onStatus?.(`Preparando o áudio de ${t.name}…`);
    let buf;
    try {
      const blob = await getMedia(t.mediaId);
      buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    } catch (_) { continue; }
    const src = ctx.createBufferSource(); src.buffer = buf;
    buildChain(ctx, t, src, bus, reverbIn);
    const off = t.offsetMs / 1000;
    if (off >= 0) src.start(off); else src.start(0, -off);
    any = true;
  }
  if (!any) return null;
  onStatus?.('Mixando…');
  const out = await ctx.startRendering();
  return normalize(out, -14, -1);
}

/**
 * Renderiza o projeto. Devolve Blob MP4.
 * opts: { quality: 'fhd' | 'uhd' | 'hd', onProgress(0..1), onStatus(text), signal }
 */
export async function renderProject(p, opts = {}) {
  const { onProgress = () => {}, onStatus = () => {}, signal } = opts;
  await libs();
  const q = QUALITIES[opts.quality || 'fhd'];
  const f = FORMATS[p.format];
  const even = (v) => Math.round(v / 2) * 2;
  const W = even(f.w * q.scale), H = even(f.h * q.scale);
  const bitrate = Math.round(W * H * FPS * q.bpp);
  const vcfg = await videoConfig(W, H, bitrate);
  if (!vcfg) throw new Error('Este aparelho não codifica vídeo nessa resolução. Tente uma qualidade menor.');
  const acfg = await audioConfig();
  const durMs = projectDurationMs(p);
  if (durMs <= 0) throw new Error('Projeto vazio.');
  const durS = durMs / 1000;

  // áudio primeiro (rápido) para falhar cedo
  const mix = acfg ? await mixAudio(p, durS, onStatus) : null;

  onStatus('Lendo os vídeos…');
  const visible = p.tracks.filter(t => t.showVideo);
  const sources = [];
  for (const t of visible) {
    const blob = await getMedia(t.mediaId);
    const d = await demux(blob);
    d.buf = null;
    const s = new Source(d, t.offsetMs * 1000);
    await s.init();
    s.rotation = d.rotation;
    sources.push(s);
  }
  const cells = computeCells(visible.length, p.format, p.layout, p.separar, q.scale)
    .map(c => ({ ...c, x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.w), h: Math.round(c.h) }));
  const radius = p.separar && visible.length > 1 ? Math.round(Math.min(W, H) * 0.012) : 0;

  const muxer = new Mux.Muxer({
    target: new Mux.ArrayBufferTarget(),
    video: { codec: 'avc', width: W, height: H, frameRate: FPS },
    audio: mix ? { codec: 'aac', numberOfChannels: 2, sampleRate: SR } : undefined,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const c = canvas.getContext('2d', { alpha: false });
  let encErr = null;
  const enc = new VideoEncoder({ output: (ch, m) => muxer.addVideoChunk(ch, m), error: (e) => { encErr = e; } });
  enc.configure(vcfg);

  const total = Math.ceil(durS * FPS);
  try {
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
      if (encErr) throw encErr;
      const T = Math.round(i * 1e6 / FPS);
      c.fillStyle = '#0B0D10'; c.fillRect(0, 0, W, H);
      for (let k = 0; k < sources.length; k++) {
        const fr = await sources[k].frameAt(T);
        if (fr) drawCover(c, fr, cells[k], sources[k].rotation, radius);
      }
      const vf = new VideoFrame(canvas, { timestamp: T, duration: Math.round(1e6 / FPS) });
      while (enc.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 1));
      enc.encode(vf, { keyFrame: i % (FPS * 2) === 0 });
      vf.close();
      if (i % 10 === 0) { onProgress(0.05 + 0.85 * i / total); onStatus(`Renderizando ${Math.round(i / total * 100)}%`); }
    }
    await enc.flush();
  } finally {
    try { enc.close(); } catch (_) {}
    sources.forEach(s => s.close());
  }

  if (mix) {
    onStatus('Codificando o áudio…');
    const aenc = new AudioEncoder({ output: (ch, m) => muxer.addAudioChunk(ch, m), error: (e) => { encErr = e; } });
    aenc.configure(acfg);
    const L = mix.getChannelData(0), R = mix.getChannelData(1), N = 1024;
    for (let i = 0; i < mix.length; i += N) {
      const n = Math.min(N, mix.length - i);
      const data = new Float32Array(n * 2);
      data.set(L.subarray(i, i + n), 0); data.set(R.subarray(i, i + n), n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(i / SR * 1e6), data });
      aenc.encode(ad); ad.close();
      if (aenc.encodeQueueSize > 32) await new Promise(r => setTimeout(r, 0));
    }
    await aenc.flush(); aenc.close();
    if (encErr) throw encErr;
  }
  onProgress(1);
  muxer.finalize();
  return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), width: W, height: H, codec: vcfg.codec, audio: !!mix };
}

/** Duração e se tem áudio, lendo o arquivo. */
export async function probe(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const v = document.createElement('video');
    v.preload = 'metadata'; v.muted = true; v.playsInline = true; v.src = url;
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('Não consegui abrir esse vídeo.')); });
    let dur = v.duration;
    if (!isFinite(dur)) { v.currentTime = 1e9; await new Promise(r => { v.ontimeupdate = r; setTimeout(r, 1500); }); dur = v.duration; }
    let hasAudio = true;
    if ('mozHasAudio' in v) hasAudio = v.mozHasAudio;
    else if (v.audioTracks) hasAudio = v.audioTracks.length > 0;
    return { durationMs: Math.round((isFinite(dur) ? dur : 0) * 1000), hasAudio };
  } finally { URL.revokeObjectURL(url); }
}
