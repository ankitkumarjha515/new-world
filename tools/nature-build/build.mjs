/* build.mjs - build-time only. Not loaded by the game. Run with:
       node tools/nature-build/build.mjs

   Turns the CC0 Quaternius "Stylized Nature MegaKit" GLBs (downloaded
   from poly.pizza, see SOURCES.md) into what this game actually wants:

     * one GLB per prop, carrying TWO levels of detail as two nodes
       (LOD0 full, LOD1 reduced canopy), and NO textures at all
     * a handful of shared PNGs, downsampled, that every model points at
       by material name

   Why strip the textures out of the models: the source files embed a
   1024x1024 base colour AND a 1024x1024 normal map per material, and
   the same eight textures are repeated across all 25 models - about
   2.2 MB of PNG in every single tree. Pulling them out once means the
   whole nature set downloads in roughly the size of ONE original tree,
   and - more important on an integrated GPU with no VRAM to spare -
   there is exactly one THREE.Texture per image for the entire world
   instead of one per model. models.js re-attaches them by material
   name (NATURE_TEX there mirrors TEXTURES here).

   The normal maps are dropped outright: everything in this world is
   MeshToonMaterial with a 4-step gradient ramp, which cannot show a
   normal map's detail in any case. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flatten, writeGLB, extractImages } from './glb.mjs';
import { decodePNG, encodePNG, downsample } from './png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* Explicitly the asset directory, NOT `HERE/..`. This script used to live in
   public/assets/nature/tools/, where `..` was the right answer; it was moved
   to tools/nature-build/ and the relative path came with it, so a build
   quietly wrote models/, textures/ and manifest.json into tools/ and left
   the real asset directory untouched. Anchoring on the repo root means
   moving the script again cannot repeat that. */
const ROOT = path.join(HERE, '..', '..');
const OUT = path.join(ROOT, 'public', 'assets', 'nature');
const CACHE = path.join(HERE, '.cache');

/* ---------------------------------------------------------------- source
   Every one of these is CC0, by Quaternius, mirrored on poly.pizza.
   `id` is the poly.pizza asset uuid: https://static.poly.pizza/<id>.glb */
