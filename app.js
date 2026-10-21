/* app.js — Interfaz y estado de Vibra. Usa DSP (dsp.js), Sensores (sensores.js) y Grafica (grafica.js). */
'use strict';
const D = DSP, S = Sensores, G = Grafica;
const $ = id => document.getElementById(id);
const PARAM = new URLSearchParams(location.search);

/* ============================================================ formato */
const fmt = (v, d = 3) => (v === undefined || v === null || !isFinite(v)) ? '—' : v.toFixed(d).replace('.', ',').replace(/^-(0,0*)$/, '$1');
const SUPS = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
const fsig = (v, n = 4) => { if (!isFinite(v)) return '—'; if (v === 0) return '0'; const a = Math.abs(v); if (a >= 1e5 || a < 1e-3) { const [m, e] = v.toExponential(n - 1).split('e'); return m.replace('.', ',') + '·10' + String(+e).split('').map(c => SUPS[c]).join(''); } return fmt(v, Math.max(0, n - 1 - Math.floor(Math.log10(a)))); };
/** valor ± incertidumbre con 2 cifras significativas en σ. */
function conInc(v, s, u = '') {
  if (!isFinite(v)) return '—';
  if (!(s > 0) || !isFinite(s)) return fsig(v, 5) + (u ? ' ' + u : '');
  const d = Math.max(0, 1 - Math.floor(Math.log10(s)));
  return d > 9 ? `${v.toExponential(3)} ± ${s.toExponential(1)} ${u}` : `${fmt(v, d)} ± ${fmt(s, d)}${u ? ' ' + u : ''}`;
}
const num = (id, def) => { const v = parseFloat(String($(id).value).replace(',', '.')); return isFinite(v) ? v : def; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const COL = () => ({ x: css('--s1'), y: css('--s2'), z: css('--s3'), mag: css('--s4'), ajuste: css('--s5'), muted: css('--muted') });
const tabla = (cab, filas, marcar) => `<table><thead><tr>${cab.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${filas.map((f, i) => `<tr${marcar && marcar(i) ? ' class="marcada"' : ''}>${f.map((c, j) => `<td${j > 0 && /^[-−+]?[\d—]/.test(String(c)) ? ' class="n"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
const indic = arr => arr.map(([e, v, u]) => `<div><span>${e}</span><b>${v}</b>${u ? `<i>${u}</i>` : ''}</div>`).join('');
const NOMBRE_EJE = { x: 'x', y: 'y', z: 'z', mag: '|v|' };
const UNID = {
  acc: [{ u: 'm/s²', f: 1 }, { u: 'mm/s', f: 1e3 }, { u: 'µm', f: 1e6 }],
  lin: [{ u: 'm/s²', f: 1 }, { u: 'mm/s', f: 1e3 }, { u: 'µm', f: 1e6 }],
  gyr: [{ u: 'rad/s', f: 1 }, { u: 'mrad', f: 1e3 }, null],
  mag: [{ u: 'µT', f: 1 }, null, null]
};

/* ============================================================ estado y ajustes */
const E = {
  cap: new S.Captura(), lista: [], actual: null, sel: null, zoom: null, cal: null, ref: null, tab: 'medir',
  grabando: null, wake: null, ajuste: null, pendulo: null, calMed: {}, calRes: null, sinBD: false,
  efimero: PARAM.has('demo') // modo de prueba por URL: no se toca IndexedDB
};
const PERSISTIR = ['fuente', 'freqPedida', 'demoTipo', 'demoFs', 'usarMag', 'vivoFlujo', 'vivoEje', 'durGrab', 'cuentaGrab', 'disparo', 'umbral', 'preDisparo',
  'demoInstTipo', 'demoInstDur', 'demoInstFs', 'aInterp', 'eMag', 'eTipo', 'eEscala', 'eVent', 'eSeg', 'eFhp', 'eInterp', 'sgSeg', 'sgRango', 'pL',
  'mEje', 'mFmin', 'mClase', 'sDf', 'sFmax', 'sFlujo', 'sPar', 'sVert', 'alFlujo', 'gLocal', 'cFlujo', 'cEje'];
function leerLS(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
function guardarLS(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sin almacenamiento */ } }
function guardarConfig() { const c = {}; for (const id of PERSISTIR) { const el = $(id); if (el) c[id] = el.type === 'checkbox' ? el.checked : el.value; } guardarLS('vibra-config', c); }
// Ajustes guardados (el origen se comparte con otras apps): casillas solo booleanas, listas solo con una opción que exista,
// campos numéricos solo con cifras, signo, coma/punto o exponente. Lo demás se ignora.
function cargarConfig() {
  const c = leerLS('vibra-config', {}); if (!c || typeof c !== 'object' || Array.isArray(c)) return;
  for (const id of PERSISTIR) {
    const el = $(id), v = Object.prototype.hasOwnProperty.call(c, id) ? c[id] : undefined; if (!el || v === undefined) continue;
    if (el.type === 'checkbox') { if (typeof v === 'boolean') el.checked = v; }
    else if (typeof v !== 'string' || v.length > 40) continue;
    else if (el.tagName === 'SELECT') { if ([...el.options].some(o => o.value === v)) el.value = v; }
    else if (/^[\d\s.,+\-eE]{0,20}$/.test(v)) el.value = v;
  }
}

/* ============================================================ datos no confiables
   Todo lo que llega de localStorage, de IndexedDB o de un archivo importado se valida campo por campo antes de usarse:
   números finitos y en rango, textos cortos sin caracteres de control, fechas legibles, arreglos con tamaño máximo.
   Lo que no encaja se descarta y se cuenta (nunca se ejecuta nada). Además, al pintar, todo texto que no sea literal
   del código pasa por esc() o textContent. */
const LIM = { texto: 200, notas: 2000, muestras: 4e6, ref: 1e6, valor: 1e6, archivoMB: 256 };
const tiene = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const esNum = (v, lo = -Infinity, hi = Infinity) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const texto = (v, max = LIM.texto) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '';
const FECHA_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;   // ISO 8601 (Date.parse es demasiado permisivo)
const fechaOk = v => { if (!(typeof v === 'number' || (typeof v === 'string' && FECHA_RE.test(v)))) return null; const t = new Date(v).getTime(); return Number.isFinite(t) && t > Date.UTC(1990, 0, 1) && t < Date.UTC(2200, 0, 1) ? new Date(t).toISOString() : null; };
const ID_OK = /^[\w-]{1,64}$/;
const fuenteOk = f => typeof f === 'string' && f.length <= 40 && (['generico', 'devicemotion', 'importada'].includes(f) || (f.startsWith('demo:') && tiene(S.DEMOS, f.slice(5))));
const nuevoId = () => 'g' + Date.now().toString(36) + Math.floor(Math.random() * 1e5).toString(36);
const esArr = a => Array.isArray(a) || (ArrayBuffer.isView(a) && !(a instanceof DataView));
const vec3 = (a, lo, hi) => esArr(a) && a.length === 3 && Array.prototype.every.call(a, v => esNum(v, lo, hi)) ? Array.from(a) : null;
const contador = () => ({ grab: 0, flujos: 0, muestras: 0, campos: 0 });
const txtDescartes = c => { const p = []; if (c.grab) p.push(`${c.grab} ${c.grab > 1 ? 'grabaciones ilegibles' : 'grabación ilegible'}`); if (c.flujos) p.push(`${c.flujos} sensor${c.flujos > 1 ? 'es' : ''} desconocido${c.flujos > 1 ? 's' : ''} o sin datos válidos`);
  if (c.muestras) p.push(`${c.muestras} muestra${c.muestras > 1 ? 's' : ''} inválida${c.muestras > 1 ? 's' : ''} (no numéricas, fuera de rango o con el tiempo hacia atrás)`); if (c.campos) p.push(`${c.campos} campo${c.campos > 1 ? 's' : ''} inválido${c.campos > 1 ? 's' : ''}`);
  return p.length ? 'Descartado: ' + p.join('; ') + '.' : ''; };
/** Calibración: ganancias 0,2–5, offsets ±20 m/s², sesgo del giroscopio ±10 rad/s. */
function normCal(c, cnt) {
  if (c === null || c === undefined) return null;
  if (typeof c !== 'object') { if (cnt) cnt.campos++; return null; }
  const o = {};
  if (c.acc) { const g = vec3(c.acc.ganancia, 0.2, 5), of = vec3(c.acc.offset, -20, 20); if (g && of) { o.acc = { ganancia: g, offset: of, fecha: fechaOk(c.acc.fecha) || '' }; if (esNum(c.acc.g, 1, 20)) o.acc.g = c.acc.g; } else if (cnt) cnt.campos++; }
  if (c.gyr) { const s = vec3(c.gyr.sesgo, -10, 10); if (s) o.gyr = { sesgo: s, fecha: fechaOk(c.gyr.fecha) || '' }; else if (cnt) cnt.campos++; }
  return o.acc || o.gyr ? o : null;
}
/** Un flujo {t,x,y,z}: arreglos numéricos de igual largo (≤ LIM.muestras), valores finitos (|v| ≤ 1e6) y tiempo creciente.
 *  Las filas que no cumplen se descartan y se cuentan. Si todo está bien y ya son Float64Array, se usa tal cual (sin copiar). */
function normFlujo(d, cnt) {
  if (!d || typeof d !== 'object') return null;
  const A = ['t', 'x', 'y', 'z'].map(k => d[k]); if (!A.every(esArr)) return null;
  const nMin = Math.min(...A.map(a => a.length)), nMax = Math.max(...A.map(a => a.length)), n = Math.min(nMin, LIM.muestras);
  const T = A[0], X = A[1], Y = A[2], Z = A[3], V = LIM.valor, ok = new Uint8Array(n); let k = 0, tAnt = -Infinity;
  for (let i = 0; i < n; i++) {
    const t = T[i], x = X[i], y = Y[i], z = Z[i];
    if (esNum(t, -1e13, 1e13) && t > tAnt && esNum(x, -V, V) && esNum(y, -V, V) && esNum(z, -V, V)) { ok[i] = 1; k++; tAnt = t; }
  }
  if (cnt) cnt.muestras += nMax - k;
  if (k < 3) return null;
  if (k === nMax && A.every(a => a instanceof Float64Array)) return Object.keys(d).length === 4 ? d : { t: T, x: X, y: Y, z: Z };
  const o = { t: new Float64Array(k), x: new Float64Array(k), y: new Float64Array(k), z: new Float64Array(k) };
  for (let i = 0, j = 0; i < n; i++) if (ok[i]) { o.t[j] = T[i]; o.x[j] = X[i]; o.y[j] = Y[i]; o.z[j] = Z[i]; j++; }
  return o;
}
/** Grabación guardada (importada = false) o importada (true). Devuelve null si no queda ningún sensor útil. */
function normGrab(o, importada, cnt) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const fl = o.flujos && typeof o.flujos === 'object' && !Array.isArray(o.flujos) ? o.flujos : {}, flujos = {};
  for (const f of Object.keys(fl)) { if (!tiene(S.FLUJOS, f)) { cnt.flujos++; continue; } const d = normFlujo(fl[f], cnt); if (d) flujos[f] = d; else cnt.flujos++; }
  const b = flujos.acc || flujos.lin || flujos.gyr; if (!b) return null;   // sin acelerómetro ni giroscopio no hay nada que analizar
  const id = importada ? nuevoId() : typeof o.id === 'string' && ID_OK.test(o.id) ? o.id : null; if (!id) { cnt.campos++; return null; }
  const mal = (v, bien) => { if (v !== undefined && v !== null && v !== '' && !bien) cnt.campos++; return bien; };
  const nombre = texto(o.nombre), fecha = fechaOk(o.fecha), dur = b.t[b.t.length - 1] - b.t[0];
  mal(o.nombre, typeof o.nombre === 'string' && o.nombre.length <= LIM.texto); mal(o.fecha, !!fecha); mal(o.notas, typeof o.notas === 'string' && o.notas.length <= LIM.notas);
  return {
    id, nombre: nombre || (importada ? 'Importada' : 'sin nombre'), fecha: fecha || new Date().toISOString(),
    fuente: mal(o.fuente, fuenteOk(o.fuente)) ? o.fuente : 'importada',
    frecuenciaPedida: mal(o.frecuenciaPedida, esNum(o.frecuenciaPedida, 0, 1e5)) ? o.frecuenciaPedida : null,
    duracion: !importada && esNum(o.duracion, 0, 1e7) ? o.duracion : dur,
    notas: texto(o.notas, LIM.notas), cal: normCal(o.cal, cnt), flujos
  };
}
/** Referencia de máquina guardada: espectro {f, psd} numérico del mismo largo y parámetros en rango. */
function normRef(r) {
  if (!r || typeof r !== 'object') return null;
  const arr = a => esArr(a) && a.length >= 2 && a.length <= LIM.ref && Array.prototype.every.call(a, v => esNum(v)) ? Array.from(a) : null;
  const f = arr(r.f), psd = arr(r.psd);
  if (!f || !psd || f.length !== psd.length || !esNum(r.df, 1e-9, 1e5) || !esNum(r.fs, 1e-3, 1e6) || !esNum(r.fmin, 0, 1e6)) return null;
  return { nombre: texto(r.nombre) || 'referencia', fecha: fechaOk(r.fecha) || new Date().toISOString(), f, psd, df: r.df, fs: r.fs, eje: ['x', 'y', 'z', 'mag'].includes(r.eje) ? r.eje : '?', fmin: r.fmin };
}

/* ============================================================ IndexedDB */
const BD = {
  db: null,
  abrir() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((ok, mal) => { const q = indexedDB.open('vibra', 1); q.onupgradeneeded = () => q.result.createObjectStore('grabaciones', { keyPath: 'id' }); q.onsuccess = () => { this.db = q.result; ok(this.db); }; q.onerror = () => mal(q.error); });
  },
  async op(modo, fn) { const db = await this.abrir(); return new Promise((ok, mal) => { const tx = db.transaction('grabaciones', modo), st = tx.objectStore('grabaciones'), r = fn(st); tx.oncomplete = () => ok(r && r.result); tx.onerror = () => mal(tx.error); }); },
  todas() { return this.op('readonly', st => st.getAll()); },
  guardar(g) { return this.op('readwrite', st => st.put(g)); },
  borrar(id) { return this.op('readwrite', st => st.delete(id)); }
};
async function cargarLista() {
  if (E.efimero) return;
  let crudas = [];
  try { crudas = (await BD.todas()) || []; } catch (e) { E.sinBD = true; }
  const cnt = contador(); E.lista = [];
  for (const o of crudas) { const g = normGrab(o, false, cnt); if (g) E.lista.push(g); else cnt.grab++; }
  const d = txtDescartes(cnt); if (d) aviso('Datos guardados revisados al abrir (no se borró nada del teléfono). ' + d);
  E.lista.sort((a, b) => b.fecha.localeCompare(a.fecha));
}
async function agregarGrabacion(g, abrir = true) {
  E.lista.unshift(g);
  if (!E.efimero) try { await BD.guardar(g); } catch (e) { E.sinBD = true; aviso('No se pudo guardar en el teléfono (IndexedDB): la grabación vive solo en esta sesión.'); }
  if (abrir) seleccionar(g.id); else renderSelector();
  renderGrabaciones();
}
function seleccionar(id) {
  E.actual = E.lista.find(g => g.id === id) || null; E.sel = null; E.zoom = null; E.ajuste = null; E.pendulo = null; cacheRem.clear();
  if (E.actual) {
    const fl = Object.keys(E.actual.flujos);
    $('aFlujo').innerHTML = fl.map(f => `<option value="${esc(f)}">${esc(S.FLUJOS[f].nombre)}</option>`).join('');
    $('aFlujo').value = E.actual.fuente === 'demo:pendulo' && fl.includes('gyr') ? 'gyr' : fl.includes('lin') ? 'lin' : fl[0];
    $('aEje').value = E.actual.fuente === 'demo:pendulo' ? 'x' : E.actual.fuente === 'demo:maquina' || E.actual.fuente === 'demo:maquina-falla' ? 'x' : 'z';
  }
  $('resAjuste').innerHTML = ''; $('gAjuste').hidden = $('gResid').hidden = true; $('resPendulo').innerHTML = ''; $('gPendulo').hidden = true;
  renderSelector(); renderTab();
}

/* ============================================================ señal remuestreada */
const cacheRem = new Map();
/** Remuestrea los tres ejes de un flujo a malla uniforme. fs = 1/⟨Δt⟩ sin contar huecos. */
function remuestreado(g, flujo, interp) {
  const k = g.id + '|' + flujo + '|' + interp; if (cacheRem.has(k)) return cacheRem.get(k);
  const f = g.flujos[flujo]; if (!f || f.t.length < 16) return null;
  const m = D.analizarMuestreo(f.t); let s = 0, n = 0; const um = m.huecos.length ? Math.min(...m.huecos.map(h => h.dur)) : Infinity;
  for (const v of m.dt) if (v < um) { s += v; n++; }
  const fs = Math.round(1e3 * n / s) / 1e3, r = { fs, t0: f.t[0], muestreo: m };
  for (const e of ['x', 'y', 'z']) r[e] = D.remuestrear(f.t, f[e], fs, interp);
  r.n = r.x.length; r.t = new Float64Array(r.n); for (let i = 0; i < r.n; i++) r.t[i] = f.t[0] + i / fs;
  cacheRem.set(k, r); return r;
}
function ejeDe(r, eje) { if (eje !== 'mag') return Float64Array.from(r[eje]); const y = new Float64Array(r.n); for (let i = 0; i < r.n; i++) y[i] = Math.hypot(r.x[i], r.y[i], r.z[i]); return y; }
function quitarMedia(y) { const m = D.media(y); for (let i = 0; i < y.length; i++) y[i] -= m; return y; }
/** Señal de la pestaña Analizar (eje, media, filtro). */
function senalAnalizar() {
  const g = E.actual; if (!g) return null; const flujo = $('aFlujo').value, r = remuestreado(g, flujo, $('aInterp').value); if (!r) return null;
  let y = ejeDe(r, $('aEje').value); if ($('aQuitarMedia').checked) quitarMedia(y);
  const tf = $('aFiltro').value, ny = r.fs / 2; let comoF = '';
  if (tf !== 'no') {
    const f1 = Math.min(num('aF1', 0.5), 0.95 * ny), f2 = Math.min(num('aF2', 10), 0.95 * ny), orden = +$('aOrden').value;
    y = D.filtrar(y, r.fs, { tipo: tf, f1, f2, orden });
    comoF = `<b>Filtro:</b> Butterworth de orden ${orden} (${tf === 'banda' ? `paso alto ${fmt(f1, 2)} Hz + paso bajo ${fmt(f2, 2)} Hz` : tf === 'bajo' ? `paso bajo ${fmt(f2, 2)} Hz` : `paso alto ${fmt(f1, 2)} Hz`}) en biquads por transformación bilineal, aplicado ida y vuelta (fase cero), con el corte corregido para que la caída total sea −3 dB en la frecuencia pedida.`;
  }
  return { r, y, fs: r.fs, t: r.t, flujo, eje: $('aEje').value, unidad: UNID[flujo][0].u, comoF };
}
function tramo(s) {
  if (!E.sel) return { t: s.t, y: s.y, i0: 0, i1: s.y.length };
  const i0 = Math.max(0, Math.round((E.sel[0] - s.t[0]) * s.fs)), i1 = Math.min(s.y.length, Math.round((E.sel[1] - s.t[0]) * s.fs) + 1);
  return { t: s.t.subarray(i0, i1), y: s.y.subarray(i0, i1), i0, i1 };
}

/* ============================================================ gráficas */
const GR = {};
function crearGraficas() {
  const cur = (xn, xu) => ({ xNombre: xn, xUnidad: xu });
  GR.vivoAcc = new G($('gVivoAcc'), { alto: 200, xEtiqueta: 't (s)' });
  GR.vivoGyr = new G($('gVivoGyr'), { alto: 170, xEtiqueta: 't (s)' });
  GR.vivoEsp = new G($('gVivoEsp'), { alto: 190, ylog: true, xEtiqueta: 'f (Hz)' });
  GR.serie = new G($('gSerie'), { alto: 230, xEtiqueta: 't (s)', seleccionable: true, onSeleccion: (a, b) => { E.sel = [a, b]; E.ajuste = null; renderAnalizar(false); } });
  GR.sg = new G($('gSg'), { alto: 240, xEtiqueta: 't (s)', yEtiqueta: 'f (Hz)' });
  GR.esp = new G($('gEsp'), { alto: 260, xEtiqueta: 'f (Hz)' });
  GR.ajuste = new G($('gAjuste'), { alto: 220, xEtiqueta: 't (s)' });
  GR.resid = new G($('gResid'), { alto: 130, xEtiqueta: 't (s)', yEtiqueta: 'residuo' });
  GR.pend = new G($('gPendulo'), { alto: 200, xEtiqueta: 't (s)' });
  GR.maq = new G($('gMaq'), { alto: 250, xEtiqueta: 'f (Hz)', yEtiqueta: 'mm/s RMS' });
  GR.ref = new G($('gRef'), { alto: 220, xEtiqueta: 'f (Hz)', yEtiqueta: 'dB' });
  GR.est = new G($('gEst'), { alto: 270, ylog: true, xEtiqueta: 'f (Hz)', yEtiqueta: '(m/s²)²/Hz' });
  GR.coh = new G($('gCoh'), { alto: 200, xEtiqueta: 'f (Hz)', yEtiqueta: 'γ²' });
  GR.allan = new G($('gAllan'), { alto: 260, xlog: true, ylog: true, xEtiqueta: 'τ (s)' });
  GR.jitter = new G($('gJitter'), { alto: 190, xEtiqueta: 'Δt (ms)', yEtiqueta: 'muestras' });
  GR.comp = new G($('gComp'), { alto: 240, ylog: true, xEtiqueta: 'f (Hz)' });
  void cur;
}

/* ============================================================ pestañas */
function irA(tab) {
  E.tab = tab;
  for (const b of document.querySelectorAll('nav.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== 'tab-' + tab;
  $('barraGrab').hidden = !['analizar', 'maquinas', 'estructuras', 'sensor'].includes(tab);
  renderTab(); window.scrollTo(0, 0);
}
function renderTab() {
  try {
    if (E.tab === 'analizar') renderAnalizar(true);
    else if (E.tab === 'maquinas') renderMaquinas();
    else if (E.tab === 'estructuras') renderEstructuras();
    else if (E.tab === 'sensor') renderSensor();
    else if (E.tab === 'grabaciones') renderGrabaciones();
  } catch (e) { console.error(e); aviso('Error en el análisis: ' + e.message); }
  renderEstadoTop();
}
function sinGrabacion(cont) { const h = '<p class="aviso">No hay grabación seleccionada. Grabe una en <b>Medir</b> o pulse <b>+ DEMO</b> arriba.</p>'; if (cont) $(cont).innerHTML = h; return h; }
let avisoT = null;
function aviso(txt) {
  let el = $('avisoFlotante');
  if (!el) { el = document.createElement('div'); el.id = 'avisoFlotante'; el.className = 'error'; el.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:9;max-width:640px;margin:0 auto;box-shadow:0 4px 16px #0004'; el.onclick = () => { el.hidden = true; }; document.body.appendChild(el); }
  el.textContent = txt; el.hidden = false; clearTimeout(avisoT); avisoT = setTimeout(() => { el.hidden = true; }, 7000);
}

/* ============================================================ selector de grabación */
function renderSelector() {
  const s = $('selGrab');
  s.innerHTML = E.lista.length ? E.lista.map(g => `<option value="${esc(g.id)}">${esc(g.nombre || 'sin nombre')} · ${new Date(g.fecha).toLocaleString('es-DO', { dateStyle: 'short', timeStyle: 'short' })}</option>`).join('') : '<option value="">(sin grabaciones)</option>';
  if (E.actual) s.value = E.actual.id;
  const g = E.actual;
  if (!g) { $('infoGrab').innerHTML = 'Sin grabación seleccionada.'; return; }
  const base = g.flujos.acc || g.flujos.lin || g.flujos.gyr, m = D.analizarMuestreo(base.t), fsr = m.fs;
  $('infoGrab').innerHTML = `<b>${esc(fuenteTxt(g.fuente))}</b> · ${fmt(g.duracion, 1)} s · ${base.t.length} muestras · fs real <b>${fmt(fsr, 2)} Hz</b> · Nyquist <b>${fmt(fsr / 2, 2)} Hz</b> · jitter ${fmt(1000 * m.jitter, 2)} ms · huecos ${m.huecos.length}${g.cal ? ' · calibrada' : ''}`;
}
function fuenteTxt(f) { return f === 'generico' ? 'Generic Sensor API' : f === 'devicemotion' ? 'DeviceMotionEvent' : f && f.startsWith('demo:') ? 'DEMO ' + (S.DEMOS[f.slice(5)] || {}).nombre : f || '?'; }
function renderEstadoTop() {
  const el = $('estadoTop');
  if (E.cap.activa) {
    const a = E.cap.anillos.acc.n ? E.cap.anillos.acc : E.cap.anillos.gyr, d = a.ultimos(5), m = D.analizarMuestreo(d.t);
    el.innerHTML = `${E.cap.fuente === 'demo' ? 'DEMO' : E.cap.fuente === 'generico' ? 'Sensor genérico' : 'DeviceMotion'} · fs <b>${fmt(m.fs, 1)} Hz</b> · Nyquist <b>${fmt(m.fs / 2, 1)} Hz</b>`;
  } else if (E.actual && E.tab !== 'medir') {
    const b = E.actual.flujos.acc || E.actual.flujos.lin || E.actual.flujos.gyr, fs = (b.t.length - 1) / (b.t[b.t.length - 1] - b.t[0]);
    el.innerHTML = `grabación · fs <b>${fmt(fs, 1)} Hz</b> · Nyquist <b>${fmt(fs / 2, 1)} Hz</b>`;
  } else el.textContent = 'sensores detenidos';
}

/* ============================================================ MEDIR */
async function iniciar() {
  const fuente = $('fuente').value; $('msgFuente').innerHTML = ''; guardarConfig();
  try {
    E.cap.cal = E.cal;
    const f = await E.cap.iniciar({ fuente, frecuencia: num('freqPedida', 500), demo: $('demoTipo').value, demoFs: +$('demoFs').value, magnetometro: $('usarMag').checked });
    $('fuenteActual').textContent = f === 'generico' ? 'Generic Sensor API' : f === 'devicemotion' ? 'DeviceMotionEvent' : 'DEMO · ' + S.DEMOS[$('demoTipo').value].nombre;
    $('fsPed').textContent = f === 'demo' ? $('demoFs').value : f === 'devicemotion' ? '—' : fmt(num('freqPedida', 500), 0);
    if (E.cap.errores.length) $('msgFuente').innerHTML = `<p class="nota">${E.cap.errores.map(esc).join('<br>')}</p>`;
    $('btnIniciar').disabled = true; $('btnDetener').disabled = false; pedirWake(); bucleVivo();
  } catch (e) {
    const disp = S.disponibles();
    $('msgFuente').innerHTML = `<p class="error">${esc(e.message)}${!disp.seguro ? ' La página no está en un contexto seguro (https): los sensores están bloqueados.' : ''} Puede usar el modo <b>DEMO</b>.</p>`;
  }
}
function detener() { E.cap.detener(); $('btnIniciar').disabled = false; $('btnDetener').disabled = true; soltarWake(); renderEstadoTop(); }
async function pedirWake() { try { if (!E.wake && navigator.wakeLock) { E.wake = await navigator.wakeLock.request('screen'); E.wake.addEventListener('release', () => { E.wake = null; }); } } catch (e) { /* no disponible */ } }
function soltarWake() { try { if (E.wake && !E.grabando) { E.wake.release(); E.wake = null; } } catch (e) { /* nada */ } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (E.cap.activa || E.grabando)) pedirWake(); });

let vivoId = null, vivoTick = 0;
function bucleVivo() {
  clearInterval(vivoId);
  vivoId = setInterval(() => {
    if (!E.cap.activa) { clearInterval(vivoId); return; }
    vivoTick++; if (E.tab !== 'medir') { if (vivoTick % 10 === 0) renderEstadoTop(); return; }
    try { dibujarVivo(vivoTick % 3 === 0); } catch (e) { console.error(e); }
  }, 120);
}
function dibujarVivo(conEspectro) {
  const c = COL(), cap = E.cap, fl = cap.anillos[$('vivoFlujo').value].n ? $('vivoFlujo').value : 'acc';
  const a = cap.vivo(fl, 5), ahora = cap.anillos[fl].ultimoT;
  const tt = Float64Array.from(a.t, v => v - ahora), mag = a.x.map((_, i) => Math.hypot(a.x[i], a.y[i], a.z[i]));
  GR.vivoAcc.set({ series: [{ x: tt, y: a.x, color: c.x, nombre: 'x' }, { x: tt, y: a.y, color: c.y, nombre: 'y' }, { x: tt, y: a.z, color: c.z, nombre: 'z' }, { x: tt, y: mag, color: c.mag, nombre: '|a|', ancho: 1 }], xr: [-5, 0], yEtiqueta: 'm/s²' });
  if (cap.anillos.gyr.n) { const w = cap.vivo('gyr', 5), tw = Float64Array.from(w.t, v => v - ahora); GR.vivoGyr.set({ series: [{ x: tw, y: w.x, color: c.x, nombre: 'x' }, { x: tw, y: w.y, color: c.y, nombre: 'y' }, { x: tw, y: w.z, color: c.z, nombre: 'z' }], xr: [-5, 0] }); }
  const d10 = cap.vivo('acc', 10).t.length > 10 ? cap.vivo('acc', 10) : cap.vivo('gyr', 10), m = D.analizarMuestreo(d10.t), mg = D.analizarMuestreo(cap.vivo('gyr', 10).t);
  $('fsAcc').textContent = fmt(m.fs, 1); $('nyq').textContent = fmt(m.fs / 2, 1); $('fsGyr').textContent = fmt(mg.fs, 1);
  $('jit').textContent = fmt(1000 * m.jitter, 2); $('huecos').textContent = isFinite(m.fs) ? m.huecos.length : '—';
  renderEstadoTop();
  if (conEspectro) {
    const e = cap.vivo(fl, 10); if (e.t.length < 64) return;
    const mm = D.analizarMuestreo(e.t), fs = mm.fsMediana, eje = $('vivoEje').value;
    const r = {}; for (const k of ['x', 'y', 'z']) r[k] = D.remuestrear(e.t, e[k], fs, 'cubica'); r.n = r.x.length;
    const y = quitarMedia(ejeDe(r, eje)), esp = D.welch(y, fs, { nseg: D.potInferior2(Math.max(64, y.length / 3)) });
    const pk = D.buscarPicos(esp.f, esp.amp, { n: 3, fmin: 2 * esp.df, promDb: 8 });
    GR.vivoEsp.set({ series: [{ x: esp.f, y: esp.psd, color: c[eje] }], xr: [0, fs / 2], yEtiqueta: '(m/s²)²/Hz', marcas: pk.slice(0, 2).map((p, i) => ({ x: p.f, texto: fmt(p.f, 2) + ' Hz', fila: i })) });
    $('vivoPico').textContent = pk.length ? `Pico principal: ${fmt(pk[0].f, 2)} Hz (Δf = ${fmt(esp.df, 3)} Hz; amplitud ${fsig(pk[0].y, 3)} m/s²).` : 'Sin picos claros.';
  }
}

/* ---------- grabación */
async function grabar() {
  if (E.grabando) return;
  if (!E.cap.activa) { await iniciar(); if (!E.cap.activa) return; }
  guardarConfig();
  const dur = +$('durGrab').value, cuenta = +$('cuentaGrab').value, disparo = $('disparo').checked, umbral = num('umbral', 0.5), pre = Math.max(0, num('preDisparo', 1));
  const G0 = E.grabando = { estado: 'cuenta', dur, fin: 0 };
  $('estadoGrab').hidden = false; $('btnGrabar').disabled = true; $('btnParar').disabled = false; pedirWake();
  for (let k = cuenta; k > 0 && E.grabando === G0; k--) { $('cuenta').textContent = k; $('txtGrab').textContent = 'Prepárese: suelte el teléfono y no lo toque.'; await new Promise(r => setTimeout(r, 1000)); }
  if (E.grabando !== G0) return;
  const empezar = () => { E.cap.empezarGrabacion(disparo ? pre : 0); G0.estado = 'grabando'; G0.inicio = performance.now(); };
  if (disparo) {
    G0.estado = 'esperando'; $('cuenta').textContent = '…'; $('txtGrab').textContent = `Esperando que |a| cambie más de ${fmt(umbral, 2)} m/s² (pre-disparo ${fmt(pre, 1)} s).`;
    let base = null; const flujo = E.cap.anillos.lin.n ? 'lin' : 'acc';
    E.cap.alMuestra = (f, t, x, y, z) => {
      if (f !== flujo || G0.estado !== 'esperando') return; const m = Math.hypot(x, y, z);
      if (base === null) { base = m; return; } if (Math.abs(m - base) > umbral) { E.cap.alMuestra = null; empezar(); } else base += 0.02 * (m - base);
    };
  } else empezar();
  const tick = () => {
    if (E.grabando !== G0) return;
    if (G0.estado === 'grabando') {
      const s = (performance.now() - G0.inicio) / 1000; $('cuenta').textContent = fmt(s, 0) + ' s';
      $('txtGrab').textContent = 'Grabando… no toque el teléfono.'; $('barraProg').style.width = dur ? Math.min(100, 100 * s / dur) + '%' : '100%';
      if (dur && s >= dur) { terminarGrabacion(); return; }
    }
    setTimeout(tick, 200);
  };
  tick();
}
async function terminarGrabacion() {
  const G0 = E.grabando; if (!G0) return; E.grabando = null; E.cap.alMuestra = null;
  $('btnGrabar').disabled = false; $('btnParar').disabled = true; $('barraProg').style.width = '0';
  if (G0.estado !== 'grabando') { $('estadoGrab').hidden = true; return; }
  const nombre = $('nombreGrab').value.trim() || `Medición ${E.lista.length + 1}`;
  const g = E.cap.terminarGrabacion({ nombre });
  $('cuenta').textContent = '✓'; $('txtGrab').innerHTML = g ? `Guardada «${esc(nombre)}» (${fmt(g.duracion, 1)} s). <button class="btn peq" id="irAnalizar">Analizar</button>` : 'No llegaron datos.';
  if (g) { await agregarGrabacion(g); $('irAnalizar').onclick = () => irA('analizar'); }
}

/* ============================================================ ANALIZAR */
function renderAnalizar(completo = true) {
  const s = senalAnalizar();
  if (!s) { $('infoSenal').textContent = ''; $('estad').innerHTML = sinGrabacion(); GR.serie.set({ series: [] }); GR.esp.set({ series: [] }); GR.sg.set({ series: [] }); $('tPicos').innerHTML = ''; return; }
  const c = COL(), ny = s.fs / 2, m = s.r.muestreo;
  $('infoSenal').textContent = `${S.FLUJOS[s.flujo].nombre} · ${NOMBRE_EJE[s.eje]} · remuestreada a ${fmt(s.fs, 2)} Hz · Nyquist ${fmt(ny, 2)} Hz`;
  $('comoFiltro').innerHTML = `<b>Cómo se calcula:</b> las muestras llegan con jitter (σΔt = ${fmt(1000 * m.jitter, 2)} ms, ${m.huecos.length} huecos); antes de cualquier FFT se interpolan a una malla uniforme de ${fmt(s.fs, 2)} Hz (= 1/⟨Δt⟩ sin huecos) con ${$('aInterp').value === 'cubica' ? 'Hermite cúbica con pendientes de Catmull-Rom' : 'interpolación lineal'}. ` + s.comoF;
  const tr = tramo(s);
  GR.serie.set({ series: [{ x: s.t, y: s.y, color: c[s.eje] || c.z, ancho: 1.2, nombre: NOMBRE_EJE[s.eje] }], xr: E.zoom || undefined, seleccion: E.sel, yEtiqueta: s.unidad, xNombre: 't', xUnidad: 's' });
  $('txtSel').textContent = E.sel ? `Tramo ${fmt(E.sel[0], 2)}–${fmt(E.sel[1], 2)} s (${fmt(E.sel[1] - E.sel[0], 2)} s, ${tr.y.length} muestras)` : `Todo el registro (${fmt(s.t[s.t.length - 1] - s.t[0], 1)} s)`;
  const st = D.estadisticos(tr.y), u = s.unidad;
  $('estad').innerHTML = indic([['Media', Math.abs(st.media) < 1e-9 * (st.rms || 1) ? '0 (restada)' : fsig(st.media, 4), u], ['RMS (sin media)', fsig(st.rms, 4), u], ['Pico', fsig(st.pico, 4), u], ['Pico a pico', fsig(st.picoPico, 4), u],
    ['Factor de cresta', fmt(st.cresta, 2), ''], ['Curtosis', fmt(st.curtosis, 2), ''], ['Asimetría', fmt(st.asimetria, 2), ''], ['Muestras', st.n, fmt(st.n / s.fs, 2) + ' s']]);
  if (tr.y.length >= 32) renderEspectro(s, tr);
  if (completo) renderEspectrograma(s);
  if (E.ajuste) dibujarAjuste();
}
function renderEspectro(s, tr) {
  const c = COL(), mag = +$('eMag').value, tipo = $('eTipo').value, escala = $('eEscala').value, ventana = $('eVent').value;
  const N = tr.y.length, segSel = $('eSeg').value, nseg = segSel === 'auto' ? Math.max(64, Math.min(16384, D.potInferior2(N / 2.5))) : Math.min(+segSel, D.potInferior2(N));
  const unidades = UNID[s.flujo], un = unidades[mag] || unidades[0], magEf = unidades[mag] ? mag : 0, fhp = Math.max(num('eFhp', 1), 0.01);
  const esp0 = D.welch(tr.y, s.fs, { nseg, ventana }), esp = magEf ? D.integrarEspectro(esp0, magEf, fhp) : esp0;
  const yv = tipo === 'psd' ? esp.psd.map(v => v * un.f * un.f) : esp.amp.map(v => v * un.f);
  const yd = escala === 'db' ? yv.map(v => (tipo === 'psd' ? 10 : 20) * Math.log10(v + 1e-300)) : yv;
  const fminP = Math.max(2 * esp.df, magEf ? 1.2 * fhp : 0);
  const picos = D.buscarPicos(esp.f, tipo === 'psd' ? esp.psd : esp.amp, { n: 8, fmin: fminP, promDb: 8, interp: $('eInterp').value, potencia: tipo === 'psd' });
  const filas = picos.map((p, k) => {
    const piso = D.pisoLocal(esp0.psd, p.i, 30, 4), af = D.afinarTono(tr.y, s.fs, p.f, { ancho: esp.df, ruidoPSD: piso });
    const corr = D.respVentana(esp.w, p.delta), ampC = esp.amp[p.i] / corr * un.f, hp = D.medioPotencia(esp.f, esp.psd, p.i);
    p.fa = af.f;
    return [k + 1, conInc(af.f, af.sf) + `<br><small class="nota">bin interp. ${fmt(p.f, 4)} · ${fmt(p.promDb, 0)} dB sobre el fondo</small>`, fsig(ampC, 4), fsig(esp.psd[p.i] * un.f * un.f, 3), hp && hp.ancho > 2 * esp.enbw ? fmt(100 * hp.zeta, 2) + ' %' : '—'];
  });
  const yu = tipo === 'psd' ? `(${un.u})²/Hz` : `${un.u} (pico)`;
  GR.esp.set({ series: [{ x: esp.f, y: yd, color: c[s.eje] || c.z, ancho: 1.3 }], xr: [0, s.fs / 2], ylog: escala === 'log', yEtiqueta: escala === 'db' ? `dB re 1 ${yu}` : yu,
    marcas: picos.slice(0, 4).map((p, i) => ({ x: p.f, texto: fmt(p.f, 3), fila: i })), xNombre: 'f', xUnidad: 'Hz',
    lecturaCursor: x => { const i = Math.max(0, Math.min(esp.f.length - 1, Math.round(x / esp.df))); return [`${fsig(yd[i], 4)} ${escala === 'db' ? 'dB' : yu}`]; } });
  $('infoEsp').textContent = `Δf = ${fmt(esp.df, 4)} Hz · ENBW = ${fmt(esp.enbw, 4)} Hz · ${esp.K} promedios · Nyquist ${fmt(s.fs / 2, 2)} Hz`;
  $('tPicos').innerHTML = picos.length ? tabla(['#', 'f afinada ± σ (Hz)', `amplitud ${un.u} (pico)`, `PSD ${un.u}²/Hz`, 'ζ (½ pot.)'], filas) : '<p class="nota">Sin picos prominentes.</p>';
  const VN = D.VENTANAS[ventana].nombre;
  $('comoEsp').innerHTML = `<b>Cómo se calcula:</b> Welch con ventana ${VN}, segmentos de ${esp.nseg} muestras, solape 50 %, media restada por segmento. PSD = 2⟨|X_k|²⟩/(fs·Σw²) (corrección de energía de la ventana: Σ PSD·Δf = varianza); amplitud = 2√⟨|X_k|²⟩/Σw (corrección coherente: un seno A da pico A en su bin). ${magEf ? `Velocidad/desplazamiento: se divide por (2πf)${magEf === 2 ? '²' : ''} y se anula por debajo de ${fmt(fhp, 2)} Hz (paso alto; evita la divergencia en 0 Hz). ` : ''}Picos: interpolación ${$('eInterp').value === 'gauss' ? 'Gaussiana (parábola sobre ln)' : 'parabólica'} entre 3 bins; amplitud corregida por el festoneo de la ventana |W(δ)|. «f afinada» maximiza la DTFT del tramo completo (sin sesgo de interpolación); σ es la incertidumbre de ese estimador para un tono en ruido (equivale a la cota de Cramér–Rao con ventana rectangular), con el ruido tomado del piso local de la PSD. Para picos anchos (modos amortiguados) σ subestima la incertidumbre: vea ζ.`;
}
function renderEspectrograma(s) {
  const N = s.y.length, nseg = Math.min(+$('sgSeg').value, D.potInferior2(N / 2));
  if (nseg < 16) return;
  const sg = D.espectrograma(s.y, s.fs, { nseg, solape: 0.75 }), im = G.imagenEspectrograma(sg, { rango: +$('sgRango').value });
  $('infoSg').textContent = `Δf = ${fmt(sg.df, 3)} Hz · Δt = ${fmt(sg.dt, 3)} s`;
  GR.sg.set({ series: [], imagen: im, xr: [im.x0, im.x1], yr: [0, s.fs / 2], xNombre: 't', xUnidad: 's',
    lecturaCursor: (x, y) => { const k = Math.max(0, Math.min(sg.nt - 1, Math.round((x - sg.t[0]) / sg.dt))), i = Math.max(0, Math.min(im.nfMax - 1, Math.round(y / sg.df))); return [`f = ${fmt(i * sg.df, 3)} Hz`, `${fmt(im.db[k * im.nfMax + i], 1)} dB`]; } });
  $('sgLeyenda').textContent = `Color: PSD en dB re 1 (${s.unidad})²/Hz, de ${fmt(im.dbMin, 0)} (violeta) a ${fmt(im.dbMax, 0)} (amarillo), escala viridis (perceptual). Ventana Hann, solape 75 %. Toque para leer t, f y nivel.`;
}
/** Busca automáticamente un tramo de decaimiento libre: desde poco después del máximo de la envolvente hasta que cae al 4 % o vuelve a subir. */
function detectarDecaimiento() {
  const s = senalAnalizar(); if (!s) return;
  const y = quitarMedia(Float64Array.from(s.y)), env = D.envolvente(y), w = Math.max(1, Math.round(0.3 * s.fs)), sm = new Float64Array(env.length);
  let acc = 0; for (let i = 0; i < env.length; i++) { acc += env[i]; if (i >= w) acc -= env[i - w]; sm[i] = acc / Math.min(i + 1, w); }
  let imax = 0; for (let i = 0; i < sm.length; i++) if (sm[i] > sm[imax]) imax = i;
  const i0 = Math.min(sm.length - 1, imax + w); let mn = sm[i0], j = i0;
  for (; j < sm.length; j++) { if (sm[j] < mn) mn = sm[j]; if (sm[j] < 0.04 * sm[imax] || sm[j] > 1.6 * mn + 0.05 * sm[imax]) break; }
  E.sel = [s.t[i0], s.t[Math.max(i0 + 32, Math.min(j, sm.length) - 1)] ]; E.zoom = null; E.ajuste = null; renderAnalizar(false);
}
function hacerAjuste() {
  const s = senalAnalizar(); if (!s) { $('resAjuste').innerHTML = sinGrabacion(); return; }
  if (!E.sel) detectarDecaimiento();
  const tr = tramo(senalAnalizar());
  if (tr.y.length < 40) { $('resAjuste').innerHTML = '<p class="error">Tramo demasiado corto: seleccione al menos unos ciclos de oscilación.</p>'; return; }
  try {
    const a = D.ajustarAmortiguado(tr.t, tr.y), dl = D.decrementoLog(tr.t, tr.y, a.c, a.f, 10 * a.sigmaRuido), mp = D.amortiguamientoMedioPotencia(tr.y, s.fs, a.c);
    E.ajuste = { a, dl, mp, tr: { t: Float64Array.from(tr.t), y: Float64Array.from(tr.y) }, unidad: s.unidad };
    dibujarAjuste();
  } catch (e) { $('resAjuste').innerHTML = `<p class="error">No se pudo ajustar: ${esc(e.message)}</p>`; }
}
function dibujarAjuste() {
  const { a, dl, mp, tr, unidad } = E.ajuste, c = COL(), u = unidad;
  const filas = [['Frecuencia amortiguada f', conInc(a.f, a.sf, 'Hz')], ['Frecuencia natural f₀', conInc(a.f0, a.sf0, 'Hz')], ['Constante de tiempo τ', conInc(a.tau, a.stau, 's')],
    ['Razón de amortiguamiento ζ', conInc(a.zeta, a.szeta)], ['Factor de calidad Q', conInc(a.Q, a.sQ)], ['Amplitud inicial A', conInc(a.A, a.sA, u)], ['Fase φ', conInc(a.phi, a.sphi, 'rad')],
    ['Desplazamiento c', conInc(a.c, a.sc, u)], ['χ²/ν (ruido por diferencias)', fmt(a.chi2nu, 2) + (a.chi2nu > 2 ? ' — el modelo no describe todo (¿no linealidad, otro modo, roce seco?)' : '')],
    ['RMS de residuos / ruido', `${fsig(a.sResid, 3)} / ${fsig(a.sigmaRuido, 3)} ${u}`], ['ρ₁ de residuos', fmt(a.rho1, 3) + (a.factorCorr > 1 ? ` (σ inflada ×${fmt(Math.sqrt(a.factorCorr), 2)})` : '')], ['N · iteraciones', `${a.N} · ${a.iter}${a.convergio ? '' : ' (sin convergencia plena)'}`]];
  const met = (n, nota) => `${n}<br><small class="nota">${nota}</small>`;
  const zq = (z, q) => `${z}<br><small class="nota">Q = ${q}</small>`;
  const comp = [[met('Ajuste LM', 'envolvente y fase de todo el tramo'), zq(conInc(a.zeta, a.szeta), conInc(a.Q, a.sQ))],
    [met('Decremento logarítmico', dl ? `δ = ${conInc(dl.delta, dl.sdelta)} por ciclo, ${dl.npicos} picos` : 'pocos picos sobre el ruido'), dl ? zq(conInc(dl.zeta, dl.szeta), fmt(dl.Q, 1)) : '—'],
    [met('Media potencia (PSD)', mp ? `Δf = ${fmt(mp.ancho, 4)} Hz${mp.limitado ? ' · <b>limitado por la resolución</b> (1/T = ' + fmt(mp.resolucion, 3) + ' Hz): sesgado hacia arriba' : ''}` : 'sin pico'), mp ? zq(fmt(mp.zeta, 5), fmt(mp.Q, 1)) : '—']];
  $('resAjuste').innerHTML = `<div class="tabla">${tabla(['Parámetro', 'Valor ± 1σ'], filas)}</div><h2 style="margin-top:12px">Comparación de métodos</h2><div class="tabla">${tabla(['Método', 'ζ (y Q)'], comp)}</div>`;
  const mod = tr.t.map(t => a.modelo(t)), env = tr.t.map(t => a.A * Math.exp(-(t - a.t0) / a.tau)), envN = env.map((v, i) => -v + a.c);
  $('gAjuste').hidden = $('gResid').hidden = false;
  GR.ajuste.set({ series: [{ x: tr.t, y: tr.y, color: c.muted, ancho: 1, nombre: 'datos' }, { x: tr.t, y: mod, color: c.ajuste, ancho: 1.6, nombre: 'ajuste' }, { x: tr.t, y: env.map(v => v + a.c), color: c.ajuste, ancho: 1, guiones: [4, 4], nombre: 'envolvente' }, { x: tr.t, y: envN, color: c.ajuste, ancho: 1, guiones: [4, 4] }],
    yEtiqueta: u, marcas: dl ? dl.picos.map(p => ({ x: p.t, y: p.y + a.c, color: c.x })) : [] });
  GR.resid.set({ series: [{ x: tr.t, y: a.resid, color: c.muted, ancho: 1 }] });
}
function hacerPendulo() {
  const g = E.actual; if (!g) { $('resPendulo').innerHTML = sinGrabacion(); return; }
  if (!g.flujos.gyr) { $('resPendulo').innerHTML = '<p class="error">Esta grabación no tiene giroscopio.</p>'; return; }
  const r = remuestreado(g, 'gyr', $('aInterp').value); let eje = $('pEje').value;
  if (eje === 'auto') { const v = ['x', 'y', 'z'].map(e => D.estadisticos(r[e]).rms); eje = ['x', 'y', 'z'][v.indexOf(Math.max(...v))]; }
  let t = r.t, w = r[eje];
  if (E.sel) { const i0 = Math.max(0, Math.round((E.sel[0] - r.t[0]) * r.fs)), i1 = Math.min(r.n, Math.round((E.sel[1] - r.t[0]) * r.fs) + 1); t = t.subarray(i0, i1); w = w.subarray(i0, i1); }
  const L = num('pL', 0.75), p = D.pendulo(t, w, L);
  if (!p) { $('resPendulo').innerHTML = '<p class="error">No se encontraron al menos 3 ciclos de oscilación en el eje ' + esc(eje) + '.</p>'; return; }
  const deg = 180 / Math.PI;
  $('resPendulo').innerHTML = `<div class="indic">${indic([['g (exacta, K(k))', conInc(p.g, p.sg), 'm/s²'], ['Periodo T', conInc(p.T, p.sT), 's'], ['Amplitud θ₀ (ω·T)', conInc(p.th0 * deg, p.sth0 * deg), '°'], ['θ₀ integrando ω', fmt(p.thInt * deg, 2), '°'],
    ['g ángulo pequeño', conInc(p.g0, p.sg0), 'm/s² (sesgada)'], ['g con serie en θ₀²', fmt(p.gSerie, 4), 'm/s² (T₀(1+θ₀²/16+…))'], ['Ciclos', p.n, 'eje ' + esc(eje)], ['Media de ω', fsig(p.sesgo, 3), 'rad/s (se resta)']])}</div>
    <p class="nota">Incertidumbres: error estándar entre ciclos (estadístico). El error de L se propaga como σ_g/g = σ_L/L: con L = ${fmt(L, 3)} m y σ_L = 2 mm, ≈ ${fmt(100 * 0.002 / L, 2)} %.</p>`;
  const c = COL(); $('gPendulo').hidden = false;
  GR.pend.set({ series: [{ x: t, y: p.theta.map(v => v * deg), color: c.x, ancho: 1.2, nombre: 'θ integrado (°)' }, { x: p.ciclos.map(q => q.t), y: p.ciclos.map(q => q.th0 * deg), color: c.ajuste, puntos: true, nombre: 'θ₀ por ciclo (°)' }], yEtiqueta: '°' });
}

/* ============================================================ MÁQUINAS */
function senalMaquina() {
  const g = E.actual; if (!g) return null; const flujo = g.flujos.lin ? 'lin' : 'acc', r = remuestreado(g, flujo, 'cubica'); if (!r) return null;
  let eje = $('mEje').value; const sel = E.sel;
  const corta = y => { if (!sel) return y; const i0 = Math.max(0, Math.round((sel[0] - r.t[0]) * r.fs)), i1 = Math.min(r.n, Math.round((sel[1] - r.t[0]) * r.fs) + 1); return y.slice(i0, i1); };
  if (eje === 'auto') { const v = ['x', 'y', 'z'].map(e => D.estadisticos(corta(r[e])).rms); eje = ['x', 'y', 'z'][v.indexOf(Math.max(...v))]; }
  const y = quitarMedia(corta(ejeDe(r, eje)));
  return { y, fs: r.fs, eje, flujo };
}
function renderMaquinas() {
  const s = senalMaquina();
  if (!s || s.y.length < 256) { $('mGlobal').innerHTML = sinGrabacion(); $('tArm').innerHTML = $('mDiag').innerHTML = $('mAvisos').innerHTML = ''; GR.maq.set({ series: [] }); renderRef(null); return; }
  const c = COL(), ny = s.fs / 2, fmin = Math.max(0.5, num('mFmin', 10)), clase = $('mClase').value;
  const nseg = Math.max(256, Math.min(D.potInferior2(s.y.length / 4), D.siguientePot2(s.fs * 8)));
  const esp = D.welch(s.y, s.fs, { nseg, ventana: 'hann' }), vel = D.integrarEspectro(esp, 1, fmin);
  const vrms = D.rmsBanda(vel, fmin, ny) * 1e3, arms = D.rmsBanda(esp, fmin, ny), st = D.estadisticos(s.y), zona = D.zona20816(vrms, clase);
  const rpm = num('mRpm', NaN), arm = D.armonicos(s.y, s.fs, esp, { fmin: Math.min(fmin, 2), f1: isFinite(rpm) && rpm > 0 ? rpm / 60 : undefined });
  $('mGlobal').innerHTML = indic([[`v RMS ${fmt(fmin, 0)}–${fmt(ny, 0)} Hz`, fmt(vrms, 2), 'mm/s'], ['Zona orientativa', zona, D.ZONAS_20816[clase].lim.map(v => fmt(v, 1)).join(' / ') + ' mm/s'], [`a RMS ${fmt(fmin, 0)}–${fmt(ny, 0)} Hz`, fsig(arms, 3), 'm/s²'],
    ['Pico de a', fsig(st.pico, 3), 'm/s²'], ['Cresta', fmt(st.cresta, 2), ''], ['Curtosis', fmt(st.curtosis, 2), '> 3: impactos'], ['1× (f₁)', arm ? conInc(arm.f1, arm.sf1, 'Hz') : '—', arm ? fmt(arm.rpm, 0) + ' rpm' : ''], ['Eje', esc(s.eje), esc(S.FLUJOS[s.flujo].corto)]]);
  const avisos = [`<p class="aviso">ISO 20816 mide la velocidad RMS entre 10 y 1000 Hz con un acelerómetro fijo a la carcasa. Esta medición cubre solo ${fmt(fmin, 0)}–${fmt(ny, 1)} Hz (Nyquist): <b>la zona es solo orientativa</b> y subestima si hay vibración por encima de ${fmt(ny, 0)} Hz.</p>`,
    `<p class="aviso"><b>Aliasing:</b> una máquina que gire a más de ${fmt(ny * 60, 0)} rpm (Nyquist × 60) muestra su 1× en una frecuencia falsa. Un armónico f aparece en |f − m·fs| (el m que lo deja en 0–${fmt(ny, 1)} Hz). Ejemplo con esta fs: un motor de 3550 rpm (59,2 Hz) aparecería en ${fmt(Math.abs(59.17 - Math.round(59.17 / s.fs) * s.fs), 1)} Hz.</p>`];
  if (isFinite(rpm) && rpm / 60 > ny) avisos.push(`<p class="error">La velocidad indicada (${fmt(rpm / 60, 2)} Hz) supera Nyquist: su 1× se verá en ${fmt(Math.abs(rpm / 60 - Math.round(rpm / 60 / s.fs) * s.fs), 2)} Hz.</p>`);
  $('mAvisos').innerHTML = avisos.join('');
  const vamp = vel.amp.map(v => v / Math.SQRT2 * 1e3);
  GR.maq.set({ series: [{ x: vel.f, y: vamp, color: c.x, ancho: 1.3 }], xr: [0, ny], marcas: arm ? arm.lista.map(h => ({ x: h.f, texto: h.k + '×', color: c.ajuste })) : [], xNombre: 'f', xUnidad: 'Hz' });
  if (arm) {
    const k_ = (k, f) => `<b>${k}×</b><br><small class="nota">${fmt(f * 60, 0)} cpm</small>`;
    const filas = arm.lista.map(h => [k_(h.k, h.f), fmt(h.f, 3), fmt(h.velRMS * 1e3, 3), fsig(h.ampAcc / Math.SQRT2, 3), fmt(100 * h.velRMS / arm.lista[0].velRMS, 0) + ' %']);
    const alias = []; for (let k = arm.kmax + 1; k <= Math.max(4, arm.kmax + 2); k++) { const f = k * arm.f1, fa = Math.abs(f - Math.round(f / s.fs) * s.fs); alias.push(`${k}× (${fmt(f, 2)} Hz) → aparece en <b>${fmt(fa, 2)} Hz</b>`); }
    $('tArm').innerHTML = tabla(['k', 'f (Hz)', 'v mm/s', 'a m/s²', '% de 1×'], filas) + '<p class="nota">Valores RMS por línea.</p>' +
      `<p class="aviso">Sobre Nyquist (${fmt(ny, 1)} Hz), no medibles y doblados por aliasing: ${alias.join('; ')}. Un pico en esas frecuencias puede ser un armónico alto, no una vibración real de esa frecuencia.</p>` + (isFinite(arm.dispersion) ? `<p class="nota">Estabilidad de la velocidad: f₁ por cuartos del registro varía ±${fmt(arm.dispersion, 4)} Hz (${fmt(arm.dispersion * 60, 1)} rpm); σ de f₁ = máx(σ de tono ${fsig(arm.sf1Tono, 2)} Hz, dispersión/2).</p>` : '');
  } else $('tArm').innerHTML = '<p class="nota">No se encontró una frecuencia de giro clara.</p>';
  $('mDiag').innerHTML = arm ? D.diagnosticoMaquina(arm).map(([t, d]) => `<p><b>${t}.</b> ${d}</p>`).join('') : '<p class="nota">Sin datos suficientes.</p>';
  $('comoMaq').innerHTML = `<b>Cómo se calcula:</b> PSD de Welch (Hann, ${esp.nseg} muestras, Δf = ${fmt(esp.df, 3)} Hz) de la aceleración sin gravedad; velocidad dividiendo por 2πf; v RMS = √(Σ PSD_v·Δf) en la banda. f₁: pico de velocidad más alto (o el rpm indicado), comprobando subarmónicos, afinado con la DTFT del registro completo; amplitud de cada k·f₁ por el mismo afinado (sin festoneo). Valores RMS = pico/√2.`;
  E.maqActual = { f: Array.from(vel.f), psd: Array.from(vel.psd), df: vel.df, fs: s.fs, eje: s.eje, fmin };
  renderRef(E.maqActual);
}
function renderRef(act) {
  const r = E.ref;
  $('txtRef').textContent = r ? `Referencia: «${r.nombre}» (${new Date(r.fecha).toLocaleString('es-DO', { dateStyle: 'short', timeStyle: 'short' })}, eje ${r.eje}, fs ${fmt(r.fs, 1)} Hz).` : 'Sin referencia guardada.';
  if (!r || !act) { $('gRef').hidden = true; $('tRef').innerHTML = ''; return; }
  const c = COL(), fmax = Math.min(r.fs, act.fs) / 2 * 0.98, fmin = Math.max(r.fmin, act.fmin, 1);
  const er = { f: r.f, psd: r.psd, df: r.df }, ea = { f: act.f, psd: act.psd, df: act.df };
  const br = D.bandasLog(er, fmin, fmax, 10), ba = D.bandasLog(ea, fmin, fmax, 10);
  $('gRef').hidden = false;
  const db = (e) => e.psd.map(v => v > 0 ? 10 * Math.log10(v * 1e6) : NaN);
  GR.ref.set({ series: [{ x: er.f, y: db(er), color: c.muted, ancho: 1.2, nombre: 'referencia' }, { x: ea.f, y: db(ea), color: c.x, ancho: 1.3, nombre: 'actual' }], xr: [0, fmax], yEtiqueta: 'dB re 1 (mm/s)²/Hz' });
  const filas = br.centros.map((cf, k) => { const d = ba.dB[k] - br.dB[k]; return [`${fmt(br.lim[k], 1)}–${fmt(br.lim[k + 1], 1)}`, fmt(br.dB[k] + 60, 1), fmt(ba.dB[k] + 60, 1), (d > 0 ? '+' : '') + fmt(d, 1), Math.abs(d) >= 6 ? (d > 0 ? '<b class="mal">sube</b>' : '<b>baja</b>') : '']; });
  $('tRef').innerHTML = tabla(['Banda (Hz)', 'Ref. (dB)', 'Actual (dB)', 'Δ (dB)', 'Cambio ≥ 6 dB'], filas, i => Math.abs(ba.dB[i] - br.dB[i]) >= 6) + '<p class="nota">dB re 1 (mm/s)² (energía de velocidad en la banda).</p>';
}

/* ============================================================ ESTRUCTURAS */
function renderEstructuras() {
  const g = E.actual; const flujo = g && g.flujos[$('sFlujo').value] ? $('sFlujo').value : (g && g.flujos.lin ? 'lin' : 'acc');
  const r = g ? remuestreado(g, flujo, 'cubica') : null;
  if (!r || r.n < 512) { $('tModos').innerHTML = sinGrabacion(); $('tConfort').innerHTML = ''; GR.est.set({ series: [] }); GR.coh.set({ series: [] }); return; }
  const c = COL(), dfObj = +$('sDf').value, fmax = Math.min(num('sFmax', 20), r.fs / 2), T = r.n / r.fs;
  let nseg = D.siguientePot2(r.fs / dfObj); const nsegMax = D.potInferior2(r.n / 4); const limit = nseg > nsegMax; if (limit) nseg = nsegMax;
  const ys = {}; for (const e of ['x', 'y', 'z']) ys[e] = quitarMedia(Float64Array.from(r[e]));
  const esp = {}; for (const e of ['x', 'y', 'z']) esp[e] = D.welch(ys[e], r.fs, { nseg, ventana: 'hann' });
  const vert = $('sVert').value, todos = [];
  for (const e of ['x', 'y', 'z']) for (const m of D.modos(ys[e], r.fs, esp[e], { fmin: Math.max(0.3, 3 * esp[e].df), fmax, n: 5, promDb: 8 })) todos.push(Object.assign(m, { eje: e }));
  todos.sort((a, b) => b.psd - a.psd); const modos = [];
  for (const m of todos) if (modos.every(q => Math.abs(q.f - m.f) > 3 * esp.x.df)) modos.push(m);
  modos.sort((a, b) => a.f - b.f);
  const [p1, p2] = $('sPar').value.split('-'), coh = D.coherencia(ys[p1], ys[p2], r.fs, { nseg: Math.min(nseg, D.potInferior2(r.n / 8)) });
  const cohEn = f => coh.coh[Math.min(coh.coh.length - 1, Math.round(f / coh.df))];
  GR.est.set({ series: ['x', 'y', 'z'].map(e => ({ x: esp[e].f, y: esp[e].psd, color: c[e], ancho: 1.2, nombre: e + (e === vert ? ' (vertical)' : '') })), xr: [0, fmax], xNombre: 'f', xUnidad: 'Hz',
    marcas: modos.slice(0, 6).map((m, i) => ({ x: m.f, texto: fmt(m.f, 2), fila: i % 3 })) });
  $('tModos').innerHTML = modos.length ? tabla(['#', 'f ± σ (Hz)', 'ζ (½ pot.)', 'Eje', `γ² ${esc(p1)}–${esc(p2)}`],
    modos.map((m, i) => [i + 1, conInc(m.f, m.sf) + `<br><small class="nota">${fmt(m.promDb, 0)} dB sobre el fondo</small>`, m.limitado ? '<small>limitado por Δf</small>' : fmt(100 * m.zeta, 2) + ' %', m.eje + (m.eje === vert ? ' (v)' : ' (h)'), fmt(cohEn(m.f), 2)])) : '<p class="nota">Sin picos prominentes por debajo de la f máxima.</p>';
  $('comoEst').innerHTML = `<b>Cómo se calcula:</b> PSD de Welch (Hann, ${nseg} muestras ⇒ Δf = ${fmt(esp.x.df, 4)} Hz, ${esp.x.K} promedios en ${fmt(T / 60, 1)} min)${limit ? ' — <b>registro corto para la Δf pedida</b>' : ''}. Modos = picos prominentes de cada eje; ζ por ancho de media potencia (sesgada hacia arriba si el pico ocupa pocos bins: aumente la duración). σ_f ≈ √(ζ·f/(π·T)) para un modo excitado por ruido (aproximación), o la del tono si el pico es más angosto que la resolución.`;
  GR.coh.set({ series: [{ x: coh.f, y: coh.coh, color: c.mag, ancho: 1.2 }], xr: [0, fmax], yr: [0, 1.02], marcas: modos.slice(0, 4).map(m => ({ x: m.f })) });
  // confort ISO 2631-1
  const filas = [], aws = [];
  for (const e of ['x', 'y', 'z']) {
    const tipo = e === vert ? 'Wk' : 'Wd', k = D.confortISO2631(ys[e], r.fs, tipo); aws.push(k.aw);
    filas.push([e + (e === vert ? ' (v)' : ' (h)'), tipo, fsig(k.aw, 3), fsig(k.vdv, 3), fsig(k.mtvv, 3), fmt(k.cresta, 1) + (k.cresta > 9 ? '<br><small>&gt; 9: use VDV</small>' : '')]);
  }
  const av = Math.hypot(...aws), pv = D.confortISO2631(ys[vert], r.fs, 'Wk').pico;
  filas.push(['<b>a_v</b>', 'k = 1', `<b>${fsig(av, 3)}</b>`, '', '', '']);
  $('tConfort').innerHTML = tabla(['Eje', 'Pond.', 'a_w m/s²', 'VDV m/s<sup>1,75</sup>', 'MTVV m/s²', 'Cresta'], filas) +
    `<p class="nota">Percepción vertical: pico ponderado ${fsig(pv, 3)} m/s² frente a ≈ 0,015 m/s² (umbral medio) ⇒ <b>${pv > 0.015 ? 'probablemente perceptible' : 'probablemente imperceptible'}</b>. ${r.fs / 2 < 80 ? `La ponderación llega a 80 Hz, pero el registro solo cubre hasta ${fmt(r.fs / 2, 1)} Hz.` : ''} El teléfono debe estar apoyado firme: si se mueve o vibra sobre la funda, los valores no son válidos.</p>`;
  $('tTablaConfort').innerHTML = tabla(['a_w (m/s²)', 'Reacción probable (ISO 2631-1, anexo C)'], D.TABLA_CONFORT.map(([a, b, t]) => [`${fmt(a, 3)} – ${isFinite(b) ? fmt(b, 3) : '…'}`, t]), i => av >= D.TABLA_CONFORT[i][0] && av < D.TABLA_CONFORT[i][1]);
}

/* ============================================================ SENSOR */
function renderSensor() {
  const g = E.actual;
  renderCalibracion();
  if (!g) { $('tRuido').innerHTML = sinGrabacion(); $('tAllan').innerHTML = ''; GR.allan.set({ series: [] }); GR.jitter.set({ series: [] }); return; }
  const c = COL(), filas = [], deg = 180 / Math.PI;
  for (const fl of ['acc', 'gyr']) {
    const r = remuestreado(g, fl, 'cubica'); if (!r) continue;
    for (const e of ['x', 'y', 'z']) {
      const y = r[e], m = D.media(y), sd = D.desv(y), esp = D.welch(y, r.fs, { nseg: Math.min(4096, D.potInferior2(r.n / 8)) });
      const sel = []; for (let i = 0; i < esp.f.length; i++) if (esp.f[i] >= 1 && esp.f[i] <= 0.8 * r.fs / 2) sel.push(esp.psd[i]);
      const dens = Math.sqrt(D.mediana(sel));
      const sm = t => `<br><small class="nota">${t}</small>`;
      if (fl === 'acc') filas.push([`a<sub>${e}</sub>`, `${fmt(m, 4)} m/s²`, `${fsig(sd, 3)} m/s²`, `${fmt(dens / 9.80665e-6, 0)} µg/√Hz` + sm(`${fsig(dens, 3)} (m/s²)/√Hz`)]);
      else filas.push([`ω<sub>${e}</sub>`, `${fmt(m * deg * 3600, 0)} °/h` + sm(`${fmt(m * 1e3, 3)} mrad/s`), `${fsig(sd * 1e3, 3)} mrad/s`, `${fmt(dens * deg * 3600, 1)} (°/h)/√Hz` + sm(`${fsig(dens * 1e3, 3)} mrad/s/√Hz`)]);
    }
  }
  $('tRuido').innerHTML = tabla(['Eje', 'Media (sesgo)', 'σ', 'Densidad de ruido'], filas) + '<p class="nota">En el acelerómetro con gravedad, la media del eje vertical incluye g. ' + (g.cal ? 'La grabación ya tiene la calibración aplicada.' : '') + '</p>';
  // Allan
  const fl = g.flujos[$('alFlujo').value] ? $('alFlujo').value : 'acc', r = remuestreado(g, fl, 'cubica');
  if (r) {
    const series = [], filasA = [];
    for (const e of ['x', 'y', 'z']) {
      const al = D.allan(r[e], r.fs, { puntosPorDecada: 8 }), co = D.coefAllan(al), sl = D.pendienteLogLog(al.tau, al.adev, al.tau[0], Math.min(1, al.tau[al.tau.length - 1]));
      series.push({ x: al.tau, y: fl === 'gyr' ? al.adev.map(v => v * deg * 3600) : al.adev.map(v => v / 9.80665e-6), color: c[e], ancho: 1.5, nombre: e });
      if (!co) continue;
      const pend = sl ? `<br><small class="nota">pendiente ${fmt(sl.pendiente, 2)} (τ ≤ 1 s)</small>` : '', tb = `<br><small class="nota">en τ = ${fsig(co.tauB, 2)} s${co.minimoEnBorde ? ' · registro corto' : ''}</small>`;
      if (fl === 'gyr') filasA.push([e, `${fmt(co.N * deg * 60, 3)} °/√h` + pend, `${fmt(co.B * deg * 3600, 1)} °/h` + tb, isFinite(co.K) ? `${fsig(co.K * deg * 3600 * 60, 3)} °/h/√h` : '—']);
      else filasA.push([e, `${fsig(co.N * 60, 3)} (m/s)/√h` + pend, `${fmt(co.B / 9.80665e-6, 1)} µg` + tb, isFinite(co.K) ? `${fsig(co.K, 3)} m/s²/√s` : '—']);
    }
    const unidad = fl === 'gyr' ? '°/h' : 'µg';
    GR.allan.set({ series, yEtiqueta: 'σ_A (' + unidad + ')', xNombre: 'τ', xUnidad: 's' });
    $('tAllan').innerHTML = tabla(['Eje', fl === 'gyr' ? 'ARW (N)' : 'VRW (N)', 'Inestab. de sesgo (B)', 'K (+½)'], filasA) + `<p class="nota">Duración ${fmt(r.n / r.fs / 60, 1)} min: para ver la inestabilidad de sesgo y K se necesitan registros largos en reposo (≥ 20 min).</p>`;
  }
  // jitter
  const base = g.flujos.acc || g.flujos.lin || g.flujos.gyr, m = D.analizarMuestreo(base.t), dms = Array.from(m.dt, v => v * 1000);
  const lo = D.percentil(dms, 0.5), hi = D.percentil(dms, 99.5), dentro = dms.filter(v => v >= lo && v <= hi), h = D.histograma(dentro, 40, lo, hi + 1e-9);
  GR.jitter.set({ series: [{ x: Array.from(h.cuentas, (_, i) => h.min + (i + 0.5) * h.ancho), y: Array.from(h.cuentas), color: c.x, barras: true }], xr: [h.min, h.max], yr: [0, Math.max(...h.cuentas) * 1.08] });
  $('txtJitter').innerHTML = `Mediana Δt ${fmt(1000 * m.dtMediana, 3)} ms (${fmt(m.fsMediana, 2)} Hz) · σ(Δt) = ${fmt(1000 * m.jitter, 3)} ms · mín ${fmt(1000 * m.dtMin, 2)} · máx ${fmt(1000 * m.dtMax, 1)} ms · huecos ${m.huecos.length}. Histograma del 99 % central (${dms.length - dentro.length} valores extremos fuera). fs efectiva ${fmt(m.fs, 3)} Hz. Con DeviceMotion, la marca es la hora de entrega del evento (no la de medida), por lo que el jitter real del sensor suele ser menor que el mostrado.`;
}
const POSICIONES = [['zp', '+Z arriba', 'pantalla arriba', [0, 0, 1]], ['zn', '−Z arriba', 'pantalla abajo', [0, 0, -1]], ['yp', '+Y arriba', 'de pie, cámara arriba', [0, 1, 0]], ['yn', '−Y arriba', 'de pie, cámara abajo', [0, -1, 0]], ['xp', '+X arriba', 'de lado, borde derecho arriba', [1, 0, 0]], ['xn', '−X arriba', 'de lado, borde izquierdo arriba', [-1, 0, 0]]];
function renderCalibracion() {
  $('calBotones').innerHTML = POSICIONES.map(([k, t, d]) => `<button class="btn${E.calMed[k] ? ' hecho' : ''}" data-pos="${k}">${t}<br><small style="font-weight:400">${E.calMed[k] ? E.calMed[k].map(v => fmt(v, 3)).join(' ') : d}</small></button>`).join('');
  const listo = POSICIONES.every(([k]) => E.calMed[k]);
  if (listo) {
    E.calRes = D.calibrar6(E.calMed, num('gLocal', 9.78));
    $('resCal').innerHTML = tabla(['Eje', 'Ganancia', 'Offset (m/s²)'], ['x', 'y', 'z'].map((e, i) => [e, fmt(E.calRes.ganancia[i], 5), fmt(E.calRes.offset[i], 4)])) +
      `<p class="nota">Residuo | |a_cal| − g | por posición: ${Object.entries(E.calRes.residuos).map(([k, v]) => `${k} ${fmt(Math.abs(v), 4)}`).join(', ')} m/s² (≈ 0 si los ejes están bien alineados y el teléfono nivelado).</p>`;
  } else $('resCal').innerHTML = '';
  $('btnAplicarCal').disabled = !listo;
  const c = E.cal;
  $('txtCal').innerHTML = c ? `Calibración activa: ${c.acc ? `acelerómetro (ganancias ${c.acc.ganancia.map(v => fmt(v, 4)).join(', ')}; offsets ${c.acc.offset.map(v => fmt(v, 3)).join(', ')} m/s²)` : 'acelerómetro sin calibrar'}; ${c.gyr ? `sesgo del giroscopio ${c.gyr.sesgo.map(v => fmt(v * 1e3, 2)).join(', ')} mrad/s` : 'giroscopio sin sesgo medido'}. Se aplica a las grabaciones nuevas.` : 'Sin calibración: se usan los valores de fábrica.';
}
async function medirPromedio(flujo, seg, txt) {
  if (!E.cap.activa) { aviso('Primero inicie los sensores (o el modo DEMO) en la pestaña Medir.'); return null; }
  const calPrev = E.cap.cal; E.cap.cal = null; $('txtCal').textContent = txt;
  await new Promise(r => setTimeout(r, 400)); const t0 = E.cap.anillos[flujo].ultimoT;
  await new Promise(r => setTimeout(r, seg * 1000));
  const d = E.cap.anillos[flujo].desde(t0); E.cap.cal = calPrev;
  if (d.t.length < 5) { aviso('No llegaron suficientes muestras.'); return null; }
  return [D.media(d.x), D.media(d.y), D.media(d.z)];
}
async function medirPosicion(k) {
  const p = POSICIONES.find(q => q[0] === k); if (E.cap.generador) E.cap.generador.orientacion = p[3];
  const v = await medirPromedio('acc', 3, `Midiendo «${p[1]}» (3 s)… no toque el teléfono.`); if (E.cap.generador) E.cap.generador.orientacion = [0, 0, 1];
  if (v) E.calMed[k] = v; renderCalibracion();
}

/* ============================================================ GRABACIONES */
function renderGrabaciones() {
  const el = $('listaGrab');
  if (!E.lista.length) { el.innerHTML = '<p class="nota">Aún no hay grabaciones.</p>'; $('btnComparar').disabled = true; return; }
  el.innerHTML = E.lista.map(g => {
    const b = g.flujos.acc || g.flujos.lin || g.flujos.gyr, fs = (b.t.length - 1) / (b.t[b.t.length - 1] - b.t[0]);
    return `<div class="item-grab" data-id="${esc(g.id)}"><div class="tit"><input type="checkbox" class="marcaComp" aria-label="Marcar para comparar"><span class="nom">${esc(g.nombre || 'sin nombre')}</span>${E.actual && E.actual.id === g.id ? '<span class="chip">actual</span>' : ''}</div>
      <div class="meta">${new Date(g.fecha).toLocaleString('es-DO', { dateStyle: 'medium', timeStyle: 'short' })} · ${esc(fuenteTxt(g.fuente))} · ${fmt(g.duracion, 1)} s · ${fmt(fs, 1)} Hz · ${esc(Object.keys(g.flujos).join(', '))}${g.cal ? ' · calibrada' : ''}</div>
      <div class="grupo acciones"><button class="btn peq" data-acc="abrir">Abrir</button><button class="btn peq" data-acc="renombrar">Renombrar</button><button class="btn peq" data-acc="csv">CSV crudo</button><button class="btn peq" data-acc="csvr">CSV remuestreado</button><button class="btn peq" data-acc="json">JSON</button><button class="btn peq peligro" data-acc="borrar">Borrar</button></div></div>`;
  }).join('');
  if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(e => { $('txtAlmac').textContent = `${E.lista.length} · ${fmt(e.usage / 1e6, 1)} MB usados`; }).catch(() => {});
  actualizarComparar();
}
function actualizarComparar() { $('btnComparar').disabled = document.querySelectorAll('.marcaComp:checked').length !== 2; }
function descargar(nombre, texto, tipo) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([texto], { type: tipo })); a.download = nombre; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }
const nombreArchivo = g => (g.nombre || 'vibra').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '_').slice(0, 60);
function csvCrudo(g) {
  const L = [`# Vibra · ${g.nombre} · ${g.fecha} · fuente ${g.fuente}`, '# flujo: acc/lin m/s², gyr rad/s, mag µT; t en s desde la primera muestra (marcas originales)', 'flujo,t_s,x,y,z'];
  for (const [f, d] of Object.entries(g.flujos)) for (let i = 0; i < d.t.length; i++) L.push(`${f},${d.t[i].toFixed(6)},${d.x[i]},${d.y[i]},${d.z[i]}`);
  return L.join('\n');
}
function csvRemuestreado(g) {
  const fls = Object.keys(g.flujos), rs = fls.map(f => remuestreado(g, f, 'cubica')), fs = rs[0].fs;
  let t0 = -Infinity, t1 = Infinity; for (const f of fls) { const t = g.flujos[f].t; t0 = Math.max(t0, t[0]); t1 = Math.min(t1, t[t.length - 1]); }
  const cols = fls.map(f => ['x', 'y', 'z'].map(e => D.remuestrear(g.flujos[f].t, g.flujos[f][e], fs, 'cubica', t0, t1)));
  const L = [`# Vibra · ${g.nombre} · remuestreado (Hermite cúbica) a ${fs} Hz`, 't_s,' + fls.map(f => ['x', 'y', 'z'].map(e => `${f}_${e}`).join(',')).join(',')];
  for (let i = 0; i < cols[0][0].length; i++) L.push((t0 + i / fs).toFixed(6) + ',' + cols.map(c => c.map(v => v[i].toPrecision(8)).join(',')).join(','));
  return L.join('\n');
}
function aJSON(g) { const o = Object.assign({}, g, { flujos: {} }); for (const [f, d] of Object.entries(g.flujos)) o.flujos[f] = { t: Array.from(d.t), x: Array.from(d.x), y: Array.from(d.y), z: Array.from(d.z) }; o.formato = 'vibra-1'; return JSON.stringify(o); }
/** JSON de Vibra (formato vibra-1) u objeto equivalente: se valida campo por campo (ver normGrab). */
function desdeObjeto(o, cnt = contador()) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('el JSON no es una grabación de Vibra');
  const g = normGrab(o, true, cnt);
  if (!g) throw new Error('el archivo no tiene datos válidos de acelerómetro, aceleración lineal o giroscopio (al menos 3 muestras numéricas)');
  return g;
}
/** CSV de Vibra (flujo,t,x,y,z) o de phyphox/otros (tiempo + 3 columnas por sensor, detectado por el encabezado).
 *  Los valores se leen como números (celda vacía o texto = muestra inválida, que se descarta y se cuenta). */
function desdeCSV(texto0, nombre, cnt = contador()) {
  const lineas = texto0.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
  if (lineas.length < 4) throw new Error('el CSV no tiene suficientes filas');
  const sep = [',', ';', '\t'].map(s => [s, lineas[0].split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  // con separador «;» o tabulador se acepta la coma decimal (phyphox «punto y coma, coma decimal»)
  const nv = v => { const t = v.replace(/"/g, '').trim(); return t === '' ? NaN : Number(sep === ',' ? t : t.replace(',', '.')); };
  const cab = lineas[0].split(sep).slice(0, 200).map(s => s.replace(/"/g, '').trim().toLowerCase().slice(0, 100));
  const flujos = {};
  if (cab[0] === 'flujo') {
    const L = {}; for (const l of lineas.slice(1)) { const p = l.split(sep), f = p[0].replace(/"/g, '').trim(); if (!tiene(S.FLUJOS, f)) { cnt.muestras++; continue; } (L[f] = L[f] || []).push(p.slice(1, 5).map(nv)); }
    for (const [f, a] of Object.entries(L)) flujos[f] = { t: Float64Array.from(a, r => r[0]), x: Float64Array.from(a, r => r[1]), y: Float64Array.from(a, r => r[2]), z: Float64Array.from(a, r => r[3]) };
  } else {
    const it = cab.findIndex(c => c.startsWith('time') || c.startsWith('t_s') || c === 't' || c.startsWith('tiempo')); if (it < 0) throw new Error('no se encontró la columna de tiempo');
    const filas = lineas.slice(1).map(l => l.split(sep).map(nv));
    const tipoDe = c => /gyr|rad\/s|rotation|giro/.test(c) ? 'gyr' : /magnet|^mag|µt|\but\b/.test(c) ? 'mag' : /linear|without|sin g|lin_/.test(c) ? 'lin' : /acc|m\/s\^2|m\/s²/.test(c) ? 'acc' : null;
    const grupos = {}; cab.forEach((c, j) => { if (j === it) return; const f = tipoDe(c), e = /(^|[\s_])x\b|_x$| x /.test(c) ? 'x' : /(^|[\s_])y\b|_y$| y /.test(c) ? 'y' : /(^|[\s_])z\b|_z$| z /.test(c) ? 'z' : null; if (f && e) (grupos[f] = grupos[f] || {})[e] = j; });
    for (const [f, ej] of Object.entries(grupos)) if (ej.x !== undefined && ej.y !== undefined && ej.z !== undefined)
      flujos[f] = { t: Float64Array.from(filas, r => r[it]), x: Float64Array.from(filas, r => r[ej.x]), y: Float64Array.from(filas, r => r[ej.y]), z: Float64Array.from(filas, r => r[ej.z]) };
  }
  return desdeObjeto({ nombre: String(nombre).replace(/\.\w+$/, ''), fuente: 'importada', flujos }, cnt);
}
async function importar(files) {
  for (const f of files) {
    try {
      if (f.size > LIM.archivoMB * 1e6) throw new Error(`pesa ${fmt(f.size / 1e6, 0)} MB (máximo ${LIM.archivoMB} MB)`);
      const txt = await f.text(), cnt = contador();
      let o = null; if (f.name.toLowerCase().endsWith('.json')) { try { o = JSON.parse(txt); } catch (e) { throw new Error('el JSON no se puede leer'); } }
      const g = o ? desdeObjeto(o, cnt) : desdeCSV(txt, f.name, cnt);
      await agregarGrabacion(g, false); const d = txtDescartes(cnt);
      aviso(`Importada «${g.nombre}».` + (d ? ' ' + d : ''));
    } catch (e) { aviso(`No se pudo importar ${f.name}: ${e.message}`); }
  }
  renderGrabaciones();
}
function accionGrabacion(id, acc, item) {
  const g = E.lista.find(q => q.id === id); if (!g) return;
  if (acc === 'abrir') { seleccionar(id); irA('analizar'); }
  else if (acc === 'csv') descargar(nombreArchivo(g) + '_crudo.csv', csvCrudo(g), 'text/csv');
  else if (acc === 'csvr') descargar(nombreArchivo(g) + '_remuestreado.csv', csvRemuestreado(g), 'text/csv');
  else if (acc === 'json') descargar(nombreArchivo(g) + '.json', aJSON(g), 'application/json');
  else if (acc === 'renombrar') {
    const nom = item.querySelector('.nom'); nom.innerHTML = `<input type="text" value="${esc(g.nombre || '')}" style="width:100%"> `;
    const inp = nom.querySelector('input'); inp.focus(); inp.select();
    const fin = async () => { g.nombre = texto(inp.value) || g.nombre; try { await BD.guardar(g); } catch (e) { /* solo memoria */ } renderGrabaciones(); renderSelector(); };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') fin(); if (e.key === 'Escape') renderGrabaciones(); }); inp.addEventListener('blur', fin);
  } else if (acc === 'borrar') {
    const ac = item.querySelector('.acciones');
    ac.innerHTML = `<span class="mal" style="font-weight:600">¿Borrar «${esc(g.nombre)}» definitivamente?</span><button class="btn peq peligro" data-acc="borrarSi">Sí, borrar</button><button class="btn peq" data-acc="borrarNo">No</button>`;
  } else if (acc === 'borrarNo') renderGrabaciones();
  else if (acc === 'borrarSi') {
    (async () => { try { await BD.borrar(id); } catch (e) { /* nada */ } E.lista = E.lista.filter(q => q.id !== id); if (E.actual && E.actual.id === id) seleccionar(E.lista[0] ? E.lista[0].id : null); renderGrabaciones(); renderSelector(); })();
  }
}
function renderComparacion() {
  const ids = [...document.querySelectorAll('.marcaComp:checked')].map(c => c.closest('.item-grab').dataset.id), gs = ids.map(id => E.lista.find(g => g.id === id));
  if (gs.length !== 2) return; $('cardComp').hidden = false;
  const c = COL(), fl = $('cFlujo').value, eje = $('cEje').value, esps = [], cols = [c.muted, c.x];
  for (const g of gs) {
    const f = g.flujos[fl] ? fl : Object.keys(g.flujos)[0], r = remuestreado(g, f, 'cubica'), y = quitarMedia(ejeDe(r, eje));
    esps.push(D.welch(y, r.fs, { nseg: Math.max(256, Math.min(D.potInferior2(y.length / 6), 8192)) }));
  }
  const fmax = Math.min(esps[0].fs, esps[1].fs) / 2;
  GR.comp.set({ series: esps.map((e, i) => ({ x: e.f, y: e.psd, color: cols[i], ancho: 1.3, nombre: i ? 'B' : 'A' })), xr: [0, fmax], yEtiqueta: `(${UNID[fl][0].u})²/Hz` });
  const fmin = Math.max(0.5, 2 * Math.max(esps[0].df, esps[1].df)), b = esps.map(e => D.bandasLog(e, fmin, 0.98 * fmax, 10));
  $('tComp').innerHTML = tabla(['Banda (Hz)', 'A (dB)', 'B (dB)', 'B − A (dB)'], b[0].centros.map((_, k) => [`${fmt(b[0].lim[k], 2)}–${fmt(b[0].lim[k + 1], 2)}`, fmt(b[0].dB[k], 1), fmt(b[1].dB[k], 1), ((b[1].dB[k] - b[0].dB[k]) > 0 ? '+' : '') + fmt(b[1].dB[k] - b[0].dB[k], 1)]), k => Math.abs(b[1].dB[k] - b[0].dB[k]) >= 6) + `<p class="nota">dB re 1 (${UNID[fl][0].u})²: energía en cada banda logarítmica. Marcadas: diferencias ≥ 6 dB (el doble de amplitud).</p>`;
  $('txtComp').textContent = `A = «${gs[0].nombre}», B = «${gs[1].nombre}»`;
}

/* ============================================================ eventos */
function enlazar() {
  for (const b of document.querySelectorAll('nav.tabs button')) b.addEventListener('click', () => irA(b.dataset.tab));
  const optsDemo = Object.entries(S.DEMOS).map(([k, v]) => `<option value="${k}">${v.nombre}</option>`).join('');
  $('demoTipo').innerHTML = optsDemo; $('demoInstTipo').innerHTML = optsDemo;
  $('mClase').innerHTML = Object.entries(D.ZONAS_20816).map(([k, v]) => `<option value="${k}">${v.nombre}</option>`).join('');
  cargarConfig();
  const visDemo = () => { const d = $('fuente').value === 'demo'; $('lblDemo').hidden = $('lblDemoFs').hidden = !d; $('lblFreq').hidden = d || $('fuente').value === 'devicemotion'; };
  $('fuente').addEventListener('change', visDemo); visDemo();
  const descDemo = () => { $('demoDesc').textContent = S.DEMOS[$('demoInstTipo').value].desc; }; $('demoInstTipo').addEventListener('change', descDemo); descDemo();
  $('btnIniciar').onclick = iniciar; $('btnDetener').onclick = detener; $('btnGrabar').onclick = grabar; $('btnParar').onclick = terminarGrabacion;
  $('btnDemoInst').onclick = async () => { guardarConfig(); const g = S.grabacionSintetica($('demoInstTipo').value, +$('demoInstDur').value, +$('demoInstFs').value, Math.floor(Math.random() * 1e6)); await agregarGrabacion(g); irA(g.fuente === 'demo:maquina' || g.fuente === 'demo:maquina-falla' ? 'maquinas' : g.fuente === 'demo:estructura' ? 'estructuras' : g.fuente === 'demo:reposo' ? 'sensor' : 'analizar'); };
  $('btnDemoRapida').onclick = () => { irA('medir'); $('demoInstTipo').focus(); document.getElementById('btnDemoInst').scrollIntoView({ block: 'center' }); };
  $('selGrab').addEventListener('change', () => seleccionar($('selGrab').value));
  const re = (ids, fn) => ids.forEach(id => $(id).addEventListener('change', () => { guardarConfig(); try { fn(); } catch (e) { console.error(e); aviso(e.message); } }));
  const visFiltro = () => { const t = $('aFiltro').value; $('lblF1').hidden = !(t === 'alto' || t === 'banda'); $('lblF2').hidden = !(t === 'bajo' || t === 'banda'); $('lblOrden').hidden = t === 'no'; };
  $('aFiltro').addEventListener('change', visFiltro); visFiltro();
  re(['aFlujo', 'aEje', 'aQuitarMedia', 'aInterp', 'aFiltro', 'aF1', 'aF2', 'aOrden'], () => { E.ajuste = null; renderAnalizar(true); });
  re(['eMag', 'eTipo', 'eEscala', 'eVent', 'eSeg', 'eFhp', 'eInterp'], () => renderAnalizar(false));
  re(['sgSeg', 'sgRango'], () => renderEspectrograma(senalAnalizar()));
  re(['mEje', 'mRpm', 'mFmin', 'mClase'], renderMaquinas);
  re(['sDf', 'sFmax', 'sFlujo', 'sPar', 'sVert'], renderEstructuras);
  re(['alFlujo', 'gLocal'], renderSensor);
  re(['cFlujo', 'cEje'], renderComparacion);
  re(['vivoFlujo', 'vivoEje', 'durGrab', 'cuentaGrab', 'disparo', 'umbral', 'preDisparo', 'pL', 'demoTipo', 'demoFs', 'usarMag', 'freqPedida', 'demoInstTipo', 'demoInstDur', 'demoInstFs'], () => {});
  $('btnTodo').onclick = () => { E.sel = null; E.zoom = null; E.ajuste = null; renderAnalizar(false); };
  $('btnZoom').onclick = () => { if (E.sel) { E.zoom = E.sel.slice(); renderAnalizar(false); } };
  $('btnDecae').onclick = detectarDecaimiento;
  $('btnAjuste').onclick = hacerAjuste; $('btnPendulo').onclick = hacerPendulo;
  $('btnGuardarRef').onclick = () => { if (!E.maqActual || !E.actual) return; E.ref = Object.assign({ nombre: E.actual.nombre, fecha: new Date().toISOString() }, E.maqActual); guardarLS('vibra-ref', E.ref); renderRef(E.maqActual); };
  $('btnBorrarRef').onclick = () => { E.ref = null; guardarLS('vibra-ref', null); renderRef(E.maqActual); };
  for (const b of document.querySelectorAll('[data-grabar]')) b.addEventListener('click', () => {
    const v = b.dataset.grabar; $('durGrab').value = v; $('cuentaGrab').value = '5'; $('disparo').checked = false; $('nombreGrab').value = 'Estructura ' + (v / 60) + ' min'; irA('medir'); grabar();
  });
  $('calBotones').addEventListener('click', e => { const b = e.target.closest('button[data-pos]'); if (b) medirPosicion(b.dataset.pos); });
  $('btnAplicarCal').onclick = () => { if (!E.calRes) return; E.cal = Object.assign({}, E.cal, { acc: { ganancia: E.calRes.ganancia, offset: E.calRes.offset, g: E.calRes.g, fecha: new Date().toISOString() } }); guardarLS('vibra-cal', E.cal); E.cap.cal = E.cal; renderCalibracion(); };
  $('btnSesgoGyr').onclick = async () => { const v = await medirPromedio('gyr', 10, 'Midiendo el sesgo del giroscopio (10 s)… no mueva el teléfono.'); if (v) { E.cal = Object.assign({}, E.cal, { gyr: { sesgo: v, fecha: new Date().toISOString() } }); guardarLS('vibra-cal', E.cal); E.cap.cal = E.cal; } renderCalibracion(); };
  $('btnBorrarCal').onclick = () => { E.cal = null; E.calMed = {}; E.calRes = null; guardarLS('vibra-cal', null); E.cap.cal = null; renderCalibracion(); };
  $('archivo').addEventListener('change', e => { importar([...e.target.files]); e.target.value = ''; });
  $('listaGrab').addEventListener('click', e => { const b = e.target.closest('button[data-acc]'); if (b) accionGrabacion(b.closest('.item-grab').dataset.id, b.dataset.acc, b.closest('.item-grab')); });
  $('listaGrab').addEventListener('change', e => { if (e.target.classList.contains('marcaComp')) actualizarComparar(); });
  $('btnComparar').onclick = renderComparacion;
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderTab());
}

/* ============================================================ arranque */
async function arrancar() {
  E.cal = normCal(leerLS('vibra-cal', null)); E.ref = normRef(leerLS('vibra-ref', null));
  crearGraficas(); enlazar();
  await cargarLista();
  // Parámetros de prueba: ?demo=tipo&dur=s&fs=Hz&tab=pestaña&vivo=1
  const demo = PARAM.get('demo');
  if (demo && tiene(S.DEMOS, demo)) {
    const g = S.grabacionSintetica(demo, +(PARAM.get('dur') || (demo === 'estructura' || demo === 'reposo' ? 600 : 40)), +(PARAM.get('fs') || 100), 7);
    await agregarGrabacion(g, false); seleccionar(g.id);
    if (PARAM.get('ref') === '1' && demo === 'maquina-falla') { const r = S.grabacionSintetica('maquina', 40, +(PARAM.get('fs') || 100), 3); E.lista.push(r); E.actual = r; cacheRem.clear(); renderMaquinas(); E.ref = Object.assign({ nombre: 'DEMO referencia', fecha: new Date().toISOString() }, E.maqActual); E.actual = g; cacheRem.clear(); }
  } else if (E.lista.length) seleccionar(E.lista[0].id);
  renderSelector(); renderGrabaciones();
  const tab = PARAM.get('tab'); irA(tab && $('tab-' + tab) ? tab : 'medir');
  if (demo && tab === 'analizar') { if (demo === 'pendulo') { $('pL').value = '0,75'; hacerPendulo(); } else { detectarDecaimiento(); hacerAjuste(); } }
  if (PARAM.get('vivo') === '1') { $('fuente').value = 'demo'; $('demoTipo').value = demo || 'amortiguado'; $('fuente').dispatchEvent(new Event('change')); iniciar(); }
  if (PARAM.get('grabar')) setTimeout(() => { $('durGrab').innerHTML += `<option value="${+PARAM.get('grabar')}">prueba</option>`; $('durGrab').value = PARAM.get('grabar'); $('cuentaGrab').value = PARAM.get('cuenta') || '0'; $('disparo').checked = PARAM.get('disparo') === '1'; $('umbral').value = PARAM.get('umbral') || '0,5'; grabar(); }, 1000);
  if (PARAM.get('cal') === '1') (async () => { await new Promise(r => setTimeout(r, 600)); for (const [k] of POSICIONES) await medirPosicion(k); })();
  // solo para capturas de prueba: ?ocultar=k oculta las primeras k tarjetas de la pestaña
  if (PARAM.get('ocultar')) [...document.querySelector('#tab-' + E.tab).children].slice(0, +PARAM.get('ocultar')).forEach(el => { el.hidden = true; });
  if (tab === 'grabaciones' && PARAM.get('comparar') === '1') { const r = S.grabacionSintetica('maquina-falla', 40, 100, 5); await agregarGrabacion(r, false); const cb = document.querySelectorAll('.marcaComp'); if (cb.length >= 2) { cb[0].checked = cb[1].checked = true; actualizarComparar(); renderComparacion(); } }
}
arrancar();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  const habia = !!navigator.serviceWorker.controller; let recargado = false;
  // si llega una versión nueva se recarga sola, salvo en medio de una medición
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (habia && !recargado && !E.grabando && !E.cap.activa) { recargado = true; location.reload(); } });
  navigator.serviceWorker.register('sw.js').then(r => { document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') r.update().catch(() => {}); }); }).catch(() => {});
}
