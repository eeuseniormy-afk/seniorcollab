import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, APP_VERSION } from './config.js';
import { FORMATS, LAYOUTS, computeCells } from './layout.js';
import { EQ } from './audio.js';
import * as db from './db.js';
import { Player, unlockAudio } from './player.js';
import { decodeAudio, forgetMedia, mediaMeta } from './media.js';
import { MicCapture, findLag, calibrate, savedLatency, setLatency, defaultLatency } from './sync.js';
import { renderProject, projectDurationMs, probe, QUALITIES, supportsExport } from './render.js';

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, detectSessionInUrl: true, flowType: 'implicit' } });
const MAX_TRACKS = 6;
const app = document.getElementById('app');
let user = null;

// ---------- utilidades ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
}
const fmtTime = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
function toast(msg, ms = 2600) {
  const t = h('div', { class: 'toast' }, msg);
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
}
function confirmBox(text, okLabel = 'Apagar') {
  return new Promise(res => {
    const close = (v) => { m.remove(); res(v); };
    const m = h('div', { class: 'modal' }, h('div', { class: 'sheet' },
      h('p', {}, text),
      h('div', { class: 'row' },
        h('button', { class: 'btn ghost', onclick: () => close(false) }, 'Cancelar'),
        h('button', { class: 'btn danger', onclick: () => close(true) }, okLabel))));
    document.body.append(m);
  });
}
function pickFile(accept = 'video/*') {
  return new Promise(res => {
    const i = h('input', { type: 'file', accept, style: 'display:none' });
    i.onchange = () => { res(i.files[0] || null); i.remove(); };
    document.body.append(i); i.click();
  });
}
const icon = (name) => h('span', { class: 'ico', html: ICONS[name] || '' });
const ICONS = {
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z" fill="currentColor" stroke="none"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/></svg>',
  rec: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="currentColor" stroke="none"/></svg>',
  mix: '<svg viewBox="0 0 24 24"><path d="M6 4v16M12 4v16M18 4v16"/><circle cx="6" cy="9" r="2" fill="currentColor"/><circle cx="12" cy="15" r="2" fill="currentColor"/><circle cx="18" cy="7" r="2" fill="currentColor"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 8l5-5 5 5M5 14v5h14v-5"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  flip: '<svg viewBox="0 0 24 24"><path d="M4 8h13l-3-3M20 16H7l3 3"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  film: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M3 15h18M8 5v14M16 5v14"/></svg>',
  person: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><circle cx="16" cy="9" r="2.5"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6M14 14.5c3 0 7 1.5 7 5.5"/></svg>',
};

