const YELLOW = '#ffd43d';
const FONT = '"Noto Sans JP", sans-serif';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function angleDeg(g) {
  let d = Math.atan2(g.p2.y - g.p1.y, g.p2.x - g.p1.x) * 180 / Math.PI;
  if (d > 90) d -= 180;
  if (d <= -90) d += 180;
  return d;
}

/* ---------- 比較ビュー ---------- */
export class CompareView {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = opts.onChange || (() => {});
    this.mode = 'side';
    this.tool = null;
    this.imgA = null; this.imgB = null;
    this.labels = { a: '', b: '' };
    this.zoom = 1; this.dx = 0; this.dy = 0;
    this.opacity = 0.5; this.wipe = 0.5; this.showB = false;
    this.ann = { h: [], v: [], angles: [] };
    this.blurRects = { a: [], b: [] };
    this._blurCache = { a: null, b: null };
    this.pendingAngle = null; this.tempRect = null;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cssW = 0; this.cssH = 0;
    this._ptrs = new Map(); this._gesture = null; this._lastTap = 0;
    this._bind();
  }

  get ready() { return !!(this.imgA && this.imgB); }

  setImages(a, b, labels) {
    this.imgA = a; this.imgB = b;
    this.labels = labels || { a: '', b: '' };
    this._computeFit();
    this.resetAll();
    this.render();
  }

  _computeFit() {
    if (!this.ready) return;
    this.W = this.imgA.width; this.H = this.imgA.height;
    const f = Math.min(this.W / this.imgB.width, this.H / this.imgB.height);
    this.fB = f;
    this.offB = { x: (this.W - this.imgB.width * f) / 2, y: (this.H - this.imgB.height * f) / 2 };
  }

  clear() { this.imgA = null; this.imgB = null; this.resetAll(); this.render(); }

  resetAll() {
    this.zoom = 1; this.dx = 0; this.dy = 0;
    this.ann = { h: [], v: [], angles: [] };
    this.blurRects = { a: [], b: [] };
    this._blurCache = { a: null, b: null };
    this.pendingAngle = null; this.tempRect = null;
    this.wipe = 0.5; this.showB = false;
  }

  resetView() { this.zoom = 1; this.dx = 0; this.dy = 0; this.render(); }

  clearAnnotations() {
    this.ann = { h: [], v: [], angles: [] };
    this.pendingAngle = null;
    this.blurRects = { a: [], b: [] };
    this._blurCache = { a: null, b: null };
    this.render();
  }

  swap() {
    if (!this.ready) return;
    const ob = this.offB, fb = this.fB;
    const mx = x => (x - ob.x) / fb, my = y => (y - ob.y) / fb;
    this.ann.h = this.ann.h.map(my);
    this.ann.v = this.ann.v.map(mx);
    this.ann.angles = this.ann.angles.map(g => ({ p1: { x: mx(g.p1.x), y: my(g.p1.y) }, p2: { x: mx(g.p2.x), y: my(g.p2.y) } }));
    if (this.pendingAngle) this.pendingAngle = { x: mx(this.pendingAngle.x), y: my(this.pendingAngle.y) };
    this.dx /= fb; this.dy /= fb;
    [this.imgA, this.imgB] = [this.imgB, this.imgA];
    this.labels = { a: this.labels.b, b: this.labels.a };
    this.blurRects = { a: this.blurRects.b, b: this.blurRects.a };
    this._blurCache = { a: null, b: null };
    this._computeFit();
    this.render();
  }

  setMode(m) { this.mode = m; this.render(); }
  setTool(t) { this.tool = t; this.pendingAngle = null; this.tempRect = null; this.render(); }
  setOpacity(v) { this.opacity = clamp(v, 0, 1); this.render(); }
  toggle() { this.showB = !this.showB; this.render(); }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.cssW = r.width; this.cssH = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.render();
  }

  layout(W = this.cssW, H = this.cssH, mode = this.mode, gap = 4) {
    if (mode === 'side') return [{ x: 0, y: 0, w: (W - gap) / 2, h: H, which: 'a' }, { x: (W + gap) / 2, y: 0, w: (W - gap) / 2, h: H, which: 'b' }];
    if (mode === 'stack') return [{ x: 0, y: 0, w: W, h: (H - gap) / 2, which: 'a' }, { x: 0, y: (H + gap) / 2, w: W, h: (H - gap) / 2, which: 'b' }];
    return [{ x: 0, y: 0, w: W, h: H, which: 'both' }];
  }

  _k0(box) { return Math.min(box.w / this.W, box.h / this.H); }

  _origin(box, view) {
    const k = this._k0(box) * view.zoom;
    return { k, ox: box.x + box.w / 2 - (this.W / 2 + view.dx) * k, oy: box.y + box.h / 2 - (this.H / 2 + view.dy) * k };
  }

  toCanon(box, p, view = this) {
    const { k, ox, oy } = this._origin(box, view);
    return { x: (p.x - ox) / k, y: (p.y - oy) / k };
  }

  boxAt(p) {
    return this.layout().find(b => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) || null;
  }

  _setView(box, c, p, z) {
    this.zoom = z;
    const k = this._k0(box) * z;
    this.dx = clamp(c.x - this.W / 2 - (p.x - (box.x + box.w / 2)) / k, -this.W / 2, this.W / 2);
    this.dy = clamp(c.y - this.H / 2 - (p.y - (box.y + box.h / 2)) / k, -this.H / 2, this.H / 2);
  }

  _blurred(which) {
    const img = which === 'a' ? this.imgA : this.imgB;
    const rects = this.blurRects[which];
    if (!rects.length) return img;
    if (this._blurCache[which]) return this._blurCache[which];
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    for (const r of rects) {
      const block = Math.max(6, Math.round(Math.max(r.w, r.h) / 10));
      const sw = Math.max(1, Math.round(r.w / block)), sh = Math.max(1, Math.round(r.h / block));
      const t = document.createElement('canvas');
      t.width = sw; t.height = sh;
      t.getContext('2d').drawImage(img, r.x, r.y, r.w, r.h, 0, 0, sw, sh);
      x.imageSmoothingEnabled = false;
      x.drawImage(t, 0, 0, sw, sh, r.x, r.y, r.w, r.h);
      x.imageSmoothingEnabled = true;
    }
    this._blurCache[which] = c;
    return c;
  }

  _commitBlur(rect, box) {
    const add = (which, r) => {
      const img = which === 'a' ? this.imgA : this.imgB;
      const x0 = clamp(r.x, 0, img.width), y0 = clamp(r.y, 0, img.height);
      const x1 = clamp(r.x + r.w, 0, img.width), y1 = clamp(r.y + r.h, 0, img.height);
      if (x1 - x0 < 2 || y1 - y0 < 2) return;
      this.blurRects[which].push({ x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) });
      this._blurCache[which] = null;
    };
    const toB = r => ({ x: (r.x - this.offB.x) / this.fB, y: (r.y - this.offB.y) / this.fB, w: r.w / this.fB, h: r.h / this.fB });
    if (box.which === 'a') add('a', rect);
    else if (box.which === 'b') add('b', toB(rect));
    else { add('a', rect); add('b', toB(rect)); }
  }

  render() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    if (!this.ready || !this.cssW) return;
    this.drawScene(ctx, this.layout(), this, { mode: this.mode, labels: this.labels, interactive: true });
  }

  drawScene(ctx, boxes, view, opts) {
    const mode = opts.mode;
    for (const box of boxes) {
      ctx.save();
      ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip();
      ctx.fillStyle = '#000'; ctx.fillRect(box.x, box.y, box.w, box.h);
      const { k, ox, oy } = this._origin(box, view);
      const drawA = () => ctx.drawImage(this._blurred('a'), ox, oy, this.W * k, this.H * k);
      const drawB = () => ctx.drawImage(this._blurred('b'), ox + this.offB.x * k, oy + this.offB.y * k, this.imgB.width * this.fB * k, this.imgB.height * this.fB * k);
      if (box.which === 'a') drawA();
      else if (box.which === 'b') drawB();
      else if (mode === 'overlay') { drawA(); ctx.globalAlpha = this.opacity; drawB(); ctx.globalAlpha = 1; }
      else if (mode === 'wipe') {
        drawA();
        const wx = box.x + box.w * this.wipe;
        ctx.save();
        ctx.beginPath(); ctx.rect(wx, box.y, box.x + box.w - wx, box.h); ctx.clip();
        drawB();
        ctx.restore();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(2, box.h * 0.004);
        ctx.beginPath(); ctx.moveTo(wx, box.y); ctx.lineTo(wx, box.y + box.h); ctx.stroke();
        if (opts.interactive) {
          const cy = box.y + box.h / 2, r = 16;
          ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(wx, cy, r, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(wx - 4, cy - 5); ctx.lineTo(wx - 9, cy); ctx.lineTo(wx - 4, cy + 5);
          ctx.moveTo(wx + 4, cy - 5); ctx.lineTo(wx + 9, cy); ctx.lineTo(wx + 4, cy + 5);
          ctx.stroke();
        }
      } else { if (this.showB) drawB(); else drawA(); }
      const vis = this._visibleRect(box, k, ox, oy);
      this._drawAnnotations(ctx, box, k, ox, oy, opts, vis);
      this._drawLabels(ctx, vis, mode, opts.labels);
      if (opts.interactive && this.tempRect && (this.tempRect.which === box.which)) {
        const r = this.tempRect;
        ctx.setLineDash([6, 4]); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
        ctx.strokeRect(ox + r.x * k, oy + r.y * k, r.w * k, r.h * k);
        ctx.setLineDash([]);
      }
      ctx.restore();
    }
  }

  _visibleRect(box, k, ox, oy) {
    const x1 = Math.max(box.x, ox), y1 = Math.max(box.y, oy);
    const x2 = Math.min(box.x + box.w, ox + this.W * k), y2 = Math.min(box.y + box.h, oy + this.H * k);
    if (x2 <= x1 || y2 <= y1) return { x: box.x, y: box.y, w: box.w, h: box.h, which: box.which };
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1, which: box.which };
  }

  _drawAnnotations(ctx, box, k, ox, oy, opts, vis) {
    const fs = clamp(vis.h * 0.028, 11, 36);
    const lw = Math.max(1.5, fs / 8);
    ctx.lineWidth = lw; ctx.strokeStyle = YELLOW; ctx.fillStyle = YELLOW;
    ctx.font = `700 ${fs}px ${FONT}`; ctx.textBaseline = 'bottom'; ctx.textAlign = 'left';
    const line = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };
    const dot = (x, y) => { ctx.beginPath(); ctx.arc(x, y, lw * 2.2, 0, Math.PI * 2); ctx.fill(); };
    const text = (s, x, y) => {
      ctx.lineWidth = Math.max(2, fs / 5); ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(s, x, y); ctx.fillText(s, x, y);
      ctx.lineWidth = lw; ctx.strokeStyle = YELLOW;
    };
    for (const y of this.ann.h) line(box.x, oy + y * k, box.x + box.w, oy + y * k);
    for (const x of this.ann.v) line(ox + x * k, box.y, ox + x * k, box.y + box.h);
    for (const g of this.ann.angles) {
      const x1 = ox + g.p1.x * k, y1 = oy + g.p1.y * k, x2 = ox + g.p2.x * k, y2 = oy + g.p2.y * k;
      line(x1, y1, x2, y2); dot(x1, y1); dot(x2, y2);
      text(`${angleDeg(g).toFixed(1)}°`, (x1 + x2) / 2 + fs * 0.4, (y1 + y2) / 2 - fs * 0.3);
    }
    if (opts.interactive && this.pendingAngle) dot(ox + this.pendingAngle.x * k, oy + this.pendingAngle.y * k);
  }

  _drawLabels(ctx, box, mode, labels) {
    const fs = clamp(box.h * 0.032, 11, 44);
    const pad = fs * 0.55, m = box.h * 0.02 + 4;
    ctx.font = `700 ${fs}px ${FONT}`; ctx.textBaseline = 'middle';
    const pill = (t, x, y, right) => {
      if (!t) return;
      const w = ctx.measureText(t).width + pad * 2, h = fs * 1.7;
      const px = right ? x - w : x;
      roundRect(ctx, px, y, w, h, h / 2);
      ctx.fillStyle = 'rgba(0,0,0,0.62)'; ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
      ctx.fillText(t, px + pad, y + h / 2);
    };
    if (box.which === 'a') pill(labels.a, box.x + m, box.y + m);
    else if (box.which === 'b') pill(labels.b, box.x + m, box.y + m);
    else if (mode === 'toggle') pill(this.showB ? labels.b : labels.a, box.x + m, box.y + m);
    else { pill(labels.a, box.x + m, box.y + m); pill(labels.b, box.x + box.w - m, box.y + m, true); }
  }

  /* ---- 操作 ---- */
  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', e => this._down(e));
    c.addEventListener('pointermove', e => this._move(e));
    c.addEventListener('pointerup', e => this._up(e));
    c.addEventListener('pointercancel', e => this._up(e));
    c.addEventListener('wheel', e => this._wheel(e), { passive: false });
    c.addEventListener('dblclick', e => e.preventDefault());
  }

  _pt(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  _down(e) {
    if (!this.ready) return;
    e.preventDefault();
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* 一部ブラウザでは不要 */ }
    const p = this._pt(e);
    this._ptrs.set(e.pointerId, { x: p.x, y: p.y, sx: p.x, sy: p.y, t: performance.now() });
    if (this._ptrs.size === 1) {
      this._gesture = this._beginSingle(p);
    } else if (this._ptrs.size === 2) {
      const [a, b] = [...this._ptrs.values()];
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const box = this.boxAt(m) || this.layout()[0];
      this._gesture = { type: 'pinch', box, d0: dist(a, b), z0: this.zoom, c0: this.toCanon(box, m) };
      this.tempRect = null;
    }
  }

  _beginSingle(p) {
    const box = this.boxAt(p);
    if (!box) return null;
    const { k, ox, oy } = this._origin(box, this);
    const c = this.toCanon(box, p);
    if (this.mode === 'wipe' && box.which === 'both') {
      const wx = box.x + box.w * this.wipe;
      if (Math.abs(p.x - wx) <= 24) return { type: 'wipe', box };
    }
    if (this.tool === 'hline') {
      let best = -1, bd = 14;
      this.ann.h.forEach((y, i) => { const d = Math.abs(oy + y * k - p.y); if (d < bd) { bd = d; best = i; } });
      return best >= 0 ? { type: 'drag-h', box, idx: best } : { type: 'tap', box };
    }
    if (this.tool === 'vline') {
      let best = -1, bd = 14;
      this.ann.v.forEach((x, i) => { const d = Math.abs(ox + x * k - p.x); if (d < bd) { bd = d; best = i; } });
      return best >= 0 ? { type: 'drag-v', box, idx: best } : { type: 'tap', box };
    }
    if (this.tool === 'blur') return { type: 'rect', box, start: c };
    if (this.tool === 'angle') return { type: 'tap', box };
    return { type: 'pan', box, dx0: this.dx, dy0: this.dy };
  }

  _move(e) {
    const pr = this._ptrs.get(e.pointerId);
    if (!pr) return;
    e.preventDefault();
    const p = this._pt(e);
    pr.x = p.x; pr.y = p.y;
    const g = this._gesture;
    if (!g) { if (this._ptrs.size === 1) this._gesture = this._beginSingle(p); return; }
    if (g.type === 'pinch') {
      if (this._ptrs.size < 2) return;
      const [a, b] = [...this._ptrs.values()];
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const z = clamp(g.z0 * dist(a, b) / Math.max(1, g.d0), 1, 10);
      this._setView(g.box, g.c0, m, z);
      this.render();
      return;
    }
    if (this._ptrs.size !== 1) return;
    const box = g.box;
    if (g.type === 'pan') {
      const k = this._k0(box) * this.zoom;
      this.dx = clamp(g.dx0 - (p.x - pr.sx) / k, -this.W / 2, this.W / 2);
      this.dy = clamp(g.dy0 - (p.y - pr.sy) / k, -this.H / 2, this.H / 2);
      this.render();
    } else if (g.type === 'wipe') {
      this.wipe = clamp((p.x - box.x) / box.w, 0, 1);
      this.render();
    } else if (g.type === 'drag-h') {
      this.ann.h[g.idx] = clamp(this.toCanon(box, p).y, 0, this.H);
      this.render();
    } else if (g.type === 'drag-v') {
      this.ann.v[g.idx] = clamp(this.toCanon(box, p).x, 0, this.W);
      this.render();
    } else if (g.type === 'rect') {
      const c = this.toCanon(box, p);
      this.tempRect = { which: box.which, x: Math.min(g.start.x, c.x), y: Math.min(g.start.y, c.y), w: Math.abs(c.x - g.start.x), h: Math.abs(c.y - g.start.y) };
      this.render();
    }
  }

  _up(e) {
    const pr = this._ptrs.get(e.pointerId);
    if (!pr) return;
    const p = this._pt(e);
    const g = this._gesture;
    const moved = Math.hypot(p.x - pr.sx, p.y - pr.sy);
    const dt = performance.now() - pr.t;
    this._ptrs.delete(e.pointerId);
    if (g && g.type === 'pinch') { if (this._ptrs.size < 2) this._gesture = null; return; }
    if (this._ptrs.size > 0) return;
    this._gesture = null;
    if (!g) return;
    if (g.type === 'rect') {
      if (this.tempRect && this.tempRect.w > 4 && this.tempRect.h > 4) this._commitBlur(this.tempRect, g.box);
      this.tempRect = null;
      this.render(); this.onChange();
      return;
    }
    const isTap = moved < 8 && dt < 600;
    if (!isTap) { this.onChange(); return; }
    const now = performance.now();
    if (now - this._lastTap < 320 && !this.tool) { this._lastTap = 0; this.resetView(); return; }
    this._lastTap = now;
    const box = g.box;
    const c = this.toCanon(box, p);
    if (this.tool === 'hline') { if (g.type === 'tap') this.ann.h.push(clamp(c.y, 0, this.H)); }
    else if (this.tool === 'vline') { if (g.type === 'tap') this.ann.v.push(clamp(c.x, 0, this.W)); }
    else if (this.tool === 'angle') {
      if (!this.pendingAngle) this.pendingAngle = c;
      else { this.ann.angles.push({ p1: this.pendingAngle, p2: c }); this.pendingAngle = null; }
    } else if (this.mode === 'toggle' && !this.tool) {
      this.showB = !this.showB;
    }
    this.render(); this.onChange();
  }

  _wheel(e) {
    if (!this.ready) return;
    e.preventDefault();
    const p = this._pt(e);
    const box = this.boxAt(p);
    if (!box) return;
    const c = this.toCanon(box, p);
    const z = clamp(this.zoom * Math.pow(1.0015, -e.deltaY), 1, 10);
    this._setView(box, c, p, z);
    this.render();
  }
}

