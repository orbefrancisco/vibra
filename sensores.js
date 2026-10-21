/* sensores.js — Captura de los sensores de movimiento del teléfono y fuente DEMO sintética.
 *
 * Orden de preferencia: Generic Sensor API (Accelerometer, LinearAccelerationSensor, Gyroscope, Magnetometer),
 * pidiendo la frecuencia indicada y midiendo la que realmente llega; si no hay lecturas, DeviceMotionEvent.
 * Cada muestra se guarda con su marca de tiempo (sensor.timestamp o event.timeStamp, en ms del reloj de la página),
 * convertida a segundos. El remuestreo a malla uniforme se hace después, en el análisis (DSP.remuestrear).
 *
 * Flujos: acc (aceleración con gravedad, m/s²), lin (sin gravedad, m/s²), gyr (velocidad angular, rad/s),
 * mag (campo magnético, µT). Ejes del teléfono: x a la derecha, y hacia arriba de la pantalla, z saliendo de la pantalla.
 */
(function (raiz) {
'use strict';
const S = {};
const D = raiz.DSP;
const GRAD = Math.PI / 180;
S.FLUJOS = {
  acc: { nombre: 'Acelerómetro (con gravedad)', corto: 'Acel.', unidad: 'm/s²' },
  lin: { nombre: 'Aceleración lineal (sin gravedad)', corto: 'Lineal', unidad: 'm/s²' },
  gyr: { nombre: 'Giroscopio', corto: 'Giro', unidad: 'rad/s' },
  mag: { nombre: 'Magnetómetro', corto: 'Mag.', unidad: 'µT' }
};

/** Búfer circular de muestras (t, x, y, z). */
class Anillo {
  constructor(cap) { this.cap = cap; this.t = new Float64Array(cap); this.x = new Float64Array(cap); this.y = new Float64Array(cap); this.z = new Float64Array(cap); this.n = 0; }
  push(t, x, y, z) { const i = this.n % this.cap; this.t[i] = t; this.x[i] = x; this.y[i] = y; this.z[i] = z; this.n++; }
  get largo() { return Math.min(this.n, this.cap); }
  get ultimoT() { return this.n ? this.t[(this.n - 1) % this.cap] : NaN; }
  /** Copia de las muestras con t ≥ desde (s). */
  desde(desde) {
    const L = this.largo; let k = 0;
    while (k < L && this.t[(this.n - 1 - k) % this.cap] >= desde) k++;
    const o = { t: new Float64Array(k), x: new Float64Array(k), y: new Float64Array(k), z: new Float64Array(k) };
    for (let j = 0; j < k; j++) { const i = (this.n - k + j) % this.cap; o.t[j] = this.t[i]; o.x[j] = this.x[i]; o.y[j] = this.y[i]; o.z[j] = this.z[i]; }
    return o;
  }
  ultimos(seg) { return this.desde(this.ultimoT - seg); }
}
/** Lista creciente de muestras para grabar. */
class Lista {
  constructor() { this.cap = 4096; this.n = 0; this.t = new Float64Array(this.cap); this.x = new Float64Array(this.cap); this.y = new Float64Array(this.cap); this.z = new Float64Array(this.cap); }
  push(t, x, y, z) {
    if (this.n === this.cap) { this.cap *= 2; for (const k of ['t', 'x', 'y', 'z']) { const a = new Float64Array(this.cap); a.set(this[k]); this[k] = a; } }
    this.t[this.n] = t; this.x[this.n] = x; this.y[this.n] = y; this.z[this.n] = z; this.n++;
  }
  datos(t0) { const o = {}; for (const k of ['t', 'x', 'y', 'z']) o[k] = this[k].slice(0, this.n); if (t0 !== undefined) for (let i = 0; i < this.n; i++) o.t[i] -= t0; return o; }
}

/* ================================================================== generadores DEMO */
/** Modelo de sensor común a los generadores: ganancia/offset del acelerómetro, sesgo del giroscopio y ruido blanco
 *  con densidad realista (acelerómetro ≈ 200 µg/√Hz, giroscopio ≈ 0,7 (°/s)/√h). */
const MODELO = { gan: [1.008, 0.994, 1.012], off: [0.06, -0.04, 0.12], sesgoG: [0.004, -0.0025, 0.003], densA: 0.002, densG: 2e-4, g: 9.78 };

S.DEMOS = {
  amortiguado: { nombre: 'Resorte (oscilador amortiguado)', desc: 'Masa en un resorte vertical soltada cada 15 s: f ≈ 1,85 Hz, τ ≈ 3,5 s.' },
  pendulo: { nombre: 'Péndulo de gran amplitud', desc: 'Teléfono colgado de un hilo de 0,75 m soltado desde 50°, gira alrededor del eje x.' },
  maquina: { nombre: 'Máquina (desbalance)', desc: 'Motor a 888 rpm (14,8 Hz) con 1×, 2×, 3×, 4× y ruido.' },
  'maquina-falla': { nombre: 'Máquina (2× alto, holgura)', desc: 'El mismo motor con 2× elevado y más armónicos: compárelo con la referencia.' },
  estructura: { nombre: 'Losa / pasarela', desc: 'Dos modos (2,85 Hz y 7,4 Hz) excitados por ruido ambiental y pasos ocasionales.' },
  reposo: { nombre: 'Sensor en reposo', desc: 'Ruido blanco + paseo aleatorio + inestabilidad del sesgo, con errores de calibración.' }
};

/** Crea un generador sintético. en(t) devuelve {acc, lin, gyr, mag} para tiempos crecientes t (s). */
S.crearGenerador = function (tipo, fs, semilla = 12345) {
  const r = D.rng(semilla), nrm = () => D.normal(r), M = MODELO;
  const sA = M.densA * Math.sqrt(fs / 2), sG = M.densG * Math.sqrt(fs / 2);
  const gen = { tipo, fs, orientacion: [0, 0, 1], tAnt: 0 };
  // procesos lentos (reposo): paseo aleatorio del sesgo y Gauss–Markov de varias escalas (≈ inestabilidad de sesgo)
  const gm = [[5, 0, 0, 0], [60, 0, 0, 0], [600, 0, 0, 0]].map(v => ({ tau: v[0], s: [0, 0, 0] }));
  const paseoA = [0, 0, 0], paseoG = [0, 0, 0];
  let senal = () => ({ a: [0, 0, 0], w: [0, 0, 0], quieto: true });

  if (tipo === 'amortiguado') {
    const f = 1.85, tau = 3.5, A = 4, Tr = 15;
    senal = t => { const u = t - 1; if (u < 0) return { a: [0, 0, 0], w: [0, 0, 0] }; const s = u % Tr, e = A * Math.exp(-s / tau), c = Math.cos(2 * Math.PI * f * s);
      return { a: [0.04 * e * Math.sin(2 * Math.PI * f * s), 0.03 * e * c, e * c], w: [0.012 * e * Math.sin(2 * Math.PI * f * s), 0, 0] }; };
  } else if (tipo === 'pendulo') {
    const L = 0.75, g = M.g, beta = 1 / 160, dt = 1e-3, Tr = 60; let th = 50 * GRAD, om = 0, tp = 0, ciclo = 0;
    const der = (a, b) => [b, -(g / L) * Math.sin(a) - 2 * beta * b];
    senal = t => {
      const c = Math.floor(t / Tr); if (c !== ciclo) { ciclo = c; th = 50 * GRAD; om = 0; tp = c * Tr; }
      while (tp + dt <= t) {
        const k1 = der(th, om), k2 = der(th + dt / 2 * k1[0], om + dt / 2 * k1[1]), k3 = der(th + dt / 2 * k2[0], om + dt / 2 * k2[1]), k4 = der(th + dt * k3[0], om + dt * k3[1]);
        th += dt / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]); om += dt / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]); tp += dt;
      }
      // fuerza específica en el marco del teléfono (z hacia el punto de suspensión): radial Lω² + g cosθ, tangencial ≈ 0
      return { a: [0, -2 * beta * L * om, L * om * om], grav: [0, 0, g * Math.cos(th)], lin: [0, -g * Math.sin(th) - 2 * beta * L * om, L * om * om], w: [om, 0, 0], th };
    };
  } else if (tipo === 'maquina' || tipo === 'maquina-falla') {
    const falla = tipo === 'maquina-falla', amps = falla ? [0.9, 2.2, 0.6, 0.5, 0.35, 0.25] : [0.9, 0.35, 0.15, 0.06], fases = amps.map(() => 6.283 * r());
    let fase = 0, tA = 0, deriva = 0;
    senal = t => {
      deriva += 0.002 * nrm(); deriva *= 0.999; const f1 = 14.8 + 0.03 * Math.sin(2 * Math.PI * t / 23) + 0.01 * deriva;
      fase += 2 * Math.PI * f1 * (t - tA); tA = t; let s = 0;
      amps.forEach((A, k) => { s += A * Math.cos((k + 1) * fase + fases[k]); });
      const imp = falla ? 0.25 * Math.pow(Math.max(0, Math.cos(fase)), 30) : 0;
      return { a: [s + imp, 0.6 * s + 0.05 * nrm(), 0.3 * s + 0.04 * nrm()], w: [0.002 * s, 0.001 * s, 0] };
    };
  } else if (tipo === 'estructura') {
    const modos = [{ f: 2.85, z: 0.015, ej: [0.35, 0.25, 1], arms: 0.012 }, { f: 7.4, z: 0.02, ej: [0.05, 0.1, 1], arms: 0.006 }]
      .map(m => { const w = 2 * Math.PI * m.f, sx = m.arms / (w * w); return Object.assign(m, { w, q: sx * Math.sqrt(4 * m.z * w * w * w), x: 0, v: 0 }); });
    const dt = 1e-3; let tp = 0;
    senal = t => {
      while (tp + dt <= t) {
        const ep = (tp % 90) > 40 && (tp % 90) < 52, paso = ep ? 0.004 * Math.pow(Math.abs(Math.sin(Math.PI * 1.9 * tp)), 8) : 0; // alguien camina 12 s cada 90 s (1,9 pasos/s)
        for (const m of modos) { m.v += (-2 * m.z * m.w * m.v - m.w * m.w * m.x + paso) * dt + m.q * Math.sqrt(dt) * nrm(); m.x += m.v * dt; }
        tp += dt;
      }
      const a = [0, 0, 0]; for (const m of modos) { const ac = -2 * m.z * m.w * m.v - m.w * m.w * m.x; for (let k = 0; k < 3; k++) a[k] += m.ej[k] * ac; }
      return { a, w: [a[1] * 0.002, a[0] * 0.002, 0] };
    };
  }

  gen.en = function (t) {
    const dt = Math.max(0, t - gen.tAnt); gen.tAnt = t;
    for (const p of gm) for (let k = 0; k < 3; k++) { const e = Math.exp(-dt / p.tau); p.s[k] = p.s[k] * e + Math.sqrt(1 - e * e) * nrm(); }
    for (let k = 0; k < 3; k++) { paseoA[k] += 2e-4 * Math.sqrt(dt) * nrm(); paseoG[k] += 2e-5 * Math.sqrt(dt) * nrm(); }
    const s = senal(t), gv = s.grav || gen.orientacion.map(v => v * M.g);
    const acc = [], lin = [], gyr = [];
    for (let k = 0; k < 3; k++) {
      const inest = 0.0015 * (gm[0].s[k] + gm[1].s[k] + gm[2].s[k]) / 3, inestG = 0.0004 * (gm[0].s[(k + 1) % 3] + gm[1].s[(k + 1) % 3] + gm[2].s[(k + 1) % 3]) / 3;
      const ruidoA = sA * nrm();
      lin.push((s.lin || s.a)[k] + ruidoA + paseoA[k] + inest);
      acc.push(M.gan[k] * (s.a[k] + gv[k]) + M.off[k] + ruidoA + paseoA[k] + inest);
      gyr.push(s.w[k] + M.sesgoG[k] + sG * nrm() + paseoG[k] + inestG);
    }
    return { acc, lin, gyr, mag: [22 + 0.3 * nrm(), 5 + 0.3 * nrm(), -38 + 0.3 * nrm()] };
  };
  return gen;
};

