/* grafica.js — Gráficas científicas mínimas en <canvas>, sin librerías.
 * Ejes lineales o logarítmicos, varias series, marcas, bandas, imagen (espectrograma), selección de un intervalo
 * arrastrando y cursor con lectura de valores al tocar. Nítidas con devicePixelRatio. Colores desde variables CSS.
 */
(function (raiz) {
'use strict';

/** Mapa de color perceptual (viridis, aproximación polinómica de grado 6). t ∈ [0,1] → [r,g,b] 0–255. */
function viridis(t) {
  t = Math.max(0, Math.min(1, t));
  const c0 = [0.2777273272234177, 0.005407344544966578, 0.3340998053353061], c1 = [0.1050930431085774, 1.404613529898575, 1.384590162594685],
    c2 = [-0.3308618287255563, 0.214847559468213, 0.09509516302823659], c3 = [-4.634230498983486, -5.799100973351585, -19.33244095627987],
    c4 = [6.228269936347081, 14.17993336680509, 56.69055260068105], c5 = [4.776384997670288, -13.74514537774601, -65.35303263337234],
    c6 = [-5.435455855934631, 4.645852612178535, 26.3124352495832];
  return [0, 1, 2].map(i => Math.round(255 * Math.max(0, Math.min(1, c0[i] + t * (c1[i] + t * (c2[i] + t * (c3[i] + t * (c4[i] + t * (c5[i] + t * c6[i])))))))));
}

function ticksLin(a, b, n = 5) {
  const span = b - a; if (!(span > 0)) return [a];
  const paso0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(paso0))), r = paso0 / mag;
  const paso = (r < 1.5 ? 1 : r < 3.5 ? 2 : r < 7.5 ? 5 : 10) * mag, out = [];
  for (let v = Math.ceil(a / paso) * paso; v <= b + paso * 1e-9; v += paso) out.push(Math.abs(v) < paso * 1e-9 ? 0 : v);
  return out;
}
function ticksLog(a, b) {
  const out = [], men = []; const e0 = Math.floor(Math.log10(a)), e1 = Math.ceil(Math.log10(b));
  for (let e = e0; e <= e1; e++) for (const m of [1, 2, 5]) { const v = m * Math.pow(10, e); if (v >= a * 0.999 && v <= b * 1.001) (m === 1 ? out : men).push(v); }
  if (out.length < 2) return out.concat(men).sort((x, y) => x - y);
  return out;
}
function fmtNum(v) {
  if (v === 0) return '0'; const a = Math.abs(v);
  if (a >= 1e4 || a < 1e-3) { const e = Math.floor(Math.log10(a)), m = v / Math.pow(10, e); return (Math.abs(m - 1) < 1e-9 ? '' : (+m.toFixed(1)) + '·') + '10' + sup(e); }
  return String(+v.toPrecision(4)).replace('.', ',');
}
const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
const sup = e => String(e).split('').map(c => SUP[c]).join('');