const MODELS = [
  /* broadleaf - the ordinary meadow tree */
  { out: 'tree_a', id: '2c5938cb-4005-4958-829b-e191be39b3b9', page: 'QVOop92WmG', title: 'Tree' },
  { out: 'tree_b', id: '856b5db4-21c1-406b-a800-d96843d1ec69', page: 'YWjGDJ9F7g', title: 'Tree' },
  { out: 'tree_c', id: '7f84a768-ac30-48d4-9c5d-f760492e7867', page: 't9KbsfYdXz', title: 'Tree' },
  { out: 'tree_d', id: '24cf9df9-435f-408e-971b-640d670ce973', page: 'qZtx0AHhcy', title: 'Tree' },
  /* conifers */
  { out: 'pine_a', id: '082c2026-56af-4e3f-bea7-9ae5de71101f', page: '79gmlLnweB', title: 'Pine' },
  { out: 'pine_b', id: 'be462d46-2e48-401e-8da9-2f4d9bc9df0c', page: 'Zt62gceKXZ', title: 'Pine' },
  { out: 'pine_c', id: '712aaefa-ae7f-4cb3-8834-a1b8860df3b2', page: 'igSu0cPoBz', title: 'Pine' },
  /* the big gnarled ones - these become the blossom trees along the path */
  { out: 'blossom_a', id: 'c6b8d04d-8ca3-4898-a180-e2ca2b936863', page: '9aWlx82xUf', title: 'Twisted Tree' },
  { out: 'blossom_b', id: '0e8292f8-f8ac-4483-987f-93386f07ea58', page: 'GVTsMmuzv7', title: 'Twisted Tree' },
  /* undergrowth */
  { out: 'bush_a', id: '5d3066f4-58ac-46d4-899c-39d9e566e9df', page: 'EoTERLq3z2', title: 'Bush' },
  { out: 'fern_a', id: 'f94d836f-4eb4-4db0-aa53-3ecdddffa527', page: 'jqcanvH7D6', title: 'Fern' },
  /* stone */
  { out: 'rock_a', id: 'aaf0aaa7-c244-430a-908b-2ac57567d81c', page: 'KZdEP3uUpa', title: 'Rock Medium' },
  { out: 'rock_b', id: 'be5fef3a-4fa1-4d08-b2d4-82e02284588d', page: 's1OJ3bBzqc', title: 'Rock Medium' },
  { out: 'rock_c', id: '73b7e249-300d-4d4b-9c31-a610b8a1ffec', page: 'JQxF95498B', title: 'Rock Medium' },
  /* the tall single flower the sunflower field is built from */
  { out: 'flower_a', id: '358cce00-6e7e-4411-b889-8514eae139ce', page: 'rHBoS64rRL', title: 'Flower Single' },
  { out: 'flower_b', id: '9fbc2eff-4a06-4450-801e-cdb700722ff0', page: 'GvfHo0roi3', title: 'Flower Single' },

  /* ---------------------------------------------------------- landmarks
     Not scatter. These are the handful of things the meadow is meant to
     have ONE of, or a few of, so that walking in a direction has a point
     to it. They come through this build for the same reason the trees do:
     the alternative is four more models each carrying its own copy of a
     texture, and this pipeline is the thing that stops that happening.

     The dead tree is the case that justifies the rule twice over. Its
     source GLB is 2.5 MB, of which 2.3 MB is two PNGs - and 1.33 MB of
     THAT is a normal map, which this game cannot display at all
     (MeshToonMaterial through a 4-step ramp has nowhere to put it). It is
     dropped here simply by not being named in TEXTURES, and the base
     colour comes down to 256px with everything else. */
  { out: 'statue_fox', id: '9a765c68-38b8-40a8-95a2-892b44ef8b46', page: 'abxyXID5EA', title: 'Fox Statue' },
  { out: 'pillar',     id: '459e3296-6e9c-4360-a2db-d2fb875bd670', page: '1nt8n3rVKU', title: 'Pillar' },
  { out: 'crypt',      id: 'c9caf59f-b468-4da8-9d95-27c65fb41f01', page: 'iV5x01FYAl', title: 'Crypt' },
  { out: 'dead_tree',  id: 'c02771ac-10db-420b-9426-86f26ae0869a', page: 'n8FhMgMldD', title: 'Dead Tree' }
];

/* A material with no texture and no COLOR_0 would reach the game as flat
   white under the toon ramp. The fox statue is exactly that - it ships with
   POSITION and NORMAL and nothing else - so it gets a vertex colour painted
   on here rather than a special case in the renderer. Weathered limestone,
   slightly warm, so it separates from the grey rocks it stands among. */
const TINT = {
  Stone: [0.74, 0.72, 0.67]
};

/* material name in the source GLB -> { file, role, size }
   role decides both the LOD treatment here and the material the game
   builds in models.js. `size` is the output edge length in pixels. */
const TEXTURES = {
  Bark_NormalTree:   { image: 'Bark_NormalTree.png',       file: 'bark.png',           role: 'bark',   size: 256 },
  Bark_TwistedTree:  { image: 'Bark_TwistedTree.png',      file: 'bark_twisted.png',   role: 'bark',   size: 256 },
  Leaves_NormalTree: { image: 'Leaves_NormalTree_C.png',   file: 'leaves_broad.png',   role: 'leaves', size: 512 },
  Leaves_Pine:       { image: 'Leaf_Pine_C.png',           file: 'leaves_pine.png',    role: 'leaves', size: 512 },
  Leaves_TwistedTree:{ image: 'Leaves_TwistedTree_C.png',  file: 'leaves_twisted.png', role: 'leaves', size: 512 },
  Leaves:            { image: 'Leaves.png',                file: 'leaves_blade.png',   role: 'leaves', size: 256 },
  Flowers:           { image: 'Flowers.png',               file: 'flowers.png',        role: 'leaves', size: 256 },
  Rocks:             { image: 'Rocks_Diffuse.png',         file: 'rock.png',           role: 'rock',   size: 256 },
  /* landmarks. HalloweenBits is ONE atlas serving both KayKit props, which
     is the arrangement this whole table exists to produce - it just came
     that way already. Bark_DeadTree's companion Bark_DeadTree_Normal.png is
     deliberately absent: not naming it here is what drops it. */
  HalloweenBits:     { image: 'halloweenbits_texture.png', file: 'halloween.png',      role: 'rock',   size: 256 },
  Bark_DeadTree:     { image: 'Bark_DeadTree.png',         file: 'bark_dead.png',      role: 'bark',   size: 256 }
};