/** Tiempos de muestreo sintéticos con jitter realista: periodo nominal 1/fs, jitter gaussiano del 3 %, y
 *  pérdidas ocasionales de una muestra (0,2 %). */
function* tiemposDemo(fs, r, t0 = 0) {
  for (let k = 0; ; k++) {
    if (r() < 0.002) continue;
    yield t0 + k / fs + 0.03 / fs * D.normal(r);
  }
}

/** Genera una grabación sintética completa (al instante) con el mismo formato que una real. */
S.grabacionSintetica = function (tipo, duracion, fs = 100, semilla = 7) {
  const gen = S.crearGenerador(tipo, fs, semilla), r = D.rng(semilla + 1), L = { acc: new Lista(), lin: new Lista(), gyr: new Lista() };
  let tAnt = -Infinity;
  for (const t of tiemposDemo(fs, r, 0)) {
    if (t > duracion) break; const tt = Math.max(t, tAnt + 1e-5); tAnt = tt;
    const m = gen.en(tt); for (const f of ['acc', 'lin', 'gyr']) L[f].push(tt, m[f][0], m[f][1], m[f][2]);
  }
  const flujos = {}; let t0 = Infinity; for (const f in L) t0 = Math.min(t0, L[f].t[0]); for (const f in L) flujos[f] = L[f].datos(t0);
  return { id: 'g' + Date.now().toString(36) + Math.floor(r() * 1e6).toString(36), nombre: 'DEMO · ' + S.DEMOS[tipo].nombre, fecha: new Date().toISOString(),
    fuente: 'demo:' + tipo, frecuenciaPedida: fs, duracion: flujos.acc.t[flujos.acc.t.length - 1], notas: S.DEMOS[tipo].desc, cal: null, flujos };
};

