/* ---------- カメラ ---------- */
export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.facing = 'environment';
    this._gen = 0; // start()/stop() のたびに進める番号。古い起動結果を捨てるために使う
  }

  get active() { return !!this.stream; }

  async start(facing = 'environment', highRes = false) {
    this.stop();
    const gen = ++this._gen;
    const size = highRes ? { width: { ideal: 3840 }, height: { ideal: 2160 } } : { width: { ideal: 1920 }, height: { ideal: 1080 } };
    const base = { audio: false, video: { facingMode: { ideal: facing }, ...size } };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(base);
    } catch (e) {
      if (e && (e.name === 'OverconstrainedError' || e.name === 'ConstraintNotSatisfiedError')) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      } else {
        throw e;
      }
    }
    /* 待っている間に stop() や別の start() が呼ばれていたら、この映像は使わずに止める */
    if (gen !== this._gen) { stream.getTracks().forEach(t => t.stop()); return null; }
    this.stream = stream;
    this.facing = facing;
    const track = this.stream.getVideoTracks()[0];
    if (track && track.getSettings) {
      const st = track.getSettings();
      if (st.facingMode) this.facing = st.facingMode;
    }
    this.video.srcObject = this.stream;
    await new Promise(resolve => {
      if (this.video.readyState >= 1) { resolve(); return; }
      const done = () => { this.video.removeEventListener('loadedmetadata', done); resolve(); };
      this.video.addEventListener('loadedmetadata', done);
      setTimeout(resolve, 3000);
    });
    try { await this.video.play(); } catch (e) { /* 自動再生がブロックされても映像は表示される */ }
    return this.stream;
  }

  stop() {
    this._gen++;
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.video.srcObject) this.video.srcObject = null;
  }

  /* 映像の中央を指定の縦横比で切り出したキャンバスを返す */
  capture(aspect) {
    const v = this.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return null;
    let cw, ch, sx, sy;
    if (vw / vh > aspect) {
      ch = vh; cw = Math.round(vh * aspect); sx = Math.round((vw - cw) / 2); sy = 0;
    } else {
      cw = vw; ch = Math.round(vw / aspect); sx = 0; sy = Math.round((vh - ch) / 2);
    }
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    c.getContext('2d').drawImage(v, sx, sy, cw, ch, 0, 0, cw, ch);
    return c;
  }
}

export function cameraErrorMessage(e) {
  const name = (e && e.name) || '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'カメラの使用が許可されていません。ブラウザの設定(サイトの権限)または端末の設定でカメラを「許可」にしてから、画面を開き直してください。';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'カメラが見つかりません。';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'カメラを起動できません。ほかのアプリがカメラを使用していないか確認してください。';
    case 'SecurityError':
      return 'この接続ではカメラを使えません。https:// で開いているか確認してください。';
    default:
      return 'カメラを起動できませんでした。' + (name ? `(${name})` : '');
  }
}

/* ---------- 輪郭線オーバーレイ(Sobel) ---------- */
export function makeEdgeCanvas(src, maxW = 900) {
  const s = Math.min(1, maxW / src.width);
  const w = Math.max(2, Math.round(src.width * s)), h = Math.max(2, Math.round(src.height * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const out = ctx.createImageData(w, h);
  const o = out.data;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1] + gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1];
      const gy = -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1] + gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
      const m = Math.sqrt(gx * gx + gy * gy);
      let a = (m - 36) * 2.4;
      a = a < 0 ? 0 : a > 255 ? 255 : a;
      const p = i * 4;
      o[p] = 255; o[p + 1] = 255; o[p + 2] = 255; o[p + 3] = a;
    }
  }
  ctx.putImageData(out, 0, 0);
  return c;
}

/* ---------- 水平器 ---------- */
export class LevelMeter {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.enabled = false;
    this._handler = e => this._handle(e);
  }

  static supported() { return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window; }

  async enable() {
    if (!LevelMeter.supported()) throw new Error('unsupported');
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') throw new Error('denied');
    }
    window.addEventListener('deviceorientation', this._handler);
    this.enabled = true;
    this._got = false;
    setTimeout(() => { if (this.enabled && !this._got) this.onUpdate(null); }, 1500);
  }

  disable() {
    window.removeEventListener('deviceorientation', this._handler);
    this.enabled = false;
  }

  _handle(e) {
    if (e.beta == null || e.gamma == null) return;
    this._got = true;
    const rad = Math.PI / 180;
    const b = e.beta * rad, g = e.gamma * rad;
    const cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
    const u = { x: -cb * sg, y: sb, z: cb * cg };
    let angle = 0;
    if (screen.orientation && typeof screen.orientation.angle === 'number') angle = screen.orientation.angle;
    else if (typeof window.orientation === 'number') angle = window.orientation;
    const a = angle * rad;
    const right = { x: Math.cos(a), y: Math.sin(a) };
    const up = { x: -Math.sin(a), y: Math.cos(a) };
    const ur = u.x * right.x + u.y * right.y;
    const uu = u.x * up.x + u.y * up.y;
    const roll = Math.atan2(ur, uu) / rad;
    const pitch = Math.atan2(u.z, Math.hypot(ur, uu)) / rad;
    this.onUpdate({ roll, pitch });
  }
}

/* ---------- ガイド線 ---------- */
export class Guides {
  constructor(el) {
    this.el = el;
    this.onChange = null;
  }

  render(preset, on) {
    this.el.innerHTML = '';
    if (!on || !preset) return;
    if (preset.plumb) {
      const v = document.createElement('div');
      v.className = 'gl gl-v';
      this.el.appendChild(v);
    }
    (preset.hlines || []).forEach((f, idx) => {
      const line = document.createElement('div');
      line.className = 'gl gl-h';
      line.style.top = (f * 100) + '%';
      const knob = document.createElement('div');
      knob.className = 'knob';
      line.appendChild(knob);
      line.addEventListener('pointerdown', e => this._drag(e, line, idx));
      this.el.appendChild(line);
    });
  }

  _drag(e, line, idx) {
    e.preventDefault();
    line.setPointerCapture(e.pointerId);
    const rect = this.el.getBoundingClientRect();
    const move = ev => {
      const f = Math.min(0.98, Math.max(0.02, (ev.clientY - rect.top) / rect.height));
      line.style.top = (f * 100) + '%';
      line._f = f;
    };
    const up = ev => {
      line.removeEventListener('pointermove', move);
      line.removeEventListener('pointerup', up);
      line.removeEventListener('pointercancel', up);
      if (line._f != null && this.onChange) this.onChange(idx, line._f);
    };
    line.addEventListener('pointermove', move);
    line.addEventListener('pointerup', up);
    line.addEventListener('pointercancel', up);
  }
}
