import {
  APP_VERSION, settings, saveSettings,
  addBefore, listBefores, deleteBefore, clearBefores, purgeExpired,
  loadImage, decodeToCanvas, ensureCanvas, makeThumb, canvasToBlob, dataURLToBytes,
  readExifDate, fmtDate, fileStamp, shareOrDownload, toast, APP_BUILD,
} from './store.js';
import { stampBytes, newImageId } from './meta.js';
import { Camera, cameraErrorMessage, makeEdgeCanvas, LevelMeter, Guides } from './camera.js';
import { CompareView, exportCompare, Adjuster } from './compare.js';

/* 他のサイトの iframe に埋め込まれた状態では動かさない */
if (window.top !== window.self) {
  document.body.replaceChildren();
  document.body.textContent = 'このページは埋め込み表示では使えません。';
  try { window.top.location.replace(location.href); } catch (e) { /* 遷移を止められたときはこのまま */ }
  throw new Error('Reframe must not run inside a frame');
}

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const SOFTWARE = 'Reframe ' + APP_VERSION;
/* メタデータの説明欄に書く表記 */
const KIND_LABEL = { before: 'ビフォー', after: 'アフター' };
const DESC_COMPARE = 'Reframe 比較画像';
const descPhoto = kind => `Reframe ${KIND_LABEL[kind]}画像`;
/* 説明欄の1項目:「区分 日時 プリセット・アングル」 */
const metaItem = (kind, createdAt, preset, view) =>
  [KIND_LABEL[kind], fmtDate(createdAt), [preset, view].filter(Boolean).join('・')].filter(Boolean).join(' ');

/* キャンバスをJPEGにし、作成ソフト・日時・画像IDのメタデータを付ける */
async function stampedJpeg(canvas, kind, preset, view) {
  const id = newImageId();
  const date = new Date();
  let blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
  try {
    const bytes = stampBytes(new Uint8Array(await blob.arrayBuffer()), {
      software: SOFTWARE, id, date, kind, build: APP_BUILD,
      description: descPhoto(kind), detail: metaItem(kind, date.getTime(), preset, view),
    });
    blob = new Blob([bytes], { type: 'image/jpeg' });
  } catch (e) { /* メタデータが付かなくても写真は使える */ }
  return { blob, imageId: id, createdAt: date.getTime() };
}

const state = {
  mode: 'before',       // 'before' | 'after'
  preset: null,
  viewIndex: 0,
  doneViews: new Set(),
  before: null,         // { blob, url, canvas?, w, h, label, createdAt, view, preset, id? }
  after: null,
  captured: null,
  lastBefore: null,
  lastShotThumb: null,
};

/* ---------- 画面遷移 ---------- */
const SCREENS = ['home', 'capture', 'preview', 'adjust', 'select', 'compare', 'settings'];
const hooks = {};
let current = null;

function show(name) {
  if (!SCREENS.includes(name)) name = 'home';
  if ((name === 'preview' || name === 'adjust') && !state.captured) name = 'home';
  if (name === 'capture' && state.mode === 'after' && !state.before) name = 'select';
  if (current === name) return;
  if (current && hooks[current] && hooks[current].leave) hooks[current].leave();
  SCREENS.forEach(s => { $('s-' + s).hidden = s !== name; });
  current = name;
  if (hooks[name] && hooks[name].enter) hooks[name].enter();
}
function go(name) { history.pushState({ s: name }, '', '#' + name); show(name); }
function back() { history.back(); }
window.addEventListener('popstate', e => show((e.state && e.state.s) || 'home'));

/* ---------- 共通 ---------- */
function setRecord(target, rec) {
  if (rec && !rec.url) rec.url = URL.createObjectURL(rec.blob);
  state[target] = rec;
}
/* 画像の一時URLと展開済みの画像を手放す(元データ blob は残る) */
function releaseRecord(rec) {
  if (!rec) return;
  if (rec.url) { URL.revokeObjectURL(rec.url); rec.url = null; }
  delete rec.canvas;
  delete rec.edge;
}
/* 新しい作業を始める前に、直前の作業で使った写真を画面とメモリから外す */
function clearWorkingSet() {
  for (const k of ['before', 'after', 'captured']) { releaseRecord(state[k]); state[k] = null; }
  state.lastShotThumb = null;
  $('pv-img').removeAttribute('src');
  $('cap-last-img').removeAttribute('src');
  $('ov-img').removeAttribute('src');
  const edge = $('ov-edge');
  edge.width = edge.width;
  cmp.clear();
}
/* 選んだビフォーに重ねてアフターを撮る。残っていたアフターは使わない */
function startAfterFlow(rec) {
  for (const k of ['after', 'captured']) { if (state[k] !== rec) releaseRecord(state[k]); state[k] = null; }
  state.lastShotThumb = null;
  state.mode = 'after';
  setRecord('before', rec);
  go('capture');
}
function recLabel(rec) {
  if (!rec) return '';
  if (rec.label) return rec.label;
  return fmtDate(rec.createdAt) + (rec.view ? ' ' + rec.view : '');
}
/* 写真の選択ボタンに出す名前。端末の写真はファイル名で区別できるようにする */
function srcLabel(rec) {
  if (!rec) return '未選択';
  return rec.fileName || recLabel(rec);
}
async function recordFromFile(file) {
  const canvas = await decodeToCanvas(file, 2048);
  const exif = await readExifDate(file);
  return {
    blob: file, canvas, w: canvas.width, h: canvas.height,
    label: exif || fmtDate(file.lastModified || Date.now()),
    fileName: (file.name || '').replace(/\.[^.]+$/, ''),
    createdAt: file.lastModified || Date.now(), view: '', preset: '', kind: 'file',
  };
}
function recordFromStored(it) {
  return { id: it.id, blob: it.blob, w: it.w, h: it.h, thumb: it.thumb, view: it.view, preset: it.preset, createdAt: it.createdAt, kind: 'before' };
}
function confirmDialog(text, okLabel = '削除') {
  return new Promise(resolve => {
    const d = $('dlg-confirm');
    $('confirm-text').textContent = text;
    $('confirm-ok').textContent = okLabel;
    const onClose = () => { d.removeEventListener('close', onClose); resolve(d.returnValue === 'ok'); };
    d.addEventListener('close', onClose);
    d.showModal();
  });
}
function currentPreset() {
  return settings.presets.find(p => p.id === settings.lastPreset) || settings.presets[0];
}
function arText(w, h) {
  const g = (a, b) => b ? g(b, a % b) : a;
  const d = g(w, h) || 1;
  const a = w / d, b = h / d;
  return (a <= 20 && b <= 20) ? `${a}:${b}` : `${w}×${h}`;
}

