// Exportação no próprio aparelho: decodifica cada faixa (WebCodecs), monta no layout,
// mixa o áudio com os efeitos e codifica H.264 + AAC em MP4.
import { FORMATS, computeCells } from './layout.js?v=0.2.0-web';
import { buildChain, buildMaster, normalize } from './audio.js?v=0.2.0-web';
import { mediaMeta, readSamples, decodeAudio, mp4box, forgetMedia } from './media.js?v=0.2.0-web';
import { findLag } from './sync.js?v=0.2.0-web';
import { audioCtx } from './player.js?v=0.2.0-web';

const FPS = 30, SR = 48000;
let Mux;
async function libs() {
  if (!Mux) Mux = await import('https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.1/+esm');
  await mp4box();
}

export const QUALITIES = {
  hd:  { label: 'HD 720p', scale: 2 / 3, bpp: 0.11 },
  fhd: { label: 'Full HD 1080p', scale: 1, bpp: 0.13 },
  uhd: { label: '4K', scale: 2, bpp: 0.09 },
};

export function supportsExport() {
  return 'VideoEncoder' in window && 'VideoDecoder' in window;
}

async function videoConfig(w, h, bitrate, sw = false) {
  const codecs = ['avc1.640034', 'avc1.640033', 'avc1.640032', 'avc1.640028', 'avc1.4d0034', 'avc1.42003e'];
  for (const hardwareAcceleration of (sw ? ['no-preference', 'prefer-software'] : ['prefer-hardware', 'no-preference'])) {
    for (const codec of codecs) {
      const cfg = { codec, width: w, height: h, bitrate, framerate: FPS, hardwareAcceleration, latencyMode: 'quality', bitrateMode: 'variable', avc: { format: 'avc' } };
      try { const s = await VideoEncoder.isConfigSupported(cfg); if (s.supported) return cfg; } catch (_) {}
    }
  }
  return null;
}

