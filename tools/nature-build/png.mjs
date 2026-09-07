/* png.mjs - build-time only. Not loaded by the game.

   A tiny PNG reader/writer, just enough for the one job this pipeline
   needs: take the 1024x1024 PNGs that ship inside the Quaternius GLBs,
   box-filter them down to something an integrated GPU is happy to hold,
   and write them back out. Node has zlib, which is the only genuinely
   hard part of PNG, so this is mostly chunk bookkeeping.

   Supports exactly what those files use: 8-bit, non-interlaced, colour
   type 2 (RGB) or 6 (RGBA). Anything else throws rather than guessing. */

import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) { return CRC_TABLE; }
  CRC_TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) { c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); }
    CRC_TABLE[n] = c;
  }
  return CRC_TABLE;
}

function crc32(buf) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) { c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8); }
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
}

/* -> { width, height, data: Uint8Array RGBA } */
export function decodePNG(buf) {
  if (!buf.slice(0, 8).equals(SIG)) { throw new Error('not a PNG'); }
  let off = 8, ihdr = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        depth: data[8], colorType: data[9], interlace: data[12]
      };
    } else if (type === 'IDAT') { idat.push(data); }
    else if (type === 'IEND') { break; }
    off += 12 + len;
  }
  if (!ihdr) { throw new Error('PNG had no IHDR'); }
  if (ihdr.depth !== 8 || ihdr.interlace !== 0 || (ihdr.colorType !== 2 && ihdr.colorType !== 6)) {
    throw new Error('unsupported PNG: depth=' + ihdr.depth + ' ct=' + ihdr.colorType + ' interlace=' + ihdr.interlace);
  }
  const bpp = ihdr.colorType === 6 ? 4 : 3;
  const stride = ihdr.width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(ihdr.width * ihdr.height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < ihdr.height; y++) {
    const filter = raw[p++];
    for (let i = 0; i < stride; i++) {
      const x = raw[p + i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v;
      if (filter === 0) { v = x; }
      else if (filter === 1) { v = x + a; }
      else if (filter === 2) { v = x + b; }
      else if (filter === 3) { v = x + ((a + b) >> 1); }
      else if (filter === 4) { v = x + paeth(a, b, c); }
      else { throw new Error('bad PNG filter ' + filter); }
      cur[i] = v & 0xff;
    }
    p += stride;
    for (let x = 0; x < ihdr.width; x++) {
      const s = x * bpp, d = (y * ihdr.width + x) * 4;
      out[d] = cur[s]; out[d + 1] = cur[s + 1]; out[d + 2] = cur[s + 2];
      out[d + 3] = bpp === 4 ? cur[s + 3] : 255;
    }
    prev.set(cur);
  }
  return { width: ihdr.width, height: ihdr.height, data: out };
}

/* RGBA in, PNG out. hasAlpha:false writes colour type 2, which is a
   third smaller and is what every opaque texture here wants. */
export function encodePNG(img, hasAlpha) {
  const { width, height, data } = img;
  const bpp = hasAlpha ? 4 : 3;
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;                       /* filter 0: the deflate pass below
                                           gets these down far enough that
                                           per-line filter search is not
                                           worth the code */
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      raw[p++] = data[s]; raw[p++] = data[s + 1]; raw[p++] = data[s + 2];
      if (hasAlpha) { raw[p++] = data[s + 3]; }
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = hasAlpha ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  function chunk(type, body) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'ascii');
    const crcBuf = Buffer.concat([head.slice(4), body]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(crcBuf), 0);
    return Buffer.concat([head, body, tail]);
  }
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* Box downsample by an integer factor.

   Colour is averaged in PREMULTIPLIED alpha and then un-premultiplied.
   This matters: the leaf-cutout textures are a coloured shape on a fully
   transparent field whose RGB is white. Averaging straight RGB drags
   white into every edge pixel, and alphaTest then keeps some of those -
   a pale fringe around every leaf. Premultiplying weights each texel's
   colour by its own coverage, so transparent texels contribute nothing. */
export function downsample(img, factor) {
  const w = Math.max(1, Math.round(img.width / factor));
  const h = Math.max(1, Math.round(img.height / factor));
  const out = new Uint8Array(w * h * 4);
  const fx = img.width / w, fy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.min(img.height, Math.ceil((y + 1) * fy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.min(img.width, Math.ceil((x + 1) * fx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const s = (sy * img.width + sx) * 4;
          const av = img.data[s + 3] / 255;
          r += img.data[s] * av; g += img.data[s + 1] * av; b += img.data[s + 2] * av;
          a += img.data[s + 3];
          n++;
        }
      }
      const d = (y * w + x) * 4;
      const am = a / n;                       /* 0..255 */
      const wsum = (am / 255) * n;
      if (wsum > 0.0001) {
        out[d] = Math.round(r / wsum); out[d + 1] = Math.round(g / wsum); out[d + 2] = Math.round(b / wsum);
      } else { out[d] = out[d + 1] = out[d + 2] = 255; }
      out[d + 3] = Math.round(am);
    }
  }
  return { width: w, height: h, data: out };
}