/* ---------- ホーム ---------- */
hooks.home = {
  async enter() {
    await purgeExpired();
    renderRecent();
  },
};
$('home-settings').onclick = () => go('settings');
$('home-before').onclick = () => { clearWorkingSet(); state.mode = 'before'; state.viewIndex = 0; state.doneViews = new Set(); go('capture'); };
$('home-after').onclick = () => { clearWorkingSet(); state.mode = 'after'; go('select'); };
$('home-compare').onclick = () => { clearWorkingSet(); go('compare'); };
$('recent-clear').onclick = async () => {
  if (await confirmDialog('一時保持しているビフォー写真をすべて削除します。端末に保存した写真は消えません。')) {
    await clearBefores().catch(() => {});
    renderRecent();
  }
};

function retentionText() {
  return { none: '保持しない設定', day: '当日で自動削除', 7: '7日で自動削除', 30: '30日で自動削除' }[settings.retention] || '';
}

async function renderRecent() {
  const list = $('recent-list');
  list.innerHTML = '';
  let items = [];
  try { items = await listBefores(); } catch (e) { items = []; }
  $('recent-note').textContent = retentionText();
  $('recent-empty').hidden = items.length > 0;
  $('recent-clear').hidden = items.length === 0;
  for (const it of items) list.appendChild(recentTile(it, () => startAfterFlow(recordFromStored(it)), async () => {
    await deleteBefore(it.id).catch(() => {});
    renderRecent();
  }));
}

function recentTile(it, onPick, onDelete) {
  const wrap = document.createElement('div');
  wrap.className = 'recent';
  const main = document.createElement('button');
  main.className = 'recent-main';
  main.type = 'button';
  const img = document.createElement('img');
  img.src = it.thumb || '';
  img.alt = '';
  const meta = document.createElement('div');
  meta.className = 'meta';
  const strong = document.createElement('strong');
  strong.textContent = [it.preset, it.view].filter(Boolean).join('・') || 'ビフォー';
  const small = document.createElement('small');
  small.textContent = fmtDate(it.createdAt);
  meta.append(strong, small);
  main.append(img, meta);
  main.onclick = onPick;
  wrap.appendChild(main);
  if (onDelete) {
    const del = document.createElement('button');
    del.className = 'recent-del';
    del.type = 'button';
    del.setAttribute('aria-label', 'この写真を削除');
    del.innerHTML = '<svg class="ic"><use href="#i-close"/></svg>';
    del.onclick = async e => {
      e.stopPropagation();
      if (await confirmDialog('この写真を一時保持から削除します。')) onDelete();
    };
    wrap.appendChild(del);
  }
  return wrap;
}

/* ---------- 撮影 ---------- */
const cam = new Camera($('cam'));
const guides = new Guides($('guides'));
const level = new LevelMeter(onLevel);
let countdownTimer = null;

guides.onChange = (idx, f) => {
  if (state.mode === 'after') {
    if (!state.before.hlines) state.before.hlines = [];
    state.before.hlines[idx] = f;
  } else {
    const p = currentPreset();
    p.hlines[idx] = f;
    saveSettings();
  }
};

function currentAspect() {
  if (state.mode === 'after' && state.before) return state.before.w / state.before.h;
  const p = currentPreset();
  return p.ar[0] / p.ar[1];
}
function guidePresetForCapture() {
  if (state.mode === 'after' && state.before) {
    const base = settings.presets.find(p => p.name === state.before.preset) || currentPreset();
    if (!state.before.hlines) state.before.hlines = base.hlines.slice();
    return { plumb: base.plumb, hlines: state.before.hlines };
  }
  return currentPreset();
}

function layoutVF() {
  const wrap = $('vf-wrap'), vf = $('vf');
  const W = wrap.clientWidth - 8, H = wrap.clientHeight - 8;
  if (W <= 0 || H <= 0) return;
  const ar = currentAspect();
  let w = W, h = W / ar;
  if (h > H) { h = H; w = H * ar; }
  vf.style.width = Math.floor(w) + 'px';
  vf.style.height = Math.floor(h) + 'px';
}
new ResizeObserver(() => { if (current === 'capture') layoutVF(); }).observe($('vf-wrap'));

