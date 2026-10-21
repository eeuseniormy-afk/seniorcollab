// Leitura dos arquivos de vídeo: tabela de amostras (sem carregar tudo na memória),
// leitura sob demanda e decodificação do áudio com reserva via WebCodecs.
import { getMedia } from './db.js?v=0.2.0-web';

let MP4Box;
export async function mp4box() {
  if (!MP4Box) { const m = await import('../vendor/mp4box.js'); MP4Box = m.default?.createFile ? m.default : m; }
  return MP4Box;
}

const metaCache = new Map();   // mediaId -> Promise<meta>
const audioCache = new Map();  // mediaId -> Promise<AudioBuffer|null>

function descriptionOf(entry, B) {
  const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
  if (!box) return undefined;
  const ds = new B.DataStream(undefined, 0, B.DataStream.BIG_ENDIAN);
  box.write(ds);
  return new Uint8Array(ds.buffer, 8);
}
function aacDescription(entry) {
  try {
    const d = entry.esds.esd.descs[0].descs[0];
    if (d && d.data) return new Uint8Array(d.data);
  } catch (_) {}
  return undefined;
}
const slim = (s) => ({ offset: s.offset, size: s.size, cts: s.cts, dts: s.dts, duration: s.duration, sync: !!s.is_sync, ts: s.timescale });

/** Analisa o MP4/MOV uma vez e guarda só a tabela de amostras. */
export function mediaMeta(mediaId, blobIn) {
  if (!metaCache.has(mediaId)) metaCache.set(mediaId, (async () => {
    const B = await mp4box();
    const blob = blobIn || await getMedia(mediaId);
    if (!blob) throw new Error('Vídeo não encontrado no aparelho.');
    let buf = await blob.arrayBuffer();
    const mp4 = B.createFile();
    let info = null, err = null;
    mp4.onReady = (i) => { info = i; };
    mp4.onError = (e) => { err = e; };
    buf.fileStart = 0;
    mp4.appendBuffer(buf);
    mp4.flush();
    buf = null;
    if (!info) {
      const t = (blob.type || '').toLowerCase();
      throw new Error(t.includes('webm')
        ? 'Este take foi gravado em WebM, que a exportação não lê. Grave de novo pelo Safari (iPhone) ou Chrome atualizado.'
        : 'Formato de vídeo não reconhecido' + (err ? ` (${err})` : '') + '. Use MP4 ou MOV.');
    }
    const meta = { blob, video: null, audio: null };
    const vt = info.videoTracks[0];
    if (vt) {
      const trak = mp4.getTrackById(vt.id);
      const entry = trak.mdia.minf.stbl.stsd.entries[0];
      const samples = trak.samples.map(slim);
      const t0 = samples.reduce((m, s) => Math.min(m, s.cts), Infinity);
      let rotation = 0;
      const m = vt.matrix;
      if (m && m.length >= 2) {
        rotation = Math.round(Math.atan2(m[1] / 65536, m[0] / 65536) * 180 / Math.PI);
        rotation = ((rotation % 360) + 360) % 360;
      }
      meta.video = {
        codec: vt.codec, width: vt.video?.width || vt.track_width, height: vt.video?.height || vt.track_height,
        description: descriptionOf(entry, B), samples, t0: isFinite(t0) ? t0 : 0, rotation,
      };
    }
    const at = info.audioTracks[0];
    if (at) {
      const trak = mp4.getTrackById(at.id);
      const entry = trak.mdia.minf.stbl.stsd.entries[0];
      const samples = trak.samples.map(slim);
      meta.audio = {
        codec: at.codec, sampleRate: at.audio?.sample_rate || entry.getSampleRate?.() || 48000,
        channels: at.audio?.channel_count || entry.getChannelCount?.() || 1,
        description: aacDescription(entry), samples,
        t0: samples.length ? samples.reduce((m, s) => Math.min(m, s.cts), Infinity) : 0,
      };
    }
    return meta;
  })());
  const p = metaCache.get(mediaId);
  p.catch(() => metaCache.delete(mediaId));
  return p;
}