async function fetchModel(m) {
  fs.mkdirSync(CACHE, { recursive: true });
  const f = path.join(CACHE, m.out + '.glb');
  if (fs.existsSync(f)) { return f; }
  const url = 'https://static.poly.pizza/' + m.id + '.glb';
  process.stdout.write('  fetching ' + m.out + ' ... ');
  const res = await fetch(url);
  if (!res.ok) { throw new Error(url + ' -> HTTP ' + res.status); }
  fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
  console.log('ok');
  return f;
}

/* ------------------------------------------------------------- sprigs
   Every canopy in this pack is a pile of DISCONNECTED pieces: the
   broadleaf and blossom crowns are loose quads (four vertices, six
   indices, nothing shared), the pine's is little fans of a few
   triangles each. Nothing in a canopy touches anything else in it.

   That is what the mid LOD is built on. Splitting the mesh into
   connected components gives us one component per leaf card / needle
   sprig, so the canopy can be thinned by throwing away whole cards and
   growing the survivors to cover the gap. A general edge-collapse
   simplifier is the wrong tool here: with no shared edges to collapse
   it has nothing to work with, and what it does instead is weld
   neighbouring cards into spaghetti. */
function components(prim) {
  const n = prim.pos.length / 3;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) { parent[i] = i; }
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) { parent[ra] = rb; } };
  for (let i = 0; i + 3 <= prim.idx.length; i += 3) {
    union(prim.idx[i], prim.idx[i + 1]);
    union(prim.idx[i + 1], prim.idx[i + 2]);
  }
  const groups = new Map();
  for (let i = 0; i + 3 <= prim.idx.length; i += 3) {
    const r = find(prim.idx[i]);
    let g = groups.get(r);
    if (!g) { g = { tris: [], verts: new Set() }; groups.set(r, g); }
    g.tris.push(i);
    g.verts.add(prim.idx[i]); g.verts.add(prim.idx[i + 1]); g.verts.add(prim.idx[i + 2]);
  }
  const out = [];
  for (const g of groups.values()) {
    let cx = 0, cy = 0, cz = 0;
    for (const j of g.verts) { cx += prim.pos[j * 3]; cy += prim.pos[j * 3 + 1]; cz += prim.pos[j * 3 + 2]; }
    const c = g.verts.size;
    cx /= c; cy /= c; cz /= c;
    let r = 0;
    for (const j of g.verts) {
      r = Math.max(r, Math.hypot(prim.pos[j * 3] - cx, prim.pos[j * 3 + 1] - cy, prim.pos[j * 3 + 2] - cz));
    }
    out.push({ tris: g.tris, verts: Array.from(g.verts), c: [cx, cy, cz], r });
  }
  return out;
}

/* Rebuild a primitive from a subset of its components, each one blown
   up about its own centre so the canopy keeps its silhouette even
   though half the cards are gone. */
function rebuildFrom(prim, keep, grow) {
  const pos = [], nor = [], uv = [], idx = [];
  for (const g of keep) {
    const map = new Map();
    for (const src of g.verts) {
      map.set(src, pos.length / 3);
      for (let c = 0; c < 3; c++) {
        pos.push(g.c[c] + (prim.pos[src * 3 + c] - g.c[c]) * grow);
        if (prim.nor) { nor.push(prim.nor[src * 3 + c]); }
      }
      if (prim.uv) { uv.push(prim.uv[src * 2], prim.uv[src * 2 + 1]); }
    }
    for (const t of g.tris) {
      idx.push(map.get(prim.idx[t]), map.get(prim.idx[t + 1]), map.get(prim.idx[t + 2]));
    }
  }
  return {
    material: prim.material,
    pos: Float32Array.from(pos),
    nor: prim.nor ? Float32Array.from(nor) : null,
    uv: prim.uv ? Float32Array.from(uv) : null,
    col: null,
    idx: Uint32Array.from(idx)
  };
}