function renderPresetChips() {
  const el = $('cap-presets');
  el.innerHTML = '';
  el.hidden = state.mode === 'after';
  if (state.mode === 'after') return;
  const cur = currentPreset();
  for (const p of settings.presets) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.textContent = `${p.name} ${p.ar[0]}:${p.ar[1]}`;
    b.setAttribute('aria-pressed', String(p.id === cur.id));
    b.onclick = () => {
      settings.lastPreset = p.id; saveSettings();
      renderPresetChips(); layoutVF(); renderGuides(); updateHud();
    };
    el.appendChild(b);
  }
}

function renderViewChips() {
  const el = $('cap-views');
  el.innerHTML = '';
  const on = settings.sequence && state.mode === 'before' && settings.views.length > 0;
  el.hidden = !on;
  if (!on) return;
  settings.views.forEach((v, i) => {
    const b = document.createElement('button');
    b.className = 'chip' + (state.doneViews.has(i) ? ' done' : '');
    b.type = 'button';
    b.innerHTML = (state.doneViews.has(i) ? '<svg class="ic"><use href="#i-check"/></svg>' : '') + '<span></span>';
    b.querySelector('span').textContent = v;
    b.setAttribute('aria-pressed', String(i === state.viewIndex));
    b.onclick = () => { state.viewIndex = i; renderViewChips(); updateCapSub(); };
    el.appendChild(b);
  });
}

function currentViewLabel() {
  if (state.mode === 'after') return state.before ? state.before.view : '';
  if (!settings.sequence) return '';
  return settings.views[state.viewIndex] || '';
}

function updateCapSub() {
  if (state.mode === 'after') {
    $('cap-sub').textContent = 'ビフォー: ' + recLabel(state.before);
  } else {
    const p = currentPreset();
    const v = currentViewLabel();
    $('cap-sub').textContent = p.name + (v ? '・' + v : '');
  }
}

function updateHud() {
  if (state.mode === 'after' && state.before) $('hud-ar').textContent = 'ビフォーと同じ比率 ' + arText(state.before.w, state.before.h);
  else { const p = currentPreset(); $('hud-ar').textContent = `${p.ar[0]}:${p.ar[1]}`; }
  const ov = $('hud-ov');
  ov.hidden = state.mode !== 'after';
  if (state.mode === 'after') ov.textContent = (settings.overlayMode === 'edge' ? '輪郭 ' : 'ビフォー ') + settings.overlayOpacity + '%';
}

function renderGuides() {
  guides.render(guidePresetForCapture(), settings.guidesOn);
  $('chip-guides').setAttribute('aria-pressed', String(settings.guidesOn));
}

function updateTimerChip() {
  const t = settings.timer;
  $('chip-timer-text').textContent = t ? `タイマー ${t}秒` : 'タイマー オフ';
}

function setOverlayOpacity(v) {
  settings.overlayOpacity = clamp(Math.round(v), 0, 100);
  $('ov-opacity').value = settings.overlayOpacity;
  $('ov-opacity-val').textContent = settings.overlayOpacity + '%';
  const a = settings.overlayOpacity / 100;
  $('ov-img').style.opacity = a;
  $('ov-edge').style.opacity = Math.min(1, a * 1.6);
  updateHud();
}

async function setupOverlay() {
  const b = state.before;
  const img = $('ov-img'), edge = $('ov-edge');
  img.src = b.url;
  img.hidden = settings.overlayMode !== 'photo';
  edge.hidden = settings.overlayMode !== 'edge';
  $('chip-mode').textContent = settings.overlayMode === 'edge' ? '輪郭' : '写真';
  setOverlayOpacity(settings.overlayOpacity);
  if (settings.overlayMode === 'edge') await ensureEdge();
}

async function ensureEdge() {
  const b = state.before;
  if (!b) return;
  if (!b.edge) {
    const src = b.canvas || await decodeToCanvas(b.blob, 1000);
    b.edge = makeEdgeCanvas(src, 900);
  }
  const edge = $('ov-edge');
  edge.width = b.edge.width; edge.height = b.edge.height;
  edge.getContext('2d').drawImage(b.edge, 0, 0);
}

function showCamMsg(msg) {
  const el = $('cam-msg');
  el.textContent = msg;
  el.hidden = !msg;
  $('shutter').disabled = !!msg;
}

async function startCamera() {
  showCamMsg('');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showCamMsg('このブラウザではカメラを使えません。https:// で開いているか確認してください。');
    return;
  }
  try {
    const stream = await cam.start(settings.facing, settings.resolution === 'high');
    if (current !== 'capture' || document.hidden) { cam.stop(); return; }
    if (stream) $('cam').classList.toggle('mirror', cam.facing === 'user' && settings.mirrorFront);
  } catch (e) {
    showCamMsg(cameraErrorMessage(e));
  }
}