/* ================================================================== captura */
S.disponibles = function () {
  const w = raiz;
  return {
    generico: { acc: 'Accelerometer' in w, lin: 'LinearAccelerationSensor' in w, gyr: 'Gyroscope' in w, mag: 'Magnetometer' in w },
    devicemotion: 'DeviceMotionEvent' in w,
    pidePermiso: !!(w.DeviceMotionEvent && typeof w.DeviceMotionEvent.requestPermission === 'function'),
    seguro: !!w.isSecureContext
  };
};

class Captura {
  constructor() {
    this.anillos = {}; for (const f in S.FLUJOS) this.anillos[f] = new Anillo(1 << 16);
    this.fuente = null; this.grab = null; this.cal = null; this.alMuestra = null; this.errores = []; this._parar = []; this.generador = null; this.frecuenciaPedida = null;
  }
  get activa() { return !!this.fuente; }
  /** Inicia la captura. op: {fuente: 'auto'|'generico'|'devicemotion'|'demo', frecuencia, demo, demoFs, magnetometro}. */
  async iniciar(op = {}) {
    this.detener(); this.errores = []; for (const f in S.FLUJOS) this.anillos[f] = new Anillo(1 << 16);
    const fuente = op.fuente || 'auto'; this.frecuenciaPedida = op.frecuencia || 500;
    if (fuente === 'demo') return this._demo(op);
    if (fuente === 'auto' || fuente === 'generico') {
      try { await this._generico(op); return this.fuente; }
      catch (e) { this.errores.push('Sensor genérico: ' + e.message); this.detener(); if (fuente === 'generico') throw e; }
    }
    await this._devicemotion(op); return this.fuente;
  }
  detener() { for (const p of this._parar) { try { p(); } catch (e) { /* nada */ } } this._parar = []; this.fuente = null; this.generador = null; }