// ---------- autenticação ----------
function viewAuth(mode = 'login', msg = '') {
  stopEverything();
  const email = h('input', { type: 'email', placeholder: 'E-mail', autocomplete: 'email', required: true });
  const pass = h('input', { type: 'password', placeholder: mode === 'signup' ? 'Crie uma senha (mín. 8)' : 'Senha', autocomplete: mode === 'signup' ? 'new-password' : 'current-password', required: true, minlength: 8 });
  const name = h('input', { type: 'text', placeholder: 'Seu nome ou @ artístico', autocomplete: 'nickname' });
  const info = h('p', { class: 'info' }, msg);
  const btn = h('button', { class: 'btn primary big', type: 'submit' }, mode === 'signup' ? 'Criar conta' : 'Entrar');
  const form = h('form', {
    class: 'auth-form',
    onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true; info.textContent = '';
      try {
        if (mode === 'signup') {
          const { data, error } = await sb.auth.signUp({
            email: email.value.trim(), password: pass.value,
            options: { data: { display_name: name.value.trim() }, emailRedirectTo: location.href.split('#')[0] },
          });
          if (error) throw error;
          if (!data.session) { viewAuth('login', 'Conta criada! Enviamos um link de confirmação para o seu e-mail. Abra o link e volte aqui para entrar.'); return; }
        } else {
          const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
          if (error) throw error;
        }
      } catch (err) {
        info.textContent = traduzErro(err.message);
      } finally { btn.disabled = false; }
    },
  },
    mode === 'signup' ? name : null, email, pass, btn, info);

  const forgot = h('button', {
    class: 'link', onclick: async () => {
      if (!email.value) { info.textContent = 'Digite seu e-mail acima primeiro.'; return; }
      const { error } = await sb.auth.resetPasswordForEmail(email.value.trim(), { redirectTo: location.href.split('#')[0] });
      info.textContent = error ? traduzErro(error.message) : 'Enviamos um link para redefinir sua senha.';
    },
  }, 'Esqueci minha senha');

  app.replaceChildren(h('main', { class: 'auth' },
    h('div', { class: 'brand' }, h('img', { src: 'icon-192.png', alt: '' }), h('h1', {}, 'Senior', h('b', {}, 'Collab'))),
    h('p', { class: 'tag' }, 'Grave collabs e duetos em vídeo, mixe o som e exporte pronto para Reels, TikTok e YouTube.'),
    h('div', { class: 'tabs' },
      h('button', { class: mode === 'login' ? 'on' : '', onclick: () => viewAuth('login') }, 'Entrar'),
      h('button', { class: mode === 'signup' ? 'on' : '', onclick: () => viewAuth('signup') }, 'Criar conta')),
    form,
    mode === 'login' ? forgot : null,
    h('footer', {}, `© W. Carolino · SeniorMy · v${APP_VERSION}`)));
}
function traduzErro(m = '') {
  if (/Invalid login/i.test(m)) return 'E-mail ou senha incorretos.';
  if (/Email not confirmed/i.test(m)) return 'Confirme seu e-mail pelo link que enviamos antes de entrar.';
  if (/already registered/i.test(m)) return 'Esse e-mail já tem conta. Use Entrar.';
  if (/Password should be/i.test(m)) return 'A senha precisa ter pelo menos 8 caracteres.';
  if (/rate limit/i.test(m)) return 'Muitas tentativas. Espere um minuto e tente de novo.';
  return m || 'Algo deu errado. Tente de novo.';
}
function viewNewPassword() {
  const pass = h('input', { type: 'password', placeholder: 'Nova senha (mín. 8)', minlength: 8, required: true });
  const info = h('p', { class: 'info' });
  app.replaceChildren(h('main', { class: 'auth' },
    h('div', { class: 'brand' }, h('h1', {}, 'Nova ', h('b', {}, 'senha'))),
    h('form', {
      class: 'auth-form', onsubmit: async (e) => {
        e.preventDefault();
        const { error } = await sb.auth.updateUser({ password: pass.value });
        if (error) info.textContent = traduzErro(error.message); else { toast('Senha alterada.'); viewHome(); }
      },
    }, pass, h('button', { class: 'btn primary big' }, 'Salvar'), info)));
}

// ---------- início ----------
let player = null;
let recorderCleanup = null;
function stopEverything() {
  if (recorderCleanup) { recorderCleanup(); recorderCleanup = null; }
  if (player) { player.destroy(); player = null; }
}

function newProject(name) {
  return {
    id: db.uid(), userId: user.id, name, format: '9:16', layout: 'auto', separar: true, quality: 'fhd',
    latencyMs: null, tracks: [], createdAt: Date.now(), updatedAt: Date.now(),
  };
}
async function addMediaTrack(p, blob, name) {
  const mediaId = await db.putMedia(blob);
  let info = null;
  try {
    const meta = await mediaMeta(mediaId, blob);
    const v = meta.video, au = meta.audio;
    const end = (tr) => tr && tr.samples.length ? Math.max(...tr.samples.map(s => (s.cts - tr.t0 + s.duration) * 1000 / s.ts)) : 0;
    const d = Math.round(Math.max(end(v), 0));
    if (d > 0) info = { durationMs: d, hasAudio: !!(au && au.samples.length) };
  } catch (_) { /* cai no probe */ }
  if (!info) info = await probe(blob);
  if (!info.durationMs) { await db.deleteMedia(mediaId); throw new Error('Não consegui ler a duração desse vídeo.'); }
  const t = {
    id: db.uid(), name, mediaId, mime: blob.type, durationMs: info.durationMs, hasAudio: info.hasAudio,
    offsetMs: 0, volume: 1, muted: false, showVideo: true, eq: 'flat', comp: false, noise: false, reverb: 0,
  };
  p.tracks.push(t);
  await db.saveProject(p);
  return t;
}