hooks.capture = {
  async enter() {
    const after = state.mode === 'after';
    $('cap-title').textContent = after ? 'アフター撮影(ビフォー重ね)' : 'ビフォー撮影';
    $('ov-row').hidden = !after;
    $('chip-mode').hidden = !after;
    $('cap-change-before').hidden = !after;
    $('cap-spacer').hidden = after;
    $('cap-last').hidden = !state.lastShotThumb;
    if (state.lastShotThumb) $('cap-last-img').src = state.lastShotThumb;
    renderPresetChips(); renderViewChips(); updateCapSub(); updateTimerChip();
    $('chip-level').setAttribute('aria-pressed', 'false');
    $('hud-level').hidden = true;
    $('level-ui').hidden = true;
    if (after) {
      try { await setupOverlay(); }
      catch (e) { $('ov-edge').hidden = true; toast('輪郭を作成できませんでした。'); }
      if (current !== 'capture') return;
    } else { $('ov-img').hidden = true; $('ov-edge').hidden = true; }
    layoutVF(); renderGuides(); updateHud();
    await startCamera();
  },
  leave() {
    cam.stop();
    level.disable();
    cancelCountdown();
    $('ov-img').removeAttribute('src');
  },
};

document.addEventListener('visibilitychange', () => {
  if (current !== 'capture') return;
  if (document.hidden) cam.stop();
  else startCamera();
});
/* 画面に戻ってきたときにも期限切れの写真を消す */
async function purgeAndRefresh() {
  await purgeExpired();
  if (current === 'home') renderRecent();
  else if (current === 'select') renderSelectList();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) purgeAndRefresh(); });
window.addEventListener('pageshow', e => { if (e.persisted) purgeAndRefresh(); });

$('cap-back').onclick = () => back();
$('cap-switch').onclick = async () => {
  const b = $('cap-switch');
  if (b.disabled) return;
  b.disabled = true;
  settings.facing = settings.facing === 'user' ? 'environment' : 'user';
  saveSettings();
  try { await startCamera(); } finally { b.disabled = false; }
};
$('cap-change-before').onclick = () => go('select');
$('chip-guides').onclick = () => { settings.guidesOn = !settings.guidesOn; saveSettings(); renderGuides(); };
$('chip-timer').onclick = () => {
  const seq = [0, 3, 5, 10];
  settings.timer = seq[(seq.indexOf(settings.timer) + 1) % seq.length];
  saveSettings(); updateTimerChip();
};
$('chip-mode').onclick = async () => {
  settings.overlayMode = settings.overlayMode === 'edge' ? 'photo' : 'edge';
  saveSettings();
  try { await setupOverlay(); }
  catch (e) {
    settings.overlayMode = 'photo'; saveSettings();
    try { await setupOverlay(); } catch (e2) { /* 写真の重ねも出せなければそのまま */ }
    toast('輪郭を作成できませんでした。');
  }
  updateHud();
};
$('ov-opacity').oninput = e => { setOverlayOpacity(Number(e.target.value)); };
$('ov-opacity').onchange = () => saveSettings();
$('chip-level').onclick = async () => {
  if (level.enabled) {
    level.disable();
    $('chip-level').setAttribute('aria-pressed', 'false');
    $('hud-level').hidden = true;
    $('level-ui').hidden = true;
    return;
  }
  try {
    await level.enable();
    $('chip-level').setAttribute('aria-pressed', 'true');
    $('hud-level').hidden = false;
    $('hud-level').textContent = '水平器 計測中';
    $('level-ui').hidden = false;
    $('level-ui').classList.remove('ok');
    $('level-bar').style.transform = 'translate(-50%, -50%) rotate(0deg)';
  } catch (e) {
    toast(e.message === 'denied' ? '傾きセンサーの使用が許可されませんでした。' : 'この端末では傾きセンサーを使えません。');
  }
};
function onLevel(v) {
  const el = $('hud-level');
  const ui = $('level-ui');
  if (!v) { el.textContent = '傾きを取得できません'; el.classList.remove('ok'); ui.hidden = true; return; }
  const r = v.roll, p = v.pitch;
  const levelOk = Math.abs(r) < 1;
  const ok = levelOk && Math.abs(p) < 2;
  el.textContent = `左右 ${r >= 0 ? '+' : ''}${r.toFixed(1)}°  前後 ${p >= 0 ? '+' : ''}${p.toFixed(0)}°`;
  el.classList.toggle('ok', ok);
  ui.classList.toggle('ok', levelOk);
  $('level-bar').style.transform = `translate(-50%, -50%) rotate(${(levelOk ? 0 : r).toFixed(1)}deg)`;
}

$('cap-last').onclick = () => { if (state.captured) go('preview'); };

function cancelCountdown() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  $('countdown').hidden = true;
  $('shutter').disabled = !$('cam-msg').hidden;
}

let capturing = false;
$('shutter').onclick = () => {
  if (capturing) return;
  if (countdownTimer) { cancelCountdown(); return; }
  const t = settings.timer;
  if (!t) { doCapture(); return; }
  let n = t;
  const cd = $('countdown');
  cd.textContent = n; cd.hidden = false;
  countdownTimer = setInterval(() => {
    n -= 1;
    if (n <= 0) { cancelCountdown(); doCapture(); }
    else cd.textContent = n;
  }, 1000);
};