/* Thin a canopy down to roughly `frac` of its cards, keeping the
   biggest ones (a crown's read comes from its large masses; the little
   filler cards between them are exactly what stops mattering first as
   a tree recedes) and scaling each survivor by 1/sqrt(frac) so the
   total painted area stays about where it was. */
function thinCanopy(prim, frac) {
  const cs = components(prim);
  if (cs.length < 24) { return null; }
  cs.sort((a, b) => b.r - a.r);
  const keep = cs.slice(0, Math.max(12, Math.round(cs.length * frac)));
  const grow = Math.min(1.5, 1 / Math.sqrt(keep.length / cs.length));
  return rebuildFrom(prim, keep, grow);
}

/* ------------------------------------------------------- solid meshes
   Trunks are the opposite problem: one welded sculpt, and on the
   gnarled blossom trees they are TWICE the triangle count of the
   canopy hanging off them. Vertex clustering (Rossignac-Borrel) is the
   right simplifier for a mid LOD of something like that - snap every
   vertex to a coarse grid, average the ones that land in the same cell,
   drop the triangles that collapse. It ignores topology entirely, which
   is a liability for a hero asset and a virtue here: it cannot produce
   a hole, and a trunk seen from 130 metres only has to keep its
   thickness and its lean.

   The grid size is searched for rather than guessed, so every asset
   lands near the same triangle fraction whatever its scale. */
function clusterOnce(prim, cell) {
  const n = prim.pos.length / 3;
  let mnx = Infinity, mny = Infinity, mnz = Infinity;
  for (let k = 0; k < n; k++) {
    mnx = Math.min(mnx, prim.pos[k * 3]);
    mny = Math.min(mny, prim.pos[k * 3 + 1]);
    mnz = Math.min(mnz, prim.pos[k * 3 + 2]);
  }
  const key = new Map(), reps = [];
  const cellOf = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    const kx = Math.floor((prim.pos[k * 3] - mnx) / cell);
    const ky = Math.floor((prim.pos[k * 3 + 1] - mny) / cell);
    const kz = Math.floor((prim.pos[k * 3 + 2] - mnz) / cell);
    const s = kx + ',' + ky + ',' + kz;
    let r = key.get(s);
    if (r === undefined) {
      r = reps.length;
      key.set(s, r);
      reps.push({ p: [0, 0, 0], nr: [0, 0, 0], t: [0, 0], c: [0, 0, 0], n: 0 });
    }
    const rep = reps[r];
    for (let c = 0; c < 3; c++) {
      rep.p[c] += prim.pos[k * 3 + c];
      if (prim.nor) { rep.nr[c] += prim.nor[k * 3 + c]; }
      if (prim.col) { rep.c[c] += prim.col[k * 3 + c]; }
    }
    if (prim.uv) { rep.t[0] += prim.uv[k * 2]; rep.t[1] += prim.uv[k * 2 + 1]; }
    rep.n++;
    cellOf[k] = r;
  }
  const m = reps.length;
  const pos = new Float32Array(m * 3);
  const nor = prim.nor ? new Float32Array(m * 3) : null;
  const uv = prim.uv ? new Float32Array(m * 2) : null;
  const col = prim.col ? new Float32Array(m * 3) : null;
  for (let r = 0; r < m; r++) {
    const rep = reps[r];
    for (let c = 0; c < 3; c++) {
      pos[r * 3 + c] = rep.p[c] / rep.n;
      if (col) { col[r * 3 + c] = rep.c[c] / rep.n; }
    }
    if (nor) {
      const l = Math.hypot(rep.nr[0], rep.nr[1], rep.nr[2]) || 1;
      for (let c = 0; c < 3; c++) { nor[r * 3 + c] = rep.nr[c] / l; }
    }
    if (uv) { uv[r * 2] = rep.t[0] / rep.n; uv[r * 2 + 1] = rep.t[1] / rep.n; }
  }
  const idx = [];
  for (let i = 0; i + 3 <= prim.idx.length; i += 3) {
    const a = cellOf[prim.idx[i]], b = cellOf[prim.idx[i + 1]], c = cellOf[prim.idx[i + 2]];
    if (a !== b && b !== c && a !== c) { idx.push(a, b, c); }
  }
  return { material: prim.material, pos, nor, uv, col, idx: Uint32Array.from(idx) };
}

