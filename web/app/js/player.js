// Prévia: toca todas as faixas juntas, com o som passando pelos mesmos efeitos da exportação.
import { buildChain, buildMaster } from './audio.js';
import { getMedia } from './db.js';

let ctx;
export function audioCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
  }
  return ctx;
}
export async function unlockAudio() {
  const c = audioCtx();
  if (c.state !== 'running') { try { await c.resume(); } catch (_) {} }
  return c;
}
export function outputLatencyMs() {
  const c = audioCtx();
  return Math.round(((c.outputLatency || 0) + (c.baseLatency || 0)) * 1000);
}

export class Player {
  constructor() {
    this.items = new Map(); // track.id -> { el, url, src, chain }
    this.timers = [];
    this.playing = false;
    this.master = null;
    this.onEnded = null;
  }

  _ensureMaster() {
    const c = audioCtx();
    if (!this.master) {
      this.out = c.createGain();
      this.out.connect(c.destination);
      this.master = buildMaster(c, this.out);
    }
    return c;
  }

  /** Cria/remove elementos de vídeo para refletir o projeto. */
  async sync(project) {
    const c = this._ensureMaster();
    const ids = new Set(project.tracks.map(t => t.id));
    for (const [id, it] of this.items) {
      if (!ids.has(id)) { it.el.pause(); it.el.removeAttribute('src'); it.el.load(); URL.revokeObjectURL(it.url); try { it.src.disconnect(); } catch (_) {} this.items.delete(id); }
    }
    for (const t of project.tracks) {
      if (this.items.has(t.id)) continue;
      const blob = await getMedia(t.mediaId);
      const url = URL.createObjectURL(blob);
      const el = document.createElement('video');
      el.playsInline = true; el.setAttribute('playsinline', ''); el.preload = 'auto'; el.src = url;
      el.crossOrigin = 'anonymous';
      await new Promise(r => { el.onloadeddata = r; el.onerror = r; setTimeout(r, 4000); });
      const src = c.createMediaElementSource(el);
      this.items.set(t.id, { el, url, src, chain: null, sig: '' });
    }
    this.applyMix(project);
  }

  /** Reaplica volumes/efeitos. Reconstrói a cadeia só quando os efeitos mudam. */
  applyMix(project) {
    const c = this._ensureMaster();
    for (const t of project.tracks) {
      const it = this.items.get(t.id);
      if (!it) continue;
      const sig = [t.eq, t.comp, t.noise].join('|');
      if (!it.chain || it.sig !== sig) {
        try { it.src.disconnect(); } catch (_) {}
        it.chain = buildChain(c, t, it.src, this.master.bus, this.master.reverbIn);
        it.sig = sig;
      } else {
        it.chain.update(t);
      }
    }
  }

  element(trackId) { return this.items.get(trackId)?.el; }

  async play(project, fromMs = 0) {
    await unlockAudio();
    this.stop();
    this.playing = true;
    let longest = 0;
    for (const t of project.tracks) {
      const it = this.items.get(t.id);
      if (!it) continue;
      const local = fromMs - t.offsetMs;
      longest = Math.max(longest, t.offsetMs + t.durationMs - fromMs);
      if (local >= 0) {
        if (local < t.durationMs) { it.el.currentTime = local / 1000; it.el.play().catch(() => {}); }
      } else {
        it.el.currentTime = 0;
        this.timers.push(setTimeout(() => { if (this.playing) it.el.play().catch(() => {}); }, -local));
      }
    }
    this.timers.push(setTimeout(() => { this.stop(); this.onEnded?.(); }, Math.max(0, longest) + 150));
  }

  stop() {
    this.playing = false;
    this.timers.forEach(clearTimeout); this.timers = [];
    for (const it of this.items.values()) it.el.pause();
  }

  destroy() {
    this.stop();
    for (const it of this.items.values()) { it.el.removeAttribute('src'); it.el.load(); URL.revokeObjectURL(it.url); try { it.src.disconnect(); } catch (_) {} }
    this.items.clear();
    if (this.out) { try { this.out.disconnect(); } catch (_) {} }
    this.master = null;
  }
}