async function doCapture() {
  if (capturing) return;
  const c = cam.capture(currentAspect());
  if (!c) { toast('カメラの映像がまだ表示されていません。'); return; }
  capturing = true;
  $('shutter').disabled = true;
  try {
    const flash = $('flash');
    flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
    const presetName = state.mode === 'after' ? (state.before.preset || '') : currentPreset().name;
    const view = currentViewLabel();
    const { blob, imageId, createdAt } = await stampedJpeg(c, state.mode, presetName, view);
    const rec = {
      blob, canvas: c, w: c.width, h: c.height, createdAt, imageId,
      preset: presetName, view, kind: state.mode,
    };
    rec.thumb = makeThumb(c, 320);
    state.lastShotThumb = rec.thumb;
    if (state.mode === 'after') {
      rec.pairedBefore = state.before; // どのビフォーに対して撮ったか。比較後の自動削除で照合する
    } else {
      if (settings.retention !== 'none') {
        try { rec.id = await addBefore(rec); } catch (e) { toast('一時保持に保存できませんでした。「端末に保存」で保存してください。'); }
      }
      if (settings.sequence) state.doneViews.add(state.viewIndex);
      rec.fresh = true; // 「撮り直す」で一時保持から消せる状態。ホームへ進むか続けて撮ると確定する
      state.lastBefore = rec;
      delete rec.canvas;
    }
    setRecord('captured', rec);
    go('preview');
  } finally {
    capturing = false;
    $('shutter').disabled = !$('cam-msg').hidden;
  }
}

/* ---------- プレビュー ---------- */
hooks.preview = {
  enter() {
    const r = state.captured;
    const after = r.kind === 'after';
    $('pv-img').src = r.url;
    $('pv-title').textContent = after ? 'アフターを撮影しました' : 'ビフォーを撮影しました';
    $('pv-sub').textContent = recLabel(r) + ' ' + arText(r.w, r.h);
    $('pv-adjust').hidden = !after;
    const more = !after && settings.sequence && state.viewIndex < settings.views.length - 1;
    $('pv-next').hidden = !more;
    $('pv-primary').textContent = after ? '比較へ' : 'ホームへ';
  },
};
/* 撮ったばかりのビフォーを一時保持から取り消す */
async function discardCaptured() {
  const r = state.captured;
  if (!r || r.kind !== 'before' || !r.fresh) return;
  r.fresh = false;
  if (r.id) { await deleteBefore(r.id).catch(() => {}); delete r.id; }
  if (state.lastBefore === r) state.lastBefore = null;
  if (state.lastShotThumb === r.thumb) state.lastShotThumb = null;
  if (settings.sequence) state.doneViews.delete(state.viewIndex);
  $('pv-img').removeAttribute('src');
  releaseRecord(r);
  state.captured = null;
}
function keepCaptured() { if (state.captured) state.captured.fresh = false; }
$('pv-back').onclick = () => back();
$('pv-retake').onclick = async () => { await discardCaptured(); back(); };
$('pv-save').onclick = () => {
  const r = state.captured;
  const name = (r.kind === 'after' ? 'after_' : 'before_') + fileStamp(r.createdAt) + '.jpg';
  shareOrDownload(r.blob, name).then(res => { if (res === 'downloaded') toast('ダウンロードしました。'); });
};
$('pv-next').onclick = () => { keepCaptured(); state.viewIndex = Math.min(state.viewIndex + 1, settings.views.length - 1); back(); };
$('pv-adjust').onclick = () => go('adjust');
$('pv-primary').onclick = async () => {
  if (state.captured.kind === 'after') { await useCapturedAsAfter(); await releaseUsedBefore(); go('compare'); }
  else { keepCaptured(); go('home'); }
};
async function useCapturedAsAfter() {
  const r = state.captured;
  await ensureCanvas(r);
  setRecord('after', r);
}

/* ---------- 位置合わせ ---------- */
const adj = new Adjuster($('adj-canvas'));
new ResizeObserver(() => { if (current === 'adjust') adj.resize(); }).observe($('adj-canvas'));
hooks.adjust = {
  async enter() {
    await ensureCanvas(state.before);
    await ensureCanvas(state.captured);
    adj.set(state.before.canvas, state.captured.canvas);
    adj.setAlpha(Number($('adj-opacity').value) / 100);
  },
};
$('adj-back').onclick = () => back();
$('adj-cancel').onclick = () => back();
$('adj-opacity').oninput = e => { $('adj-opacity-val').textContent = e.target.value + '%'; adj.setAlpha(Number(e.target.value) / 100); };
$('adj-zoom-in').onclick = () => adj.nudgeZoom(1.02);
$('adj-zoom-out').onclick = () => adj.nudgeZoom(1 / 1.02);
$('adj-rot-l').onclick = () => adj.nudgeRot(-0.5);
$('adj-rot-r').onclick = () => adj.nudgeRot(0.5);
$('adj-reset').onclick = () => adj.reset();
$('adj-ok').onclick = async () => {
  const out = adj.output();
  const r = state.captured;
  const { blob, imageId } = await stampedJpeg(out, 'after', r.preset, r.view);
  const rec = { ...r, canvas: out, blob, w: out.width, h: out.height, url: null, imageId };
  setRecord('captured', rec);
  setRecord('after', rec);
  await releaseUsedBefore();
  go('compare');
};