/** Entrega o quadro certo de uma faixa para cada instante da linha do tempo. */
class Source {
  constructor(meta, offsetUs) {
    this.meta = meta; this.v = meta.video; this.offset = offsetUs;
    this.q = []; this.i = 0; this.flushed = false; this.err = null; this.waiters = []; this.reading = null;
    this.rotation = this.v.rotation;
  }
  async init() {
    const v = this.v;
    const base = { codec: v.codec, codedWidth: v.width, codedHeight: v.height, description: v.description };
    let cfg = null;
    for (const extra of [{ hardwareAcceleration: 'prefer-hardware' }, {}, { hardwareAcceleration: 'prefer-software' }]) {
      const c = { ...base, ...extra };
      try { if ((await VideoDecoder.isConfigSupported(c)).supported) { cfg = c; break; } } catch (_) {}
    }
    if (!cfg) throw new Error(`Este navegador não consegue ler o vídeo (${v.codec}).`);
    this.dec = new VideoDecoder({
      output: (f) => { this.q.push(f); this.q.sort((a, b) => a.timestamp - b.timestamp); this._wake(); },
      error: (e) => { this.err = e; this._wake(); },
    });
    this.dec.configure(cfg);
  }
  _wake() { const w = this.waiters; this.waiters = []; w.forEach(r => r()); }
  _wait() { return new Promise(r => { this.waiters.push(r); setTimeout(r, 25); }); }
  async _feed(n) {
    const s = this.v.samples;
    const batch = s.slice(this.i, this.i + n);
    if (!batch.length) return;
    const datas = await readSamples(this.meta.blob, batch);
    for (let k = 0; k < batch.length; k++) {
      const x = batch[k];
      if (this.dec.state !== 'configured') return;
      this.dec.decode(new EncodedVideoChunk({
        type: x.sync ? 'key' : 'delta',
        timestamp: Math.round((x.cts - this.v.t0) * 1e6 / x.ts),
        duration: Math.round(x.duration * 1e6 / x.ts),
        data: datas[k],
      }));
    }
    this.i += batch.length;
  }
  /** Quadro para o instante T (µs na linha do tempo do projeto). */
  async frameAt(T) {
    const local = T - this.offset;
    for (let guard = 0; guard < 6000; guard++) {
      if (this.err) throw new Error('Falha ao ler o vídeo: ' + (this.err.message || this.err));
      while (this.q.length >= 2 && this.q[1].timestamp <= local) this.q.shift().close();
      const doneAll = this.flushed && this.dec.decodeQueueSize === 0;
      if (this.q.length >= 2) return this.q[0];
      if (this.q.length === 1 && (this.q[0].timestamp > local || doneAll)) return this.q[0];
      if (this.i < this.v.samples.length) {
        if (this.dec.decodeQueueSize < 8) await this._feed(12);
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

/** A duração do projeto é a do vídeo base (1ª faixa): o original do dueto ou o 1º take. */
export function projectDurationMs(p) {
  if (!p.tracks.length) return 0;
  const b = p.tracks[0];
  return Math.max(0, b.offsetMs + b.durationMs);
}

// AudioSpecificConfig AAC-LC (para quando o navegador não informa)
function ascAAC(sr, ch) {
  const idx = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000].indexOf(sr);
  return new Uint8Array([(2 << 3) | (idx >> 1), ((idx & 1) << 7) | (ch << 3)]);
}

/** 1ª opção: AudioEncoder (AAC). */
async function encodeWithAudioEncoder(mix, codec, mux) {
  if (!('AudioEncoder' in window)) return null;
  const cfg = { codec, sampleRate: SR, numberOfChannels: 2, bitrate: 256000 };
  let ok = false;
  for (const br of [256000, 192000, 128000]) {
    cfg.bitrate = br;
    try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) { ok = true; break; } } catch (_) {}
  }
  if (!ok) return null;
  const chunks = []; let err = null, dcfg = null;
  const enc = new AudioEncoder({
    output: (ch, m) => {
      const data = new Uint8Array(ch.byteLength); ch.copyTo(data);
      chunks.push({ data, type: ch.type, timestamp: ch.timestamp, duration: ch.duration ?? Math.round(1024 / SR * 1e6) });
      if (m?.decoderConfig && !dcfg) dcfg = m.decoderConfig;
    },
    error: (e) => { err = e; },
  });
  enc.configure(cfg);
  const L = mix.getChannelData(0), R = mix.getChannelData(1), N = 1024;
  for (let i = 0; i < mix.length; i += N) {
    if (err) break;
    const n = Math.min(N, mix.length - i);
    const data = new Float32Array(n * 2);
    data.set(L.subarray(i, i + n), 0); data.set(R.subarray(i, i + n), n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(i / SR * 1e6), data });
    enc.encode(ad); ad.close();
    if (enc.encodeQueueSize > 32) await new Promise(r => setTimeout(r, 0));
  }
  try { await enc.flush(); } catch (e) { err = err || e; }
  try { enc.close(); } catch (_) {}
  const total = chunks.reduce((a, c) => a + c.data.length, 0);
  if (err || chunks.length < 4 || total < chunks.length * 8) return null;   // saída vazia/defeituosa
  // configuração confiável: sempre declara 48 kHz estéreo (evita o bug de "0 canais" do iOS)
  const decoderConfig = mux === 'aac'
    ? { codec: 'mp4a.40.2', sampleRate: SR, numberOfChannels: 2, description: (dcfg?.description && dcfg.description.byteLength >= 2) ? dcfg.description : ascAAC(SR, 2) }
    : { codec, sampleRate: SR, numberOfChannels: 2, description: dcfg?.description };
  return { chunks, mux, decoderConfig, sampleRate: SR, channels: 2, how: mux === 'aac' ? 'AAC' : 'Opus' };
}

/** 2ª opção: grava o mix com o MediaRecorder do aparelho (AAC em tempo real) e alinha pelo som. */
async function encodeWithMediaRecorder(mix, onStatus, signal) {
  if (!window.MediaRecorder) return null;
  const mime = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4'].find(m => MediaRecorder.isTypeSupported(m));
  if (!mime) return null;
  const ctx = audioCtx();
  try { await ctx.resume(); } catch (_) {}
  const dest = ctx.createMediaStreamDestination();
  dest.channelCount = 2;
  const src = ctx.createBufferSource(); src.buffer = mix; src.connect(dest);
  const rec = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: 256000 });
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data?.size) parts.push(e.data); };
  const started = new Promise(r => { rec.onstart = r; });
  rec.start(1000); await started;
  const lead = 0.3;
  src.start(ctx.currentTime + lead);
  const dur = mix.duration + lead + 0.6;
  const t0 = performance.now();
  await new Promise((res, rej) => {
    const iv = setInterval(() => {
      const el = (performance.now() - t0) / 1000;
      onStatus?.(`Gravando o áudio final ${Math.min(100, Math.round(el / dur * 100))}%`);
      if (signal?.aborted) { clearInterval(iv); try { rec.stop(); src.stop(); } catch (_) {} rej(new DOMException('Cancelado', 'AbortError')); }
      if (el >= dur) { clearInterval(iv); res(); }
    }, 250);
  });
  const stopped = new Promise(r => { rec.onstop = r; });
  rec.stop(); await stopped;
  try { src.disconnect(); } catch (_) {}
  const blob = new Blob(parts, { type: rec.mimeType || 'audio/mp4' });
  const key = 'mixrec-' + Math.random();
  let meta;
  try { meta = await mediaMeta(key, blob); } catch (_) { return null; } finally { forgetMedia(key); }
  const a = meta.audio;
  if (!a || !a.samples.length) return null;
  const isAAC = a.codec.startsWith('mp4a');
  // onde o mix começa dentro da gravação
  let shiftUs = Math.round(lead * 1e6);
  try {
    const recBuf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const r = findLag(mix.getChannelData(0), Math.round(0.5 * mix.sampleRate), recBuf.getChannelData(0), recBuf.sampleRate, 3);
    if (r && r.confidence > 8) shiftUs = Math.round(r.lag * 1e6);
  } catch (_) {}
  const datas = await readSamples(blob, a.samples);
  const chunks = [];
  a.samples.forEach((s, i) => {
    const ts = Math.round((s.cts - a.t0) * 1e6 / s.ts) - shiftUs;
    const d = Math.round(s.duration * 1e6 / s.ts);
    if (ts + d <= 0) return;
    chunks.push({ data: datas[i], type: 'key', timestamp: Math.max(0, ts), duration: d });
  });
  if (chunks.length < 4) return null;
  return {
    chunks, mux: isAAC ? 'aac' : 'opus', sampleRate: a.sampleRate, channels: a.channels,
    decoderConfig: { codec: isAAC ? 'mp4a.40.2' : a.codec, sampleRate: a.sampleRate, numberOfChannels: a.channels, description: a.description || (isAAC ? ascAAC(a.sampleRate, a.channels) : undefined) },
    how: isAAC ? 'AAC (gravado)' : a.codec,
  };
}

