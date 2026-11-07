import { readImageMeta } from './meta.js';

export const APP_VERSION = '1.0.1';
export const APP_BUILD = 2;

const SETTINGS_KEY = 'ba.settings.v1';

export const DEFAULT_PRESETS = [
  { id: 'full', name: '全身', ar: [3, 4], plumb: true, hlines: [0.27, 0.52] },
  { id: 'face', name: '顔', ar: [1, 1], plumb: true, hlines: [0.42, 0.62] },
  { id: 'upper', name: '上半身', ar: [4, 5], plumb: true, hlines: [0.35] },
  { id: 'free', name: '自由', ar: [3, 4], plumb: false, hlines: [] },
];

const DEFAULTS = {
  clinicName: '',
  logo: null,
  logoPos: 'br',
  sequence: false,
  views: ['正面', '右側面', '左側面', '背面'],
  mirrorFront: false,
  resolution: 'std',
  retention: '7',
  deleteUsedBefore: true,
  presets: DEFAULT_PRESETS,
  lastPreset: 'full',
  guidesOn: true,
  timer: 0,
  facing: 'environment',
  overlayOpacity: 50,
  overlayMode: 'photo',
};

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function loadSettings() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (e) { saved = null; }
  const s = clone(DEFAULTS);
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(DEFAULTS)) {
      if (saved[k] !== undefined && saved[k] !== null) s[k] = saved[k];
    }
  }
  if (!Array.isArray(s.presets) || !s.presets.length) s.presets = clone(DEFAULT_PRESETS);
  s.presets = s.presets.filter(p => p && p.name && Array.isArray(p.ar) && p.ar.length === 2).map(p => ({
    id: p.id || ('p' + Math.random().toString(36).slice(2, 8)),
    name: String(p.name).slice(0, 20),
    ar: [Number(p.ar[0]) || 3, Number(p.ar[1]) || 4],
    plumb: !!p.plumb,
    hlines: Array.isArray(p.hlines) ? p.hlines.map(Number).filter(n => n > 0 && n < 1) : [],
  }));
  if (!s.presets.length) s.presets = clone(DEFAULT_PRESETS);
  if (!Array.isArray(s.views) || !s.views.length) s.views = clone(DEFAULTS.views);
  return s;
}

export const settings = loadSettings();

export function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
  catch (e) { toast('設定を保存できませんでした。端末の空き容量を確認してください。'); }
}

/* ---------- 一時保持 (IndexedDB) ---------- */
const DB_NAME = 'reframe';
const DB_VER = 1;
const STORE = 'befores';

function openDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const st = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        st.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const st = t.objectStore(STORE);
    let result;
    try { result = fn(st); } catch (e) { reject(e); return; }
    t.oncomplete = () => { db.close(); resolve(result && result.result !== undefined ? result.result : result); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error); };
  }));
}

export async function addBefore(rec) {
  const data = {
    blob: rec.blob, thumb: rec.thumb, w: rec.w, h: rec.h,
    preset: rec.preset || '', view: rec.view || '', createdAt: rec.createdAt || Date.now(),
  };
  let id;
  await tx('readwrite', st => { const r = st.add(data); r.onsuccess = () => { id = r.result; }; return r; });
  return id;
}

export async function listBefores() {
  let items = [];
  await tx('readonly', st => { const r = st.getAll(); r.onsuccess = () => { items = r.result || []; }; return r; });
  items.sort((a, b) => b.createdAt - a.createdAt);
  return items;
}

export async function getBefore(id) {
  let item = null;
  await tx('readonly', st => { const r = st.get(id); r.onsuccess = () => { item = r.result || null; }; return r; });
  return item;
}

export function deleteBefore(id) { return tx('readwrite', st => st.delete(id)); }
export function clearBefores() { return tx('readwrite', st => st.clear()); }

export async function purgeExpired() {
  const r = settings.retention;
  if (r === 'none') { await clearBefores().catch(() => {}); return; }
  let cutoff;
  const now = new Date();
  if (r === 'day') cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  else cutoff = now.getTime() - Number(r) * 86400000;
  let items = [];
  try { items = await listBefores(); } catch (e) { return; }
  for (const it of items) {
    if (it.createdAt < cutoff) await deleteBefore(it.id).catch(() => {});
  }
}

/* ---------- 画像ユーティリティ ---------- */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = src;
  });
}

export async function decodeToCanvas(blob, maxSide = 2048) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) throw new Error('empty image');
    const s = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function ensureCanvas(rec, maxSide = 2048) {
  if (rec && !rec.canvas) {
    rec.canvas = await decodeToCanvas(rec.blob, maxSide);
    rec.w = rec.canvas.width; rec.h = rec.canvas.height;
  }
  return rec ? rec.canvas : null;
}

export function makeThumb(src, maxSide = 320) {
  const s = Math.min(1, maxSide / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(src.width * s));
  c.height = Math.max(1, Math.round(src.height * s));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.92) {
  return new Promise((resolve, reject) => {
    if (canvas.toBlob) {
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), type, quality);
    } else {
      resolve(dataURLToBlob(canvas.toDataURL(type, quality)));
    }
  });
}

export function canvasToBlobSync(canvas, type = 'image/jpeg', quality = 0.92) {
  return dataURLToBlob(canvas.toDataURL(type, quality));
}

export function dataURLToBytes(dataURL) {
  const [head, body] = dataURL.split(',');
  const mime = (/data:([^;]+)/.exec(head) || [, 'image/png'])[1];
  const bin = atob(body);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return { bytes: u8, mime };
}

export function dataURLToBlob(dataURL) {
  const { bytes, mime } = dataURLToBytes(dataURL);
  return new Blob([bytes], { type: mime });
}

/* EXIFの撮影日時(DateTimeOriginal)を読む。なければnull */
export async function readExifDate(blob) {
  const m = await readImageMeta(blob);
  const d = m.dateTimeOriginal || m.dateTime;
  if (!d) return null;
  const r = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2})/.exec(d);
  return r ? `${r[1]}/${r[2]}/${r[3]} ${r[4]}:${r[5]}` : null;
}

const pad2 = n => String(n).padStart(2, '0');
export function fmtDate(ms, withTime = true) {
  const d = new Date(ms);
  const s = `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
  return withTime ? `${s} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : s;
}
export function fileStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/* ---------- 共有・保存 ---------- */
export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* 共有シートが使えれば共有、使えなければダウンロード。ユーザー操作のハンドラ内から同期的に呼ぶこと */
export function shareOrDownload(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    return navigator.share({ files: [file], title: filename })
      .then(() => 'shared')
      .catch(e => {
        if (e && e.name === 'AbortError') return 'cancel';
        download(blob, filename);
        return 'downloaded';
      });
  }
  download(blob, filename);
  return Promise.resolve('downloaded');
}

/* ---------- トースト ---------- */
let toastTimer = null;
export function toast(message, action) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = message;
  el.appendChild(span);
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn btn-sm';
    b.textContent = action.label;
    b.onclick = () => { el.hidden = true; action.onClick(); };
    el.appendChild(b);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 12000 : 3500);
}