/* ---------- ビフォー選択 ---------- */
hooks.select = { async enter() { await purgeExpired(); renderSelectList(); } };
$('sel-back').onclick = () => back();
$('sel-file').onclick = () => $('sel-file-input').click();
$('sel-file-input').onchange = async e => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    startAfterFlow(await recordFromFile(f));
  } catch (err) {
    toast('この画像を読み込めませんでした。');
  }
};
async function renderSelectList() {
  const list = $('sel-list');
  list.innerHTML = '';
  let items = [];
  try { items = await listBefores(); } catch (e) { items = []; }
  if (state.lastBefore && !state.lastBefore.id) {
    const lb = state.lastBefore;
    list.appendChild(recentTile({ ...lb, id: null }, () => startAfterFlow(lb), null));
  }
  for (const it of items) list.appendChild(recentTile(it, () => startAfterFlow(recordFromStored(it)), null));
  $('sel-empty').hidden = list.children.length > 0;
}

/* ---------- 比較 ---------- */
const cmp = new CompareView($('cmp-canvas'));
new ResizeObserver(() => { if (current === 'compare') cmp.resize(); }).observe($('cmp-wrap'));
let brandImg = null;

hooks.compare = {
  async enter() {
    cmp.setMode(currentMode());
    $('cmp-opacity-row').hidden = currentMode() !== 'overlay';
    await refreshCompare();
    cmp.resize();
  },
};
/* アフターを撮ったビフォーを一時保持から外す。撮ったときに記録した組み合わせが一致するときだけ */
async function releaseUsedBefore() {
  const a = state.before, b = state.after;
  if (!settings.deleteUsedBefore || !a || !b || a.kind !== 'before' || b.kind !== 'after' || b.pairedBefore !== a) return;
  a.used = true;
  if (state.lastBefore === a) state.lastBefore = null;
  if (!a.id) return;
  try {
    await deleteBefore(a.id);
    delete a.id;
    toast('比較に使ったビフォーを一時保持から削除しました。');
  } catch (e) { /* 削除できなくても比較は続けられる */ }
}
function currentMode() {
  const t = $('cmp-modes').querySelector('[aria-selected="true"]');
  return t ? t.dataset.mode : 'side';
}
async function refreshCompare() {
  const a = state.before, b = state.after;
  $('src-a-label').textContent = srcLabel(a);
  $('src-b-label').textContent = srcLabel(b);
  const ready = !!(a && b);
  $('cmp-export').disabled = !ready;
  $('cmp-empty').hidden = ready;
  if (ready) {
    await ensureCanvas(a); await ensureCanvas(b);
    cmp.setImages(a.canvas, b.canvas, compareLabels());
  } else {
    cmp.clear();
  }
  $('cmp-sub').textContent = ready ? `${recLabel(a)} / ${recLabel(b)}` : '';
  updateHint();
}
$('cmp-back').onclick = () => back();
$('src-a').onclick = () => $('src-a-input').click();
$('src-b').onclick = () => $('src-b-input').click();
async function onPickCompare(e, target) {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    setRecord(target, await recordFromFile(f));
    await refreshCompare();
  } catch (err) {
    toast('この画像を読み込めませんでした。');
  }
}
$('src-a-input').onchange = e => onPickCompare(e, 'before');
$('src-b-input').onchange = e => onPickCompare(e, 'after');

$('cmp-modes').addEventListener('click', e => {
  const t = e.target.closest('.tab');
  if (!t) return;
  if (t.getAttribute('aria-selected') === 'true') { if (t.dataset.mode === 'toggle') cmp.toggle(); return; }
  $('cmp-modes').querySelectorAll('.tab').forEach(x => x.setAttribute('aria-selected', String(x === t)));
  cmp.setMode(t.dataset.mode);
  $('cmp-opacity-row').hidden = t.dataset.mode !== 'overlay';
  cmp.resize();
  updateHint();
});
$('cmp-opacity').oninput = e => { $('cmp-opacity-val').textContent = e.target.value + '%'; cmp.setOpacity(Number(e.target.value) / 100); };

$('cmp-tools').addEventListener('click', e => {
  const b = e.target.closest('.tool');
  if (!b || !cmp.ready) return;
  const t = b.dataset.tool;
  if (t === 'swap') { const tmp = state.before; state.before = state.after; state.after = tmp; cmp.swap(); refreshLabelsOnly(); return; }
  if (t === 'clear') { cmp.clearAnnotations(); return; }
  if (t === 'fit') { cmp.resetView(); return; }
  const pressed = b.getAttribute('aria-pressed') === 'true';
  $('cmp-tools').querySelectorAll('[aria-pressed]').forEach(x => x.setAttribute('aria-pressed', 'false'));
  if (pressed) { cmp.setTool(null); }
  else { b.setAttribute('aria-pressed', 'true'); cmp.setTool(t); }
  updateHint();
});
function compareLabels() {
  return { a: 'ビフォー ' + recLabel(state.before), b: 'アフター ' + recLabel(state.after) };
}
function refreshLabelsOnly() {
  const a = state.before, b = state.after;
  cmp.labels = compareLabels();
  cmp.render();
  $('src-a-label').textContent = srcLabel(a);
  $('src-b-label').textContent = srcLabel(b);
  $('cmp-sub').textContent = (a && b) ? `${recLabel(a)} / ${recLabel(b)}` : '';
}
function updateHint() {
  const h = $('cmp-hint');
  const hints = {
    hline: 'タップで横線を追加、線をドラッグで移動',
    vline: 'タップで縦線を追加、線をドラッグで移動',
    angle: '2点をタップすると角度を表示します',
    blur: 'ぼかす範囲をドラッグで囲みます',
  };
  let text = cmp.tool ? hints[cmp.tool] : '';
  if (!text && cmp.mode === 'toggle') text = 'タップで切り替え';
  if (!text && cmp.mode === 'wipe') text = '境界線をドラッグ';
  h.textContent = text;
  h.hidden = !text || !cmp.ready;
}