  _push(flujo, tms, x, y, z) {
    if (!(isFinite(x) && isFinite(y) && isFinite(z) && isFinite(tms) && tms !== null)) return;
    const t = tms / 1000, c = this.cal;
    if (c) {
      if (flujo === 'acc' && c.acc) { x = (x - c.acc.offset[0]) / c.acc.ganancia[0]; y = (y - c.acc.offset[1]) / c.acc.ganancia[1]; z = (z - c.acc.offset[2]) / c.acc.ganancia[2]; }
      else if (flujo === 'lin' && c.acc) { x /= c.acc.ganancia[0]; y /= c.acc.ganancia[1]; z /= c.acc.ganancia[2]; }
      else if (flujo === 'gyr' && c.gyr) { x -= c.gyr.sesgo[0]; y -= c.gyr.sesgo[1]; z -= c.gyr.sesgo[2]; }
    }
    const a = this.anillos[flujo]; if (a.n && t <= a.ultimoT) return; // descarta marcas repetidas o hacia atrás
    a.push(t, x, y, z);
    if (this.grab) this.grab.listas[flujo].push(t, x, y, z);
    if (this.alMuestra) this.alMuestra(flujo, t, x, y, z);
  }
  _esperarDatos(ms) {
    return new Promise((ok, mal) => { const t0 = performance.now(); const id = setInterval(() => {
      if (this.anillos.acc.n >= 3 || this.anillos.lin.n >= 3 || this.anillos.gyr.n >= 3) { clearInterval(id); ok(); }
      else if (performance.now() - t0 > ms) { clearInterval(id); mal(new Error('no llegaron lecturas en ' + (ms / 1000) + ' s')); }
    }, 50); });
  }
  async _generico(op) {
    const w = raiz; if (!('Accelerometer' in w)) throw new Error('no disponible en este navegador');
    if (navigator.permissions) for (const n of ['accelerometer', 'gyroscope', 'magnetometer']) { try { const p = await navigator.permissions.query({ name: n }); if (p.state === 'denied' && n === 'accelerometer') throw new Error('permiso denegado'); } catch (e) { if (e.message === 'permiso denegado') throw e; } }
    const crear = (nombreClase, flujo) => {
      if (!(nombreClase in w)) return;
      try {
        const s = new w[nombreClase]({ frequency: this.frecuenciaPedida, referenceFrame: 'device' });
        s.addEventListener('reading', () => this._push(flujo, s.timestamp, s.x, s.y, s.z));
        s.addEventListener('error', e => this.errores.push(`${nombreClase}: ${e.error && e.error.name} ${e.error && e.error.message}`));
        s.start(); this._parar.push(() => s.stop());
      } catch (e) { this.errores.push(`${nombreClase}: ${e.message}`); }
    };
    crear('Accelerometer', 'acc'); crear('LinearAccelerationSensor', 'lin'); crear('Gyroscope', 'gyr'); if (op.magnetometro) crear('Magnetometer', 'mag');
    this.fuente = 'generico'; await this._esperarDatos(2000);
  }
  async _devicemotion() {
    const w = raiz; if (!('DeviceMotionEvent' in w)) throw new Error('Este navegador no da acceso a los sensores de movimiento.');
    if (typeof w.DeviceMotionEvent.requestPermission === 'function') { const p = await w.DeviceMotionEvent.requestPermission(); if (p !== 'granted') throw new Error('Permiso de movimiento denegado.'); }
    const h = e => {
      const t = e.timeStamp, g = e.accelerationIncludingGravity, a = e.acceleration, r = e.rotationRate; this.intervaloDM = e.interval;
      if (g && g.x !== null) this._push('acc', t, g.x, g.y, g.z);
      if (a && a.x !== null) this._push('lin', t, a.x, a.y, a.z);
      if (r && r.alpha !== null) this._push('gyr', t, (r.beta || 0) * GRAD, (r.gamma || 0) * GRAD, (r.alpha || 0) * GRAD); // °/s → rad/s; α gira en z, β en x, γ en y
    };
    w.addEventListener('devicemotion', h); this._parar.push(() => w.removeEventListener('devicemotion', h));
    this.fuente = 'devicemotion';
    try { await this._esperarDatos(2000); } catch (e) { this.detener(); throw new Error('El navegador no entrega datos de movimiento (¿computadora sin sensores? Use el modo DEMO).'); }
  }
  _demo(op) {
    const fs = op.demoFs || 100, tipo = op.demo || 'amortiguado', r = D.rng(99);
    const gen = S.crearGenerador(tipo, fs, 4242); this.generador = gen;
    const t0 = performance.now() / 1000, tiempos = tiemposDemo(fs, r, t0); let prox = tiempos.next().value, tAnt = 0;
    const id = setInterval(() => {
      const ahora = performance.now() / 1000;
      while (prox <= ahora) {
        const tt = Math.max(prox, tAnt + 1e-5); tAnt = tt; const m = gen.en(tt - t0);
        for (const f of ['acc', 'lin', 'gyr']) this._push(f, tt * 1000, m[f][0], m[f][1], m[f][2]);
        if (op.magnetometro) this._push('mag', tt * 1000, m.mag[0], m.mag[1], m.mag[2]);
        prox = tiempos.next().value;
      }
    }, 20);
    this._parar.push(() => clearInterval(id)); this.fuente = 'demo'; this.demoTipo = tipo;
    return Promise.resolve('demo');
  }
  /** Copia de los últimos seg segundos de un flujo. */
  vivo(flujo, seg) { return this.anillos[flujo].ultimos(seg); }
  /** Comienza a grabar; pre = segundos de pre-disparo tomados del búfer circular. */
  empezarGrabacion(pre = 0) {
    const listas = {}; for (const f in S.FLUJOS) listas[f] = new Lista();
    if (pre > 0) for (const f in S.FLUJOS) { const a = this.anillos[f]; if (!a.n) continue; const d = a.desde(a.ultimoT - pre); for (let i = 0; i < d.t.length; i++) listas[f].push(d.t[i], d.x[i], d.y[i], d.z[i]); }
    this.grab = { listas, inicio: performance.now() / 1000 };
  }
  /** Termina la grabación y devuelve el objeto grabación (tiempos relativos a la primera muestra). */
  terminarGrabacion(meta = {}) {
    const g = this.grab; this.grab = null; if (!g) return null;
    let t0 = Infinity; for (const f in g.listas) if (g.listas[f].n) t0 = Math.min(t0, g.listas[f].t[0]);
    const flujos = {}; for (const f in g.listas) if (g.listas[f].n > 2) flujos[f] = g.listas[f].datos(t0);
    if (!flujos.acc && !flujos.lin && !flujos.gyr) return null;
    const base = flujos.acc || flujos.lin || flujos.gyr;
    return Object.assign({ id: 'g' + Date.now().toString(36), fecha: new Date().toISOString(), fuente: this.fuente === 'demo' ? 'demo:' + this.demoTipo : this.fuente,
      frecuenciaPedida: this.fuente === 'demo' ? this.generador.fs : this.frecuenciaPedida, duracion: base.t[base.t.length - 1], notas: '', cal: this.cal ? JSON.parse(JSON.stringify(this.cal)) : null, flujos }, meta);
  }
}
S.Captura = Captura;
raiz.Sensores = S;
})(typeof self !== 'undefined' ? self : this);