/* ---------- 書き出し ---------- */
export function exportCompare(cmp, opts) {
  const W = cmp.W, H = cmp.H;
  const e = Math.min(1, 2000 / Math.max(W, H));
  const bw = Math.round(W * e), bh = Math.round(H * e);
  const gap = Math.max(4, Math.round(bw * 0.015));
  const mode = cmp.mode === 'toggle' ? 'side' : cmp.mode;
  let cw, ch, boxes;
  if (mode === 'side') { cw = bw * 2 + gap; ch = bh; boxes = [{ x: 0, y: 0, w: bw, h: bh, which: 'a' }, { x: bw + gap, y: 0, w: bw, h: bh, which: 'b' }]; }
  else if (mode === 'stack') { cw = bw; ch = bh * 2 + gap; boxes = [{ x: 0, y: 0, w: bw, h: bh, which: 'a' }, { x: 0, y: bh + gap, w: bw, h: bh, which: 'b' }]; }
  else { cw = bw; ch = bh; boxes = [{ x: 0, y: 0, w: bw, h: bh, which: 'both' }]; }
  const brand = opts.brand && (opts.brand.name || opts.brand.logo) ? opts.brand : null;
  const band = brand ? Math.round(Math.min(cw, ch) * 0.09) : 0;
  const top = !!(brand && brand.pos && brand.pos[0] === 't');
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch + band;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  if (band && top) boxes.forEach(b => { b.y += band; });
  cmp.drawScene(ctx, boxes, { zoom: 1, dx: 0, dy: 0 }, { mode, labels: { a: opts.labelA, b: opts.labelB }, interactive: false });
  if (band) drawBrand(ctx, brand, 0, top ? 0 : ch, cw, band);
  return c;
}