async function viewHome() {
  stopEverything();
  const name = user.user_metadata?.display_name || user.email.split('@')[0];
  const list = h('div', { class: 'list' }, h('p', { class: 'muted' }, 'Carregando…'));
  app.replaceChildren(h('main', { class: 'home' },
    h('header', { class: 'top' },
      h('div', { class: 'brand small' }, h('img', { src: 'icon-192.png', alt: '' }), h('h1', {}, 'Senior', h('b', {}, 'Collab'))),
      h('button', { class: 'chip', onclick: async () => { await sb.auth.signOut(); } }, 'Sair')),
    h('p', { class: 'hello' }, `Olá, ${name}!`),
    h('div', { class: 'actions' },
      h('button', {
        class: 'card-btn duet', onclick: async () => {
          const f = await pickFile();
          if (!f) return;
          const p = newProject(f.name.replace(/\.[^.]+$/, '').slice(0, 40) || 'Dueto');
          try { await addMediaTrack(p, f, 'Vídeo original'); viewStudio(p.id, true); }
          catch (e) { toast(e.message); }
        },
      }, icon('film'), h('strong', {}, 'Dueto'), h('span', {}, 'Escolha um vídeo e grave por cima')),
      h('button', {
        class: 'card-btn solo', onclick: async () => {
          const p = newProject('Collab comigo');
          await db.saveProject(p); viewStudio(p.id, true);
        },
      }, icon('person'), h('strong', {}, 'Collab comigo'), h('span', {}, 'Grave vários takes seus na mesma tela'))),
    h('h2', {}, 'Seus projetos'),
    list,
    !supportsExport() ? h('p', { class: 'warn' }, 'Este navegador não exporta vídeo. No iPhone use o Safari (iOS 17 ou mais novo); no Android, o Chrome.') : null,
    h('footer', {}, `© W. Carolino · SeniorMy · v${APP_VERSION}`)));

  const ps = await db.listProjects(user.id);
  list.replaceChildren(...(ps.length ? ps.map(p => h('div', { class: 'proj' },
    h('button', { class: 'proj-open', onclick: () => viewStudio(p.id) },
      h('strong', {}, p.name),
      h('span', {}, `${p.tracks.length} faixa${p.tracks.length === 1 ? '' : 's'} · ${fmtTime(projectDurationMs(p))} · ${p.format} · ${new Date(p.updatedAt).toLocaleDateString('pt-BR')}`)),
    h('button', {
      class: 'icon-btn', 'aria-label': 'Apagar', onclick: async () => {
        if (await confirmBox(`Apagar "${p.name}"? Os vídeos desse projeto saem do aparelho.`)) { await db.deleteProject(p); viewHome(); }
      },
    }, icon('trash')))) : [h('p', { class: 'muted' }, 'Nenhum projeto ainda. Comece um dueto ou um collab acima.')]));
}

// ---------- prévia (grade de vídeos) ----------
function previewBox(p, extraCell) {
  const f = FORMATS[p.format];
  const box = h('div', { class: 'stage', style: `aspect-ratio:${f.w}/${f.h}` });
  const visible = p.tracks.filter(t => t.showVideo);
  const n = visible.length + (extraCell ? 1 : 0);
  const cells = computeCells(n, p.format, p.layout, p.separar);
  const radius = p.separar && n > 1 ? '1.2%' : '0';
  visible.forEach((t, i) => {
    const c = cells[i];
    const el = player?.element(t.id);
    const cell = h('div', { class: 'cell', style: pos(c, f, radius) });
    if (el) cell.append(el);
    box.append(cell);
  });
  if (extraCell) {
    const c = cells[n - 1];
    const cell = h('div', { class: 'cell cam', style: pos(c, f, radius) });
    cell.append(extraCell);
    box.append(cell);
  }
  if (!n) box.append(h('div', { class: 'empty' }, 'Grave o primeiro take'));
  return box;
}
const pos = (c, f, r) => `left:${c.x / f.w * 100}%;top:${c.y / f.h * 100}%;width:${c.w / f.w * 100}%;height:${c.h / f.h * 100}%;border-radius:${r}`;

// ---------- estúdio ----------
let saveTimer;
function saveSoon(p) { clearTimeout(saveTimer); saveTimer = setTimeout(() => db.saveProject(p), 400); }