class Grafica {
  /** op: {alto (px CSS), xlog, ylog, xEtiqueta, yEtiqueta, seleccionable, onSeleccion(x0,x1), onCursor(x,y)} */
  constructor(canvas, op = {}) {
    this.c = canvas; this.op = op; this.datos = { series: [] }; this.cursor = null;
    this.c.style.width = '100%'; this.c.style.height = (op.alto || 220) + 'px'; this.c.style.touchAction = op.seleccionable ? 'none' : 'pan-y';
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.dibujar()).observe(this.c);
    this._eventos();
  }
  set(datos) { this.datos = datos; this.dibujar(); }
  _colores() { const cs = getComputedStyle(this.c); const v = n => cs.getPropertyValue(n).trim(); return { fg: v('--fg') || '#111', muted: v('--muted') || '#666', line: v('--line') || '#ddd', grid: v('--grid') || '#eee', surface: v('--surface') || '#fff', acento: v('--acento') || '#2a78d6' }; }
  _rangos() {
    const d = this.datos, xlog = this.op.xlog || d.xlog, ylog = this.op.ylog || d.ylog;
    let xr = d.xr, yr = d.yr;
    if (!xr || !yr) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const s of d.series) for (let i = 0; i < s.x.length; i++) {
        const x = s.x[i], y = s.y[i]; if (!isFinite(x) || !isFinite(y) || (xlog && x <= 0) || (ylog && y <= 0)) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      if (!isFinite(x0)) { x0 = xlog ? 1 : 0; x1 = xlog ? 10 : 1; } if (!isFinite(y0)) { y0 = ylog ? 1 : 0; y1 = ylog ? 10 : 1; }
      if (!xr) xr = [x0, x1 > x0 ? x1 : x0 + 1];
      if (!yr) { if (ylog) yr = [y0 * 0.8, y1 * 1.25]; else { const m = (y1 - y0) * 0.06 || Math.abs(y0) * 0.1 || 1; yr = [y0 - m, y1 + m]; } }
    }
    return { xr, yr, xlog, ylog };
  }
  dibujar() {
    const c = this.c, dpr = raiz.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight; if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const col = this._colores(), d = this.datos, { xr, yr, xlog, ylog } = this._rangos();
    const fuente = '11px ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';
    g.font = fuente;
    const yt = ylog ? ticksLog(yr[0], yr[1]) : ticksLin(yr[0], yr[1], Math.max(3, Math.round(H / 55)));
    const anchoTick = Math.max(...yt.map(v => g.measureText(fmtNum(v)).width), 10);
    const L = Math.ceil(anchoTick) + ((this.op.yEtiqueta || d.yEtiqueta) ? 22 : 8), R = 10, T = d.titulo ? 22 : 10, B = 34;
    const pw = W - L - R, ph = H - T - B; if (pw < 20 || ph < 20) return;
    const tx = xlog ? v => L + pw * Math.log(v / xr[0]) / Math.log(xr[1] / xr[0]) : v => L + pw * (v - xr[0]) / (xr[1] - xr[0]);
    const ty = ylog ? v => T + ph * (1 - Math.log(v / yr[0]) / Math.log(yr[1] / yr[0])) : v => T + ph * (1 - (v - yr[0]) / (yr[1] - yr[0]));
    this._map = { tx, ty, L, T, pw, ph, xr, yr, xlog, ylog,
      ix: px => xlog ? xr[0] * Math.pow(xr[1] / xr[0], (px - L) / pw) : xr[0] + (px - L) / pw * (xr[1] - xr[0]),
      iy: py => ylog ? yr[0] * Math.pow(yr[1] / yr[0], 1 - (py - T) / ph) : yr[0] + (1 - (py - T) / ph) * (yr[1] - yr[0]) };
    // imagen (espectrograma)
    if (d.imagen) { g.imageSmoothingEnabled = false; const im = d.imagen; g.drawImage(im.canvas, tx(im.x0), ty(im.y1), tx(im.x1) - tx(im.x0), ty(im.y0) - ty(im.y1)); }
    // rejilla y ejes
    g.strokeStyle = col.grid; g.lineWidth = 1; g.fillStyle = col.muted; g.textAlign = 'right'; g.textBaseline = 'middle';
    for (const v of yt) { const y = Math.round(ty(v)) + 0.5; if (y < T - 1 || y > T + ph + 1) continue; if (!d.imagen) { g.beginPath(); g.moveTo(L, y); g.lineTo(L + pw, y); g.stroke(); } g.fillText(fmtNum(v), L - 4, y); }
    const xt = xlog ? ticksLog(xr[0], xr[1]) : ticksLin(xr[0], xr[1], Math.max(3, Math.round(pw / 70)));
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (const v of xt) { const x = Math.round(tx(v)) + 0.5; if (x < L - 1 || x > L + pw + 1) continue; if (!d.imagen) { g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke(); } g.fillText(fmtNum(v), x, T + ph + 4); }
    g.strokeStyle = col.line; g.strokeRect(L + 0.5, T + 0.5, pw, ph);
    if (this.op.xEtiqueta || d.xEtiqueta) { g.textAlign = 'right'; g.fillText(d.xEtiqueta || this.op.xEtiqueta, L + pw, T + ph + 19); }
    if (this.op.yEtiqueta || d.yEtiqueta) { g.save(); g.translate(10, T + ph / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(d.yEtiqueta || this.op.yEtiqueta, 0, 0); g.restore(); }
    if (d.titulo) { g.fillStyle = col.fg; g.textAlign = 'left'; g.textBaseline = 'top'; g.font = '600 12px system-ui, sans-serif'; g.fillText(d.titulo, L, 4); g.font = fuente; }
    g.save(); g.beginPath(); g.rect(L, T, pw, ph); g.clip();
    // bandas y selección
    for (const b of d.bandas || []) { g.fillStyle = b.color; g.fillRect(tx(b.x0), T, tx(b.x1) - tx(b.x0), ph); }
    if (d.seleccion) { g.fillStyle = col.acento; g.globalAlpha = 0.14; const a = tx(d.seleccion[0]), b = tx(d.seleccion[1]); g.fillRect(Math.min(a, b), T, Math.abs(b - a), ph); g.globalAlpha = 1; g.strokeStyle = col.acento; g.lineWidth = 1.5; for (const x of [a, b]) { g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke(); } }
    // series
    for (const s of d.series) {
      g.strokeStyle = s.color || col.fg; g.fillStyle = s.color || col.fg; g.lineWidth = s.ancho || 1.5; g.setLineDash(s.guiones || []); g.lineJoin = 'round';
      const n = s.x.length; if (!n) continue;
      if (s.puntos) { for (let i = 0; i < n; i++) { const x = s.x[i], y = s.y[i]; if (!isFinite(y) || (ylog && y <= 0) || (xlog && x <= 0)) continue; g.beginPath(); g.arc(tx(x), ty(y), s.radio || 3, 0, 6.283); g.fill(); } }
      if (s.barras) { const bw = Math.max(1, pw / n * 0.8); for (let i = 0; i < n; i++) { const y0 = ty(ylog ? yr[0] : Math.max(yr[0], 0)), y1 = ty(s.y[i]); g.fillRect(tx(s.x[i]) - bw / 2, Math.min(y0, y1), bw, Math.abs(y1 - y0)); } }
      if (s.puntos || s.barras) { g.setLineDash([]); continue; }
      g.beginPath(); let abierto = false;
      const diezmar = n > 3 * pw;
      if (diezmar) { // mínimo y máximo por columna de píxel (series con x creciente)
        let col0 = -1, mn = 0, mx = 0;
        const vaciar = () => { if (col0 < 0) return; const px = L + col0 + 0.5; if (!abierto) { g.moveTo(px, ty(mx)); abierto = true; } else g.lineTo(px, ty(mx)); g.lineTo(px, ty(mn)); };
        for (let i = 0; i < n; i++) {
          const x = s.x[i], y = s.y[i]; if (!isFinite(y) || (ylog && y <= 0) || (xlog && x <= 0)) continue;
          const cc = Math.floor(tx(x) - L); if (cc !== col0) { vaciar(); col0 = cc; mn = mx = y; } else { if (y < mn) mn = y; if (y > mx) mx = y; }
        }
        vaciar();
      } else {
        for (let i = 0; i < n; i++) {
          const x = s.x[i], y = s.y[i]; if (!isFinite(y) || (ylog && y <= 0) || (xlog && x <= 0)) { abierto = false; continue; }
          const px = tx(x), py = ty(y); if (!abierto) { g.moveTo(px, py); abierto = true; } else g.lineTo(px, py);
        }
      }
      g.stroke(); g.setLineDash([]);
    }
    // marcas verticales / puntuales
    g.font = '600 11px system-ui, sans-serif';
    for (const m of d.marcas || []) {
      const x = tx(m.x); g.strokeStyle = m.color || col.muted; g.fillStyle = m.color || col.fg; g.lineWidth = 1; g.setLineDash([3, 3]);
      if (m.y === undefined) { g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke(); }
      g.setLineDash([]);
      if (m.y !== undefined) { g.beginPath(); g.arc(x, ty(m.y), 4, 0, 6.283); g.stroke(); }
      if (m.texto) { g.fillStyle = col.fg; g.textAlign = x > L + pw - 60 ? 'right' : 'left'; g.textBaseline = 'top'; const yy = m.y !== undefined ? Math.max(T + 2, ty(m.y) - 16) : T + 2 + (m.fila || 0) * 13; g.fillText(m.texto, x + (g.textAlign === 'left' ? 4 : -4), yy); }
    }
    g.restore();
    // leyenda
    const nombradas = d.series.filter(s => s.nombre);
    if (nombradas.length > 1 || (nombradas.length === 1 && d.leyendaSiempre)) {
      g.font = '11px system-ui, sans-serif'; let x = L + 6; const y = T + ph - 8; g.textBaseline = 'middle'; g.textAlign = 'left';
      const anchos = nombradas.map(s => g.measureText(s.nombre).width + 22), tot = anchos.reduce((a, b) => a + b, 0);
      g.fillStyle = col.surface; g.globalAlpha = 0.85; g.fillRect(x - 4, y - 8, Math.min(pw - 4, tot + 4), 16); g.globalAlpha = 1;
      nombradas.forEach((s, i) => { g.strokeStyle = s.color || col.fg; g.lineWidth = 2; g.setLineDash(s.guiones || []); g.beginPath(); g.moveTo(x, y); g.lineTo(x + 14, y); g.stroke(); g.setLineDash([]); g.fillStyle = col.fg; g.fillText(s.nombre, x + 18, y); x += anchos[i]; });
    }
    // cursor
    if (this.cursor) {
      const { px } = this.cursor; if (px >= L && px <= L + pw) {
        const xv = this._map.ix(px); g.strokeStyle = col.fg; g.lineWidth = 1; g.beginPath(); g.moveTo(px + 0.5, T); g.lineTo(px + 0.5, T + ph); g.stroke();
        const lineas = [(d.xNombre || 'x') + ' = ' + fmtNum(xv) + (d.xUnidad ? ' ' + d.xUnidad : '')];
        if (d.lecturaCursor) lineas.push(...d.lecturaCursor(xv, this._map.iy(this.cursor.py)));
        else for (const s of d.series) {
          if (!s.nombre || s.puntos || !s.x.length) continue; let lo = 0, hi = s.x.length - 1;
          while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s.x[m] < xv) lo = m; else hi = m; }
          const i = Math.abs(s.x[lo] - xv) < Math.abs(s.x[hi] - xv) ? lo : hi; lineas.push(s.nombre + ': ' + fmtNum(s.y[i]));
        }
        g.font = '11px ui-monospace, Menlo, monospace'; const w = Math.max(...lineas.map(l => g.measureText(l).width)) + 12, h = lineas.length * 14 + 8;
        const bx = px + w + 10 > L + pw ? px - w - 6 : px + 6; g.fillStyle = col.surface; g.strokeStyle = col.line; g.fillRect(bx, T + 4, w, h); g.strokeRect(bx + 0.5, T + 4.5, w, h);
        g.fillStyle = col.fg; g.textAlign = 'left'; g.textBaseline = 'top'; lineas.forEach((l, k) => g.fillText(l, bx + 6, T + 9 + 14 * k));
      }
    }
  }
  _eventos() {
    let ini = null, movio = false;
    const pos = e => { const r = this.c.getBoundingClientRect(); return { px: e.clientX - r.left, py: e.clientY - r.top }; };
    this.c.addEventListener('pointerdown', e => { if (!this._map) return; ini = pos(e); movio = false; if (this.op.seleccionable) this.c.setPointerCapture(e.pointerId); });
    this.c.addEventListener('pointermove', e => {
      if (!ini || !this.op.seleccionable) return; const p = pos(e); if (Math.abs(p.px - ini.px) > 6) movio = true;
      if (movio) { const m = this._map, a = m.ix(Math.max(m.L, Math.min(m.L + m.pw, ini.px))), b = m.ix(Math.max(m.L, Math.min(m.L + m.pw, p.px))); this.datos.seleccion = [Math.min(a, b), Math.max(a, b)]; this.cursor = null; this.dibujar(); }
    });
    const fin = e => {
      if (!ini) return; const p = pos(e);
      if (!movio) { this.cursor = this.cursor && Math.abs(this.cursor.px - p.px) < 4 ? null : p; this.dibujar(); if (this.op.onCursor && this.cursor) this.op.onCursor(this._map.ix(p.px), this._map.iy(p.py)); }
      else if (this.op.onSeleccion && this.datos.seleccion) this.op.onSeleccion(this.datos.seleccion[0], this.datos.seleccion[1]);
      ini = null;
    };
    this.c.addEventListener('pointerup', fin); this.c.addEventListener('pointercancel', () => { ini = null; });
  }
}