async function encodeAudio(mix, onStatus, signal) {
  onStatus('Codificando o áudio…');
  return (await encodeWithAudioEncoder(mix, 'mp4a.40.2', 'aac').catch(() => null))
    || (await encodeWithMediaRecorder(mix, onStatus, signal).catch((e) => { if (e?.name === 'AbortError') throw e; return null; }))
    || (await encodeWithAudioEncoder(mix, 'opus', 'opus').catch(() => null));
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
    const buf = await decodeAudio(t.mediaId, audioCtx()).catch(() => null);
    if (!buf) continue;
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
  const vcfg = await videoConfig(W, H, bitrate, !!opts._sw);
  if (!vcfg) throw new Error('Este aparelho não codifica vídeo nessa resolução. Tente uma qualidade menor.');
  const durMs = projectDurationMs(p);
  if (durMs <= 0) throw new Error('Projeto vazio.');
  const durS = durMs / 1000;

  // áudio primeiro: mixa e codifica (com reservas) antes do vídeo
  const mix = opts._audio !== undefined ? null : await mixAudio(p, durS, onStatus);
  const audio = opts._audio !== undefined ? opts._audio : (mix ? await encodeAudio(mix, onStatus, signal) : null);

  onStatus('Lendo os vídeos…');
  const visible = p.tracks.filter(t => t.showVideo);
  const sources = [];
  for (const t of visible) {
    const meta = await mediaMeta(t.mediaId);
    if (!meta.video) continue;
    const s = new Source(meta, t.offsetMs * 1000);
    await s.init();
    sources.push(s);
  }
  const cells = computeCells(sources.length, p.format, p.layout, p.separar, q.scale)
    .map(c => ({ ...c, x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.w), h: Math.round(c.h) }));
  const radius = p.separar && sources.length > 1 ? Math.round(Math.min(W, H) * 0.012) : 0;

  const muxer = new Mux.Muxer({
    target: new Mux.ArrayBufferTarget(),
    video: { codec: 'avc', width: W, height: H, frameRate: FPS },
    audio: audio ? { codec: audio.mux, numberOfChannels: audio.channels, sampleRate: audio.sampleRate } : undefined,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'cross-track-offset',
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
      if (encErr) throw Object.assign(new Error('Codificador de vídeo: ' + (encErr.message || encErr)), { encoder: true });
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
    if (encErr) throw Object.assign(new Error('Codificador de vídeo: ' + (encErr.message || encErr)), { encoder: true });
  } catch (e) {
    if (e.encoder && !opts._sw) {
      onStatus('Tentando de novo em modo compatível…');
      try { enc.close(); } catch (_) {}
      sources.forEach(s => s.close());
      return renderProject(p, { ...opts, _sw: true, _audio: audio });
    }
    throw e;
  } finally {
    try { enc.close(); } catch (_) {}
    sources.forEach(s => s.close());
  }

  if (audio) {
    let first = true;
    for (const c of audio.chunks) {
      muxer.addAudioChunkRaw(c.data, c.type, c.timestamp, c.duration, first ? { decoderConfig: audio.decoderConfig } : undefined);
      first = false;
    }
  }
  onProgress(1);
  muxer.finalize();
  return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), width: W, height: H, codec: vcfg.codec, audio: audio ? audio.how : false };
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
