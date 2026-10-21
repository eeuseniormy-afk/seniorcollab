// Cadeia de efeitos por faixa, usada na prévia (tempo real) e na exportação (offline).
export const EQ = {
  flat:   { label: 'Neutro', bands: [] },
  voz:    { label: 'Voz', bands: [['highpass', 90, 0, 0.7], ['peaking', 250, -2, 1], ['peaking', 3200, 3, 1], ['highshelf', 10000, 2, 0]] },
  brilho: { label: 'Brilho', bands: [['highshelf', 6000, 4, 0], ['peaking', 3000, 1.5, 1]] },
  grave:  { label: 'Mais grave', bands: [['lowshelf', 120, 4, 0], ['peaking', 400, -1, 1]] },
  violao: { label: 'Violão', bands: [['highpass', 70, 0, 0.7], ['peaking', 200, -2.5, 1.2], ['peaking', 5000, 2.5, 1]] },
  radio:  { label: 'Rádio', bands: [['highpass', 400, 0, 0.7], ['lowpass', 4000, 0, 0.7], ['peaking', 1500, 4, 1]] },
};

export function makeImpulse(ctx, seconds = 2.2, decay = 3) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return b;
}

/**
 * Liga input -> [ruído] -> [EQ] -> [compressor] -> ganho -> dest, com envio de reverb.
 * Devolve { gain, setVolume } para ajuste ao vivo.
 */
export function buildChain(ctx, track, input, dest, reverbIn) {
  let node = input;
  const link = (n) => { node.connect(n); node = n; return n; };
  if (track.noise) {
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 100; hp.Q.value = 0.7; link(hp);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 13000; link(lp);
    const hum = ctx.createBiquadFilter(); hum.type = 'notch'; hum.frequency.value = 60; hum.Q.value = 8; link(hum);
    const hiss = ctx.createBiquadFilter(); hiss.type = 'highshelf'; hiss.frequency.value = 8000; hiss.gain.value = -4; link(hiss);
  }
  for (const [type, f, g, q] of (EQ[track.eq] || EQ.flat).bands) {
    const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.gain.value = g; if (q) b.Q.value = q; link(b);
  }
  if (track.comp) {
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = -22; c.knee.value = 8; c.ratio.value = 3.5; c.attack.value = 0.008; c.release.value = 0.18;
    link(c);
    const makeup = ctx.createGain(); makeup.gain.value = 1.5; link(makeup);
  }
  const gain = ctx.createGain();
  gain.gain.value = track.muted ? 0 : track.volume;
  link(gain);
  gain.connect(dest);
  let send = null;
  if (reverbIn) {
    send = ctx.createGain(); send.gain.value = track.reverb || 0;
    gain.connect(send); send.connect(reverbIn);
  }
  return {
    gain,
    update(t) {
      gain.gain.value = t.muted ? 0 : t.volume;
      if (send) send.gain.value = t.reverb || 0;
    },
  };
}

/** Bus master: soma + reverb + compressor suave. */
export function buildMaster(ctx, out) {
  const bus = ctx.createGain();
  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -10; glue.knee.value = 6; glue.ratio.value = 2; glue.attack.value = 0.01; glue.release.value = 0.25;
  bus.connect(glue); glue.connect(out);
  const verb = ctx.createConvolver(); verb.buffer = makeImpulse(ctx);
  const verbOut = ctx.createGain(); verbOut.gain.value = 0.6;
  verb.connect(verbOut); verbOut.connect(bus);
  return { bus, reverbIn: verb };
}

/** Leva o mix para perto de -14 LUFS (aproximação por RMS ponderado) sem passar de -1 dBFS de pico. */
export function normalize(buffer, targetDb = -14, ceilingDb = -1) {
  const chs = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chs.push(buffer.getChannelData(c));
  const block = Math.floor(buffer.sampleRate * 0.4);
  const energies = [];
  let peak = 0;
  for (let i = 0; i < buffer.length; i += block) {
    let s = 0, n = 0;
    for (const d of chs) {
      const end = Math.min(i + block, d.length);
      for (let j = i; j < end; j++) { const v = d[j]; s += v * v; n++; const a = v < 0 ? -v : v; if (a > peak) peak = a; }
    }
    if (n) energies.push(s / n);
  }
  // gate absoluto (-70) e relativo (-10 dB), como no BS.1770
  const lu = (e) => -0.691 + 10 * Math.log10(e + 1e-12);
  let gated = energies.filter(e => lu(e) > -70);
  if (!gated.length) return buffer;
  const mean = gated.reduce((a, b) => a + b, 0) / gated.length;
  gated = gated.filter(e => lu(e) > lu(mean) - 10);
  const loud = lu(gated.reduce((a, b) => a + b, 0) / gated.length) + 0.7; // +0.7 ≈ peso K para voz/música
  let gain = Math.pow(10, (targetDb - loud) / 20);
  const ceiling = Math.pow(10, ceilingDb / 20);
  if (peak * gain > ceiling) {
    // limitador simples: ganho total + soft clip acima do teto
    for (const d of chs) for (let j = 0; j < d.length; j++) {
      const v = d[j] * gain, a = Math.abs(v);
      d[j] = a <= ceiling * 0.8 ? v : Math.sign(v) * (ceiling * 0.8 + (ceiling * 0.2) * Math.tanh((a - ceiling * 0.8) / (ceiling * 0.2)));
    }
  } else {
    for (const d of chs) for (let j = 0; j < d.length; j++) d[j] *= gain;
  }
  return buffer;
}