async function viewStudio(id, autoStart = false) {
  stopEverything();
  const p = await db.getProject(id);
  if (!p) return viewHome();
  player = new Player();
  app.replaceChildren(h('main', { class: 'studio' }, h('p', { class: 'muted center' }, 'Abrindo…')));
  const opening = app.querySelector('.muted');
  await player.sync(p, (txt) => { if (opening) opening.textContent = txt; });
  saveSoon(p);

  const render = () => {
    const playBtn = h('button', {
      class: 'round', 'aria-label': 'Tocar', disabled: !p.tracks.length,
      onclick: async () => {
        if (player.playing) { player.stop(); render(); }
        else { await player.play(p); render(); }
      },
    }, icon(player.playing ? 'stop' : 'play'));
    player.onEnded = render;

    const title = h('input', { class: 'title', value: p.name, maxlength: 60, onchange: (e) => { p.name = e.target.value || 'Sem nome'; saveSoon(p); } });

    const chips = (obj, cur, set) => h('div', { class: 'chips' }, Object.entries(obj).map(([k, v]) =>
      h('button', { class: 'chip' + (k === cur ? ' on' : ''), onclick: () => { set(k); saveSoon(p); render(); } }, typeof v === 'string' ? v : k)));

    const tracks = p.tracks.map((t, i) => h('div', { class: 'track' },
      h('span', { class: 'num', style: `background:${i ? 'var(--purple)' : 'var(--pink)'}` }, i + 1),
      h('div', { class: 'tinfo' }, h('strong', {}, t.name), h('span', {}, `${(t.durationMs / 1000).toFixed(1).replace('.', ',')} s${t.muted ? ' · mudo' : ''}${t.showVideo ? '' : ' · só áudio'}${t.offsetMs ? ` · ${t.offsetMs > 0 ? '+' : ''}${t.offsetMs} ms` : ''}`)),
      h('button', {
        class: 'icon-btn', 'aria-label': 'Apagar faixa', onclick: async () => {
          if (!(await confirmBox(`Apagar ${t.name}?`))) return;
          player.stop();
          p.tracks.splice(i, 1); forgetMedia(t.mediaId); await db.deleteMedia(t.mediaId); await db.saveProject(p);
          await player.sync(p); render();
        },
      }, icon('trash'))));

    app.replaceChildren(h('main', { class: 'studio' },
      h('header', { class: 'top' },
        h('button', { class: 'icon-btn', 'aria-label': 'Voltar', onclick: viewHome }, icon('back')),
        title,
        h('button', { class: 'chip on', disabled: !p.tracks.length || !supportsExport(), onclick: () => viewExport(p) }, icon('share'), 'Exportar')),
      h('div', { class: 'stage-wrap' }, previewBox(p)),
      h('div', { class: 'controls' },
        playBtn,
        h('button', { class: 'round', 'aria-label': 'Mixer', disabled: !p.tracks.length, onclick: () => viewMixer(p) }, icon('mix')),
        h('button', {
          class: 'round', 'aria-label': 'Importar vídeo', disabled: p.tracks.length >= MAX_TRACKS, onclick: async () => {
            const f = await pickFile(); if (!f) return;
            try { player.stop(); await addMediaTrack(p, f, `Vídeo ${p.tracks.length + 1}`); await player.sync(p); render(); } catch (e) { toast(e.message); }
          },
        }, icon('plus'))),
      h('label', { class: 'lbl' }, 'Formato'),
      chips(Object.fromEntries(Object.keys(FORMATS).map(k => [k, k])), p.format, v => p.format = v),
      h('label', { class: 'lbl' }, 'Layout'),
      chips(LAYOUTS, p.layout, v => p.layout = v),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: p.separar, onchange: (e) => { p.separar = e.target.checked; saveSoon(p); render(); } }), h('span', {}, 'Vídeos bem separados')),
      h('h3', {}, `Faixas (${p.tracks.length}/${MAX_TRACKS})`),
      ...tracks,
      h('p', { class: 'muted small' }, 'Use fone de ouvido ao gravar para o som dos outros takes não vazar no microfone.'),
      h('div', { class: 'fab-space' }),
      h('button', {
        class: 'fab', disabled: p.tracks.length >= MAX_TRACKS,
        onclick: () => { player.stop(); viewRecord(p, render); },
      }, icon('rec'), p.tracks.length ? 'Gravar novo take' : 'Gravar')));
  };
  render();
  if (autoStart && p.tracks.length < MAX_TRACKS) viewRecord(p, render);
}

// ---------- gravação ----------
function pickRecorderMime() {
  const opts = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.4d002a,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=h264,opus', 'video/webm',
  ];
  return opts.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