function exportOptions() {
  const brand = $('ex-brand').checked ? { name: settings.clinicName, logo: brandImg, pos: settings.logoPos } : null;
  return { labelA: $('ex-label-a').value, labelB: $('ex-label-b').value, brand };
}
/* 書き出す画像をダイアログに縮小表示する */
function renderExportPreview() {
  const pv = $('ex-preview');
  let out;
  try { out = exportCompare(cmp, exportOptions()); } catch (err) { pv.hidden = true; return; }
  const s = Math.min(1, 640 / Math.max(out.width, out.height));
  pv.width = Math.max(1, Math.round(out.width * s));
  pv.height = Math.max(1, Math.round(out.height * s));
  pv.getContext('2d').drawImage(out, 0, 0, pv.width, pv.height);
  pv.hidden = false;
}
$('cmp-export').onclick = () => {
  if (!cmp.ready) return;
  $('ex-label-a').value = cmp.labels.a;
  $('ex-label-b').value = cmp.labels.b;
  $('ex-brand').checked = !!(settings.clinicName || settings.logo);
  $('ex-brand').disabled = !(settings.clinicName || settings.logo);
  renderExportPreview();
  $('dlg-export').showModal();
};
$('ex-label-a').onchange = renderExportPreview;
$('ex-label-b').onchange = renderExportPreview;
$('ex-brand').onchange = renderExportPreview;
$('ex-go').onclick = e => {
  e.preventDefault();
  const fmt = $('ex-format').value;
  const type = fmt === 'png' ? 'image/png' : 'image/jpeg';
  let dataURL;
  try {
    dataURL = exportCompare(cmp, exportOptions()).toDataURL(type, 0.92);
  } catch (err) {
    toast('画像を作成できませんでした。'); return;
  }
  const id = newImageId();
  const now = new Date();
  const a = state.before, b = state.after;
  const detail = `${metaItem('before', a.createdAt, a.preset, a.view)} / ${metaItem('after', b.createdAt, b.preset, b.view)}`;
  let { bytes } = dataURLToBytes(dataURL);
  try {
    bytes = stampBytes(bytes, { software: SOFTWARE, id, date: now, kind: 'compare', build: APP_BUILD, description: DESC_COMPARE, detail });
  } catch (err) { /* メタデータが付かなくても画像は書き出せる */ }
  const blob = new Blob([bytes], { type });
  $('dlg-export').close();
  shareOrDownload(blob, 'reframe_' + fileStamp(now.getTime()) + (fmt === 'png' ? '.png' : '.jpg'))
    .then(res => { if (res === 'downloaded') toast('ダウンロードしました。'); });
};

async function loadBrandImg() {
  brandImg = null;
  if (!settings.logo) return;
  try { brandImg = await loadImage(settings.logo); } catch (e) { brandImg = null; }
}

/* ---------- 設定 ---------- */
hooks.settings = { enter() { renderSettings(); } };
$('st-back').onclick = () => back();

function renderSettings() {
  $('st-clinic').value = settings.clinicName;
  $('st-logo-preview').src = settings.logo || '';
  $('st-logo-preview').hidden = !settings.logo;
  $('st-logo-clear').hidden = !settings.logo;
  $('st-logo-pos').value = settings.logoPos;
  $('st-seq').checked = settings.sequence;
  $('st-views').value = settings.views.join('、');
  $('st-mirror').checked = settings.mirrorFront;
  $('st-res').value = settings.resolution;
  $('st-retention').value = settings.retention;
  $('st-delete-used').checked = settings.deleteUsedBefore;
  $('st-version').textContent = APP_VERSION;
  renderPresetEditor();
}
$('st-clinic').onchange = e => { settings.clinicName = e.target.value.trim(); saveSettings(); };
$('st-logo-pos').onchange = e => { settings.logoPos = e.target.value; saveSettings(); };
$('st-logo-pick').onclick = () => $('st-logo-input').click();
$('st-logo-input').onchange = async e => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const c = await decodeToCanvas(f, 512);
    settings.logo = c.toDataURL('image/png');
    saveSettings();
    await loadBrandImg();
    renderSettings();
  } catch (err) { toast('この画像を読み込めませんでした。'); }
};
$('st-logo-clear').onclick = () => { settings.logo = null; saveSettings(); brandImg = null; renderSettings(); };
$('st-seq').onchange = e => { settings.sequence = e.target.checked; saveSettings(); };
$('st-views').onchange = e => {
  const v = e.target.value.split(/[、,\s]+/).map(s => s.trim()).filter(Boolean).slice(0, 8);
  settings.views = v.length ? v : ['正面', '右側面', '左側面', '背面'];
  state.viewIndex = 0;
  saveSettings(); renderSettings();
};
$('st-mirror').onchange = e => { settings.mirrorFront = e.target.checked; saveSettings(); };
$('st-res').onchange = e => { settings.resolution = e.target.value; saveSettings(); };
$('st-retention').onchange = async e => {
  const prev = settings.retention, next = e.target.value;
  if (next === 'none' && prev !== 'none') {
    if (!await confirmDialog('「残さない」にすると、一時保持している写真をすべて削除します。', '変更')) { e.target.value = prev; return; }
  }
  settings.retention = next;
  saveSettings();
  await purgeExpired();
};
$('st-delete-used').onchange = e => { settings.deleteUsedBefore = e.target.checked; saveSettings(); };
$('st-clear-all').onclick = async () => {
  if (await confirmDialog('一時保持しているビフォー写真をすべて削除します。端末に保存した写真は消えません。')) {
    await clearBefores().catch(() => {});
    toast('削除しました。');
  }
};
$('st-update').onclick = async () => {
  if (!('serviceWorker' in navigator)) { toast('このブラウザでは更新確認を使えません。'); return; }
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) { toast('更新情報を取得できませんでした。'); return; }
  try { await reg.update(); }
  catch (e) { toast('更新を確認できませんでした。通信状態を確認してください。'); return; }
  if (reg.waiting) offerUpdate(reg);
  else toast('最新の状態を確認しました。更新があれば通知します。');
};

