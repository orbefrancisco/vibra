/* dsp.js — Procesamiento de señales de Vibra.
 *
 * Funciones puras: no tocan el DOM ni guardan estado (salvo cachés de ventanas y
 * factores de giro de la FFT). Todo en Float64Array. Unidades SI salvo que se diga otra cosa:
 * tiempo en s, frecuencia en Hz, aceleración en m/s², velocidad angular en rad/s.
 *
 * Convenciones del espectro (unilateral):
 *   PSD   = 2·⟨|X_k|²⟩ / (fs·S2)      [u²/Hz]   (DC y Nyquist sin el factor 2)
 *   Amp   = 2·√⟨|X_k|²⟩ / S1          [u]       amplitud de pico de un seno centrado en el bin
 *   con S1 = Σw, S2 = Σw². Así Σ PSD·Δf = varianza (Parseval) y un seno A·cos da pico A en Amp.
 *
 * Se usa en el navegador (window.DSP) y en _pruebas/tests.html (no publicada).
 */
(function (raiz) {
'use strict';
const D = {};
const PI2 = 2 * Math.PI;
const G0 = 9.80665; // g estándar (para convertir a µg)
D.G0 = G0;

/* ===================================================================== utilidades */

/** Generador pseudoaleatorio reproducible (mulberry32). Devuelve función → [0,1). */
D.rng = function (semilla) {
  let a = (semilla >>> 0) || 1;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
/** Normal estándar por Box–Muller a partir de un generador uniforme. */
D.normal = function (rand) {
  let u = 0; while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(PI2 * rand());
};
D.siguientePot2 = n => { let p = 1; while (p < n) p <<= 1; return p; };
D.potInferior2 = n => { let p = 1; while (p * 2 <= n) p <<= 1; return p; };
D.media = function (x, i0 = 0, i1 = x.length) { let s = 0; for (let i = i0; i < i1; i++) s += x[i]; return s / Math.max(1, i1 - i0); };
D.mediana = function (x) {
  const a = Float64Array.from(x).sort(); const n = a.length;
  if (!n) return NaN; return n % 2 ? a[(n - 1) / 2] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
};
D.percentil = function (x, p) {
  const a = Float64Array.from(x).sort(); if (!a.length) return NaN;
  const r = p / 100 * (a.length - 1), i = Math.floor(r), f = r - i;
  return i + 1 < a.length ? a[i] * (1 - f) + a[i + 1] * f : a[i];
};
D.desv = function (x) { const m = D.media(x); let s = 0; for (let i = 0; i < x.length; i++) s += (x[i] - m) ** 2; return Math.sqrt(s / Math.max(1, x.length - 1)); };

/** Recta por mínimos cuadrados (pesos opcionales w = 1/σ²). y = a + b·x, con σ_a, σ_b
 *  estimadas de la dispersión de los residuos. */
D.ajusteLineal = function (x, y, w) {
  const n = x.length; let S = 0, Sx = 0, Sy = 0, Sxx = 0, Sxy = 0;
  for (let i = 0; i < n; i++) { const wi = w ? w[i] : 1; S += wi; Sx += wi * x[i]; Sy += wi * y[i]; Sxx += wi * x[i] * x[i]; Sxy += wi * x[i] * y[i]; }
  const det = S * Sxx - Sx * Sx; const b = (S * Sxy - Sx * Sy) / det, a = (Sy - b * Sx) / S;
  let chi2 = 0; for (let i = 0; i < n; i++) chi2 += (w ? w[i] : 1) * (y[i] - a - b * x[i]) ** 2;
  const s2 = n > 2 ? chi2 / (n - 2) : 0;
  return { a, b, sa: Math.sqrt(s2 * Sxx / det), sb: Math.sqrt(s2 * S / det), n };
};

/** Resuelve A·x = b (A cuadrada, arreglo de filas) por eliminación con pivoteo parcial. */
D.resolver = function (A, b) {
  const n = b.length; const M = A.map((f, i) => [...f, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (M[p][c] === 0) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x;
};
/** Inversa de una matriz pequeña (Gauss–Jordan). */
D.invertir = function (A) {
  const n = A.length; const M = A.map((f, i) => [...f, ...Array.from({ length: n }, (_, j) => +(i === j))]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (M[p][c] === 0) return null; [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c]; for (let k = 0; k < 2 * n; k++) M[c][k] /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c]; if (f) for (let k = 0; k < 2 * n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map(f => f.slice(n));
};

/* ===================================================================== FFT */
const _giros = new Map();
function giros(n) {
  let g = _giros.get(n);
  if (!g) {
    g = { c: new Float64Array(n >> 1), s: new Float64Array(n >> 1) };
    for (let k = 0; k < n >> 1; k++) { g.c[k] = Math.cos(PI2 * k / n); g.s[k] = -Math.sin(PI2 * k / n); }
    _giros.set(n, g);
  }
  return g;
}
/** FFT compleja radix-2 en el sitio (Cooley–Tukey iterativa). X_k = Σ x_n e^{-2πikn/N}.
 *  Con inversa=true calcula la inversa e incluye el factor 1/N. */
D.fft = function (re, im, inversa = false) {
  const n = re.length;
  if (n & (n - 1)) throw new Error('FFT: el largo debe ser potencia de 2');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  const { c, s } = giros(n); const sg = inversa ? -1 : 1;
  for (let len = 2; len <= n; len <<= 1) {
    const h = len >> 1, paso = n / len;
    for (let i = 0; i < n; i += len) {
      for (let j = 0, k = 0; j < h; j++, k += paso) {
        const wr = c[k], wi = sg * s[k], a = i + j, b = a + h;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
  if (inversa) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
};

/* ===================================================================== ventanas */
/** Coeficientes de las ventanas de cosenos: w[n] = Σ (−1)^k a_k cos(2πkn/N) (forma periódica,
 *  la adecuada para análisis espectral). Flat-top: la de Matlab/SRS (festoneo < 0,01 dB). */
D.VENTANAS = {
  rect: { nombre: 'Rectangular', a: [1] },
  hann: { nombre: 'Hann', a: [0.5, 0.5] },
  hamming: { nombre: 'Hamming', a: [0.54, 0.46] },
  blackmanharris: { nombre: 'Blackman-Harris', a: [0.35875, 0.48829, 0.14128, 0.01168] },
  flattop: { nombre: 'Flat-top', a: [0.21557895, 0.41663158, 0.277263158, 0.083578947, 0.006947368] }
};
const _vent = new Map();
D.ventana = function (nombre, N) {
  const clave = nombre + ':' + N; let w = _vent.get(clave);
  if (!w) {
    const a = (D.VENTANAS[nombre] || D.VENTANAS.hann).a; w = new Float64Array(N);
    for (let n = 0; n < N; n++) { let v = 0; for (let k = 0; k < a.length; k++) v += (k % 2 ? -1 : 1) * a[k] * Math.cos(PI2 * k * n / N); w[n] = v; }
    if (_vent.size > 40) _vent.clear(); _vent.set(clave, w);
  }
  return w;
};
/** Sumas S1 = Σw y S2 = Σw², y ancho de banda equivalente de ruido (en bins). */
D.propVentana = function (w) {
  let S1 = 0, S2 = 0; for (let i = 0; i < w.length; i++) { S1 += w[i]; S2 += w[i] * w[i]; }
  return { S1, S2, enbwBins: w.length * S2 / (S1 * S1) };
};
/** |W(δ)|/|W(0)|: respuesta de la ventana a un tono desplazado δ bins (para corregir el festoneo). */
D.respVentana = function (w, delta) {
  const N = w.length; let re = 0, im = 0, s = 0;
  for (let n = 0; n < N; n++) { const a = PI2 * delta * n / N; re += w[n] * Math.cos(a); im -= w[n] * Math.sin(a); s += w[n]; }
  return Math.hypot(re, im) / s;
};

function quitarTendencia(seg, n, tipo) {
  if (tipo === 'ninguna') return;
  if (tipo === 'lineal') {
    let Sx = 0, Sy = 0, Sxx = 0, Sxy = 0;
    for (let i = 0; i < n; i++) { Sx += i; Sy += seg[i]; Sxx += i * i; Sxy += i * seg[i]; }
    const b = (n * Sxy - Sx * Sy) / (n * Sxx - Sx * Sx), a = (Sy - b * Sx) / n;
    for (let i = 0; i < n; i++) seg[i] -= a + b * i;
  } else { let m = 0; for (let i = 0; i < n; i++) m += seg[i]; m /= n; for (let i = 0; i < n; i++) seg[i] -= m; }
}

/* ===================================================================== estadísticos */
/** Estadísticos de una señal: media, RMS sin media (desviación), pico (máx |x−media|),
 *  pico a pico, factor de cresta = pico/RMS, curtosis (3 para gaussiana) y asimetría. */
D.estadisticos = function (x) {
  const n = x.length; const m = D.media(x);
  let s2 = 0, s3 = 0, s4 = 0, mn = Infinity, mx = -Infinity, pk = 0, sq = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i], d = v - m; s2 += d * d; s3 += d * d * d; s4 += d * d * d * d; sq += v * v;
    if (v < mn) mn = v; if (v > mx) mx = v; if (Math.abs(d) > pk) pk = Math.abs(d);
  }
  const vr = s2 / n, rms = Math.sqrt(vr);
  return { n, media: m, rms, rmsTotal: Math.sqrt(sq / n), pico: pk, picoPico: mx - mn, min: mn, max: mx,
    cresta: rms > 0 ? pk / rms : NaN, curtosis: vr > 0 ? (s4 / n) / (vr * vr) : NaN, asimetria: vr > 0 ? (s3 / n) / Math.pow(vr, 1.5) : NaN };
};

/* ===================================================================== muestreo */
/** Analiza las marcas de tiempo t (s): frecuencia efectiva (n−1)/duración, mediana de Δt,
 *  jitter = desviación estándar de Δt y huecos (ver umbral abajo). */
D.analizarMuestreo = function (t) {
  const n = t.length; if (n < 3) return { n, fs: NaN, fsMediana: NaN, jitter: NaN, huecos: [], duracion: 0, dt: new Float64Array(0) };
  const dt = new Float64Array(n - 1); for (let i = 1; i < n; i++) dt[i - 1] = t[i] - t[i - 1];
  // hueco: Δt mayor que 1,5 × mediana y que mediana + 6 σ robustas (σ por MAD) → tolera jitter y detecta una muestra perdida
  const med = D.mediana(dt), mad = 1.4826 * D.mediana(dt.map(v => Math.abs(v - med))), umbral = Math.max(1.5 * med, med + 6 * mad), huecos = [];
  for (let i = 0; i < dt.length; i++) if (dt[i] > umbral) huecos.push({ t: t[i], dur: dt[i] });
  let mn = Infinity, mx = -Infinity; for (const v of dt) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const dur = t[n - 1] - t[0];
  return { n, duracion: dur, fs: (n - 1) / dur, fsMediana: 1 / med, dtMediana: med, jitter: D.desv(dt), dtMin: mn, dtMax: mx, huecos, dt };
};

/** Remuestrea (t, x) irregulares a una malla uniforme de frecuencia fs entre t0 y t1.
 *  metodo 'lineal' o 'cubica' (Hermite cúbica con pendientes de Catmull–Rom para malla no uniforme:
 *  m_i = (x_{i+1}−x_{i−1})/(t_{i+1}−t_{i−1})). Devuelve Float64Array. */
D.remuestrear = function (t, x, fs, metodo = 'cubica', t0 = t[0], t1 = t[t.length - 1]) {
  const n = t.length, M = Math.max(1, Math.floor((t1 - t0) * fs + 1e-9) + 1); const y = new Float64Array(M);
  const pend = i => { const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1); return (x[b] - x[a]) / (t[b] - t[a]); };
  let j = 0;
  for (let k = 0; k < M; k++) {
    const tk = t0 + k / fs;
    while (j < n - 2 && t[j + 1] < tk) j++;
    if (tk <= t[0]) { y[k] = x[0]; continue; } if (tk >= t[n - 1]) { y[k] = x[n - 1]; continue; }
    const h = t[j + 1] - t[j], u = (tk - t[j]) / h;
    if (metodo === 'lineal' || n < 3) { y[k] = x[j] + u * (x[j + 1] - x[j]); continue; }
    const m0 = pend(j) * h, m1 = pend(j + 1) * h, u2 = u * u, u3 = u2 * u;
    y[k] = (2 * u3 - 3 * u2 + 1) * x[j] + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * x[j + 1] + (u3 - u2) * m1;
  }
  return y;
};

/* ===================================================================== espectros */
/** Densidad espectral de potencia y espectro de amplitud por el método de Welch.
 *  op: nseg (potencia de 2), ventana ('hann'…), solape (0,5), nfft (≥ nseg, relleno de ceros),
 *  tendencia ('media'|'lineal'|'ninguna'). Devuelve {f, psd, amp, df, enbw (Hz), K (promedios), …}. */
D.welch = function (x, fs, op = {}) {
  const N = x.length; let nseg = D.potInferior2(Math.min(op.nseg || 1024, N));
  if (nseg < 8) throw new Error('Señal demasiado corta para el espectro');
  const nfft = Math.max(nseg, D.siguientePot2(op.nfft || nseg));
  const solape = op.solape ?? 0.5, paso = Math.max(1, Math.round(nseg * (1 - solape)));
  const nombreV = op.ventana || 'hann', w = D.ventana(nombreV, nseg), { S1, S2 } = D.propVentana(w);
  const K = Math.floor((N - nseg) / paso) + 1, h = nfft / 2;
  const P = new Float64Array(h + 1), re = new Float64Array(nfft), im = new Float64Array(nfft);
  for (let k = 0; k < K; k++) {
    const s = k * paso; re.fill(0); im.fill(0);
    for (let i = 0; i < nseg; i++) re[i] = x[s + i];
    quitarTendencia(re, nseg, op.tendencia || 'media');
    for (let i = 0; i < nseg; i++) re[i] *= w[i];
    D.fft(re, im);
    for (let i = 0; i <= h; i++) P[i] += re[i] * re[i] + im[i] * im[i];
  }
  const f = new Float64Array(h + 1), psd = new Float64Array(h + 1), amp = new Float64Array(h + 1);
  for (let i = 0; i <= h; i++) {
    const p = P[i] / K, dos = (i === 0 || i === h) ? 1 : 2;
    f[i] = i * fs / nfft; psd[i] = dos * p / (fs * S2); amp[i] = (i === 0 ? 1 : 2) * Math.sqrt(p) / S1;
  }
  return { f, psd, amp, df: fs / nfft, enbw: fs * S2 / (S1 * S1), K, nseg, nfft, ventana: nombreV, fs, N, w };
};

/** Coherencia cuadrática |Pxy|²/(Pxx·Pyy) entre dos señales (Welch, Hann) y fase de Pxy. */
D.coherencia = function (x, y, fs, op = {}) {
  const N = Math.min(x.length, y.length); const nseg = D.potInferior2(Math.min(op.nseg || 1024, N));
  const paso = Math.max(1, Math.round(nseg * (1 - (op.solape ?? 0.5)))), w = D.ventana('hann', nseg), h = nseg / 2;
  const K = Math.floor((N - nseg) / paso) + 1;
  const Pxx = new Float64Array(h + 1), Pyy = new Float64Array(h + 1), Cr = new Float64Array(h + 1), Ci = new Float64Array(h + 1);
  const ar = new Float64Array(nseg), ai = new Float64Array(nseg), br = new Float64Array(nseg), bi = new Float64Array(nseg);
  for (let k = 0; k < K; k++) {
    const s = k * paso; ai.fill(0); bi.fill(0);
    for (let i = 0; i < nseg; i++) { ar[i] = x[s + i]; br[i] = y[s + i]; }
    quitarTendencia(ar, nseg, 'media'); quitarTendencia(br, nseg, 'media');
    for (let i = 0; i < nseg; i++) { ar[i] *= w[i]; br[i] *= w[i]; }
    D.fft(ar, ai); D.fft(br, bi);
    for (let i = 0; i <= h; i++) {
      Pxx[i] += ar[i] * ar[i] + ai[i] * ai[i]; Pyy[i] += br[i] * br[i] + bi[i] * bi[i];
      Cr[i] += ar[i] * br[i] + ai[i] * bi[i]; Ci[i] += ai[i] * br[i] - ar[i] * bi[i]; // X·conj(Y)
    }
  }
  const f = new Float64Array(h + 1), coh = new Float64Array(h + 1), fase = new Float64Array(h + 1);
  for (let i = 0; i <= h; i++) { f[i] = i * fs / nseg; coh[i] = (Cr[i] ** 2 + Ci[i] ** 2) / (Pxx[i] * Pyy[i] || 1); fase[i] = Math.atan2(Ci[i], Cr[i]); }
  return { f, coh, fase, K, df: fs / nseg };
};

/** Espectrograma (STFT) con PSD por columna. Devuelve {t (centros), f, S (Float32Array nt×nf, fila = tiempo), nt, nf}. */
D.espectrograma = function (x, fs, op = {}) {
  const N = x.length, nseg = D.potInferior2(Math.min(op.nseg || 256, N));
  const paso = Math.max(1, Math.round(nseg * (1 - (op.solape ?? 0.75))));
  const w = D.ventana(op.ventana || 'hann', nseg), { S2 } = D.propVentana(w), nf = nseg / 2 + 1;
  const nt = Math.max(1, Math.floor((N - nseg) / paso) + 1);
  const S = new Float32Array(nt * nf), t = new Float64Array(nt), f = new Float64Array(nf);
  const re = new Float64Array(nseg), im = new Float64Array(nseg);
  for (let i = 0; i < nf; i++) f[i] = i * fs / nseg;
  for (let k = 0; k < nt; k++) {
    const s = k * paso; im.fill(0);
    for (let i = 0; i < nseg; i++) re[i] = x[s + i];
    quitarTendencia(re, nseg, 'media'); for (let i = 0; i < nseg; i++) re[i] *= w[i];
    D.fft(re, im); t[k] = (s + nseg / 2) / fs;
    for (let i = 0; i < nf; i++) S[k * nf + i] = (i === 0 || i === nf - 1 ? 1 : 2) * (re[i] * re[i] + im[i] * im[i]) / (fs * S2);
  }
  return { t, f, S, nt, nf, nseg, df: fs / nseg, dt: paso / fs };
};

/** Pasa un espectro de aceleración a velocidad (orden 1) o desplazamiento (orden 2) dividiendo por
 *  (2πf)^orden; por debajo de fhp se anula (filtro paso alto ideal que evita la divergencia en 0 Hz). */
D.integrarEspectro = function (esp, orden, fhp) {
  const n = esp.f.length, psd = new Float64Array(n), amp = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const f = esp.f[i]; if (f < fhp || f <= 0) continue;
    const g = Math.pow(PI2 * f, orden); psd[i] = esp.psd[i] / (g * g); amp[i] = esp.amp[i] / g;
  }
  return Object.assign({}, esp, { psd, amp });
};
/** RMS en una banda [f1, f2] a partir de la PSD: √(Σ PSD·Δf). */
D.rmsBanda = function (esp, f1, f2) {
  let s = 0; for (let i = 0; i < esp.f.length; i++) if (esp.f[i] >= f1 && esp.f[i] <= f2) s += esp.psd[i];
  return Math.sqrt(s * esp.df);
};
/** Integra una señal en el dominio de la frecuencia (veces=1: velocidad, 2: desplazamiento) con un
 *  paso alto suave (coseno) entre fhp/2 y fhp. Rellena con ceros a 2·potencia de 2. */
D.integrarFFT = function (x, fs, fhp, veces = 1) {
  const N = x.length, M = D.siguientePot2(2 * N), re = new Float64Array(M), im = new Float64Array(M), m = D.media(x);
  for (let i = 0; i < N; i++) re[i] = x[i] - m;
  D.fft(re, im);
  for (let k = 0; k < M; k++) {
    const kk = k <= M / 2 ? k : k - M, f = kk * fs / M, af = Math.abs(f);
    if (k === 0 || af < fhp / 2) { re[k] = 0; im[k] = 0; continue; }
    let g = 1; if (af < fhp) g = 0.5 - 0.5 * Math.cos(Math.PI * (af - fhp / 2) / (fhp / 2));
    for (let v = 0; v < veces; v++) { // dividir por i·2πf
      const w = PI2 * f, r = re[k], s = im[k]; re[k] = s / w; im[k] = -r / w;
    }
    re[k] *= g; im[k] *= g;
  }
  D.fft(re, im, true);
  return re.slice(0, N);
};

/* ===================================================================== picos */
/** Busca picos en un espectro {f, y}. Interpolación de sub-bin: 'gauss' (parábola sobre ln y) o
 *  'parabola' (sobre y lineal). Prominencia en dB sobre la mediana local.
 *  op: n, fmin, fmax, promDb, sepBins, potencia (true si y es potencia). */
D.buscarPicos = function (f, y, op = {}) {
  const n = y.length, fmin = op.fmin ?? f[1], fmax = op.fmax ?? f[n - 1], fac = op.potencia ? 10 : 20;
  const W = Math.max(8, Math.round(n / 40)), cand = [];
  for (let i = 1; i < n - 1; i++) {
    if (f[i] < fmin || f[i] > fmax || !(y[i] > y[i - 1] && y[i] >= y[i + 1]) || y[i] <= 0) continue;
    const loc = []; for (let j = Math.max(1, i - W); j <= Math.min(n - 1, i + W); j++) loc.push(y[j]);
    const piso = D.mediana(loc); const prom = fac * Math.log10(y[i] / (piso || 1e-300));
    if (prom < (op.promDb ?? 6)) continue;
    const a = y[i - 1], b = y[i], c = y[i + 1]; let d, yi;
    if ((op.interp || 'gauss') === 'gauss' && a > 0 && c > 0) {
      const la = Math.log(a), lb = Math.log(b), lc = Math.log(c), den = la - 2 * lb + lc;
      d = den !== 0 ? 0.5 * (la - lc) / den : 0; yi = Math.exp(lb - 0.25 * (la - lc) * d);
    } else { const den = a - 2 * b + c; d = den !== 0 ? 0.5 * (a - c) / den : 0; yi = b - 0.25 * (a - c) * d; }
    d = Math.max(-0.5, Math.min(0.5, d));
    cand.push({ i, delta: d, f: f[i] + d * (f[1] - f[0]), y: yi, yBin: b, piso, promDb: prom });
  }
  cand.sort((p, q) => q.y - p.y);
  const sep = op.sepBins ?? 3, sel = [];
  for (const p of cand) { if (sel.every(q => Math.abs(q.i - p.i) >= sep)) sel.push(p); if (sel.length >= (op.n || 8)) break; }
  return sel;
};

/** Evalúa |Σ w_n x_n e^{−2πi f n/fs}| (DTFT con ventana) en la frecuencia f. */
function dtft(x, w, fs, f) {
  const a = PI2 * f / fs, cr = Math.cos(a), ci = -Math.sin(a); let zr = 1, zi = 0, sr = 0, si = 0;
  for (let n = 0; n < x.length; n++) {
    const v = x[n] * w[n]; sr += v * zr; si += v * zi;
    const t = zr * cr - zi * ci; zi = zr * ci + zi * cr; zr = t;
    if ((n & 1023) === 1023) { const m = Math.hypot(zr, zi); zr /= m; zi /= m; }
  }
  return { re: sr, im: si };
}

/** Afina la frecuencia de un tono maximizando la DTFT de TODO el registro (ventana Hann) cerca de f0,
 *  sin sesgo de interpolación. Incertidumbre (1σ) del estimador de periodograma con ventana:
 *    var(ω̂) = 2σ²·Σw²(n−c)² / (A²·(Σw(n−c)²)²)   [rad/muestra]²
 *  (igual a la cota de Cramér–Rao 24σ²/(A²N³) con ventana rectangular); σ² = varianza del ruido
 *  en la banda completa equivalente al piso local: σ² = S_ruido·fs/2.
 *  op: ancho (Hz de búsqueda a cada lado), ruidoPSD (u²/Hz unilateral). */
D.afinarTono = function (x, fs, f0, op = {}) {
  const N = x.length, m = D.media(x), xs = new Float64Array(N);
  for (let i = 0; i < N; i++) xs[i] = x[i] - m;
  const w = D.ventana(op.ventana || 'hann', N), { S1 } = D.propVentana(w);
  const ancho = op.ancho ?? 2 * fs / N, P = f => { const z = dtft(xs, w, fs, f); return z.re * z.re + z.im * z.im; };
  let mejor = f0, pm = -1;
  for (let k = -10; k <= 10; k++) { const f = f0 + ancho * k / 10, p = f > 0 ? P(f) : -1; if (p > pm) { pm = p; mejor = f; } }
  let a = mejor - ancho / 10, b = mejor + ancho / 10; const r = (Math.sqrt(5) - 1) / 2;
  let c = b - r * (b - a), d = a + r * (b - a), pc = P(c), pd = P(d);
  for (let it = 0; it < 60 && (b - a) > 1e-7 * fs / N; it++) {
    if (pc > pd) { b = d; d = c; pd = pc; c = b - r * (b - a); pc = P(c); } else { a = c; c = d; pc = pd; d = a + r * (b - a); pd = P(d); }
  }
  const f = (a + b) / 2, z = dtft(xs, w, fs, f), A = 2 * Math.hypot(z.re, z.im) / S1, fase = Math.atan2(z.im, z.re);
  let sf = NaN, snr = NaN;
  if (op.ruidoPSD > 0) {
    const s2 = op.ruidoPSD * fs / 2, c0 = (N - 1) / 2; let num = 0, den = 0;
    for (let n = 0; n < N; n++) { const q = (n - c0) ** 2; num += w[n] * w[n] * q; den += w[n] * q; }
    sf = fs * Math.sqrt(2 * s2 * num / (A * A * den * den)) / PI2; snr = A * A / (2 * s2);
  }
  return { f, A, fase, sf, snr };
};

/** Estimación de la mediana local de una PSD alrededor del bin i, excluyendo ±excl bins. */
D.pisoLocal = function (psd, i, W = 20, excl = 4) {
  const v = []; for (let j = Math.max(1, i - W); j <= Math.min(psd.length - 1, i + W); j++) if (Math.abs(j - i) > excl) v.push(psd[j]);
  return v.length ? D.mediana(v) : NaN;
};

/** Ancho de media potencia de un pico de una PSD (P): puntos donde cae a P_pico/2, interpolando
 *  linealmente. ζ = Δf/(2f₀), Q = f₀/Δf. */
D.medioPotencia = function (f, P, i) {
  const mitad = P[i] / 2; let a = i, b = i;
  while (a > 0 && P[a] > mitad) a--; while (b < P.length - 1 && P[b] > mitad) b++;
  if (P[a] > mitad || P[b] > mitad) return null;
  const f1 = f[a] + (mitad - P[a]) / (P[a + 1] - P[a]) * (f[a + 1] - f[a]);
  const f2 = f[b - 1] + (P[b - 1] - mitad) / (P[b - 1] - P[b]) * (f[b] - f[b - 1]);
  const ancho = f2 - f1, f0 = f[i];
  return { f1, f2, ancho, f0, zeta: ancho / (2 * f0), Q: f0 / ancho };
};

/* ===================================================================== analítica / envolvente */
/** Señal analítica por FFT (anula frecuencias negativas) → envolvente |x + i·H[x]|. */
D.envolvente = function (x) {
  const N = x.length, M = D.siguientePot2(N), re = new Float64Array(M), im = new Float64Array(M);
  re.set(x); D.fft(re, im);
  for (let k = 1; k < M / 2; k++) { re[k] *= 2; im[k] *= 2; }
  for (let k = M / 2 + 1; k < M; k++) { re[k] = 0; im[k] = 0; }
  D.fft(re, im, true);
  const e = new Float64Array(N); for (let i = 0; i < N; i++) e[i] = Math.hypot(re[i], im[i]); return e;
};

/* ===================================================================== Levenberg–Marquardt */
/** Minimiza Σ r² con r = y − modelo(p). fun(p) → {r, J} con J = columnas ∂modelo/∂p_j.
 *  Escalado de Marquardt (λ·diag(JᵀJ)). Devuelve {p, chi2, JtJ, r, iter, convergio}. */
D.levenbergMarquardt = function (fun, p0, op = {}) {
  let p = p0.slice(), np = p.length, ev = fun(p), lam = 1e-3, iter = 0, convergio = false, quietos = 0;
  const chi = r => { let s = 0; for (let i = 0; i < r.length; i++) s += r[i] * r[i]; return s; };
  let c2 = chi(ev.r);
  const normales = e => {
    const A = Array.from({ length: np }, () => new Array(np).fill(0)), g = new Array(np).fill(0);
    for (let a = 0; a < np; a++) {
      const Ja = e.J[a]; let s = 0; for (let i = 0; i < Ja.length; i++) s += Ja[i] * e.r[i]; g[a] = s;
      for (let b = a; b < np; b++) { const Jb = e.J[b]; let t = 0; for (let i = 0; i < Ja.length; i++) t += Ja[i] * Jb[i]; A[a][b] = A[b][a] = t; }
    }
    return { A, g };
  };
  let { A, g } = normales(ev);
  for (iter = 0; iter < (op.maxIter || 200); iter++) {
    const B = A.map((f, i) => f.map((v, j) => i === j ? v * (1 + lam) + 1e-300 : v));
    const dp = D.resolver(B, g);
    if (!dp) { lam *= 10; continue; }
    const pn = p.map((v, i) => v + dp[i]), en = fun(pn), cn = chi(en.r);
    if (isFinite(cn) && cn < c2) {
      const rel = (c2 - cn) / c2; p = pn; ev = en; c2 = cn; ({ A, g } = normales(ev)); lam = Math.max(lam / 10, 1e-12);
      if (rel < (op.tol || 1e-10)) { if (++quietos >= 2) { convergio = true; break; } } else quietos = 0;
    } else { lam *= 10; if (lam > 1e14) { convergio = true; break; } }
  }
  return { p, chi2: c2, JtJ: A, r: ev.r, iter, convergio };
};

/** Ajusta x(t) = A·e^(−t/τ)·cos(2πf t + φ) + c a un tramo uniforme (t en s, y).
 *  Valores iniciales: f por FFT con relleno + afinado DTFT; τ por regresión ponderada de ln(envolvente de Hilbert);
 *  A, φ, c por mínimos cuadrados lineales. Parámetros internos p = [a, b, f, γ, c] con a = A cos φ, b = A sin φ, γ = 1/τ.
 *  Covarianza = s²(JᵀJ)⁻¹ con s² = χ²/(N−5); si los residuos están correlacionados (ρ₁ > 2/√N) se infla por (1+ρ₁)/(1−ρ₁).
 *  Derivados: f₀ = √(f² + (γ/2π)²), ζ = γ/ω₀, Q = 1/(2ζ), con propagación de errores (covarianza f–γ incluida). */
D.ajustarAmortiguado = function (t, y, op = {}) {
  const N = y.length; if (N < 20) throw new Error('Tramo demasiado corto para ajustar');
  const t0 = t[0], tt = new Float64Array(N); for (let i = 0; i < N; i++) tt[i] = t[i] - t0;
  const fs = (N - 1) / (tt[N - 1] || 1), m = D.media(y), yc = new Float64Array(N); for (let i = 0; i < N; i++) yc[i] = y[i] - m;
  // f inicial
  const M = D.siguientePot2(N) * 8, re = new Float64Array(M), im = new Float64Array(M), w = D.ventana('hann', N);
  for (let i = 0; i < N; i++) re[i] = yc[i] * w[i]; D.fft(re, im);
  let ib = 1, pb = 0; const fmin = op.fmin ?? 2 * fs / N;
  for (let k = 1; k < M / 2; k++) { const p = re[k] ** 2 + im[k] ** 2, f = k * fs / M; if (f >= fmin && p > pb) { pb = p; ib = k; } }
  let f0 = ib * fs / M; f0 = D.afinarTono(yc, fs, f0, { ancho: 2 * fs / M }).f;
  // γ inicial por la envolvente
  const env = D.envolvente(yc); let emax = 0; for (const v of env) emax = Math.max(emax, v);
  const xs = [], ys = [], ws = [], i0 = Math.floor(0.08 * N), i1 = Math.ceil(0.92 * N);
  for (let i = i0; i < i1; i++) if (env[i] > 0.08 * emax) { xs.push(tt[i]); ys.push(Math.log(env[i])); ws.push(env[i] * env[i]); }
  let g0 = 1e-3 * f0;
  if (xs.length > 5) { const r = D.ajusteLineal(xs, ys, ws); if (r.b < 0) g0 = -r.b; }
  // a, b, c por mínimos cuadrados lineales con f, γ fijos
  const base = (f, g) => { const c = new Float64Array(N), s = new Float64Array(N), e = new Float64Array(N); for (let i = 0; i < N; i++) { e[i] = Math.exp(-g * tt[i]); c[i] = Math.cos(PI2 * f * tt[i]); s[i] = Math.sin(PI2 * f * tt[i]); } return { c, s, e }; };
  const B0 = base(f0, g0), cols = [B0.e.map((v, i) => v * B0.c[i]), B0.e.map((v, i) => -v * B0.s[i]), new Float64Array(N).fill(1)];
  const AtA = cols.map(u => cols.map(v => { let s = 0; for (let i = 0; i < N; i++) s += u[i] * v[i]; return s; }));
  const Atb = cols.map(u => { let s = 0; for (let i = 0; i < N; i++) s += u[i] * y[i]; return s; });
  const lin = D.resolver(AtA, Atb) || [emax, 0, m];
  const ini = { f: f0, gamma: g0, a: lin[0], b: lin[1], c: lin[2] };
  const fun = p => {
    const [a, b, f, g, c] = p, r = new Float64Array(N), J = [0, 0, 0, 0, 0].map(() => new Float64Array(N));
    for (let i = 0; i < N; i++) {
      const ti = tt[i], e = Math.exp(-g * ti), co = Math.cos(PI2 * f * ti), si = Math.sin(PI2 * f * ti), osc = a * co - b * si;
      r[i] = y[i] - (e * osc + c); J[0][i] = e * co; J[1][i] = -e * si; J[2][i] = e * PI2 * ti * (-a * si - b * co); J[3][i] = -ti * e * osc; J[4][i] = 1;
    }
    return { r, J };
  };
  const res = D.levenbergMarquardt(fun, [ini.a, ini.b, ini.f, ini.gamma, ini.c]);
  const [a, b, f, g, c] = res.p, nu = N - 5, s2 = res.chi2 / nu;
  // correlación de residuos
  let r0 = 0, r1 = 0; for (let i = 0; i < N; i++) { r0 += res.r[i] ** 2; if (i) r1 += res.r[i] * res.r[i - 1]; }
  const rho = r1 / r0, fc = rho > 2 / Math.sqrt(N) ? (1 + rho) / (1 - rho) : 1;
  const Ci = D.invertir(res.JtJ), C = Ci ? Ci.map(f => f.map(v => v * s2 * fc)) : null;
  const sd = i => C ? Math.sqrt(Math.max(0, C[i][i])) : NaN;
  // ruido independiente del modelo: diferencias primeras (σ² ≈ var(Δy)/2 para ruido blanco)
  let sdif = 0; for (let i = 1; i < N; i++) { const d = (y[i] - y[i - 1]) - ((y[i] - res.r[i]) - (y[i - 1] - res.r[i - 1])); sdif += d * d; }
  const sigmaRuido = Math.sqrt(sdif / (2 * (N - 1)));
  const A = Math.hypot(a, b), phi = Math.atan2(b, a), wd = PI2 * f, w0 = Math.hypot(wd, g);
  const zeta = g / w0, Q = w0 / (2 * g);
  let szeta = NaN, sf0 = NaN, sA = NaN, sphi = NaN;
  if (C) {
    const dzdw = -g * wd / w0 ** 3, dzdg = wd * wd / w0 ** 3, dzdf = dzdw * PI2;
    szeta = Math.sqrt(Math.max(0, dzdf * dzdf * C[2][2] + dzdg * dzdg * C[3][3] + 2 * dzdf * dzdg * C[2][3]));
    const df0df = f / (w0 / PI2), df0dg = g / (PI2 * PI2 * (w0 / PI2));
    sf0 = Math.sqrt(Math.max(0, df0df ** 2 * C[2][2] + df0dg ** 2 * C[3][3] + 2 * df0df * df0dg * C[2][3]));
    sA = Math.sqrt(Math.max(0, (a * a * C[0][0] + b * b * C[1][1] + 2 * a * b * C[0][1]) / (A * A)));
    sphi = Math.sqrt(Math.max(0, (b * b * C[0][0] + a * a * C[1][1] - 2 * a * b * C[0][1]) / (A ** 4)));
  }
  const modelo = tv => Math.exp(-g * (tv - t0)) * (a * Math.cos(PI2 * f * (tv - t0)) - b * Math.sin(PI2 * f * (tv - t0))) + c;
  return { f, sf: sd(2), gamma: g, sgamma: sd(3), tau: 1 / g, stau: sd(3) / (g * g), f0: w0 / PI2, sf0, zeta, szeta, Q, sQ: szeta / (2 * zeta * zeta),
    A, sA, phi, sphi, c, sc: sd(4), cov: C, chi2: res.chi2, nu, sResid: Math.sqrt(s2), sigmaRuido, chi2nu: s2 / (sigmaRuido * sigmaRuido),
    rho1: rho, factorCorr: fc, resid: res.r, iter: res.iter, convergio: res.convergio, ini, N, t0, modelo };
};

/** Decremento logarítmico: picos positivos sucesivos de (y − c), cada uno con una parábola ajustada por mínimos
 *  cuadrados a ±1/12 de periodo (promedia el ruido: el máximo de muestras ruidosas sesgaría hacia arriba los picos
 *  pequeños). Recta ponderada (pesos ∝ pico²) de ln(pico) contra número de ciclo → δ por ciclo; ζ = δ/√(4π² + δ²).
 *  umbral: altura mínima de pico (p. ej. 10σ del ruido). */
D.decrementoLog = function (t, y, c, f, umbral = 0) {
  const N = y.length, dtm = (t[N - 1] - t[0]) / (N - 1), sep = Math.max(2, Math.round(0.6 / (f * dtm))), h = Math.max(1, Math.round(1 / (12 * f * dtm))), picos = [];
  for (let i = h; i < N - h; i++) {
    const v = y[i] - c; if (v <= umbral || !(y[i] > y[i - 1] && y[i] >= y[i + 1])) continue;
    let esMax = true; for (let j = Math.max(0, i - sep); j <= Math.min(N - 1, i + sep); j++) if (y[j] > y[i]) { esMax = false; break; }
    if (!esMax) continue;
    // parábola v = a0 + a1·u + a2·u² por mínimos cuadrados en u = −h..h
    let S0 = 0, S2 = 0, S4 = 0, T0 = 0, T1 = 0, T2 = 0;
    for (let u = -h; u <= h; u++) { const w = y[i + u] - c; S0++; S2 += u * u; S4 += u ** 4; T0 += w; T1 += u * w; T2 += u * u * w; }
    const a1 = T1 / S2, det = S0 * S4 - S2 * S2, a2 = (S0 * T2 - S2 * T0) / det, a0 = (S4 * T0 - S2 * T2) / det;
    if (!(a2 < 0)) continue;
    const um = Math.max(-h, Math.min(h, -a1 / (2 * a2)));
    picos.push({ t: t[i] + um * dtm, y: a0 + a1 * um + a2 * um * um });
  }
  if (picos.length < 3) return null;
  const k = picos.map(p => Math.round((p.t - picos[0].t) * f)), ly = picos.map(p => Math.log(p.y)), w = picos.map(p => p.y * p.y);
  const r = D.ajusteLineal(k, ly, w); const delta = -r.b, sdelta = r.sb;
  const den = Math.sqrt(4 * Math.PI ** 2 + delta * delta), zeta = delta / den, szeta = sdelta * 4 * Math.PI ** 2 / den ** 3;
  return { delta, sdelta, zeta, szeta, Q: 1 / (2 * zeta), tau: 1 / (delta * f), npicos: picos.length, picos };
};

/** Amortiguamiento por ancho de media potencia del periodograma (ventana rectangular, relleno ×8) de un
 *  tramo de decaimiento. Si el pico cae en pocos bins el resultado está limitado por la resolución. */
D.amortiguamientoMedioPotencia = function (y, fs, c = D.media(y)) {
  const N = y.length, M = D.siguientePot2(N) * 8, re = new Float64Array(M), im = new Float64Array(M);
  for (let i = 0; i < N; i++) re[i] = y[i] - c; D.fft(re, im);
  const P = new Float64Array(M / 2 + 1), f = new Float64Array(M / 2 + 1); let ib = 1;
  for (let k = 0; k <= M / 2; k++) { P[k] = re[k] ** 2 + im[k] ** 2; f[k] = k * fs / M; if (k > 0 && P[k] > P[ib]) ib = k; }
  const r = D.medioPotencia(f, P, ib); if (!r) return null;
  r.resolucion = fs / N; r.limitado = r.ancho < 2 * fs / N; return r;
};

/* ===================================================================== péndulo */
/** Media aritmético-geométrica. */
D.agm = function (a, b) { for (let i = 0; i < 60 && Math.abs(a - b) > 1e-15 * a; i++) [a, b] = [(a + b) / 2, Math.sqrt(a * b)]; return (a + b) / 2; };
/** Integral elíptica completa de primera especie K(k) = π / (2·AGM(1, √(1−k²))). */
D.elipticaK = k => Math.PI / (2 * D.agm(1, Math.sqrt(1 - k * k)));
/** Periodo exacto del péndulo simple: T = 4√(L/g)·K(sin(θ₀/2)). */
D.periodoPendulo = (L, g, th0) => 4 * Math.sqrt(L / g) * D.elipticaK(Math.sin(th0 / 2));

/** Análisis de un péndulo con el giroscopio (ω en rad/s alrededor del eje de giro).
 *  Por ciclo (cruces ascendentes de ω): T_i, ω_amp,i = (máx − mín)/2. Como ω_máx = 2√(g/L)·k y T = 4√(L/g)K(k),
 *  el producto ω_amp·T = 8k·K(k) depende solo de k = sin(θ₀/2): se despeja k sin conocer g ni integrar,
 *  y g = 16·L·K(k)²/T². También θ₀ integrando ω (comparación) y g con aproximación de ángulo pequeño. */
D.pendulo = function (t, w, L) {
  const N = w.length, m = D.media(w), x = new Float64Array(N); for (let i = 0; i < N; i++) x[i] = w[i] - m;
  const amp = D.percentil(x.map(Math.abs), 99), hist = 0.3 * amp, cruces = [];
  let armado = false;
  for (let i = 1; i < N; i++) {
    if (x[i] < -hist) armado = true;
    if (armado && x[i - 1] < 0 && x[i] >= 0) { cruces.push({ i, t: t[i - 1] + (t[i] - t[i - 1]) * (-x[i - 1]) / (x[i] - x[i - 1]) }); armado = false; }
  }
  if (cruces.length < 3) return null;
  const ciclos = [];
  for (let c = 0; c + 1 < cruces.length; c++) {
    const a = cruces[c].i, b = cruces[c + 1].i; let mx = -Infinity, mn = Infinity, imx = a, imn = a;
    for (let i = a; i < b; i++) { if (x[i] > mx) { mx = x[i]; imx = i; } if (x[i] < mn) { mn = x[i]; imn = i; } }
    const par = i => (i > 0 && i < N - 1) ? (() => { const p = x[i - 1], q = x[i], r = x[i + 1], d = p - 2 * q + r; return d ? q - (p - r) ** 2 / (8 * d) : q; })() : x[i];
    const T = cruces[c + 1].t - cruces[c].t, wamp = (par(imx) - par(imn)) / 2, W = wamp * T;
    let lo = 0, hi = 0.999999; // 8kK(k) = W
    for (let it = 0; it < 80; it++) { const k = (lo + hi) / 2; if (8 * k * D.elipticaK(k) < W) lo = k; else hi = k; }
    const k = (lo + hi) / 2, K = D.elipticaK(k);
    ciclos.push({ t: cruces[c].t, T, wamp, k, th0: 2 * Math.asin(k), g: 16 * L * K * K / (T * T), g0: 4 * Math.PI ** 2 * L / (T * T) });
  }
  const n = ciclos.length, mp = arr => D.media(arr), se = arr => n > 1 ? D.desv(arr) / Math.sqrt(n) : NaN;
  const Ts = ciclos.map(c => c.T), gs = ciclos.map(c => c.g), g0s = ciclos.map(c => c.g0), ths = ciclos.map(c => c.th0);
  // θ por integración en frecuencia (paso alto a f/5) para comparar
  const fs = (N - 1) / (t[N - 1] - t[0]), fp = 1 / mp(Ts), th = D.integrarFFT(x, fs, fp / 5);
  const thInt = [];
  for (let c = 0; c + 1 < cruces.length; c++) { let mx = -Infinity, mn = Infinity; for (let i = cruces[c].i; i < cruces[c + 1].i; i++) { mx = Math.max(mx, th[i]); mn = Math.min(mn, th[i]); } thInt.push((mx - mn) / 2); }
  const q = Math.floor(thInt.length / 4), thIntMed = D.mediana(thInt.slice(q, thInt.length - q).length ? thInt.slice(q, thInt.length - q) : thInt);
  const th0 = mp(ths), serie = 1 + th0 ** 2 / 16 + 11 * th0 ** 4 / 3072 + 173 * th0 ** 6 / 737280;
  return { n, T: mp(Ts), sT: se(Ts), th0, sth0: se(ths), thInt: thIntMed, g: mp(gs), sg: se(gs), g0: mp(g0s), sg0: se(g0s),
    gSerie: mp(g0s) * serie * serie, ciclos, theta: th, sesgo: m };
};

/* ===================================================================== Allan */
/** Desviación de Allan solapada. θ_k = Σ_{j<k} x_j/fs (integral); para τ = m/fs:
 *  σ²(τ) = Σ_k (θ_{k+2m} − 2θ_{k+m} + θ_k)² / (2τ²(N+1−2m)). τ en malla logarítmica.
 *  err ≈ σ/√(2(N/m − 1)) (aprox. para ruido blanco). */
D.allan = function (x, fs, op = {}) {
  const N = x.length, th = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) th[i + 1] = th[i] + x[i] / fs;
  const mmax = Math.floor((N - 1) / 2 * (op.fraccionMax ?? 0.5)), ppd = op.puntosPorDecada || 10, ms = [];
  for (let e = 0; ; e++) { const m = Math.round(Math.pow(10, e / ppd)); if (m > mmax) break; if (!ms.length || m > ms[ms.length - 1]) ms.push(m); }
  const tau = [], adev = [], err = [];
  for (const m of ms) {
    let s = 0; const nt = N + 1 - 2 * m; for (let k = 0; k < nt; k++) { const d = th[k + 2 * m] - 2 * th[k + m] + th[k]; s += d * d; }
    const ta = m / fs, av = s / (2 * ta * ta * nt); tau.push(ta); adev.push(Math.sqrt(av)); err.push(Math.sqrt(av) / Math.sqrt(2 * (N / m - 1)));
  }
  return { tau, adev, err };
};
/** Pendiente de log σ contra log τ en [tmin, tmax]. */
D.pendienteLogLog = function (tau, y, tmin, tmax) {
  const X = [], Y = []; for (let i = 0; i < tau.length; i++) if (tau[i] >= tmin && tau[i] <= tmax && y[i] > 0) { X.push(Math.log10(tau[i])); Y.push(Math.log10(y[i])); }
  if (X.length < 3) return null; const r = D.ajusteLineal(X, Y); return { pendiente: r.b, sp: r.sb, n: X.length };
};
/** Lee los coeficientes de ruido de una curva de Allan:
 *  N (paseo aleatorio angular/de velocidad, pendiente −1/2): σ(τ)·√τ promediado donde la pendiente local está cerca de −1/2, leído en τ = 1 s;
 *  B (inestabilidad de bias): mínimo de σ / 0,664; K (paseo aleatorio de la tasa, +1/2): σ(τ)·√(3/τ) en esa zona. */
D.coefAllan = function (al) {
  const { tau, adev } = al, n = tau.length; if (n < 3) return null;
  let imin = 0; for (let i = 1; i < n; i++) if (adev[i] < adev[imin]) imin = i;
  const loc = i => Math.log(adev[Math.min(n - 1, i + 1)] / adev[Math.max(0, i - 1)]) / Math.log(tau[Math.min(n - 1, i + 1)] / tau[Math.max(0, i - 1)]);
  const zn = [], zk = [];
  for (let i = 0; i < n; i++) { const s = loc(i); if (i <= imin && s < -0.35 && s > -0.65) zn.push(Math.log(adev[i]) + 0.5 * Math.log(tau[i])); if (i >= imin && s > 0.35 && s < 0.65) zk.push(Math.log(adev[i]) - 0.5 * Math.log(tau[i])); }
  if (!zn.length) zn.push(Math.log(adev[0]) + 0.5 * Math.log(tau[0]));
  return { N: Math.exp(D.media(zn)), B: adev[imin] / 0.664, tauB: tau[imin], K: zk.length ? Math.exp(D.media(zk)) * Math.sqrt(3) : NaN, minimoEnBorde: imin === n - 1 };
};

/** Histograma de v con nb clases entre min y max. */
D.histograma = function (v, nb = 30, min, max) {
  if (min === undefined) { min = Infinity; max = -Infinity; for (const x of v) { if (x < min) min = x; if (x > max) max = x; } }
  if (max <= min) max = min + 1e-12;
  const c = new Float64Array(nb), w = (max - min) / nb; for (const x of v) { const k = Math.min(nb - 1, Math.max(0, Math.floor((x - min) / w))); c[k]++; }
  return { min, max, ancho: w, cuentas: c };
};

/** Calibración del acelerómetro por 6 posiciones. med = {xp, xn, yp, yn, zp, zn}: vector medio [ax,ay,az]
 *  con el eje indicado hacia arriba (+) o abajo (−). Por eje: ganancia = (m₊ − m₋)/(2g), offset = (m₊ + m₋)/2.
 *  Corrección: a = (m − offset)/ganancia. Residuo: | |a_cal| − g | en cada posición. */
D.calibrar6 = function (med, g) {
  const ejes = ['x', 'y', 'z'], ganancia = [], offset = [];
  ejes.forEach((e, k) => { const p = med[e + 'p'][k], q = med[e + 'n'][k]; ganancia.push((p - q) / (2 * g)); offset.push((p + q) / 2); });
  const residuos = {};
  for (const clave of Object.keys(med)) { const v = med[clave].map((m, k) => (m - offset[k]) / ganancia[k]); residuos[clave] = Math.hypot(...v) - g; }
  return { ganancia, offset, residuos, g };
};

/* ===================================================================== filtros Butterworth */
/** Secciones de segundo orden (biquads) de un Butterworth digital por transformación bilineal con
 *  pre-distorsión: |H|² = 1/(1 + (tan(πf/fs)/tan(πfc/fs))^{2n}) para el paso bajo. tipo 'bajo' | 'alto'. */
D.butter = function (orden, fc, fs, tipo = 'bajo') {
  const K = Math.tan(Math.PI * Math.min(fc, 0.4999 * fs) / fs), sos = [];
  for (let k = 1; k <= Math.floor(orden / 2); k++) {
    const Q = 1 / (2 * Math.sin((2 * k - 1) * Math.PI / (2 * orden))), nrm = 1 / (1 + K / Q + K * K);
    const a1 = 2 * (K * K - 1) * nrm, a2 = (1 - K / Q + K * K) * nrm;
    if (tipo === 'bajo') { const b0 = K * K * nrm; sos.push({ b0, b1: 2 * b0, b2: b0, a1, a2 }); }
    else { sos.push({ b0: nrm, b1: -2 * nrm, b2: nrm, a1, a2 }); }
  }
  if (orden % 2) {
    const nrm = 1 / (1 + K), a1 = (K - 1) * nrm;
    sos.push(tipo === 'bajo' ? { b0: K * nrm, b1: K * nrm, b2: 0, a1, a2: 0 } : { b0: nrm, b1: -nrm, b2: 0, a1, a2: 0 });
  }
  return sos;
};
/** Frecuencia de diseño para que el filtro aplicado ida y vuelta (|H|² total) tenga −3 dB exactamente en fc:
 *  tan(πf'/fs) = tan(πfc/fs)·r con r = (√2−1)^{∓1/(2n)} (− paso bajo, + paso alto). */
D.corteIdaVuelta = function (fc, orden, fs, tipo) {
  const r = Math.pow(Math.SQRT2 - 1, (tipo === 'bajo' ? -1 : 1) / (2 * orden));
  return Math.atan(Math.tan(Math.PI * fc / fs) * r) * fs / Math.PI;
};
/** Aplica una cascada de biquads (forma directa II transpuesta). */
D.sosFiltrar = function (sos, x) {
  let y = Float64Array.from(x);
  for (const s of sos) {
    let z1 = 0, z2 = 0;
    for (let i = 0; i < y.length; i++) { const v = y[i], o = s.b0 * v + z1; z1 = s.b1 * v - s.a1 * o + z2; z2 = s.b2 * v - s.a2 * o; y[i] = o; }
  }
  return y;
};
/** Filtrado de fase cero: ida y vuelta con extensión impar en los bordes (pad muestras) para reducir transitorios. */
D.filtfilt = function (sos, x, pad) {
  const N = x.length; pad = Math.min(N - 1, pad ?? 3 * 2 * sos.length + 1);
  const ext = new Float64Array(N + 2 * pad);
  for (let i = 0; i < pad; i++) { ext[i] = 2 * x[0] - x[pad - i]; ext[N + pad + i] = 2 * x[N - 1] - x[N - 2 - i]; }
  ext.set(x, pad);
  let y = D.sosFiltrar(sos, ext); y.reverse(); y = D.sosFiltrar(sos, y); y.reverse();
  return y.slice(pad, pad + N);
};
/** |H(f)| de una cascada de biquads. */
D.respuestaSOS = function (sos, f, fs) {
  const w = PI2 * f / fs, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w); let H = 1;
  for (const s of sos) {
    const nr = s.b0 + s.b1 * c1 + s.b2 * c2, ni = -(s.b1 * s1 + s.b2 * s2), dr = 1 + s.a1 * c1 + s.a2 * c2, di = -(s.a1 * s1 + s.a2 * s2);
    H *= Math.hypot(nr, ni) / Math.hypot(dr, di);
  }
  return H;
};
/** Filtro de conveniencia. op: {tipo:'bajo'|'alto'|'banda', f1, f2, orden (4), faseCero (true)}.
 *  Banda = paso alto en f1 seguido de paso bajo en f2. Con fase cero se corrige el corte (−3 dB en el valor pedido). */
D.filtrar = function (x, fs, op) {
  const n = op.orden || 4, fz = op.faseCero !== false;
  const diseño = (fc, tipo) => D.butter(n, fz ? D.corteIdaVuelta(fc, n, fs, tipo) : fc, fs, tipo);
  let sos = [];
  if (op.tipo === 'bajo') sos = diseño(op.f2 ?? op.f1, 'bajo');
  else if (op.tipo === 'alto') sos = diseño(op.f1, 'alto');
  else if (op.tipo === 'banda') sos = diseño(op.f1, 'alto').concat(diseño(op.f2, 'bajo'));
  else return Float64Array.from(x);
  const fmin = Math.min(op.f1 || Infinity, op.f2 || Infinity), pad = Math.min(x.length - 1, Math.ceil(3 * fs / fmin));
  return fz ? D.filtfilt(sos, x, pad) : D.sosFiltrar(sos, x);
};

/* ===================================================================== ISO 2631-1 */
/** Parámetros de las ponderaciones de frecuencia de ISO 2631-1:1997, anexo A (tabla A.2).
 *  Wk: vertical (z) en salud/confort/percepción; Wd: horizontal (x, y). */
D.ISO2631 = {
  Wk: { f1: 0.4, f2: 100, f3: 12.5, f4: 12.5, Q4: 0.63, f5: 2.37, Q5: 0.91, f6: 3.35, Q6: 0.91 },
  Wd: { f1: 0.4, f2: 100, f3: 2.0, f4: 2.0, Q4: 0.63 }
};
/** Función de transferencia compleja H(j2πf) = Hh·Hl·Ht·Hs:
 *  Hh = s²/(s² + ω₁s/Q₁ + ω₁²), Hl = ω₂²/(s² + ω₂s/Q₁ + ω₂²), Q₁ = 1/√2 (limitación de banda),
 *  Ht = (1 + s/ω₃)/(1 + s/(Q₄ω₄) + s²/ω₄²) (transición aceleración–velocidad),
 *  Hs = (s² + ω₅s/Q₅ + ω₅²)/(s² + ω₆s/Q₆ + ω₆²) (escalón ascendente; solo Wk). */
D.ponderacion = function (f, tipo = 'Wk') {
  const p = D.ISO2631[tipo], s = { re: 0, im: PI2 * f }, w = v => PI2 * v;
  const mul = (a, b) => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
  const div = (a, b) => { const d = b.re * b.re + b.im * b.im; return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d }; };
  const s2 = mul(s, s), Q1 = Math.SQRT1_2;
  const cuad = (wi, Q) => ({ re: s2.re + wi * wi, im: s2.im + s.im * wi / Q }); // s² + ωs/Q + ω²
  let H = div(s2, cuad(w(p.f1), Q1));
  H = mul(H, div({ re: w(p.f2) ** 2, im: 0 }, cuad(w(p.f2), Q1)));
  const w3 = w(p.f3), w4 = w(p.f4);
  H = mul(H, div({ re: 1, im: s.im / w3 }, { re: 1 + s2.re / (w4 * w4), im: s.im / (p.Q4 * w4) }));
  if (p.f5) H = mul(H, div(cuad(w(p.f5), p.Q5), cuad(w(p.f6), p.Q6)));
  return { re: H.re, im: H.im, mag: Math.hypot(H.re, H.im) };
};
/** Aplica la ponderación a una señal (dominio de la frecuencia, con relleno de ceros para evitar el solape circular). */
D.ponderarSenal = function (x, fs, tipo) {
  const N = x.length, M = D.siguientePot2(2 * N), re = new Float64Array(M), im = new Float64Array(M), m = D.media(x);
  for (let i = 0; i < N; i++) re[i] = x[i] - m;
  D.fft(re, im);
  for (let k = 0; k < M; k++) {
    const kk = k <= M / 2 ? k : k - M, H = D.ponderacion(Math.abs(kk) * fs / M, tipo), hi = kk < 0 ? -H.im : H.im;
    const r = re[k], s = im[k]; re[k] = r * H.re - s * hi; im[k] = r * hi + s * H.re;
  }
  D.fft(re, im, true); return re.slice(0, N);
};
/** Valores de ISO 2631-1 para una señal de aceleración (m/s²): a_w (RMS ponderado), VDV = (∫a_w⁴dt)^¼ (m/s^1,75),
 *  MTVV (máximo del RMS móvil de 1 s), factor de cresta (pico/a_w; si > 9 la norma pide usar VDV). */
D.confortISO2631 = function (x, fs, tipo) {
  const aw = D.ponderarSenal(x, fs, tipo), N = aw.length; let s2 = 0, s4 = 0, pk = 0;
  for (let i = 0; i < N; i++) { const v = aw[i] * aw[i]; s2 += v; s4 += v * v; pk = Math.max(pk, Math.abs(aw[i])); }
  const rms = Math.sqrt(s2 / N), vdv = Math.pow(s4 / fs, 0.25), L = Math.max(1, Math.round(fs)); let mtvv = 0, acc = 0;
  for (let i = 0; i < N; i++) { acc += aw[i] * aw[i]; if (i >= L) acc -= aw[i - L] * aw[i - L]; if (i >= L - 1) mtvv = Math.max(mtvv, Math.sqrt(acc / L)); }
  return { aw: rms, vdv, mtvv, pico: pk, cresta: pk / rms, duracion: N / fs, senal: aw };
};
/** Reacciones de confort orientativas de ISO 2631-1 (anexo C.2.3), a_w en m/s². Los rangos se solapan en la norma. */
D.TABLA_CONFORT = [
  [0, 0.315, 'No incómodo'], [0.315, 0.63, 'Un poco incómodo'], [0.5, 1.0, 'Bastante incómodo'],
  [0.8, 1.6, 'Incómodo'], [1.25, 2.5, 'Muy incómodo'], [2.0, Infinity, 'Extremadamente incómodo']];
D.reaccionConfort = aw => D.TABLA_CONFORT.filter(r => aw >= r[0] && aw < r[1]).map(r => r[2]).join(' / ');

/* ===================================================================== máquinas */
/** Zonas orientativas de ISO 20816-3 (antes 10816-3), velocidad RMS en mm/s, 10–1000 Hz:
 *  límites A/B, B/C, C/D para máquinas medianas (grupo 2, 15–300 kW) y grandes (grupo 1). */
D.ZONAS_20816 = {
  'g2-rigida': { nombre: 'Grupo 2 (15–300 kW), base rígida', lim: [1.4, 2.8, 4.5] },
  'g2-flexible': { nombre: 'Grupo 2 (15–300 kW), base flexible', lim: [2.3, 4.5, 7.1] },
  'g1-rigida': { nombre: 'Grupo 1 (> 300 kW), base rígida', lim: [2.3, 4.5, 7.1] },
  'g1-flexible': { nombre: 'Grupo 1 (> 300 kW), base flexible', lim: [3.5, 7.1, 11.0] }
};
D.zona20816 = (v, clase) => { const l = D.ZONAS_20816[clase].lim; return v < l[0] ? 'A' : v < l[1] ? 'B' : v < l[2] ? 'C' : 'D'; };

/** Fundamental y armónicos de una máquina. esp: Welch de aceleración. Si se da f1 (rpm/60) se afina cerca;
 *  si no, se toma el pico de velocidad más alto (> fmin) y se prueba si f/2 o f/3 explican mejor la familia.
 *  Amplitudes en aceleración y velocidad (RMS = pico/√2) por armónico k·f1, con afinado DTFT.
 *  σ(f₁) = máx(σ de tono, dispersión entre cuartos del registro / 2). */
D.armonicos = function (x, fs, esp, op = {}) {
  const fmin = op.fmin ?? 2, ny = fs / 2, vel = D.integrarEspectro(esp, 1, fmin), df = esp.df;
  const ampEn = (f, ancho = 1.5 * df) => { let best = 0; for (let i = 0; i < esp.f.length; i++) if (Math.abs(esp.f[i] - f) <= ancho && esp.amp[i] > best) best = esp.amp[i]; return best; };
  let f1 = op.f1, fuente = 'rpm';
  if (!f1) {
    fuente = 'auto';
    const pk = D.buscarPicos(vel.f, vel.amp, { n: 6, fmin, fmax: 0.97 * ny, promDb: 8 });
    if (!pk.length) return null;
    f1 = pk[0].f;
    const piso = D.mediana(esp.amp);
    for (const d of [3, 2]) { // ¿hay una subarmónica real (pico propio) que explique la familia?
      const fs_ = pk[0].f / d; if (fs_ < fmin) continue;
      const p = pk.find(q => Math.abs(q.f - fs_) < 2 * df);
      if (p && ampEn(fs_) > 4 * piso) { f1 = p.f; break; }
    }
  }
  const pisoPSD = D.pisoLocal(esp.psd, Math.round(f1 / df), 30, 4);
  const af = D.afinarTono(x, fs, f1, { ancho: 1.5 * df, ruidoPSD: pisoPSD }); f1 = af.f;
  // estabilidad de la velocidad: f₁ en cada cuarto del registro (la σ de tono no ve fluctuaciones de velocidad)
  const q = Math.floor(x.length / 4), fq = [];
  if (q > 64) for (let k = 0; k < 4; k++) fq.push(D.afinarTono(x.subarray ? x.subarray(k * q, (k + 1) * q) : x.slice(k * q, (k + 1) * q), fs, f1, { ancho: 4 * fs / q }).f);
  const dispersion = fq.length ? D.desv(fq) : NaN, sf1 = Math.max(af.sf || 0, isFinite(dispersion) ? dispersion / 2 : 0);
  const lista = []; const kmax = Math.min(op.nmax || 10, Math.floor(0.98 * ny / f1));
  for (let k = 1; k <= kmax; k++) {
    const fk = k * f1, aa = k === 1 ? af.A : D.afinarTono(x, fs, fk, { ancho: Math.min(1.5 * df, 0.2 * f1) }).A;
    lista.push({ k, f: fk, ampAcc: aa, velRMS: aa / (PI2 * fk) / Math.SQRT2 });
  }
  return { f1, sf1, sf1Tono: af.sf, dispersion, rpm: 60 * f1, fuente, lista, kmax, nyquist: ny, piso: pisoPSD };
};
/** Diagnóstico orientativo (reglas clásicas, lenguaje prudente) a partir de la lista de armónicos. */
D.diagnosticoMaquina = function (arm) {
  const out = []; if (!arm || !arm.lista.length) return out;
  const v = arm.lista.map(a => a.velRMS), v1 = v[0], tot = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  const v2 = v[1] ?? NaN, n10 = v.slice(1).filter(x => x > 0.1 * v1).length;
  if (v1 / tot > 0.85 && !(v2 > 0.5 * v1)) out.push(['1× dominante', 'Patrón compatible con desbalance (también con excentricidad o con una resonancia cerca de la velocidad de giro). Confirmar midiendo en dirección radial horizontal y vertical.']);
  if (v2 > 0.5 * v1) out.push(['2× alto', 'El 2× supera la mitad del 1×: patrón compatible con desalineación (o con holgura). Conviene comparar con una medición axial.']);
  if (n10 >= 3) out.push(['Muchos armónicos', `${n10} armónicos superan el 10 % del 1×: patrón compatible con holgura mecánica o roce.`]);
  if (!out.length) out.push(['Sin patrón claro', 'Ningún criterio simple destaca. Guarde una referencia y compare en el tiempo: los cambios suelen decir más que el valor absoluto.']);
  if (arm.kmax < 3) out.push(['Pocos armónicos visibles', `Con la frecuencia de muestreo actual solo se ven ${arm.kmax} armónico(s) por debajo de Nyquist (${arm.nyquist.toFixed(1)} Hz); el diagnóstico queda muy limitado.`]);
  return out;
};
/** Niveles en dB (re 1 u²) por bandas logarítmicas entre fmin y fmax: 10·log10(Σ PSD·Δf). */
D.bandasLog = function (esp, fmin, fmax, nb) {
  const lim = [], centros = [], dB = [];
  for (let k = 0; k <= nb; k++) lim.push(fmin * Math.pow(fmax / fmin, k / nb));
  for (let k = 0; k < nb; k++) {
    let s = 0; for (let i = 0; i < esp.f.length; i++) if (esp.f[i] >= lim[k] && esp.f[i] < lim[k + 1]) s += esp.psd[i];
    centros.push(Math.sqrt(lim[k] * lim[k + 1])); dB.push(10 * Math.log10(s * esp.df + 1e-30));
  }
  return { lim, centros, dB };
};

/* ===================================================================== estructuras */
/** Modos de una PSD promediada: picos de la PSD, ancho de media potencia (ζ) y una incertidumbre aproximada
 *  de la frecuencia de un modo con excitación aleatoria: σ_f ≈ √(ζ·f/(π·T)) (T = duración), o la del afinado de tono
 *  si el pico es más angosto que la resolución (cota superior con ζ ≤ ancho de resolución). */
D.modos = function (x, fs, esp, op = {}) {
  const T = x.length / fs, picos = D.buscarPicos(esp.f, esp.psd, { n: op.n || 6, fmin: op.fmin ?? 0.3, fmax: op.fmax, promDb: op.promDb ?? 6, potencia: true, sepBins: 4 });
  return picos.map(p => {
    const hp = D.medioPotencia(esp.f, esp.psd, p.i), limitado = !hp || hp.ancho < 2 * esp.enbw;
    let sf;
    if (hp && !limitado) sf = Math.sqrt(hp.zeta * p.f / (Math.PI * T));
    else { // pico no resuelto: cota con ζ ≤ (ancho medido o 2·ENBW)/(2f); se toma la mayor entre ésta y la de tono
      const zub = Math.max(hp ? hp.ancho : 0, 2 * esp.enbw) / (2 * p.f);
      sf = Math.max(Math.sqrt(zub * p.f / (Math.PI * T)), D.afinarTono(x, fs, p.f, { ancho: esp.df, ruidoPSD: p.piso }).sf || 0);
    }
    return { f: p.f, sf, psd: p.y, promDb: p.promDb, zeta: hp && !limitado ? hp.zeta : NaN, ancho: hp ? hp.ancho : NaN, limitado };
  }).sort((a, b) => a.f - b.f);
};

raiz.DSP = D;
})(typeof self !== 'undefined' ? self : this);