async function viewRecord(p, back) {
  const ctx = await unlockAudio();
  let facing = 'user', stream = null, rec = null, chunks = [], recording = false, busy = false, tick = null, autoStop = null;
  let cap = null, T0 = 0, recStartCtx = 0, capStartCtx = 0;
  const cam = h('video', { class: 'camvid mirror', playsinline: true, muted: true, autoplay: true });
  cam.muted = true;
  const timer = h('div', { class: 'rtimer' }, 'Novo take');
  const count = h('div', { class: 'count' });
  const hint = h('p', { class: 'rhint' }, p.tracks.length ? 'Coloque o fone e toque para gravar' : 'Toque para gravar o primeiro take');
  const latInfo = h('button', { class: 'chip small-chip', onclick: () => openCalibration() });
  const total = projectDurationMs(p);
  const showLat = () => { latInfo.textContent = `Latência ${currentLatency()} ms · calibrar`; };

  const overlay = h('div', { class: 'record' });
  const stageHolder = h('div', { class: 'rstage' });
  const recBtn = h('button', { class: 'recbtn', 'aria-label': 'Gravar', onclick: () => recording ? stop() : startCountdown() }, h('i'));

  function currentLatency() { return savedLatency() ?? defaultLatency(ctx); }

  async function openCam() {
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (cap) { cap.close(); cap = null; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 } },
      });
    } catch (e) {
      hint.textContent = 'Não consegui acessar a câmera e o microfone. Libere o acesso nas configurações do Safari (aA › Ajustes do site).';
      return;
    }
    cam.srcObject = stream;
    cam.classList.toggle('mirror', facing === 'user');
    cam.play().catch(() => {});
    try { cap = await MicCapture.create(ctx, stream); } catch (e) { cap = null; console.warn('captura', e); }
    await unlockAudio();
  }

  function draw() { stageHolder.replaceChildren(previewBox(p, h('div', { class: 'camwrap' }, cam, count))); }

  async function startCountdown() {
    if (!stream || recording || busy) return;
    busy = true; recBtn.disabled = true;
    await unlockAudio();
    for (let i = 3; i > 0; i--) { count.textContent = i; await new Promise(r => setTimeout(r, 1000)); }
    count.textContent = '';
    try { await start(); } finally { busy = false; recBtn.disabled = false; }
  }

  async function start() {
    const mime = pickRecorderMime();
    chunks = [];
    try {
      rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: 12_000_000, audioBitsPerSecond: 256_000 });
    } catch (_) { rec = new MediaRecorder(stream); }
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    // captura do mic começa antes do gravador, para cobrir o início do arquivo
    if (cap) { cap.start(Math.min(60, total / 1000 + 20)); }
    capStartCtx = ctx.currentTime;
    const started = new Promise(r => { rec.onstart = r; });
    rec.start(1000);
    await started;
    recStartCtx = ctx.currentTime;
    // os outros takes entram num instante exato do relógio de áudio
    T0 = ctx.currentTime + 0.35;
    if (p.tracks.length) await player.play(p, 0, T0);
    recording = true; overlay.classList.add('on');
    hint.textContent = 'Gravando… toque para parar';
    tick = setInterval(() => { timer.textContent = `● ${fmtTime((ctx.currentTime - T0) * 1000)}${total ? ' / ' + fmtTime(total) : ''}`; }, 250);
    if (total) autoStop = setTimeout(stop, (T0 - ctx.currentTime) * 1000 + total + 600);
  }

  async function stop() {
    if (!recording) return;
    recording = false; clearInterval(tick); clearTimeout(autoStop);
    player.stop();
    overlay.classList.remove('on');
    hint.textContent = 'Salvando e sincronizando…'; recBtn.disabled = true;
    const done = new Promise(r => { rec.onstop = r; });
    rec.stop(); await done;
    if (cap) await cap.stop();
    const blob = new Blob(chunks, { type: rec.mimeType || 'video/mp4' });
    try {
      const n = p.tracks.length + 1;
      const t = await addMediaTrack(p, blob, `Take ${n}`);
      if (n > 1) {
        const lat = currentLatency() / 1000;
        let fileStartCtx = null, how = 'estimativa';
        const capData = cap?.take();
        if (capData) {
          const audio = await decodeAudio(t.mediaId, ctx).catch(() => null);
          if (audio) {
            const r = findLag(audio.getChannelData(0), Math.round(0.4 * audio.sampleRate), capData.data, capData.sr, 6);
            if (r && r.confidence > 8) { fileStartCtx = capData.startTime + r.lag; how = `áudio (${r.confidence.toFixed(0)})`; }
          }
        }
        if (fileStartCtx === null) fileStartCtx = recStartCtx - 0.05; // reserva: hora do início do gravador
        // posição do início do arquivo na linha do tempo do projeto
        t.offsetMs = Math.round((fileStartCtx - T0 - lat) * 1000);
        t.syncMethod = how;
      }
      await db.saveProject(p);
      cleanup();
      await player.sync(p);
      back();
      if (n > 1) toast(t.syncMethod?.startsWith('áudio') ? 'Take sincronizado pelo som.' : 'Take salvo. Se precisar, ajuste a sincronia no mixer.');
    } catch (e) {
      hint.textContent = 'Erro ao salvar: ' + e.message; recBtn.disabled = false;
    }
  }

  async function openCalibration() {
    if (recording || busy) return;
    if (!cap) { toast('Microfone indisponível para calibrar.'); return; }
    busy = true;
    const beat = h('div', { class: 'beat' });
    const msg = h('p', {}, 'Com fone: bata palmas junto com cada clique. Sem fone: só deixe o celular ouvir os cliques. Faça isso com o mesmo fone que vai usar na gravação.');
    const res = h('p', { class: 'muted' });
    const go = h('button', { class: 'btn primary' }, 'Começar');
    const manual = h('input', { type: 'range', min: 0, max: 500, step: 5, value: currentLatency() });
    const manOut = h('span', { class: 'val' }, `${currentLatency()} ms`);
    manual.oninput = () => { manOut.textContent = `${manual.value} ms`; setLatency(Number(manual.value)); showLat(); };
    const close = () => { m.remove(); busy = false; showLat(); };
    go.onclick = async () => {
      go.disabled = true; res.textContent = 'Ouvindo…';
      try {
        const ms = await calibrate(ctx, cap, (i) => { beat.classList.remove('hit'); void beat.offsetWidth; beat.classList.add('hit'); beat.textContent = i < 2 ? 'prepare' : '👏'; });
        setLatency(ms); manual.value = ms; manOut.textContent = `${ms} ms`;
        res.textContent = `Pronto: ${ms} ms. Isso fica salvo neste aparelho.`;
      } catch (e) { res.textContent = e.message; }
      go.disabled = false; go.textContent = 'Calibrar de novo'; beat.textContent = '';
    };
    const m = h('div', { class: 'modal' }, h('div', { class: 'sheet' },
      h('h3', {}, 'Calibrar fone e microfone'), msg, beat, res,
      h('div', { class: 'slider' }, h('div', { class: 'srow' }, h('span', {}, 'Ajuste manual'), manOut), manual),
      h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: close }, 'Fechar'), go)));
    document.body.append(m);
  }

  function cleanup() {
    clearInterval(tick); clearTimeout(autoStop);
    if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch (_) {} }
    if (cap) { cap.close(); cap = null; }
    if (stream) stream.getTracks().forEach(t => t.stop());
    overlay.remove();
    recorderCleanup = null;
    if (wake) { wake.release().catch(() => {}); wake = null; }
  }
  recorderCleanup = cleanup;

  let wake = null;
  try { if ('wakeLock' in navigator) wake = await navigator.wakeLock.request('screen'); } catch (_) {}

  overlay.append(
    h('div', { class: 'rtop' },
      h('button', { class: 'icon-btn', 'aria-label': 'Fechar', onclick: () => { if (!recording) { player.stop(); cleanup(); back(); } } }, icon('close')),
      timer,
      h('button', { class: 'icon-btn', 'aria-label': 'Trocar câmera', onclick: async () => { if (recording || busy) return; facing = facing === 'user' ? 'environment' : 'user'; await openCam(); } }, icon('flip'))),
    stageHolder,
    h('div', { class: 'rbottom' }, recBtn, hint, p.tracks.length ? latInfo : null));
  document.body.append(overlay);
  showLat();
  draw();
  await openCam();
}

