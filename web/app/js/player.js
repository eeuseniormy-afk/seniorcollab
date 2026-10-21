// Prévia: o som de cada faixa toca por Web Audio, agendado no mesmo instante exato
// (é o que garante a sincronia); os vídeos tocam mudos e são corrigidos se escorregarem.
import { buildChain, buildMaster } from './audio.js?v=0.2.0-web';
import { getMedia } from './db.js?v=0.2.0-web';
import { decodeAudio } from './media.js?v=0.2.0-web';

let ctx;
export function audioCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    try { ctx = new AC({ latencyHint: 'interactive', sampleRate: 48000 }); }
    catch (_) { ctx = new AC({ latencyHint: 'interactive' }); }
  }
  return ctx;
}
export async function unlockAudio() {
  const c = audioCtx();
  if (c.state !== 'running') { try { await c.resume(); } catch (_) {} }
  // iOS: um buffer mudo destrava a saída de som mesmo com a chave de silêncio
  try { const b = c.createBuffer(1, 1, c.sampleRate); const s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(); } catch (_) {}
  return c;
}

export class Player {
  constructor() {
    this.items = new Map(); // track.id -> { el, url, buffer }
    this.voices = [];       // fontes tocando agora
    this.timers = [];
    this.playing = false;
    this.onEnded = null;
  }

  async sync(project, onStatus) {
    const c = audioCtx();
    const ids = new Set(project.tracks.map(t => t.id));
    for (const [id, it] of this.items) {
      if (!ids.has(id)) { it.el.pause(); it.el.removeAttribute('src'); it.el.load(); URL.revokeObjectURL(it.url); this.items.delete(id); }
    }
    for (const t of project.tracks) {
      if (this.items.has(t.id)) continue;
      const blob = await getMedia(t.mediaId);
      const url = URL.createObjectURL(blob);
      const el = document.createElement('video');
      el.muted = true; el.defaultMuted = true; el.setAttribute('muted', '');
      el.playsInline = true; el.setAttribute('playsinline', ''); el.preload = 'auto'; el.src = url;
      await new Promise(r => { el.onloadeddata = r; el.onerror = r; setTimeout(r, 4000); });
      const it = { el, url, buffer: null };
      this.items.set(t.id, it);
      if (t.hasAudio) {
        onStatus?.(`Preparando o som de ${t.name}…`);
        it.buffer = await decodeAudio(t.mediaId, c).catch(() => null);
        if (!it.buffer) t.hasAudio = false;
      }
    }
  }

  element(trackId) { return this.items.get(trackId)?.el; }

  /** Ajustes ao vivo do mixer. */
  applyMix(project) {
    if (!this.playing) return;
    for (const v of this.voices) {
      const t = project.tracks.find(x => x.id === v.trackId);
      if (!t) continue;
      const sig = [t.eq, t.comp, t.noise].join('|');
      if (sig !== v.sig) {
        try { v.src.disconnect(); v.chainOut?.disconnect(); } catch (_) {}
        v.chain = buildChain(audioCtx(), t, v.src, this.master.bus, this.master.reverbIn);
        v.sig = sig;
      } else v.chain.update(t);
    }
  }

  /**
   * Toca tudo a partir de fromMs. `at` = instante no relógio de áudio (para gravação).
   * Devolve o T0 usado.
   */
  async play(project, fromMs = 0, at = null) {
    const c = await unlockAudio();
    this.stop();
    this.playing = true;
    this.out = c.createGain(); this.out.connect(c.destination);
    this.master = buildMaster(c, this.out);
    const T0 = at ?? c.currentTime + 0.15;
    this.T0 = T0; this.fromMs = fromMs;
    let longest = 0;
    for (const t of project.tracks) {
      const it = this.items.get(t.id);
      if (!it) continue;
      const startTl = (t.offsetMs - fromMs) / 1000;        // quando a faixa entra, relativo a T0
      const into = Math.max(0, -startTl);                   // quanto da faixa já passou
      const when = T0 + Math.max(0, startTl);
      longest = Math.max(longest, (t.offsetMs + t.durationMs - fromMs) / 1000);
      if (into * 1000 >= t.durationMs) continue;
      if (it.buffer) {
        const src = c.createBufferSource(); src.buffer = it.buffer;
        const chain = buildChain(c, t, src, this.master.bus, this.master.reverbIn);
        src.start(when, into);
        this.voices.push({ trackId: t.id, src, chain, sig: [t.eq, t.comp, t.noise].join('|') });
      }
      // vídeo mudo, acompanhando
      const el = it.el;
      el.playbackRate = 1;
      try { el.currentTime = into; } catch (_) {}
      const delay = (when - c.currentTime) * 1000;
      this.timers.push(setTimeout(() => { if (this.playing) el.play().catch(() => {}); }, Math.max(0, delay - 15)));
    }
    // correção de deriva dos vídeos
    const drift = setInterval(() => {
      if (!this.playing) return;
      const now = c.currentTime - T0;
      for (const t of project.tracks) {
        const el = this.items.get(t.id)?.el;
        if (!el || el.paused) continue;
        const expected = now + (fromMs - t.offsetMs) / 1000;
        if (expected < 0 || expected * 1000 > t.durationMs) continue;
        const d = el.currentTime - expected;
        if (Math.abs(d) > 0.25) { el.currentTime = expected; el.playbackRate = 1; }
        else if (Math.abs(d) > 0.04) el.playbackRate = d > 0 ? 0.95 : 1.05;
        else el.playbackRate = 1;
      }
    }, 300);
    this.timers.push({ interval: drift });
    const endMs = (T0 - c.currentTime + Math.max(0, longest)) * 1000 + 150;
    this.timers.push(setTimeout(() => { this.stop(); this.onEnded?.(); }, endMs));
    return T0;
  }

  stop() {
    this.playing = false;
    for (const t of this.timers) { if (t && t.interval) clearInterval(t.interval); else clearTimeout(t); }
    this.timers = [];
    for (const v of this.voices) { try { v.src.stop(); v.src.disconnect(); } catch (_) {} }
    this.voices = [];
    if (this.out) { const o = this.out; setTimeout(() => { try { o.disconnect(); } catch (_) {} }, 50); this.out = null; }
    for (const it of this.items.values()) { it.el.pause(); it.el.playbackRate = 1; }
  }

  destroy() {
    this.stop();
    for (const it of this.items.values()) { it.el.removeAttribute('src'); it.el.load(); URL.revokeObjectURL(it.url); }
    this.items.clear();
  }
}