/** Convierte una matriz de espectrograma (PSD) a una imagen en dB con viridis. Devuelve {canvas, x0, x1, y0, y1, dbMin, dbMax}. */
function imagenEspectrograma(sg, op = {}) {
  const nfMax = op.fmax ? Math.min(sg.nf, Math.floor(op.fmax / sg.df) + 1) : sg.nf;
  const db = new Float32Array(sg.nt * nfMax); const vals = [];
  for (let k = 0; k < sg.nt; k++) for (let i = 0; i < nfMax; i++) { const v = 10 * Math.log10(sg.S[k * sg.nf + i] + 1e-30); db[k * nfMax + i] = v; if (i > 0 && (k * nfMax + i) % 7 === 0) vals.push(v); }
  vals.sort((a, b) => a - b);
  const dbMax = op.dbMax ?? vals[Math.floor(0.999 * (vals.length - 1))], dbMin = op.dbMin ?? Math.max(vals[Math.floor(0.05 * (vals.length - 1))], dbMax - (op.rango || 60));
  const cv = (typeof OffscreenCanvas !== 'undefined' && !op.dom) ? new OffscreenCanvas(sg.nt, nfMax) : Object.assign(document.createElement('canvas'), { width: sg.nt, height: nfMax });
  const ctx = cv.getContext('2d'), im = ctx.createImageData(sg.nt, nfMax);
  for (let k = 0; k < sg.nt; k++) for (let i = 0; i < nfMax; i++) {
    const [r, g, b] = viridis((db[k * nfMax + i] - dbMin) / (dbMax - dbMin)), p = ((nfMax - 1 - i) * sg.nt + k) * 4;
    im.data[p] = r; im.data[p + 1] = g; im.data[p + 2] = b; im.data[p + 3] = 255;
  }
  ctx.putImageData(im, 0, 0);
  const dt = sg.nt > 1 ? sg.t[1] - sg.t[0] : 1;
  return { canvas: cv, x0: sg.t[0] - dt / 2, x1: sg.t[sg.nt - 1] + dt / 2, y0: -sg.df / 2, y1: (nfMax - 0.5) * sg.df, dbMin, dbMax, db, nfMax };
}

raiz.Grafica = Grafica;
raiz.Grafica.viridis = viridis;
raiz.Grafica.fmtNum = fmtNum;
raiz.Grafica.imagenEspectrograma = imagenEspectrograma;
})(typeof self !== 'undefined' ? self : this);