// ---------- mixer ----------
function viewMixer(p) {
  player.stop();
  const apply = () => { player.applyMix(p); saveSoon(p); };
  const slider = (label, val, min, max, step, fmt, set) => {
    const out = h('span', { class: 'val' }, fmt(val));
    return h('div', { class: 'slider' },
      h('div', { class: 'srow' }, h('span', {}, label), out),
      h('input', { type: 'range', min, max, step, value: val, oninput: (e) => { const v = Number(e.target.value); set(v); out.textContent = fmt(v); apply(); } }));
  };
  const toggle = (label, val, set) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: val, onchange: (e) => { set(e.target.checked); apply(); } }), h('span', {}, label));
  const playBtn = h('button', { class: 'chip on', onclick: async () => { if (player.playing) { player.stop(); playBtn.textContent = 'Ouvir'; } else { await player.play(p); playBtn.textContent = 'Parar'; } } }, 'Ouvir');
  player.onEnded = () => { playBtn.textContent = 'Ouvir'; };

  const cards = p.tracks.map((t, i) => {
    const offOut = h('span', { class: 'val' });
    const offRange = h('input', { type: 'range', min: -3000, max: 3000, step: 5, value: t.offsetMs });
    const setOff = (v) => { t.offsetMs = Math.round(v); offRange.value = t.offsetMs; offOut.textContent = `${t.offsetMs > 0 ? '+' : ''}${t.offsetMs} ms`; saveSoon(p); };
    setOff(t.offsetMs);
    offRange.oninput = (e) => setOff(Number(e.target.value));
    return h('section', { class: 'mcard' },
      h('div', { class: 'mhead' },
        h('span', { class: 'num', style: `background:${i ? 'var(--purple)' : 'var(--pink)'}` }, i + 1),
        h('strong', {}, t.name),
        !t.hasAudio ? h('span', { class: 'muted small' }, 'sem áudio') : null),
      h('div', { class: 'row wrap' },
        toggle('Mudo', t.muted, v => t.muted = v),
        toggle('Mostrar vídeo', t.showVideo, v => t.showVideo = v)),
      slider('Volume', t.volume, 0, 2, 0.01, v => `${Math.round(v * 100)}%`, v => t.volume = v),
      p.tracks.length > 1 ? h('div', { class: 'slider' },
        h('div', { class: 'srow' }, h('span', {}, 'Sincronia'), offOut),
        h('div', { class: 'row' },
          h('button', { class: 'mini', onclick: () => setOff(t.offsetMs - 10) }, '−10'),
          offRange,
          h('button', { class: 'mini', onclick: () => setOff(t.offsetMs + 10) }, '+10'))) : null,
      h('div', { class: 'srow' }, h('span', {}, 'Equalização'),
        h('select', { onchange: (e) => { t.eq = e.target.value; apply(); } },
          Object.entries(EQ).map(([k, v]) => h('option', { value: k, selected: k === t.eq }, v.label)))),
      toggle('Redução de ruído', t.noise, v => t.noise = v),
      toggle('Compressor (voz mais presente)', t.comp, v => t.comp = v),
      slider('Reverb', t.reverb, 0, 1, 0.01, v => `${Math.round(v * 100)}%`, v => t.reverb = v));
  });

  app.replaceChildren(h('main', { class: 'mixer' },
    h('header', { class: 'top' },
      h('button', { class: 'icon-btn', 'aria-label': 'Voltar', onclick: () => { player.stop(); db.saveProject(p).then(() => viewStudio(p.id)); } }, icon('back')),
      h('h2', {}, 'Mixer'),
      playBtn),
    ...cards,
    h('p', { class: 'muted small' }, 'Na exportação o volume final é nivelado em −14 LUFS, o padrão de Instagram, TikTok e YouTube.')));
}