/** Lê os bytes de várias amostras de uma vez (um único pedaço do arquivo). */
export async function readSamples(blob, samples) {
  if (!samples.length) return [];
  let lo = Infinity, hi = 0;
  for (const s of samples) { lo = Math.min(lo, s.offset); hi = Math.max(hi, s.offset + s.size); }
  if (hi - lo > 64 * 1024 * 1024) {
    return Promise.all(samples.map(async s => new Uint8Array(await blob.slice(s.offset, s.offset + s.size).arrayBuffer())));
  }
  const buf = new Uint8Array(await blob.slice(lo, hi).arrayBuffer());
  return samples.map(s => buf.subarray(s.offset - lo, s.offset - lo + s.size));
}

/** Áudio da faixa como AudioBuffer (cache). Tenta o decodificador do navegador e, se falhar, WebCodecs. */
export function decodeAudio(mediaId, ctx) {
  if (!audioCache.has(mediaId)) audioCache.set(mediaId, (async () => {
    const blob = await getMedia(mediaId);
    if (!blob) return null;
    try {
      const ab = await blob.arrayBuffer();
      const b = await new Promise((res, rej) => {
        const r = ctx.decodeAudioData(ab, res, rej);
        if (r && r.then) r.then(res, rej);
      });
      if (b && b.length) return b;
    } catch (_) { /* tenta o caminho WebCodecs */ }
    return decodeWithWebCodecs(mediaId, ctx);
  })());
  return audioCache.get(mediaId);
}
export function forgetMedia(mediaId) { metaCache.delete(mediaId); audioCache.delete(mediaId); }

async function decodeWithWebCodecs(mediaId, ctx) {
  if (!('AudioDecoder' in window)) return null;
  let meta;
  try { meta = await mediaMeta(mediaId); } catch (_) { return null; }
  const a = meta.audio;
  if (!a || !a.samples.length) return null;
  const cfg = { codec: a.codec.startsWith('mp4a') ? a.codec : a.codec, sampleRate: a.sampleRate, numberOfChannels: a.channels, description: a.description };
  try { if (!(await AudioDecoder.isConfigSupported(cfg)).supported) return null; } catch (_) { return null; }
  const parts = [];
  let total = 0, err = null;
  const dec = new AudioDecoder({
    output: (d) => {
      const n = d.numberOfFrames, chs = d.numberOfChannels;
      const planes = [];
      for (let c = 0; c < chs; c++) {
        const p = new Float32Array(n);
        try { d.copyTo(p, { planeIndex: c, format: 'f32-planar' }); }
        catch (_) {
          // formato intercalado
          const all = new Float32Array(n * chs); d.copyTo(all, { planeIndex: 0, format: 'f32' });
          for (let i = 0; i < n; i++) p[i] = all[i * chs + c];
        }
        planes.push(p);
      }
      parts.push(planes); total += n; d.close();
    },
    error: (e) => { err = e; },
  });
  dec.configure(cfg);
  const step = 200;
  for (let i = 0; i < a.samples.length; i += step) {
    const batch = a.samples.slice(i, i + step);
    const datas = await readSamples(meta.blob, batch);
    batch.forEach((s, k) => dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round((s.cts - a.t0) * 1e6 / s.ts), duration: Math.round(s.duration * 1e6 / s.ts), data: datas[k] })));
    await new Promise(r => setTimeout(r, 0));
  }
  await dec.flush().catch(() => {});
  dec.close();
  if (err || !total) return null;
  const chs = Math.min(2, parts[0].length);
  const out = ctx.createBuffer(chs, total, a.sampleRate);
  for (let c = 0; c < chs; c++) {
    const dst = out.getChannelData(c); let o = 0;
    for (const planes of parts) { dst.set(planes[Math.min(c, planes.length - 1)], o); o += planes[0].length; }
  }
  return out;
}