function drawBrand(ctx, brand, x, y, w, h) {
  const pad = h * 0.2, lh = h - pad * 2;
  const right = !!(brand.pos && brand.pos.endsWith('r'));
  const fs = h * 0.42;
  ctx.font = `700 ${fs}px ${FONT}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillStyle = '#1a1a1a';
  const logo = brand.logo && brand.logo.width ? brand.logo : null;
  const lw = logo ? lh * (logo.width / logo.height) : 0;
  const tw = brand.name ? ctx.measureText(brand.name).width : 0;
  const gapx = logo && brand.name ? h * 0.25 : 0;
  let sx = right ? x + w - pad - (lw + gapx + tw) : x + pad;
  if (logo) { ctx.drawImage(logo, sx, y + pad, lw, lh); sx += lw + gapx; }
  if (brand.name) ctx.fillText(brand.name, sx, y + h / 2);
}

/* ---------- 位置合わせ ---------- */
export class Adjuster {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.alpha = 0.6;
    this.t = { x: 0, y: 0, s: 1, r: 0 };
    this._ptrs = new Map(); this._g = null;
    this.cssW = 0; this.cssH = 0;
    this._bind();
  }

  set(base, over) {
    this.base = base; this.over = over;
    this.W = base.width; this.H = base.height;
    this.fB = Math.min(this.W / over.width, this.H / over.height);
    this.t = { x: 0, y: 0, s: 1, r: 0 };
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.cssW = r.width; this.cssH = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.render();
  }

  _fit() {
    const k = Math.min(this.cssW / this.W, this.cssH / this.H);
    return { k, ox: (this.cssW - this.W * k) / 2, oy: (this.cssH - this.H * k) / 2 };
  }

  render() {
    if (!this.base || !this.cssW) return;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, this.cssW, this.cssH);
    const { k, ox, oy } = this._fit();
    ctx.drawImage(this.base, ox, oy, this.W * k, this.H * k);
    ctx.save();
    ctx.beginPath(); ctx.rect(ox, oy, this.W * k, this.H * k); ctx.clip();
    ctx.globalAlpha = this.alpha;
    this._drawOver(ctx, k, ox, oy);
    ctx.restore();
  }

  _drawOver(ctx, k, ox, oy) {
    const t = this.t;
    ctx.translate(ox + (this.W / 2 + t.x) * k, oy + (this.H / 2 + t.y) * k);
    ctx.rotate(t.r);
    const s = t.s * this.fB * k;
    ctx.scale(s, s);
    ctx.drawImage(this.over, -this.over.width / 2, -this.over.height / 2);
  }

  output() {
    const c = document.createElement('canvas');
    c.width = this.W; c.height = this.H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, this.W, this.H);
    ctx.save();
    this._drawOver(ctx, 1, 0, 0);
    ctx.restore();
    return c;
  }

  setAlpha(a) { this.alpha = clamp(a, 0.05, 1); this.render(); }
  nudgeZoom(f) { this.t.s = clamp(this.t.s * f, 0.5, 3); this.render(); }
  nudgeRot(deg) { this.t.r += deg * Math.PI / 180; this.render(); }
  reset() { this.t = { x: 0, y: 0, s: 1, r: 0 }; this.render(); }

  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', e => this._down(e));
    c.addEventListener('pointermove', e => this._move(e));
    c.addEventListener('pointerup', e => this._up(e));
    c.addEventListener('pointercancel', e => this._up(e));
    c.addEventListener('wheel', e => { e.preventDefault(); this.nudgeZoom(Math.pow(1.0015, -e.deltaY)); }, { passive: false });
  }

  _pt(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  _down(e) {
    if (!this.base) return;
    e.preventDefault();
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* 不要なブラウザもある */ }
    const p = this._pt(e);
    this._ptrs.set(e.pointerId, { x: p.x, y: p.y });
    if (this._ptrs.size === 1) {
      this._g = { type: 'pan', x0: this.t.x, y0: this.t.y, sx: p.x, sy: p.y };
    } else if (this._ptrs.size === 2) {
      const [a, b] = [...this._ptrs.values()];
      this._g = { type: 'pinch', d0: dist(a, b), a0: Math.atan2(b.y - a.y, b.x - a.x), m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, t0: { ...this.t } };
    }
  }

  _move(e) {
    const pr = this._ptrs.get(e.pointerId);
    if (!pr || !this._g) return;
    e.preventDefault();
    const p = this._pt(e);
    pr.x = p.x; pr.y = p.y;
    const { k } = this._fit();
    const g = this._g;
    if (g.type === 'pinch') {
      if (this._ptrs.size < 2) return;
      const [a, b] = [...this._ptrs.values()];
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.t.s = clamp(g.t0.s * dist(a, b) / Math.max(1, g.d0), 0.5, 3);
      this.t.r = g.t0.r + (Math.atan2(b.y - a.y, b.x - a.x) - g.a0);
      this.t.x = g.t0.x + (m.x - g.m0.x) / k;
      this.t.y = g.t0.y + (m.y - g.m0.y) / k;
    } else if (this._ptrs.size === 1) {
      this.t.x = g.x0 + (p.x - g.sx) / k;
      this.t.y = g.y0 + (p.y - g.sy) / k;
    }
    this.render();
  }

  _up(e) {
    this._ptrs.delete(e.pointerId);
    if (this._ptrs.size === 0) this._g = null;
    else if (this._ptrs.size === 1 && this._g && this._g.type === 'pinch') {
      const [a] = [...this._ptrs.values()];
      this._g = { type: 'pan', x0: this.t.x, y0: this.t.y, sx: a.x, sy: a.y };
    }
  }
}