function clusterTo(prim, frac) {
  const n = prim.pos.length / 3;
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < n; k++) {
    for (let c = 0; c < 3; c++) {
      mn[c] = Math.min(mn[c], prim.pos[k * 3 + c]);
      mx[c] = Math.max(mx[c], prim.pos[k * 3 + c]);
    }
  }
  const diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
  const target = prim.idx.length / 3 * frac;
  let lo = diag / 400, hi = diag / 6, best = null;
  for (let it = 0; it < 9; it++) {
    const mid = Math.sqrt(lo * hi);
    const r = clusterOnce(prim, mid);
    const tris = r.idx.length / 3;
    if (!best || Math.abs(tris - target) < Math.abs(best.idx.length / 3 - target)) { best = r; }
    if (tris > target) { lo = mid; } else { hi = mid; }
  }
  return best;
}

/* ------------------------------------------------------------- normals
   Leaf cards come out of the pack with the quad's own flat normal, so
   under a hard 4-step toon ramp every card in the canopy lands on one
   rung or another at random and the crown reads as confetti. Bending
   each card's normal toward "outward from the middle of the canopy"
   is the standard fix (every stylized-foliage writeup does it): the
   crown then takes light as one round mass, which is exactly how the
   canopies in the reference paintings are lit. */
function spherifyLeafNormals(prim, blend) {
  if (!prim.nor) { return; }
  const n = prim.pos.length / 3;
  let cx = 0, cz = 0, lo = Infinity, hi = -Infinity;
  for (let k = 0; k < n; k++) {
    cx += prim.pos[k * 3]; cz += prim.pos[k * 3 + 2];
    lo = Math.min(lo, prim.pos[k * 3 + 1]); hi = Math.max(hi, prim.pos[k * 3 + 1]);
  }
  cx /= n; cz /= n;
  const cy = lo + (hi - lo) * 0.34;      /* a touch below centre: the top of
                                            the crown then faces the sky */
  for (let k = 0; k < n; k++) {
    let dx = prim.pos[k * 3] - cx, dy = prim.pos[k * 3 + 1] - cy, dz = prim.pos[k * 3 + 2] - cz;
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    let ox = prim.nor[k * 3] * (1 - blend) + dx * blend;
    let oy = prim.nor[k * 3 + 1] * (1 - blend) + dy * blend;
    let oz = prim.nor[k * 3 + 2] * (1 - blend) + dz * blend;
    const ol = Math.hypot(ox, oy, oz) || 1;
    prim.nor[k * 3] = ox / ol; prim.nor[k * 3 + 1] = oy / ol; prim.nor[k * 3 + 2] = oz / ol;
  }
}

function roleOf(material) { return (TEXTURES[material] || {}).role || 'bark'; }

/* ==================================================================== */

