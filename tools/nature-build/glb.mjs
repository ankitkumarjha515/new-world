/* glb.mjs - build-time only. Not loaded by the game.

   Reads a binary glTF, hands back plain JS typed arrays per primitive
   with the node transforms already baked in, and writes a new binary
   glTF back out. Deliberately minimal: the Quaternius source files are
   one mesh, two primitives, no skins, no animation, no sparse
   accessors, no Draco. Anything outside that throws instead of
   silently producing a broken model. */

import fs from 'node:fs';

const COMP = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
  5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array
};
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export function readGLB(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546c67) { throw new Error('not a GLB: ' + file); }
  const total = b.readUInt32LE(8);
  let o = 12, json = null, bin = null;
  while (o + 8 <= total) {
    const len = b.readUInt32LE(o), type = b.readUInt32LE(o + 4);
    const data = b.slice(o + 8, o + 8 + len);
    if (type === 0x4e4f534a) { json = JSON.parse(data.toString('utf8')); }
    else if (type === 0x004e4942) { bin = data; }
    o += 8 + len;
  }
  if (!json) { throw new Error('GLB had no JSON chunk: ' + file); }
  return { json, bin };
}

function accessor(json, bin, i) {
  const a = json.accessors[i];
  if (a.sparse) { throw new Error('sparse accessors not supported'); }
  const bv = json.bufferViews[a.bufferView];
  const nc = NCOMP[a.type];
  const Ctor = COMP[a.componentType];
  const off = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const stride = bv.byteStride || 0;
  const out = new Ctor(a.count * nc);
  if (!stride || stride === nc * Ctor.BYTES_PER_ELEMENT) {
    /* tightly packed: one copy. byteOffset may be unaligned for the
       typed array, so go through a slice rather than a view. */
    const bytes = bin.slice(off, off + a.count * nc * Ctor.BYTES_PER_ELEMENT);
    out.set(new Ctor(bytes.buffer, bytes.byteOffset, a.count * nc));
  } else {
    for (let k = 0; k < a.count; k++) {
      const bytes = bin.slice(off + k * stride, off + k * stride + nc * Ctor.BYTES_PER_ELEMENT);
      out.set(new Ctor(bytes.buffer, bytes.byteOffset, nc), k * nc);
    }
  }
  return out;
}

function mul(a, b) { /* column-major 4x4, a*b */
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

function trs(node) {
  if (node.matrix) { return Float64Array.from(node.matrix); }
  const t = node.translation || [0, 0, 0];
  const r = node.rotation || [0, 0, 0, 1];
  const s = node.scale || [1, 1, 1];
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return Float64Array.from([
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1
  ]);
}

function xformPoint(m, x, y, z) {
  return [m[0] * x + m[4] * y + m[8] * z + m[12],
          m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14]];
}

/* Rotate a direction by m's upper 3x3. The source models are all
   uniform-scaled (usually identity), so the inverse-transpose the
   general case would need collapses to this. */
function xformDir(m, x, y, z) {
  const o = [m[0] * x + m[4] * y + m[8] * z,
             m[1] * x + m[5] * y + m[9] * z,
             m[2] * x + m[6] * y + m[10] * z];
  const l = Math.hypot(o[0], o[1], o[2]) || 1;
  return [o[0] / l, o[1] / l, o[2] / l];
}

/* Flattens the whole scene into one array of primitives, world space.
   Each entry: { material, pos:Float32Array, nor, uv, col, idx } */
export function flatten(file) {
  const { json, bin } = readGLB(file);
  const out = [];
  const scene = json.scenes[json.scene || 0];
  const walk = (ni, parent) => {
    const node = json.nodes[ni];
    const m = mul(parent, trs(node));
    if (node.mesh !== undefined) {
      for (const p of json.meshes[node.mesh].primitives) {
        if (p.mode !== undefined && p.mode !== 4) { throw new Error('non-triangle primitive'); }
        const src = accessor(json, bin, p.attributes.POSITION);
        const n = src.length / 3;
        const pos = new Float32Array(n * 3);
        for (let k = 0; k < n; k++) {
          const v = xformPoint(m, src[k * 3], src[k * 3 + 1], src[k * 3 + 2]);
          pos[k * 3] = v[0]; pos[k * 3 + 1] = v[1]; pos[k * 3 + 2] = v[2];
        }
        let nor = null;
        if (p.attributes.NORMAL !== undefined) {
          const sn = accessor(json, bin, p.attributes.NORMAL);
          nor = new Float32Array(n * 3);
          for (let k = 0; k < n; k++) {
            const v = xformDir(m, sn[k * 3], sn[k * 3 + 1], sn[k * 3 + 2]);
            nor[k * 3] = v[0]; nor[k * 3 + 1] = v[1]; nor[k * 3 + 2] = v[2];
          }
        }
        let uv = null;
        if (p.attributes.TEXCOORD_0 !== undefined) {
          uv = Float32Array.from(accessor(json, bin, p.attributes.TEXCOORD_0));
        }
        let col = null;
        if (p.attributes.COLOR_0 !== undefined) {
          const a = json.accessors[p.attributes.COLOR_0];
          const raw = accessor(json, bin, p.attributes.COLOR_0);
          const nc = NCOMP[a.type];
          const scale = a.componentType === 5126 ? 1 : (a.componentType === 5123 ? 1 / 65535 : 1 / 255);
          col = new Float32Array(n * 3);
          for (let k = 0; k < n; k++) {
            col[k * 3] = raw[k * nc] * scale;
            col[k * 3 + 1] = raw[k * nc + 1] * scale;
            col[k * 3 + 2] = raw[k * nc + 2] * scale;
          }
        }
        const idx = p.indices !== undefined
          ? Uint32Array.from(accessor(json, bin, p.indices))
          : Uint32Array.from({ length: n }, (_, k) => k);
        out.push({
          material: (p.material !== undefined && json.materials[p.material].name) || 'default',
          pos, nor, uv, col, idx
        });
      }
    }
    for (const c of node.children || []) { walk(c, m); }
  };
  const I = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  for (const ni of scene.nodes) { walk(ni, I); }
  return { prims: out, json };
}

