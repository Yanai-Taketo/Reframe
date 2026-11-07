/* ---------- 共通 ---------- */
const TE = new TextEncoder();
const TD = new TextDecoder('utf-8');
const TAG = { ImageDescription: 0x010E, Make: 0x010F, Model: 0x0110, Orientation: 0x0112, Software: 0x0131, DateTime: 0x0132, ExifIFD: 0x8769, DateTimeOriginal: 0x9003, DateTimeDigitized: 0x9004, OffsetTimeOriginal: 0x9011, ImageUniqueID: 0xA420, XPTitle: 0x9C9B };
const XMP_NS = 'http://ns.adobe.com/xap/1.0/\0';
const REFRAME_NS = 'https://github.com/Yanai-Taketo/reframe/ns/1.0/';

const pad2 = n => String(n).padStart(2, '0');
export function exifDate(d) {
  return `${d.getFullYear()}:${pad2(d.getMonth() + 1)}:${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
export function tzOffset(d) {
  const m = -d.getTimezoneOffset();
  const sign = m >= 0 ? '+' : '-';
  const a = Math.abs(m);
  return `${sign}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}
export function isoDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${tzOffset(d)}`;
}
export function newImageId() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}
const ascii = s => TE.encode(String(s).replace(/[^\x20-\x7e]/g, '?'));
const asciiZ = s => { const a = ascii(s); const out = new Uint8Array(a.length + 1); out.set(a); return out; };
const utf8Z = s => { const a = TE.encode(String(s)); const out = new Uint8Array(a.length + 1); out.set(a); return out; };
/* UTF-16LE + 終端NUL(Windows の XPTitle 用) */
const utf16Z = s => { const t = String(s); const out = new Uint8Array((t.length + 1) * 2); for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); out[i * 2] = c & 0xFF; out[i * 2 + 1] = c >> 8; } return out; };
const escXml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/* 説明欄に書く文章(すべての説明欄で同じものを使う) */
const fullDescription = meta => meta.detail ? `${meta.description} / ${meta.detail}` : String(meta.description);

/* ---------- JPEG: EXIF ---------- */
function buildTiff(ifd0Fields, exifFields) {
  const LE = true;
  const n0 = ifd0Fields.length + (exifFields.length ? 1 : 0);
  const n1 = exifFields.length;
  let p = 8 + 2 + n0 * 12 + 4;
  const place = (fields) => {
    const list = [];
    for (const f of fields) if (f.bytes.length > 4) { list.push({ f, off: p }); p += f.bytes.length + (f.bytes.length & 1); }
    return list;
  };
  const data0 = place(ifd0Fields);
  const exifOff = n1 ? p : 0;
  if (n1) p = exifOff + 2 + n1 * 12 + 4;
  const data1 = place(exifFields);
  const buf = new Uint8Array(p);
  const v = new DataView(buf.buffer);
  buf[0] = 0x49; buf[1] = 0x49; v.setUint16(2, 0x2A, LE); v.setUint32(4, 8, LE);
  const writeIFD = (off, fields, dataList, pointer) => {
    const all = fields.map(f => ({ tag: f.tag, f }));
    if (pointer) all.push({ tag: pointer.tag, pointer });
    all.sort((a, b) => a.tag - b.tag);
    v.setUint16(off, all.length, LE);
    let e = off + 2;
    for (const it of all) {
      v.setUint16(e, it.tag, LE);
      if (it.pointer) {
        v.setUint16(e + 2, 4, LE); v.setUint32(e + 4, 1, LE); v.setUint32(e + 8, it.pointer.value, LE);
      } else {
        const f = it.f;
        v.setUint16(e + 2, f.type, LE);
        v.setUint32(e + 4, f.type === 1 || f.type === 2 ? f.bytes.length : 1, LE);
        if (f.bytes.length <= 4) buf.set(f.bytes, e + 8);
        else { const d = dataList.find(x => x.f === f); v.setUint32(e + 8, d.off, LE); buf.set(f.bytes, d.off); }
      }
      e += 12;
    }
    v.setUint32(e, 0, LE);
  };
  writeIFD(8, ifd0Fields, data0, n1 ? { tag: TAG.ExifIFD, value: exifOff } : null);
  if (n1) writeIFD(exifOff, exifFields, data1, null);
  return buf;
}

function segment(marker, payload) {
  const len = payload.length + 2;
  const head = new Uint8Array([0xFF, marker, (len >> 8) & 0xFF, len & 0xFF]);
  return concat([head, payload]);
}

function buildExifApp1(meta) {
  const d = meta.date;
  const text = fullDescription(meta);
  const ifd0 = [
    { tag: TAG.ImageDescription, type: 2, bytes: utf8Z(text) },
    { tag: TAG.Make, type: 2, bytes: asciiZ('Reframe') },
    { tag: TAG.Model, type: 2, bytes: asciiZ('Reframe') },
    { tag: TAG.Orientation, type: 3, bytes: new Uint8Array([1, 0]) },
    { tag: TAG.Software, type: 2, bytes: asciiZ(meta.software) },
    { tag: TAG.DateTime, type: 2, bytes: asciiZ(exifDate(d)) },
    { tag: TAG.XPTitle, type: 1, bytes: utf16Z(text) },
  ];
  const exif = [
    { tag: TAG.DateTimeOriginal, type: 2, bytes: asciiZ(exifDate(d)) },
    { tag: TAG.DateTimeDigitized, type: 2, bytes: asciiZ(exifDate(d)) },
    { tag: TAG.OffsetTimeOriginal, type: 2, bytes: asciiZ(tzOffset(d)) },
    { tag: TAG.ImageUniqueID, type: 2, bytes: asciiZ(meta.id) },
  ];
  return segment(0xE1, concat([TE.encode('Exif\0\0'), buildTiff(ifd0, exif)]));
}

/* ---------- XMP ---------- */
function buildXmpPacket(meta) {
  const text = escXml(fullDescription(meta));
  const title = `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${text}</rdf:li></rdf:Alt></dc:title>`;
  const desc = `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${text}</rdf:li></rdf:Alt></dc:description>`;
  return '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>'
    + '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    + `<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:reframe="${REFRAME_NS}"`
    + ` xmp:CreatorTool="${escXml(meta.software)}" xmp:CreateDate="${isoDate(meta.date)}"`
    + ` xmpMM:DocumentID="uuid:${meta.id}" xmpMM:InstanceID="uuid:${meta.id}"`
    + ` reframe:imageId="${meta.id}" reframe:kind="${escXml(meta.kind)}" reframe:build="${Number(meta.build) || 0}">${title}${desc}</rdf:Description>`
    + '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
}
function buildXmpApp1(meta) {
  return segment(0xE1, concat([TE.encode(XMP_NS), TE.encode(buildXmpPacket(meta))]));
}

/* ---------- JPEG 書き込み ---------- */
function jpegSegments(u8) {
  const segs = [];
  let pos = 2;
  while (pos + 4 <= u8.length && u8[pos] === 0xFF) {
    const marker = u8[pos + 1];
    if (marker === 0xDA || marker === 0xD9) break;
    if (marker === 0xFF) { pos += 1; continue; }
    const len = (u8[pos + 2] << 8) | u8[pos + 3];
    segs.push({ marker, start: pos, end: pos + 2 + len });
    pos += 2 + len;
  }
  return { segs, bodyStart: pos };
}
function isExifOrXmp(u8, s) {
  if (s.marker !== 0xE1) return false;
  const head = TD.decode(u8.subarray(s.start + 4, Math.min(s.end, s.start + 4 + 29)));
  return head.startsWith('Exif') || head.startsWith('http://ns.adobe.com/xap/1.0/');
}
export function stampJpeg(u8, meta) {
  if (!(u8[0] === 0xFF && u8[1] === 0xD8)) return u8;
  const { segs, bodyStart } = jpegSegments(u8);
  const kept = segs.filter(s => !isExifOrXmp(u8, s));
  const parts = [u8.subarray(0, 2)];
  let inserted = false;
  for (const s of kept) {
    parts.push(u8.subarray(s.start, s.end));
    if (!inserted && s.marker === 0xE0) { parts.push(buildExifApp1(meta), buildXmpApp1(meta)); inserted = true; }
  }
  if (!inserted) parts.splice(1, 0, buildExifApp1(meta), buildXmpApp1(meta));
  parts.push(u8.subarray(bodyStart));
  return concat(parts);
}

/* ---------- PNG 書き込み ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function pngChunk(type, data) {
  const t = TE.encode(type);
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, data.length);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(concat([t, data])));
  return concat([head, t, data, crc]);
}
const latin1 = s => Uint8Array.from(String(s).replace(/[^\x20-\x7e]/g, '?'), ch => ch.charCodeAt(0));
function tEXt(key, text) { return pngChunk('tEXt', concat([latin1(key), new Uint8Array([0]), latin1(text)])); }
function iTXt(key, text) { return pngChunk('iTXt', concat([latin1(key), new Uint8Array([0, 0, 0]), new Uint8Array([0]), new Uint8Array([0]), TE.encode(text)])); }
const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
function isPng(u8) { return PNG_SIG.every((b, i) => u8[i] === b); }
export function stampPng(u8, meta) {
  if (!isPng(u8)) return u8;
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const ihdrEnd = 8 + 12 + v.getUint32(8);
  const chunks = [
    tEXt('Software', meta.software),
    tEXt('Creation Time', meta.date.toUTCString()),
    tEXt('Comment', `Reframe image id=${meta.id} kind=${meta.kind} build=${Number(meta.build) || 0}`),
    iTXt('Description', fullDescription(meta)),
  ];
  return concat([u8.subarray(0, ihdrEnd), ...chunks, u8.subarray(ihdrEnd)]);
}

export function stampBytes(u8, meta) {
  if (u8[0] === 0xFF && u8[1] === 0xD8) return stampJpeg(u8, meta);
  if (isPng(u8)) return stampPng(u8, meta);
  return u8;
}

/* ---------- 読み取り ---------- */
function parseTiff(v, t, out) {
  if (t + 8 > v.byteLength) return;
  const le = v.getUint16(t) === 0x4949;
  const g16 = o => v.getUint16(o, le), g32 = o => v.getUint32(o, le);
  if (g16(t + 2) !== 0x2A) return;
  const readAscii = (o, n) => {
    let i = 0;
    while (i < n && o + i < v.byteLength && v.getUint8(o + i) !== 0) i++;
    return TD.decode(new Uint8Array(v.buffer, v.byteOffset + o, i)).trim();
  };
  const scan = (ifd, wanted) => {
    const found = {};
    if (ifd + 2 > v.byteLength) return found;
    const n = g16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > v.byteLength) break;
      const tag = g16(e), type = g16(e + 2), count = g32(e + 4);
      if (!wanted.includes(tag)) continue;
      if (type === 2) found[tag] = count <= 4 ? readAscii(e + 8, count) : readAscii(t + g32(e + 8), count);
      else if (type === 3) found[tag] = g16(e + 8);
      else if (type === 4) found[tag] = g32(e + 8);
    }
    return found;
  };
  const ifd0 = scan(t + g32(t + 4), [TAG.ImageDescription, TAG.Software, TAG.DateTime, TAG.ExifIFD]);
  out.description = ifd0[TAG.ImageDescription] || out.description;
  out.software = ifd0[TAG.Software] || out.software;
  out.dateTime = ifd0[TAG.DateTime] || out.dateTime;
  if (ifd0[TAG.ExifIFD]) {
    const ex = scan(t + ifd0[TAG.ExifIFD], [TAG.DateTimeOriginal, TAG.OffsetTimeOriginal, TAG.ImageUniqueID]);
    out.dateTimeOriginal = ex[TAG.DateTimeOriginal] || out.dateTimeOriginal;
    out.offsetTime = ex[TAG.OffsetTimeOriginal] || out.offsetTime;
    out.imageId = ex[TAG.ImageUniqueID] || out.imageId;
  }
}
function parseXmp(text, out) {
  const attr = name => { const m = new RegExp(name + '="([^"]*)"').exec(text); return m ? m[1] : null; };
  out.xmp = {
    creatorTool: attr('xmp:CreatorTool'),
    createDate: attr('xmp:CreateDate'),
    imageId: attr('reframe:imageId'),
    kind: attr('reframe:kind'),
    build: attr('reframe:build'),
    description: (/<dc:description>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/.exec(text) || [])[1] || null,
  };
  if (out.xmp.description) out.xmp.description = out.xmp.description.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/* 画像ファイルのメタデータを読む。Reframeの印があれば isReframe が true */
export async function readImageMeta(blob) {
  const out = { format: null, software: null, description: null, dateTime: null, dateTimeOriginal: null, offsetTime: null, imageId: null, xmp: null, png: null };
  try {
    const buf = await blob.slice(0, 512 * 1024).arrayBuffer();
    const u8 = new Uint8Array(buf);
    const v = new DataView(buf);
    if (u8[0] === 0xFF && u8[1] === 0xD8) {
      out.format = 'JPEG';
      const { segs } = jpegSegments(u8);
      for (const s of segs) {
        if (s.marker !== 0xE1) continue;
        const head = TD.decode(u8.subarray(s.start + 4, Math.min(s.end, s.start + 4 + 29)));
        if (head.startsWith('Exif')) parseTiff(v, s.start + 10, out);
        else if (head.startsWith('http://ns.adobe.com/xap/1.0/')) parseXmp(TD.decode(u8.subarray(s.start + 4 + 29, s.end)), out);
      }
    } else if (isPng(u8)) {
      out.format = 'PNG';
      out.png = {};
      let pos = 8;
      while (pos + 12 <= u8.length) {
        const len = v.getUint32(pos);
        const type = TD.decode(u8.subarray(pos + 4, pos + 8));
        const data = u8.subarray(pos + 8, pos + 8 + len);
        if (type === 'tEXt' || type === 'iTXt') {
          const z = data.indexOf(0);
          const key = TD.decode(data.subarray(0, z));
          let text;
          if (type === 'tEXt') text = Array.from(data.subarray(z + 1), b => String.fromCharCode(b)).join('');
          else {
            let q = z + 3; q = data.indexOf(0, q) + 1; q = data.indexOf(0, q) + 1;
            text = TD.decode(data.subarray(q));
          }
          out.png[key] = text;
        }
        if (type === 'IDAT' || type === 'IEND') break;
        pos += 12 + len;
      }
      out.software = out.png.Software || null;
      out.description = out.png.Description || null;
      const m = /id=([0-9a-f]{32})/.exec(out.png.Comment || '');
      out.imageId = m ? m[1] : null;
    }
  } catch (e) { /* 読めない形式は空のまま返す */ }
  const soft = out.software || (out.xmp && out.xmp.creatorTool) || '';
  out.isReframe = /^Reframe\b/.test(soft) || !!(out.xmp && out.xmp.imageId) || /^Reframe/.test(out.description || '');
  if (!out.imageId && out.xmp && out.xmp.imageId) out.imageId = out.xmp.imageId;
  return out;
}