const AR_OPTIONS = [[3, 4], [1, 1], [4, 5], [2, 3], [9, 16], [4, 3], [16, 9]];
function renderPresetEditor() {
  const wrap = $('st-presets');
  wrap.innerHTML = '';
  settings.presets.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'preset-row';
    const name = field('名前', 'text');
    name.input.value = p.name; name.input.maxLength = 20;
    name.input.onchange = e => { p.name = e.target.value.trim() || p.name; saveSettings(); renderPresetEditor(); };
    const ar = field('縦横比(幅:高さ)', 'select');
    AR_OPTIONS.forEach(a => { const o = document.createElement('option'); o.value = a.join(':'); o.textContent = a.join(':'); ar.input.appendChild(o); });
    const cur = p.ar.join(':');
    if (!AR_OPTIONS.some(a => a.join(':') === cur)) { const o = document.createElement('option'); o.value = cur; o.textContent = cur; ar.input.appendChild(o); }
    ar.input.value = cur;
    ar.input.onchange = e => { p.ar = e.target.value.split(':').map(Number); saveSettings(); };
    const plumb = document.createElement('label');
    plumb.className = 'check';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = p.plumb;
    cb.onchange = () => { p.plumb = cb.checked; saveSettings(); };
    const cbText = document.createElement('span'); cbText.textContent = '鉛直線(中央)';
    plumb.append(cb, cbText);
    const hl = field('横線の本数', 'select');
    [0, 1, 2, 3].forEach(n => { const o = document.createElement('option'); o.value = n; o.textContent = n ? `${n}本` : 'なし'; hl.input.appendChild(o); });
    hl.input.value = p.hlines.length;
    hl.input.onchange = e => {
      const n = Number(e.target.value);
      const def = [0.27, 0.52, 0.75];
      p.hlines = p.hlines.slice(0, n);
      while (p.hlines.length < n) p.hlines.push(def[p.hlines.length] || 0.5);
      saveSettings();
    };
    const actions = document.createElement('div');
    actions.className = 'full inline-actions';
    const del = document.createElement('button');
    del.className = 'btn btn-text btn-danger btn-sm'; del.type = 'button'; del.textContent = '削除';
    del.disabled = settings.presets.length <= 1;
    del.onclick = async () => {
      if (await confirmDialog(`プリセット「${p.name}」を削除します。`)) {
        settings.presets.splice(i, 1);
        if (settings.lastPreset === p.id) settings.lastPreset = settings.presets[0].id;
        saveSettings(); renderPresetEditor();
      }
    };
    actions.appendChild(del);
    row.append(name.label, ar.label, plumb, hl.label, actions);
    wrap.appendChild(row);
  });
}
function field(labelText, kind) {
  const label = document.createElement('label');
  label.className = 'field';
  const span = document.createElement('span'); span.textContent = labelText;
  const input = document.createElement(kind === 'select' ? 'select' : 'input');
  if (kind !== 'select') input.type = 'text';
  label.append(span, input);
  return { label, input };
}
$('st-preset-add').onclick = () => {
  if (settings.presets.length >= 10) { toast('プリセットは10件までです。'); return; }
  settings.presets.push({ id: 'p' + Date.now().toString(36), name: '新しいプリセット', ar: [3, 4], plumb: true, hlines: [0.5] });
  saveSettings(); renderPresetEditor();
};

/* ---------- Service Worker ---------- */
let reloadOnControl = false;
/* 新しい版が待機中なら知らせる。切り替えと再読み込みは利用者が「再読み込み」を押したときに行う */
function offerUpdate(reg) {
  const waiting = reg.waiting;
  if (!waiting) return;
  toast('新しいバージョンがあります。', { label: '再読み込み', onClick: () => { reloadOnControl = true; waiting.postMessage('SKIP_WAITING'); } });
}
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadOnControl) { reloadOnControl = false; location.reload(); }
    });
    const reg = await navigator.serviceWorker.register('./sw.js');
    offerUpdate(reg);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(reg);
      });
    });
  } catch (e) { /* 登録できなくてもアプリは動作する */ }
}

/* ---------- 初期化 ---------- */
(async function init() {
  state.preset = currentPreset();
  await loadBrandImg();
  history.replaceState({ s: 'home' }, '', location.pathname + location.search);
  show('home');
  registerSW();
})();