/* Writes a texture-less GLB. `lods` is an array of { name, prims },
   one node per entry, so a single file carries every level of detail
   and the game fetches it once. Materials are name-only stubs: the
   game looks the name up in its own table and attaches the shared
   texture + toon material itself (see models.js). */
export function writeGLB(file, lods) {
  const json = {
    asset: { version: '2.0', generator: 'whispering-meadow nature packer' },
    scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [],
    materials: [], accessors: [], bufferViews: [], buffers: []
  };
  const matIndex = new Map();
  const chunks = [];
  let offset = 0;

  function pushView(typedArray, target) {
    const buf = Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
    const pad = (4 - (buf.length % 4)) % 4;
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target });
    chunks.push(buf);
    if (pad) { chunks.push(Buffer.alloc(pad)); }
    offset += buf.length + pad;
    return json.bufferViews.length - 1;
  }

  function pushAccessor(typedArray, type, componentType, target, minmax) {
    const nc = NCOMP[type];
    const bv = pushView(typedArray, target);
    const a = { bufferView: bv, componentType, count: typedArray.length / nc, type };
    if (minmax) { a.min = minmax[0]; a.max = minmax[1]; }
    json.accessors.push(a);
    return json.accessors.length - 1;
  }

  for (const lod of lods) {
    const primitives = [];
    for (const p of lod.prims) {
      if (!p.idx.length) { continue; }
      let mi = matIndex.get(p.material);
      if (mi === undefined) {
        json.materials.push({
          name: p.material,
          pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 }
        });
        mi = json.materials.length - 1;
        matIndex.set(p.material, mi);
      }
      const n = p.pos.length / 3;
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < n; k++) {
        for (let c = 0; c < 3; c++) {
          const v = p.pos[k * 3 + c];
          if (v < min[c]) { min[c] = v; }
          if (v > max[c]) { max[c] = v; }
        }
      }
      const attributes = { POSITION: pushAccessor(p.pos, 'VEC3', 5126, 34962, [min, max]) };
      if (p.nor) { attributes.NORMAL = pushAccessor(p.nor, 'VEC3', 5126, 34962); }
      if (p.uv) { attributes.TEXCOORD_0 = pushAccessor(p.uv, 'VEC2', 5126, 34962); }
      if (p.col) { attributes.COLOR_0 = pushAccessor(p.col, 'VEC3', 5126, 34962); }
      const big = n > 65535;
      const idx = big ? Uint32Array.from(p.idx) : Uint16Array.from(p.idx);
      primitives.push({
        attributes, material: mi,
        indices: pushAccessor(idx, 'SCALAR', big ? 5125 : 5123, 34963)
      });
    }
    json.meshes.push({ name: lod.name, primitives });
    json.nodes.push({ name: lod.name, mesh: json.meshes.length - 1 });
    json.scenes[0].nodes.push(json.nodes.length - 1);
  }

  const binChunk = Buffer.concat(chunks);
  json.buffers.push({ byteLength: binChunk.length });
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jpad = (4 - (jsonBuf.length % 4)) % 4;
  if (jpad) { jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jpad, 0x20)]); }

  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binChunk.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(binChunk.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  fs.writeFileSync(file, Buffer.concat([head, jh, jsonBuf, bh, binChunk]));
  return 12 + 8 + jsonBuf.length + 8 + binChunk.length;
}

/* Pulls the embedded PNGs out of a source GLB, keyed by image name. */
export function extractImages(file) {
  const { json, bin } = readGLB(file);
  const out = {};
  for (const im of json.images || []) {
    if (im.bufferView === undefined) { continue; }
    const bv = json.bufferViews[im.bufferView];
    const off = bv.byteOffset || 0;
    out[im.name || ('image' + Object.keys(out).length)] = bin.slice(off, off + bv.byteLength);
  }
  return out;
}