// ---------- exportação ----------
function viewExport(p) {
  player?.stop();
  let ctrl = null, resultUrl = null, resultBlob = null;
  const bar = h('i');
  const status = h('p', { class: 'muted' });
  const result = h('div', { class: 'result' });
  const go = h('button', { class: 'btn primary big', onclick: run }, 'Renderizar vídeo');
  const cancel = h('button', { class: 'btn ghost', style: 'display:none', onclick: () => ctrl?.abort() }, 'Cancelar');

  async function run() {
    go.disabled = true; cancel.style.display = ''; result.replaceChildren();
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    ctrl = new AbortController();
    let wake = null;
    try { if ('wakeLock' in navigator) wake = await navigator.wakeLock.request('screen'); } catch (_) {}
    const t0 = performance.now();
    try {
      const r = await renderProject(p, {
        quality: p.quality, signal: ctrl.signal,
        onProgress: (v) => { bar.style.width = `${Math.round(v * 100)}%`; },
        onStatus: (s) => { status.textContent = s; },
      });
      const secs = ((performance.now() - t0) / 1000).toFixed(1).replace('.', ',');
      resultBlob = r.blob; resultUrl = URL.createObjectURL(r.blob);
      status.textContent = `Pronto em ${secs} s · ${r.width}×${r.height} · ${(r.blob.size / 1e6).toFixed(1).replace('.', ',')} MB${r.audio ? '' : ' · sem áudio'}`;
      const fname = `${p.name.replace(/[^\w\- ]+/g, '').trim() || 'seniorcollab'}-${p.format.replace(':', 'x')}.mp4`;
      const file = new File([r.blob], fname, { type: 'video/mp4' });
      result.replaceChildren(
        h('video', { src: resultUrl, controls: true, playsinline: true, class: 'outvid' }),
        h('div', { class: 'row' },
          navigator.canShare?.({ files: [file] })
            ? h('button', { class: 'btn primary', onclick: () => navigator.share({ files: [file], title: p.name }).catch(() => {}) }, 'Salvar / Compartilhar')
            : null,
          h('a', { class: 'btn ghost', href: resultUrl, download: fname }, 'Baixar MP4')),
        h('p', { class: 'muted small' }, 'No iPhone, toque em Salvar / Compartilhar e escolha "Salvar vídeo" para ir para a galeria.'));
    } catch (e) {
      bar.style.width = '0';
      if (e.name === 'AbortError') status.textContent = 'Cancelado.';
      else {
        console.error(e);
        status.textContent = 'Falhou: ' + (e.message || e);
        const details = [
          `SeniorCollab ${APP_VERSION}`, navigator.userAgent,
          `Erro: ${e.name || ''} ${e.message || e}`,
          `Formato ${p.format} · ${p.quality} · layout ${p.layout} · ${p.tracks.length} faixas`,
          ...p.tracks.map((t, i) => `#${i + 1} ${t.mime || '?'} ${t.durationMs}ms offset ${t.offsetMs} áudio ${t.hasAudio} vídeo ${t.showVideo}`),
          `WebCodecs: VE ${'VideoEncoder' in window} VD ${'VideoDecoder' in window} AE ${'AudioEncoder' in window} AD ${'AudioDecoder' in window}`,
          (e.stack || '').split('\n').slice(0, 4).join(' | '),
        ].join('\n');
        result.replaceChildren(
          h('pre', { class: 'errbox' }, details),
          h('button', { class: 'btn ghost', onclick: async () => { try { await navigator.clipboard.writeText(details); toast('Copiado. Cole aqui na conversa com o Hark.'); } catch (_) { toast('Selecione o texto e copie.'); } } }, 'Copiar detalhes do erro'));
      }
    } finally {
      go.disabled = false; go.textContent = 'Renderizar de novo'; cancel.style.display = 'none';
      if (wake) wake.release().catch(() => {});
    }
  }

  const radio = (obj, cur, set) => h('div', { class: 'chips' }, Object.entries(obj).map(([k, v]) =>
    h('button', { class: 'chip' + (k === cur() ? ' on' : ''), onclick: (e) => { set(k); saveSoon(p); e.target.parentNode.querySelectorAll('.chip').forEach(c => c.classList.remove('on')); e.target.classList.add('on'); } }, v.label || v)));

  app.replaceChildren(h('main', { class: 'export' },
    h('header', { class: 'top' },
      h('button', { class: 'icon-btn', 'aria-label': 'Voltar', onclick: () => { ctrl?.abort(); viewStudio(p.id); } }, icon('back')),
      h('h2', {}, 'Exportar')),
    h('label', { class: 'lbl' }, 'Formato'),
    radio(FORMATS, () => p.format, v => p.format = v),
    h('label', { class: 'lbl' }, 'Layout'),
    radio(LAYOUTS, () => p.layout, v => p.layout = v),
    h('label', { class: 'lbl' }, 'Qualidade'),
    radio(QUALITIES, () => p.quality, v => p.quality = v),
    h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: p.separar, onchange: (e) => { p.separar = e.target.checked; saveSoon(p); } }), h('span', {}, 'Vídeos bem separados')),
    h('p', { class: 'muted small' }, `Duração: ${fmtTime(projectDurationMs(p))}. Deixe a tela ligada enquanto renderiza.`),
    go, h('div', { class: 'bar' }, bar), status, cancel, result));
}

// ---------- inicialização ----------
async function route(session) {
  user = session?.user || null;
  if (!user) return viewAuth();
  db.persist();
  viewHome();
}
let lastUserId;
sb.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') { user = session?.user; return viewNewPassword(); }
  const id = session?.user?.id || null;
  if (id === lastUserId && event !== 'SIGNED_OUT') return;
  lastUserId = id;
  route(session);
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