async function main() {
  fs.mkdirSync(path.join(OUT, 'models'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'textures'), { recursive: true });

  console.log('sources:');
  const files = [];
  for (const m of MODELS) { files.push({ m, file: await fetchModel(m) }); }

  /* ---- textures: pull each one out of whichever model has it, once -- */
  const wanted = new Map(Object.values(TEXTURES).map(t => [t.image, t]));
  const done = new Set();
  console.log('textures:');
  for (const { file } of files) {
    if (done.size === wanted.size) { break; }
    const imgs = extractImages(file);
    for (const name in imgs) {
      const t = wanted.get(name);
      if (!t || done.has(name)) { continue; }
      const src = decodePNG(imgs[name]);
      const img = downsample(src, src.width / t.size);
      /* bark and rock are opaque; only the cutouts need an alpha channel */
      const alpha = t.role !== 'bark' && t.role !== 'rock';
      const png = encodePNG(img, alpha);
      fs.writeFileSync(path.join(OUT, 'textures', t.file), png);
      console.log('  ' + t.file.padEnd(20) + src.width + 'px ' + Math.round(imgs[name].length / 1024) +
                  'KB  ->  ' + img.width + 'px ' + Math.round(png.length / 1024) + 'KB');
      done.add(name);
    }
  }
  for (const [name] of wanted) { if (!done.has(name)) { console.log('  MISSING ' + name); } }

  /* ---- models -------------------------------------------------------- */
  console.log('models:');
  const manifest = [];
  for (const { m, file } of files) {
    const { prims } = flatten(file);
    const lod0 = [];
    for (const p of prims) {
      if (TINT[p.material] && !p.col) {
        const t = TINT[p.material], n = p.pos.length / 3;
        p.col = new Float32Array(n * 3);
        for (let k = 0; k < n; k++) { p.col[k * 3] = t[0]; p.col[k * 3 + 1] = t[1]; p.col[k * 3 + 2] = t[2]; }
      }
      if (roleOf(p.material) === 'leaves') { spherifyLeafNormals(p, 0.80); p.col = null; }
      else if (p.col) {
        /* the bark's COLOR_0 is baked ambient occlusion, and at full
           strength (down to 0.41) it goes muddy under this game's already
           dark shadow rung. Half strength keeps the crevices readable. */
        for (let k = 0; k < p.col.length; k++) { p.col[k] = 0.55 + 0.45 * p.col[k]; }
      }
      lod0.push(p);
    }

    /* LOD1 - the mid level, for everything from roughly 120 metres out
       to where the impostor takes over. Canopies lose half their cards;
       trunks get vertex-clustered to a bit under half. Anything small
       enough that a mid level would not pay for itself (rocks, the
       flowers, the bush) just reuses LOD0 - see the `useful` test. */
    const lod1 = [];
    let cut = 0, full = 0;
    for (const p of lod0) {
      full += p.idx.length / 3;
      const red = roleOf(p.material) === 'leaves' ? thinCanopy(p, 0.45)
        : (p.idx.length / 3 > 700 ? clusterTo(p, 0.42) : null);
      const use = red || p;
      lod1.push(use);
      cut += use.idx.length / 3;
    }

    /* A second copy of the same geometry under a different node is pure
       download for nothing, so only ship LOD1 when it actually saved
       something worth a swap. */
    const useful = cut < full * 0.8;
    const bytes = writeGLB(path.join(OUT, 'models', m.out + '.glb'),
      useful ? [{ name: 'LOD0', prims: lod0 }, { name: 'LOD1', prims: lod1 }]
             : [{ name: 'LOD0', prims: lod0 }]);
    if (!useful) { cut = full; }

    /* height, so the game can scale the model into world units without
       hardcoding a magic number per asset */
    let lo = Infinity, hi = -Infinity, rad = 0;
    for (const p of lod0) {
      for (let k = 0; k < p.pos.length / 3; k++) {
        lo = Math.min(lo, p.pos[k * 3 + 1]); hi = Math.max(hi, p.pos[k * 3 + 1]);
        rad = Math.max(rad, Math.hypot(p.pos[k * 3], p.pos[k * 3 + 2]));
      }
    }
    manifest.push({ name: m.out, height: +(hi - lo).toFixed(3), base: +lo.toFixed(3), radius: +rad.toFixed(3) });
    console.log('  ' + m.out.padEnd(11) + 'h=' + (hi - lo).toFixed(1).padStart(5) +
                '  tris ' + String(full).padStart(6) + ' -> ' + String(cut).padStart(6) +
                '  ' + Math.round(bytes / 1024) + 'KB');
  }
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
  console.log('wrote ' + path.join(OUT, 'manifest.json'));
}

main().catch(err => { console.error(err); process.exit(1); });
