/* Whispering Meadow - props.js
   Extracted from the original single file. Logic unchanged. */

import { withRim, toonRamp, BEACHPATH, BROOK, HALF, PI, RIVER, SUN, TAU, WALKPATH, WORLD, WSEG, clamp, fbm, lerp, mulberry32, pathInfo, scene, smoothstep, terrainHeight, timeU, vnoise, volcanoBare } from './core.js';
import { GB, M4, siteInfo } from './geom.js';
import { addOutline } from './outline.js';
import { NATURE_BANDS, LOD_BANDS, LOD_K, propExtent, rungFor, rungForProp, rungForGeometry, setNatureLODScale, bakeGeoImpostors, buildNatureImpostors, impostorGeometry, natureImpostorMaterial, natureMaterial, natureSwapImpostors, patchNatureShader, preloadNature } from './models.js';
import { terrainHeights } from './terrain.js';
import { P } from './player.js';
import { barkColorAt, leafClusterTexture } from './textures.js';

/* barkBlend() - samples the painted bark canvas (textures.js) at a world
   position and blends it into a base trunk colour. This is how
   barkTexture() gets "used" on trunks: as a CPU-side vertex-colour source
   at world-build time, not a live GPU texture map for the pine/bush trunks
   (which stay flat-shaded, vertex-colour-only geometry, see bushGeo /
   pineGeo). Broadleaf and sakura trunks go through the SAME atlas as their
   leaf cards instead - see TB below. */
function barkBlend(base, wx, wy) {
  var s = barkColorAt(wx * 0.045 + 11.3, wy * 0.09 - 4.7);
  return base.clone().lerp(new THREE.Color(s[0], s[1], s[2]), 0.5);
}

/* ------------------------------------------------------------ leaf cards
   TB ("textured builder") is GB (geom.js) plus a uv attribute. It is a
   separate small class, not a change to geom.js, because only trees need
   UVs - everything else in this file (flowers, reeds, rocks, the bridge)
   stays on plain GB. TB.add() has the exact same signature as GB.add(), so
   limbs() (below) works unmodified whether it's handed a GB or a TB.

   Every non-card shape added via .add() (trunk cylinders) gets a constant
   UV pointing at the small opaque white swatch baked into the corner of
   leafClusterTexture() - so trunk and leaf cards can share one merged
   geometry, one material and one instanced draw call per tree. */
var SWATCH_UV = [0.06, 0.06];
/* the rect of leafClusterTexture() actually painted with the leaf
   cluster, kept clear of the swatch corner - see that function for the
   layout this must match */
var LEAF_UV = [0.20, 0.20, 0.99, 0.99];

function TB() { this.p = []; this.n = []; this.c = []; this.uv = []; this.i = []; }
TB.prototype.add = function (geo, mtx, col, jitter, rng) {
  var pos = geo.attributes.position, nor = geo.attributes.normal;
  var base = this.p.length / 3;
  var nm = new THREE.Matrix3().getNormalMatrix(mtx);
  var v = new THREE.Vector3();
  for (var k = 0; k < pos.count; k++) {
    v.fromBufferAttribute(pos, k).applyMatrix4(mtx);
    this.p.push(v.x, v.y, v.z);
    if (nor) { v.fromBufferAttribute(nor, k).applyMatrix3(nm).normalize(); this.n.push(v.x, v.y, v.z); }
    else { this.n.push(0, 1, 0); }
    var j = jitter ? (rng() - 0.5) * jitter : 0;
    this.c.push(clamp(col.r + j, 0, 1), clamp(col.g + j, 0, 1), clamp(col.b + j, 0, 1));
    this.uv.push(SWATCH_UV[0], SWATCH_UV[1]);
  }
  var id = geo.index;
  if (id) { for (k = 0; k < id.count; k++) { this.i.push(base + id.getX(k)); } }
  else { for (k = 0; k < pos.count; k++) { this.i.push(base + k); } }
  return this;
};
/* one quad, corners already positioned relative to `center` (see
   addLeafCluster) so callers don't need to build a Matrix4 for something
   this simple. uvRect is [u0, v0, u1, v1] into the shared atlas. */
TB.prototype.addCard = function (center, corners, normal, col, uvRect) {
  var base = this.p.length / 3;
  var uvs = [[uvRect[0], uvRect[1]], [uvRect[2], uvRect[1]], [uvRect[2], uvRect[3]], [uvRect[0], uvRect[3]]];
  for (var k = 0; k < 4; k++) {
    this.p.push(center.x + corners[k].x, center.y + corners[k].y, center.z + corners[k].z);
    this.n.push(normal.x, normal.y, normal.z);
    this.c.push(col.r, col.g, col.b);
    this.uv.push(uvs[k][0], uvs[k][1]);
  }
  this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  return this;
};
TB.prototype.build = function () {
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
  g.setIndex(this.i);
  g.computeBoundingSphere();
  return g;
};

/* A billboard CROSS: two quads sharing a centre, 90 degrees apart, each
   with its own outward-facing normal (not billboarded toward the camera -
   everything here is a static merged buffer baked once at world-build
   time, so true per-frame billboarding would need a vertex-shader
   rewrite; a cross is the standard cheap substitute, since from ANY
   horizontal viewing angle at least one of the two planes is within 45
   degrees of facing the camera). `ry` gives the whole cross a random yaw
   so identical clusters across a tree, or across trees, don't all line up
   on the same two axes. */
function addLeafCluster(tb, cx, cy, cz, ry, w, h, col) {
  var center = new THREE.Vector3(cx, cy, cz);
  var halfW = w * 0.5, halfH = h * 0.5;
  for (var p = 0; p < 2; p++) {
    var ang = ry + p * (PI / 2);
    var rx = Math.cos(ang) * halfW, rz = Math.sin(ang) * halfW;
    var nx = Math.sin(ang), nz = -Math.cos(ang);
    var corners = [
      new THREE.Vector3(-rx, -halfH, -rz),
      new THREE.Vector3(rx, -halfH, rz),
      new THREE.Vector3(rx, halfH, rz),
      new THREE.Vector3(-rx, halfH, -rz)
    ];
    tb.addCard(center, corners, new THREE.Vector3(nx, 0, nz), col, LEAF_UV);
  }
}
function sunflowerGeometry() {
  var rng = mulberry32(4242);
  var gb = new GB();
  var stemC = new THREE.Color(0x4c7a2c), leafC = new THREE.Color(0x568a30);
  var petalC = new THREE.Color(0xf5c033), petalC2 = new THREE.Color(0xe8971f);
  var faceC = new THREE.Color(0x5b3a1e), faceC2 = new THREE.Color(0x8a5a2b);

  var stem = new THREE.CylinderGeometry(0.035, 0.062, 2.05, 5, 1, true);
  gb.add(stem, M4(0, 1.02, 0, 0, 0, 0.02), stemC, 0.05, rng);
  var leaf = new THREE.CircleGeometry(0.30, 5);
  for (var l = 0; l < 3; l++) {
    var ang = l * 2.1 + 0.4, hgt = 0.55 + l * 0.42;
    var m = new THREE.Matrix4();
    m.compose(new THREE.Vector3(Math.cos(ang) * 0.25, hgt, Math.sin(ang) * 0.25),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(-1.15, ang, 0, 'YXZ')),
      new THREE.Vector3(1, 1.7, 1));
    gb.add(leaf, m, leafC, 0.07, rng);
  }
  /* the head, tipped to look out at the world */
  var head = new GB();
  var disc = new THREE.CircleGeometry(0.30, 12);
  head.add(disc, M4(0, 0, 0.03), faceC, 0.06, rng);
  head.add(disc, M4(0, 0, -0.02, 0, PI, 0, 1.08), new THREE.Color(0x4e7a2e), 0.05, rng);
  head.add(new THREE.CircleGeometry(0.21, 10), M4(0, 0, 0.045), faceC2, 0.07, rng);
  var petal = new THREE.CircleGeometry(0.5, 5);
  for (var i = 0; i < 13; i++) {
    var a = i / 13 * TAU + rng() * 0.06;
    var rr = 0.44 + rng() * 0.07;
    var mm = new THREE.Matrix4();
    mm.compose(new THREE.Vector3(Math.cos(a) * rr, Math.sin(a) * rr, 0.012 + (i % 2) * 0.012),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, a - PI / 2, 'XYZ')),
      new THREE.Vector3(0.30, 0.62, 0.3));
    head.add(petal, mm, (i % 3 === 0) ? petalC2 : petalC, 0.08, rng);
  }
  var hg = head.build();
  hg.rotateX(-0.62);
  hg.translate(0, 2.06, 0.16);
  gb.add(hg, new THREE.Matrix4(), new THREE.Color(1, 1, 1), 0, rng);
  /* keep the colours the head already has */
  var built = gb.build();
  var hc = hg.attributes.color, bc = built.attributes.color;
  var base = bc.count - hc.count;
  for (var k = 0; k < hc.count; k++) {
    bc.setXYZ(base + k, hc.getX(k), hc.getY(k), hc.getZ(k));
  }
  bc.needsUpdate = true;
  return built;
}

function swayMaterial(strength, band) {
  var m = new THREE.MeshToonMaterial({ vertexColors: true, side: THREE.DoubleSide, gradientMap: toonRamp() });
  m.onBeforeCompile = function (sh) {
    if (band) { patchNatureShader(sh, band, 1, 0); }
    sh.uniforms.uTime = timeU;
    sh.uniforms.uSway = { value: strength };
    sh.vertexShader = 'uniform float uTime; uniform float uSway;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n' +
      '#ifdef USE_INSTANCING\n' +
      ' vec3 iw = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);\n' +
      '#else\n vec3 iw = vec3(0.0);\n#endif\n' +
      ' float sw = sin(uTime*1.30 + iw.x*0.19 + iw.z*0.163)*0.5 + 0.5;\n' +
      ' float gu = sin(uTime*0.41 + iw.x*0.0115 + iw.z*0.0093)*0.5 + 0.5;\n' +
      ' float amt = uSway * (0.30 + 0.70*gu) * (0.35 + 0.65*sw) * max(transformed.y,0.0)*max(transformed.y,0.0);\n' +
      ' transformed.x += amt*1.55; transformed.z += amt*0.62;\n'
    );
  };
  return m;
}

/* The sunflower field: a named landmark, so it keeps its own placement -
   an ellipse east of spawn, thinned by fbm so it has edges a painter would
   draw, and every head turned roughly toward the sun. What changed is what
   grows there: flower_a / flower_b out of the nature set, which are the
   tall single flowers that pack was built around, instead of the
   hand-written sunflowerGeometry() (still here, still the fallback). */
function buildSunflowers() {
  var rng = mulberry32(777);
  var mats = [], cols = [], picks = [];
  var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  var pos = new THREE.Vector3(), scl = new THREE.Vector3();
  var sunYaw = Math.atan2(SUN.x, SUN.z);
  var TRY = 16000;
  /* 700 across the whole field, down from 3400 - see the note in the
     hand-off: this is the landmark the loading screen names, and at a
     fifth of the count it reads as a scattering rather than a field. */
  for (var k = 0; k < TRY && mats.length < 700; k++) {
    var ux = rng() * 2 - 1, uz = rng() * 2 - 1;
    var x = 200 + ux * 250, z = 40 + uz * 178;
    var d = Math.sqrt(ux * ux + uz * uz);
    if (d > 1) continue;
    var mask = smoothstep(1.02, 0.30, d) * (0.35 + 0.9 * fbm(x * 0.011 + 3.3, z * 0.011 - 1.1, 3));
    if (rng() > mask) continue;
    var si = siteInfo(x, z);
    if (si.water || si.h < 2.2 || si.slope > 0.42 || si.riverD < 34) continue;
    var s = 0.82 + rng() * 0.55;
    pos.set(x, groundY(x, z) - 0.06, z);
    e.set((rng() - 0.5) * 0.14, sunYaw + (rng() - 0.5) * 1.05, (rng() - 0.5) * 0.14, 'YXZ');
    q.setFromEuler(e);
    scl.set(s, s * (0.9 + rng() * 0.3), s);
    m4.compose(pos, q, scl);
    mats.push(m4.clone());
    var t = rng();
    cols.push(new THREE.Color(lerp(0.94, 1.06, t), lerp(0.93, 1.03, t), lerp(0.88, 1.0, rng())));
    picks.push(rng());
  }
  if (!mats.length) { return; }

  /* Both kinds grow here. Swapping the whole field over to the kit's
     generic single flower took the sunflowers - the landmark the loading
     screen names - out of the game entirely, which is not a trade anyone
     asked for. The split is driven by picks[], a draw that already came off
     this seed's stream, so which flower stands where stays identical in
     every player's browser. */
  var sunM = [], sunC = [], natM = [], natC = [], natP = [];
  for (var i = 0; i < mats.length; i++) {
    if (picks[i] < 0.62) { sunM.push(mats[i]); sunC.push(cols[i]); }
    else { natM.push(mats[i]); natC.push(cols[i]); natP.push(picks[i]); }
  }

  /* The sunflowers are procedural, so they need no network and appear with
     the terrain rather than a beat later. */
  SCATTERED[777] = { mats: sunM, meshes: [] };
  if (sunM.length) {
    SCATTERED[777].meshes =
      cullBand(emitInstances(sunflowerGeometry(), swayMaterial(0.030, SMALL_SCATTER.sunflower),
        sunM, sunC, 150, false), SMALL_SCATTER.sunflower);
  }

  if (!natM.length) { return; }
  SCATTERED[778] = { mats: natM, meshes: [] };
  natureReady.then(function (lib) {
    if (lib && emitNature(lib, {
      seed: 778, props: ['flower_a', 'flower_b'],
      sway: 0.09, bury: 0.02, shadow: false
    }, { mats: natM, cols: natC, picks: natP })) { return; }
    SCATTERED[778].meshes =
      cullBand(emitInstances(flowerGeo(321), swayMaterial(0.030, SMALL_SCATTER.sunflower),
        natM, natC, 150, false), SMALL_SCATTER.sunflower);
  });
}

function blobGeo(r, seed, detail) {
  var g = new THREE.IcosahedronGeometry(r, detail === undefined ? 0 : detail);
  var p = g.attributes.position;
  var v = new THREE.Vector3();
  for (var i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    var d = v.clone().normalize();
    /* two noise frequencies instead of one - the coarse term makes the
       overall lobed shape, the fine term shifts each vertex a bit
       independently so the same 12 verts (detail 0) don't all bulge
       together in one direction, which is what read as a faceted gem
       instead of a leaf cluster. Vertex count is still the hard ceiling
       here (that's the actual triangle budget), but this gets more
       silhouette variety out of it for free. */
    var f = 0.62 + 0.46 * vnoise(d.x * 2.6 + seed, d.z * 2.6 + d.y * 2.1 + seed * 0.7)
                 + 0.20 * vnoise(d.x * 6.3 + seed * 1.7, d.y * 6.3 - d.z * 5.4 + seed * 2.3);
    p.setXYZ(i, v.x * f, v.y * f * 0.86, v.z * f);
  }
  g.computeVertexNormals();
  return g;
}

/* ---------------------------------------------------------------- branches
   A tree reads as a tree because of its skeleton. The old version was a
   cylinder with five spheres stuck on it, which is why it looked like
   broccoli. This grows a real branching structure and reports where the
   branch tips ended up, so the canopy can be hung on them.

   Cheaper than before, too: the silhouette now comes from MANY SMALL
   clusters (20 triangles each) instead of a few big ones (80 each). */
function limbs(gb, rng, tips, px, py, pz, dx, dy, dz, len, rad, depth, bark) {
  var UP = new THREE.Vector3(0, 1, 0);
  var dir = new THREE.Vector3(dx, dy, dz).normalize();
  var ex = px + dir.x * len, ey = py + dir.y * len, ez = pz + dir.z * len;

  var m = new THREE.Matrix4();
  m.compose(new THREE.Vector3(px + dir.x * len * 0.5, py + dir.y * len * 0.5, pz + dir.z * len * 0.5),
    new THREE.Quaternion().setFromUnitVectors(UP, dir),
    new THREE.Vector3(1, 1, 1));
  var segCol = barkBlend(bark, ex, ey);
  gb.add(new THREE.CylinderGeometry(rad * 0.62, rad, len, depth > 2 ? 6 : 4, 1, true), m, segCol, 0.09, rng);

  if (depth <= 1) {
    tips.push([ex, ey, ez]);
    return;
  }

  var n = depth >= 3 ? 3 : 2;
  for (var i = 0; i < n; i++) {
    var a = (i / n) * TAU + rng() * 1.1;
    var spread = 0.55 + rng() * 0.42;           // how wide it forks
    var nx = dir.x + Math.cos(a) * spread;
    var nz = dir.z + Math.sin(a) * spread;
    var ny = dir.y + 0.32 + rng() * 0.22;       // always reaching upward
    limbs(gb, rng, tips, ex, ey, ez, nx, ny, nz,
          len * (0.62 + rng() * 0.14), rad * 0.58, depth - 1, bark);
  }
}

/* Hang the canopy on the branch tips as painted leaf-cluster cards
   (billboard crosses, see addLeafCluster above) rather than geometry
   blobs. The vertical gradient is still the whole trick: sunlit crown at
   the top, deep shade underneath - it's applied twice now, once baked
   into leafClusterTexture() itself (each card has its own light-to-dark
   falloff) and once per-instance here via vertex colour (the tree-wide
   gradient), which is what makes the whole crown read as one lit mass
   instead of a pile of identically-lit cards. */
function canopy(gb, rng, tips, seed, palette, size, y0, y1) {
  var i, k;
  /* sorted low-to-high luminance once, so the crown can be biased toward
     the brighter/warmer members and the underside toward the darker/
     cooler ones - the split tone every reference painting has, instead of
     one palette pool sampled uniformly at every height */
  var sorted = palette.slice().sort(function (a, b) {
    var ca = new THREE.Color(a), cb = new THREE.Color(b);
    return (ca.r + ca.g + ca.b) - (cb.r + cb.g + cb.b);
  });
  for (i = 0; i < tips.length; i++) {
    var t = tips[i];
    var tipLift = clamp((t[1] - y0) / Math.max(0.001, y1 - y0), 0, 1);
    /* the first version under-shot this badly: fewer, smaller crosses
       than the geometry blobs they replaced, so the canopy read as thin
       sticks with small dusty puffs instead of a full mass. A cross
       covers more viewing angles per instance than a solid blob did, but
       it does NOT cover more silhouette AREA - it still needs count and
       size at least matching the blobs it replaced, so this errs dense. */
    var clumps = 4 + Math.floor(rng() * 3);
    for (k = 0; k < clumps; k++) {
      var jx = (rng() - 0.5) * size * 2.1;
      var jy = (rng() - 0.5) * size * 1.05;
      var jz = (rng() - 0.5) * size * 2.1;
      var yy = t[1] + jy;
      var lift = clamp((yy - y0) / Math.max(0.001, y1 - y0), 0, 1);
      var bias = Math.pow(rng(), lift > 0.5 ? 0.5 : 1.9);
      var pi = clamp(Math.floor(bias * sorted.length), 0, sorted.length - 1);
      var c = new THREE.Color(sorted[pi]);
      /* deep shade below, bright crown above. Widened by darkening the
         floor rather than raising the ceiling further, so the brightest
         crown cards stay clear of the white-glare limit. */
      /* The leaf-card texture MULTIPLIES into this colour, so the vertex
         colour has to be pre-brightened or the canopy goes near-black.
         Values above 1.0 are fine here - the buffer is float and the
         shader treats them as extra headroom. */
      c.multiplyScalar(0.60 + 0.66 * lift * lift);
      /* Back to geometry blobs. The card version rendered as flat opaque
         quads once the alpha texture was dropped, and read worse than this
         even with the texture on. addLeafCluster() is still below if
         someone wants to revisit it. */
      var rr = size * (0.62 + rng() * 0.55);
      gb.add(blobGeo(rr, seed * 3.7 + i * 11.3 + k * 5.1),
             M4(t[0] + jx, yy, t[2] + jz, 0, rng() * TAU, 0), c, 0.05, rng);
    }
  }
}

function broadleafGeo(seed, big) {
  var rng = mulberry32(seed);
  var gb = new TB();
  var bark = new THREE.Color(0x6b4a30);
  var S = big ? 1.0 : 0.74;
  var trunk = (5.4 + rng() * 1.6) * S;

  var tips = [];
  limbs(gb, rng, tips, 0, 0, 0, 0, 1, 0, trunk, 0.55 * S, 4, bark);

  var lo = 1e9, hi = -1e9;
  for (var i = 0; i < tips.length; i++) { lo = Math.min(lo, tips[i][1]); hi = Math.max(hi, tips[i][1]); }
  canopy(gb, rng, tips, seed,
         [0x3f9c2c, 0x55b636, 0x6ecb3e, 0x2f8322, 0x86d94b], 1.62 * S, lo, hi);
  return gb.build();
}

function sakuraGeo(seed) {
  var rng = mulberry32(seed);
  var gb = new TB();
  var bark = new THREE.Color(0x5a4134);
  var trunk = 5.2 + rng() * 1.6;

  var tips = [];
  limbs(gb, rng, tips, 0, 0, 0, 0, 1, 0, trunk, 0.46, 4, bark);

  var lo = 1e9, hi = -1e9;
  for (var i = 0; i < tips.length; i++) { lo = Math.min(lo, tips[i][1]); hi = Math.max(hi, tips[i][1]); }
  /* blossom reads best when the crown is near-white and the underside
     stays a saturated rose - that contrast is the whole effect */
  canopy(gb, rng, tips, seed,
         [0xff9cba, 0xffb3cc, 0xffc9dd, 0xff8fb0, 0xffe0ec], 1.58, lo, hi);
  return gb.build();
}

function pineGeo(seed) {
  var rng = mulberry32(seed);
  var gb = new GB();
  var th = 11 + rng() * 4.0;
  gb.add(new THREE.CylinderGeometry(0.17, 0.44, th, 5, 1, true),
         M4(0, th / 2, 0), barkBlend(new THREE.Color(0x513a26), 0, th / 2), 0.10, rng);

  /* Conifers in the reference are ragged, not smooth cones: many thin
     tiers, each slightly offset and rotated, dark below and bright on top. */
  var n = 11;
  for (var i = 0; i < n; i++) {
    var f = i / (n - 1);
    var y = 1.8 + f * (th - 1.2);
    var r = (3.8 - f * 3.1) * (0.86 + rng() * 0.34);
    var hh = 2.2 - f * 0.9;
    var c = new THREE.Color().setHSL(0.325 - f * 0.028, 0.50 + f * 0.14, 0.15 + f * 0.19);
    var ox = (rng() - 0.5) * 0.42, oz = (rng() - 0.5) * 0.42;
    gb.add(new THREE.ConeGeometry(r, hh, 6, 1, true),
           M4(ox, y + hh * 0.35, oz, (rng() - 0.5) * 0.07, rng() * TAU, (rng() - 0.5) * 0.07),
           c, 0.05, rng);
  }
  return gb.build();
}

function bushGeo(seed) {
  var rng = mulberry32(seed);
  var gb = new GB();
  gb.add(new THREE.CylinderGeometry(0.14, 0.24, 1.5, 4, 1, true), M4(0, 0.75, 0),
         barkBlend(new THREE.Color(0x6b4a30), 0, 0.75), 0.08, rng);
  for (var i = 0; i < 5; i++) {
    var a = i / 5 * TAU + rng();
    var r = 0.45 + rng() * 0.85;
    var yy = 1.4 + rng() * 0.95;
    var lift = clamp((yy - 1.3) / 1.35, 0, 1);
    var c = new THREE.Color().setHSL(0.28 + rng() * 0.06, 0.52, 0.22 + rng() * 0.12);
    /* same crown/shade split as the trees, much milder - bushes are small
       enough that a strong version would just look dark, not shaded */
    c.multiplyScalar(0.74 + 0.36 * lift);
    var rad = 0.75 + rng() * 0.5;
    gb.add(blobGeo(1, seed + i * 7.1, 0),
      M4(Math.cos(a) * r, yy, Math.sin(a) * r,
         (rng() - 0.5) * 0.4, rng() * TAU, (rng() - 0.5) * 0.4,
         rad * (0.75 + rng() * 0.5), rad * (0.62 + rng() * 0.3), rad * (0.75 + rng() * 0.5)),
      c, 0.06, rng);
  }
  return gb.build();
}

var FORESTS = [
  { x: -560, z: -120, r: 210, d: 1.0 }, { x: -660, z: 150, r: 190, d: 0.9 },
  { x: -420, z: 250, r: 160, d: 0.8 }, { x: 560, z: -260, r: 200, d: 0.95 },
  { x: 690, z: 60, r: 190, d: 0.85 }, { x: -330, z: -270, r: 130, d: 0.7 },
  { x: 430, z: 330, r: 120, d: 0.6 }, { x: -140, z: -300, r: 120, d: 0.55 },
  { x: -700, z: -320, r: 200, d: 0.9 }, { x: 300, z: -420, r: 190, d: 0.8 }
];

function forestDensity(x, z) {
  var d = 0;
  for (var i = 0; i < FORESTS.length; i++) {
    var F = FORESTS[i];
    var dx = x - F.x, dz = z - F.z;
    var t = Math.sqrt(dx * dx + dz * dz) / F.r;
    d = Math.max(d, smoothstep(1.0, 0.15, t) * F.d);
  }
  d = Math.max(d, 0.045 * smoothstep(0.3, 0.75, fbm(x * 0.004 + 7.7, z * 0.004 - 3.3, 3)));
  return d;
}

/* ------------------------------------------------------------ bucket size
   Splitting a scatter into spatial cells is a trade. Small cells cull
   tightly, but every cell is its own InstancedMesh and therefore its own
   draw call; large cells batch well, but drag instances the camera cannot
   see into the frustum with them.

   The shipped cell of 150 was chosen without counting what came out of it,
   and what came out was lopsided: the 620 boulders landed in 226 cells -
   one draw call per 2.7 stones, roughly 900 triangles of work behind each
   piece of driver overhead - while a cell of oak trees at the same size
   held 40,000. A rock and an oak are not the same unit of cost, so sizing
   by instance count cannot be right for both.

   fitCell() sizes by TRIANGLES instead. It grows the cell until a bucket
   is carrying a draw call's worth of geometry, which leaves the heavy
   props bucketed exactly as finely as before (a bucket of five oaks is
   already past the target) and stops the cheap ones from being shattered
   into hundreds of near-empty draw calls. Placement is untouched: this
   only decides which instances share a mesh. */
function bucketsOf(mats, cell) {
  var b = {};
  for (var i = 0; i < mats.length; i++) {
    var e = mats[i].elements;
    var key = Math.floor(e[12] / cell) + ':' + Math.floor(e[14] / cell);
    if (!b[key]) { b[key] = []; }
    b[key].push(i);
  }
  return b;
}

function geoTris(geo) {
  if (!geo) { return 600; }
  var n = geo.index ? geo.index.count : (geo.attributes.position ? geo.attributes.position.count : 0);
  return Math.max(1, n / 3);
}

/* Measured, not guessed. At 26,000 the cells grew so far that the extra
   off-band instances they dragged into the frustum cost more triangles than
   the saved draw calls were worth - a forest view went from 4.2 to 5.8
   million triangles. 3,000 is where the two curves cross on the views this
   world actually offers: it leaves the heavy props (a bucket of five oaks
   is already past it) bucketed exactly as before and only collapses the
   scatters that were being shattered into near-empty draw calls. */
var BUCKET_TRIS = 3000;

function fitCell(mats, cell, tris, target) {
  target = (target || BUCKET_TRIS) / Math.max(1, tris);   /* -> instances per bucket */
  for (var i = 0; i < 5; i++) {
    var b = bucketsOf(mats, cell), n = 0;
    for (var k in b) { n++; }
    if (n <= 1 || mats.length / n >= target) { break; }
    cell *= 1.6;
  }
  return cell;
}

function emitInstances(geo, mat, mats, cols, cell, shadow, outline) {
  var out = [];
  cell = fitCell(mats, cell, geoTris(geo));
  var buckets = bucketsOf(mats, cell);
  for (var k in buckets) {
    var list = buckets[k];
    var mesh = new THREE.InstancedMesh(geo, mat, list.length);
    for (var j = 0; j < list.length; j++) {
      mesh.setMatrixAt(j, mats[list[j]]);
      if (cols) { mesh.setColorAt(j, cols[list[j]]); }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) { mesh.instanceColor.needsUpdate = true; }
    mesh.castShadow = !!shadow;
    mesh.receiveShadow = !!shadow;
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = true;
    if (mesh.computeBoundingSphere) { mesh.computeBoundingSphere(); }
    scene.add(mesh);
    /* A dark line around big objects is what makes cel shading read as
       DRAWN rather than modelled. Worth it on trees and rocks; on 13,000
       flowers it would double the draw calls for no visible gain. */
    if (outline) { addOutline(mesh, typeof outline === 'object' ? outline : undefined); }
    out.push(mesh);
  }
  return out;
}

/* ======================================================================== *
 *  SEATING A PROP ON THE GROUND
 *
 *  The visible ground is NOT terrainHeight(). It is a finite mesh: WSEG
 *  quads across WORLD units - about 6.25 units per quad - and each quad is
 *  two flat triangles. Between the grid points the surface the player sees
 *  is that triangle, and on a convex slope a flat triangle sits BELOW the
 *  analytic curve its corners were sampled from. Seat a tree with
 *  terrainHeight() and on those slopes it hovers. That is the flying-tree
 *  bug, and it is worst exactly where it is most visible: the mid-distance
 *  hillsides, which are all convex brow.
 *
 *  So sample the same array the mesh vertices were built from -
 *  terrainHeights, exported by terrain.js - and interpolate across the
 *  SAME triangle the renderer draws. genTerrain() emits, for each quad
 *  A=(i,j) B=(i+1,j) C=(i,j+1) D=(i+1,j+1), the triangles (A,C,B) and
 *  (B,C,D): the split runs along B..C, so the near triangle is the one
 *  with tx + tz <= 1. Getting that diagonal right is the difference
 *  between "close" and "exact" - bilinear would still leave up to a
 *  quarter of the quad's curvature under the trunk.
 * ======================================================================== */
function groundY(x, z) {
  var H = terrainHeights;
  if (!H) { return terrainHeight(x, z); }    /* before genTerrain(): analytic */
  var N = WSEG + 1, step = WORLD / WSEG;
  var fx = (x + HALF) / step, fz = (z + HALF) / step;
  var ix = Math.floor(fx), iz = Math.floor(fz);
  if (ix < 0) { ix = 0; } else if (ix > N - 2) { ix = N - 2; }
  if (iz < 0) { iz = 0; } else if (iz > N - 2) { iz = N - 2; }
  var tx = clamp(fx - ix, 0, 1), tz = clamp(fz - iz, 0, 1);
  var k = iz * N + ix;
  var h00 = H[k], h10 = H[k + 1], h01 = H[k + N], h11 = H[k + N + 1];
  if (tx + tz <= 1) { return h00 + tx * (h10 - h00) + tz * (h01 - h00); }
  return h11 + (1 - tx) * (h01 - h11) + (1 - tz) * (h10 - h11);
}

/* every scatter() records its placements here, keyed by seed, so we can
   later swap the procedural mesh for a downloaded model at the exact same
   spots without re-running the placement logic */
var SCATTERED = {};

/* ---------------------------------------------------------------- placing
   The placement half of scatter(), split out so the model path and the
   procedural path put things in exactly the same spots. Every number comes
   out of the seeded mulberry32 stream and nothing here touches
   Math.random(), because two browsers that disagree about where a tree is
   are two browsers that cannot share a world. */
function placeProps(opts) {
  var rng = mulberry32(opts.seed);
  var mats = [], cols = [], picks = [];
  var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  var pos = new THREE.Vector3(), scl = new THREE.Vector3();
  for (var k = 0; k < opts.tries && mats.length < opts.max; k++) {
    var x = (rng() * 2 - 1) * opts.range + (opts.cx || 0);
    var z = (rng() * 2 - 1) * (opts.rangeZ || opts.range) + (opts.cz || 0);
    var p = opts.prob(x, z, rng);
    if (p <= 0 || rng() > p) continue;
    var si = siteInfo(x, z);
    if (!opts.accept(x, z, si, rng)) continue;
    var s = opts.scale(rng, si);
    pos.set(x, groundY(x, z) + (opts.sink || 0), z);
    e.set((rng() - 0.5) * (opts.tilt || 0), rng() * TAU, (rng() - 0.5) * (opts.tilt || 0), 'YXZ');
    q.setFromEuler(e);
    scl.set(s * (0.94 + rng() * 0.12), s * (0.92 + rng() * 0.20), s * (0.94 + rng() * 0.12));
    m4.compose(pos, q, scl);
    mats.push(m4.clone());
    var t = 0.86 + rng() * 0.28;
    cols.push(new THREE.Color(t, t * (0.96 + rng() * 0.09), t * (0.92 + rng() * 0.12)));
    /* which model variant this one is, drawn from the same stream so the
       choice is as deterministic as the position */
    picks.push(rng());
    /* Nothing takes root on the cinder cone. This is done HERE, after every
       draw has been made, and not in accept() where it belongs on the face
       of it - because accept() returning false skips the eight rng() calls
       below it, and one extra rejection anywhere shifts the shared stream
       for every candidate after it. Gating in accept() moved trees on the
       far side of the world. Drawing the placement and then discarding it
       costs a few wasted draws and leaves the other four thousand props
       exactly where they were. Rocks opt out: boulders on a volcano are
       right where they should be. */
    if (opts.onBare !== 'allow' && volcanoBare(x, z) > 0.35) {
      mats.pop(); cols.pop(); picks.pop();
    }
  }
  if (!mats.length) { return null; }
  return { mats: mats, cols: cols, picks: picks };
}

/* The far band for a hand-written prop: two triangles per instance, one
   draw call for every instance of that geometry in the world, no bucketing
   and no frustum test. Culling a quad costs more than drawing it. */
function emitGeoImpostor(out, rec, mats) {
  if (!rec || !rec.tex || !rec.imp) { return; }
  emitImpostorBuckets(out, rec.tex, rec.imp, PROC_FAR, mats, 620);
}

function scatter(opts) {
  var placed = placeProps(opts);
  if (!placed) { return null; }
  var meshes = emitInstances(opts.geo, opts.mat, placed.mats, placed.cols,
    opts.cell || 300, opts.shadow, opts.outline);
  /* opts.impostor is a { tex, imp } record from bakeGeoImpostors(). With
     one, the real geometry stops at 330m and a photograph of it carries on
     from there; without one the mesh is simply drawn at every distance, as
     it always was. */
  if (opts.impostor) {
    cullBand(meshes, PROC_NEAR);
    emitGeoImpostor(meshes, opts.impostor, placed.mats);
  } else if (opts.band) {
    /* no billboard to hand over to, so this band simply ends the prop */
    cullBand(meshes, opts.band);
  }
  SCATTERED[opts.seed] = { mats: placed.mats, meshes: meshes };
  return meshes;
}

/* ======================================================================== *
 *  THE MODELLED PROPS
 *
 *  Trees, bushes, rocks and the sunflower field are the CC0 Quaternius
 *  models in public/assets/nature, not the hand-written geometry further
 *  up this file. That geometry is still here and still exported: it is the
 *  fallback if the asset set cannot be loaded, and nothing in the world is
 *  allowed to depend on a file that might not arrive.
 *
 *  The load is kicked off the moment this module is evaluated - a long way
 *  before buildTrees() runs, since raising the terrain alone is about 45%
 *  of the boot - so in practice the models are in hand before the woods
 *  are planted. If they are not, the placement still happens on time and
 *  the meshes arrive a beat later, at the same coordinates.
 * ======================================================================== */
var natureReady = preloadNature();

/* Per-prop scale correction. The manifest heights are what the modeller
   built; a few of them are not what this meadow wants at the scatter
   scales it was tuned with - the twisted trees the blossoms are made from
   are 17-19 metres tall on their own, which next to a 9-metre broadleaf
   reads as a different world rather than a bigger tree. */
var NATURE_FIT = {
  blossom_a: 0.46, blossom_b: 0.42,
  fern_a: 0.62,
  rock_a: 0.85, rock_b: 0.85, rock_c: 0.85
};

/* MID_NO_IMPOSTOR used to live here: the band for a prop whose atlas could
   not be baked, whose `out` was NATURE_BANDS.far.out - the 99000 sentinel
   meaning "never fade". A prop that took this path was drawn at every
   distance for the rest of the session. It is gone, and so is SOLO_FOREVER
   below it, because emitNature now falls back to the prop's own rung
   instead: no atlas is a reason to stop the mesh SOONER, never a reason to
   draw it for ever. */

/* The bands the hand-written trees live in. They are ONE merged geometry
   with no second level to fall back to, so there is no 118m step in the
   middle: full detail, then a billboard, and nothing in between.

   That single step is why the hand-over sits so much further out than the
   330m the modelled props use. A modelled tree has already dropped to LOD1
   by the time its card takes over; a hand-written one goes from every
   triangle it has straight to two. And a card, because it always turns to
   face you, presents its full crown from every angle - so a WOOD of cards
   reads denser than a wood of meshes, closing the gaps you could see
   through between real crowns. A side-by-side of the western forest showed
   exactly that at 330m and again at 430m: not a worse tree, but a solid
   tree line where there had been daylight.

   700m is past where that is recoverable. The composite pass's aerial
   perspective is already washing 15% of the way to haze there and the fog
   term is on top of that, so the far wood has lost its see-through depth to
   the atmosphere before the geometry has a chance to lose it. The pair
   still shares one cross-fade window, so the two dither halves add up to a
   whole tree through the transition. */
var PROC_HANDOVER = [700, 850];
/* ...and where the card itself stops. It used to inherit the 99000 sentinel
   from NATURE_BANDS.far, which means "never fade out" - so the hand-written
   trees' billboards were drawn to the edge of the plate for ever. */
var PROC_FAR_OUT = [980, 1150];

/* The hand-written trees' own hand-over, scaled alongside the modelled ones.
   Same in-place mutation for the same reason: PROC_NEAR.out and PROC_FAR.in
   are both this array. */
function setPropLODScale(k) {
  PROC_HANDOVER[0] = Math.round(PROC_HANDOVER[0] * k);
  PROC_HANDOVER[1] = Math.round(PROC_HANDOVER[1] * k);
  PROC_FAR_OUT[0] = Math.round(PROC_FAR_OUT[0] * k);
  PROC_FAR_OUT[1] = Math.round(PROC_FAR_OUT[1] * k);
  /* SMALL_SCATTER is no longer scaled here. Its two bands ARE ladder rungs
     now, and setNatureLODScale scales the whole ladder - doing it here as
     well would square the factor for the flowers alone. */
  setNatureLODScale(k);
}
var PROC_NEAR = { key: 'p', level: 0, in: [-2, -1], out: PROC_HANDOVER };
var PROC_FAR = { key: 'P', level: 2, in: PROC_HANDOVER, out: PROC_FAR_OUT };

/* Same shape, for a modelled prop that turned out to have only one level of
   detail in its GLB - see SOLO below. The second form never fades, for when
   there is no impostor to fade INTO. */
var SOLO_TO_IMP = { key: 's', level: 0, in: [-2, -1], out: NATURE_BANDS.far.in };

/* The scatter that had NO distance rule of any kind: the wildflowers, the
   hand-written sunflowers and the reeds. They go out through emitInstances(),
   which had no band and no entry in NAT_CULL, so every one of them was drawn
   at any distance it happened to be in frame. Same principle as everything
   else - the smaller the thing, the sooner it is not worth drawing - and a
   flower head is about ten centimetres across.

   These were hand-tuned to 150m and 270m, and they are two of the three
   numbers LOD_K was checked against - at 56 m/m they imply a 2.7m and a
   4.8m object, which is a wildflower and a sunflower at the size their own
   scatters draw them. So they are not replaced by the ladder so much as
   recognised as already being on it, and pointing them AT the ladder is
   what puts them under the same rule as everything else: 165m and 250m, a
   move of about a tenth either way.

   Sharing the rung bands also means a wildflower and a rock now compile to
   the SAME program instead of two, which is the ladder paying for itself. */
var SMALL_SCATTER = {
  flower:    LOD_BANDS[0].mesh,    /* rung 0 - 165m */
  sunflower: LOD_BANDS[1].mesh     /* rung 1 - 240m */
};

/* Every LOD bucket in the world, with the sphere that contains it and the
   distance band it belongs to. One distance compare per bucket per frame
   turns a level that is off-band into zero draw calls and zero vertex
   work - which is the entire reason the near level is bucketed finely and
   the mid level coarsely. */
var NAT_CULL = [];
var _natCullInstalled = false;

/* Hand a plain (non-nature) InstancedMesh the same per-bucket distance
   cull the modelled props get. The mesh's own transform is identity - every
   position lives in its instance matrices - so the bounding sphere three
   computes over those instances is already in world space. */
function cullBand(meshes, band) {
  if (!meshes || !meshes.length) { return; }
  for (var i = 0; i < meshes.length; i++) {
    var m = meshes[i];
    if (!m.boundingSphere && m.computeBoundingSphere) { m.computeBoundingSphere(); }
    var bs = m.boundingSphere;
    if (!bs) { continue; }
    NAT_CULL.push({
      m: m, cx: bs.center.x, cy: bs.center.y, cz: bs.center.z, r: bs.radius,
      d0: band.in[0], d1: band.out[1]
    });
  }
  installNatureCull();
}

function natureCull(cam) {
  var p = cam.position;
  for (var i = 0; i < NAT_CULL.length; i++) {
    var b = NAT_CULL[i];
    var dx = p.x - b.cx, dy = p.y - b.cy, dz = p.z - b.cz;
    var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    b.m.visible = (d + b.r >= b.d0) && (d - b.r <= b.d1);
  }
}

/* Hooked onto the scene rather than the game loop, so props.js does not
   need main.js to call it and cannot be forgotten by a later refactor.
   three fires Scene.onBeforeRender once per render(), before it walks the
   graph to build the render list - exactly the moment a `visible` flag
   still counts. Chained, never replaced: whatever else wants this hook
   keeps it. */
function installNatureCull() {
  if (_natCullInstalled || !scene) { return; }
  _natCullInstalled = true;
  var prev = scene.onBeforeRender;
  scene.onBeforeRender = function (r, s, cam) {
    if (prev) { prev.call(this, r, s, cam); }
    if (cam && cam.isCamera && NAT_CULL.length) { natureCull(cam); }
  };
}

/* One LOD level of one prop, bucketed into spatial cells. Both primitives
   of a tree (bark and leaves are separate materials) share ONE
   instanceMatrix and ONE instanceColor - the literal same buffer objects,
   the trick outline.js uses - so a two-material prop costs two draw calls
   but only one copy of its instance data. On a machine with 8 GB of RAM
   that is not a micro-optimisation. */
function emitNatureLevel(out, prop, mats, cols, band, level, cell, sway, shadow, swap) {
  var prims = prop.lods[level];
  if (!prims || !prims.length) { return; }
  var i, e, tris = 0;
  for (i = 0; i < prims.length; i++) { tris += geoTris(prims[i].geo); }
  var buckets = bucketsOf(mats, fitCell(mats, cell, tris));
  for (var bk in buckets) {
    var list = buckets[bk];
    var cx = 0, cy = 0, cz = 0;
    for (i = 0; i < list.length; i++) {
      e = mats[list[i]].elements;
      cx += e[12]; cy += e[13]; cz += e[14];
    }
    cx /= list.length; cy /= list.length; cz /= list.length;
    var rad = 0;
    for (i = 0; i < list.length; i++) {
      e = mats[list[i]].elements;
      var sy = Math.sqrt(e[4] * e[4] + e[5] * e[5] + e[6] * e[6]);
      var dx = e[12] - cx, dy = e[13] - cy, dz = e[14] - cz;
      var d = Math.sqrt(dx * dx + dy * dy + dz * dz) +
        Math.max(prop.radius, prop.height) * sy;
      if (d > rad) { rad = d; }
    }
    var shareM = null, shareC = null;
    for (var pi = 0; pi < prims.length; pi++) {
      /* `swap` re-points one material name at another entry in NATURE_TEX,
         which is how the same twisted-tree geometry is planted twice - once
         in autumn red, once in summer green. */
      var mn = prims[pi].matName;
      if (swap && swap[mn]) { mn = swap[mn]; }
      var mat = natureMaterial(mn, prims[pi].vc, band, prop.height, sway);
      var im = new THREE.InstancedMesh(prims[pi].geo, mat, list.length);
      if (shareM) {
        im.instanceMatrix = shareM;
        im.instanceColor = shareC;
      } else {
        for (i = 0; i < list.length; i++) {
          im.setMatrixAt(i, mats[list[i]]);
          if (cols) { im.setColorAt(i, cols[list[i]]); }
        }
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) { im.instanceColor.needsUpdate = true; }
        shareM = im.instanceMatrix;
        shareC = im.instanceColor;
      }
      im.castShadow = !!shadow;
      im.receiveShadow = !!shadow;
      im.matrixAutoUpdate = false;
      im.frustumCulled = true;
      if (im.computeBoundingSphere) { im.computeBoundingSphere(); }
      scene.add(im);
      NAT_CULL.push({ m: im, cx: cx, cy: cy, cz: cz, r: rad, d0: band.in[0], d1: band.out[1] });
      out.push(im);
    }
  }
}

/* The far band: two triangles per prop, one draw call for every instance
   of that prop in the world, no bucketing and no frustum test. Culling a
   quad costs more than drawing it. */
/* One quad per prop is cheap to DRAW. It was not cheap to keep submitting:
   with no bucketing there was one mesh per prop covering the entire plate,
   so `frustumCulled = false` was not an optimisation but a necessity - a
   bounding sphere that size can never be rejected anyway - and the result
   was every card in the world, including the half behind the camera, going
   through the vertex shader every frame for ever.

   Bucketed at a coarse cell, each mesh covers a patch of ground instead of
   the world, which makes both tests meaningful: the frustum throws away
   everything behind you, and the entry in NAT_CULL throws away everything
   past the distance this size of prop is worth drawing at. The cell stays
   large because the alternative is trading the win back for draw calls. */
function emitImpostorBuckets(out, tex, imp, band, mats, cell) {
  var buckets = bucketsOf(mats, cell);
  var geo = impostorGeometry(imp);
  var mat = natureImpostorMaterial(tex, band);
  for (var bk in buckets) {
    var list = buckets[bk], i;
    var im = new THREE.InstancedMesh(geo, mat, list.length);
    var cx = 0, cy = 0, cz = 0;
    for (i = 0; i < list.length; i++) {
      im.setMatrixAt(i, mats[list[i]]);
      var e = mats[list[i]].elements;
      cx += e[12]; cy += e[13]; cz += e[14];
    }
    cx /= list.length; cy /= list.length; cz /= list.length;
    var rad = 0;
    for (i = 0; i < list.length; i++) {
      var e2 = mats[list[i]].elements;
      var dx = e2[12] - cx, dy = e2[13] - cy, dz = e2[14] - cz;
      var d = Math.sqrt(dx * dx + dy * dy + dz * dz) + imp.h;
      if (d > rad) { rad = d; }
    }
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = false;
    im.receiveShadow = false;
    im.matrixAutoUpdate = false;
    im.frustumCulled = true;
    if (im.computeBoundingSphere) { im.computeBoundingSphere(); }
    scene.add(im);
    NAT_CULL.push({ m: im, cx: cx, cy: cy, cz: cz, r: rad,
                    d0: band.in[0], d1: band.out[1] });
    out.push(im);
  }
  installNatureCull();
}

function emitNatureImpostor(out, lib, prop, mats, impSet, band) {
  var tex = impSet ? impSet.tex : lib.impostorTex;
  var imp = impSet ? impSet.imps[prop.name] : prop.imp;
  if (!tex || !imp || !band) { return; }
  emitImpostorBuckets(out, tex, imp, band, mats, 620);
}

/* The scale this group of instances is ACTUALLY drawn at.

   One band serves a whole group, so a single number has to stand in for a
   spread - and the spread can be wide: the volcano scatter varies its
   instances over 0.6 to 6.1. The 75th percentile rather than the mean
   because the two errors are not symmetrical. Give the group too SHORT a
   distance and the biggest instances in it - the ones that read as
   landmarks - blink out while still visibly large, which is the exact
   complaint that started this. Give it too LONG a distance and some small
   instances are drawn further than they earn, which costs a little fill
   and nothing else. So lean high.

   Measured off the placed matrices, not off the scatter's `scale`
   callback, so NATURE_FIT and any later transform are already in it. */
function groupScale(mats) {
  if (!mats || !mats.length) { return 1; }
  var s = [];
  for (var i = 0; i < mats.length; i++) {
    var e = mats[i].elements;
    s.push(Math.sqrt(e[4] * e[4] + e[5] * e[5] + e[6] * e[6]));
  }
  s.sort(function (a, b) { return a - b; });
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.75))] || 1;
}

/* Boot-time proof that every prop landed where the rule says it should.
   The old three-class table hid its own mistakes - a prop on the wrong
   distance looked exactly like a prop on the right one until you walked
   out to find it. One table in the console is cheaper than that walk. */
var LOD_REPORT = [];
function noteLOD(name, extent, rung, kind) {
  LOD_REPORT.push({ name: name, extent: extent, dist: rung.dist, kind: kind });
}
function dumpLODReport() {
  if (!LOD_REPORT.length) { return; }
  LOD_REPORT.sort(function (a, b) { return a.extent - b.extent; });
  var rows = LOD_REPORT.map(function (r) {
    return {
      prop: r.name,
      'extent (m)': Math.round(r.extent * 100) / 100,
      'ideal (m)': Math.round(LOD_K * r.extent),
      'rung (m)': r.dist,
      'snap': (Math.round((r.dist / (LOD_K * r.extent) - 1) * 100)) + '%',
      'far level': r.kind
    };
  });
  if (console.table) { console.table(rows); } else { console.log(rows); }
}

/* Splits a placement across the prop variants it was asked for, seats each
   one on the ground, and emits all three levels. Returns false if none of
   the requested props are in the library, so the caller can fall back. */
function emitNature(lib, opts, placed) {
  var names = [], i, gi;
  for (i = 0; i < opts.props.length; i++) {
    if (lib.props[opts.props[i]]) { names.push(opts.props[i]); }
  }
  if (!names.length) { return false; }
  buildNatureImpostors(lib);
  installNatureCull();

  var groups = [], gcols = [];
  for (i = 0; i < names.length; i++) { groups.push([]); gcols.push([]); }
  var kv = new THREE.Vector3();
  for (i = 0; i < placed.mats.length; i++) {
    gi = Math.min(names.length - 1, Math.floor(placed.picks[i] * names.length));
    var prop = lib.props[names[gi]];
    var k = NATURE_FIT[prop.name] === undefined ? 1 : NATURE_FIT[prop.name];
    var m = placed.mats[i].clone();
    if (k !== 1) { m.scale(kv.set(k, k, k)); }
    var e = m.elements;
    var sy = Math.sqrt(e[4] * e[4] + e[5] * e[5] + e[6] * e[6]);
    /* placeProps() put the ORIGIN on the ground. `base` from the manifest
       is where the model's lowest vertex sits relative to that origin, so
       this line puts the lowest vertex a definite distance UNDER the
       surface instead of wherever the modeller's origin happened to fall.
       A little burial is not a fudge: real trunks flare into the ground,
       and it also swallows the last of the terrain's own error on a slope
       steep enough that a 2-metre-wide trunk spans a real height change.
       Nothing in this world is ever allowed to show daylight under it. */
    var bury = clamp(prop.height * sy * (opts.bury === undefined ? 0.03 : opts.bury), 0.12, 0.85);
    e[13] -= prop.base * sy + bury;
    groups[gi].push(m);
    gcols[gi].push(placed.cols[i]);
  }

  /* The base atlas is photographed from each prop's OWN materials, so a
     scatter that re-points a material name (the twisted trees planted a
     second time in summer green) would have turned autumn red the moment it
     crossed into the far band. That used to mean giving those trees no far
     band at all - three hundred trees holding a four-thousand-triangle mid
     LOD out to the edge of the world, about 1.2 million triangles that
     nothing could ever cull. Photograph the swapped variant instead: one
     extra atlas, baked once, and the green trees get the same billboard
     hand-off everything else has had all along. */
  var swap = opts.matSwap || null;
  var impSet = swap ? natureSwapImpostors(lib, swap, names) : null;
  var useImp = swap ? !!impSet : !!lib.impostorTex;

  var out = [];
  for (gi = 0; gi < names.length; gi++) {
    if (!groups[gi].length) { continue; }
    var pr = lib.props[names[gi]];
    var sway = opts.sway || 0;

    /* Where this prop, at the size THIS scatter draws it, stops being worth
       drawing. Everything below hangs off `rung`: which band the geometry
       fades out on, whether there is a billboard at all, and how far that
       billboard runs. Nothing here is assigned by prop name. */
    var ext = propExtent(pr, groupScale(groups[gi]));
    var rung = rungFor(ext);
    /* A rung short enough to carry no card ends the geometry itself. That
       is the whole far field for a flower or a rock now: no atlas cell, no
       impostor bucket, no second draw call - the mesh simply stops. */
    var card = useImp && rung.imp ? rung.imp : null;
    noteLOD(pr.name, ext, rung, card ? 'billboard' : 'mesh ends');
    /* SOLO: the small props - every rock, both ferns, the two tall
       flowers the sunflower field is half made of, and one of the pines -
       ship with only an LOD0 in their GLB, and loadNatureProp() fills the
       gap by pointing lods[1] at lods[0]. So the mid level was drawing the
       SAME geometry the near level had already drawn: every one of those
       instances submitted twice, all the way out to 410 metres, with one
       copy dithering itself away pixel by pixel. At the sunflower field
       that was a million triangles of pure duplicate.

       When the two levels are the same object there is nothing to hand
       over to, so emit ONE mesh that carries the whole range and let the
       billboard take it from 330. The band it fades out on is the same
       band the mid level used, and the geometry is the same geometry, so
       what reaches the screen is unchanged to the pixel - there is simply
       one copy of it instead of two.

       Near cells are small because that level is off-screen most of the
       time and a small cell is what lets a whole cell be skipped. Mid
       cells are large because that level is on screen almost everywhere,
       so the only thing extra buckets would buy is extra draw calls. Both
       are floors now - fitCell() grows them for props cheap enough that a
       fine cell was buying draw calls and nothing else. */
    if (pr.lods[1] === pr.lods[0]) {
      /* Hand over to the card if there is one to hand over to; otherwise
         this single level carries the prop and ends on its own rung. The
         second case used to be SOLO_FOREVER, whose `out` was the 99000
         sentinel - a prop with no atlas was drawn to the edge of the world
         for ever, which is precisely the "some things never stop
         rendering" this change exists to remove. */
      emitNatureLevel(out, pr, groups[gi], gcols[gi], card ? SOLO_TO_IMP : rung.mesh,
        0, 150, sway, opts.shadow !== false, swap);
    } else {
      /* Same for the two-level props: with an atlas the mid LOD hands to
         the card at the shared window, without one it ends on the rung
         rather than inheriting the sentinel from MID_NO_IMPOSTOR. */
      emitNatureLevel(out, pr, groups[gi], gcols[gi], NATURE_BANDS.near, 0, 150, sway, opts.shadow !== false, swap);
      emitNatureLevel(out, pr, groups[gi], gcols[gi], card ? NATURE_BANDS.mid : rung.midOnly,
        1, 420, sway, false, swap);
    }
    if (card) { emitNatureImpostor(out, lib, pr, groups[gi], impSet, card); }
  }
  var rec = SCATTERED[opts.seed];
  if (rec) { rec.meshes = out; }
  return true;
}

/* scatter(), but the mesh is a downloaded model. Placement happens NOW,
   synchronously, exactly as it always did; the meshes appear when the
   asset set resolves. opts.fallback, if given, is a function returning
   { geo, mat } for the procedural version, used only if the models never
   turn up. */
function natureScatter(opts) {
  var placed = placeProps(opts);
  if (!placed) { return null; }
  SCATTERED[opts.seed] = { mats: placed.mats, meshes: [] };
  natureReady.then(function (lib) {
    if (lib && emitNature(lib, opts, placed)) { return; }
    if (!opts.fallback) { return; }
    var f = opts.fallback();
    if (!f || !f.geo) { return; }
    SCATTERED[opts.seed].meshes = emitInstances(f.geo, f.mat, placed.mats, placed.cols,
      opts.cell || 300, opts.shadow, false);
  });
  return placed;
}

/* the procedural fallbacks' materials, built only if they are ever needed.
   Pass a band to have the mesh dither itself out at that distance - only
   the hand-written trees planted alongside the models do that, because
   only they have a billboard waiting to take over. A material with no band
   draws at every distance, which is what the "the asset set never arrived"
   fallbacks need. */
function proceduralLeafMat(band) {
  var m = withRim(new THREE.MeshToonMaterial({
    vertexColors: true, gradientMap: toonRamp(), side: THREE.DoubleSide
  }), 0.50);
  if (!band) { return m; }
  var prev = m.onBeforeCompile;
  m.onBeforeCompile = function (sh) {
    if (prev) { prev.call(this, sh); }     /* withRim() got there first - chain */
    patchNatureShader(sh, band, 1, 0);
  };
  m.customProgramCacheKey = function () { return 'procleaf|' + band.key; };
  return m;
}

/* The plate is WORLD across, so anything scattered past HALF lands on ground
   that does not exist - groundY() then samples outside terrainHeights and the
   prop ends up hanging in the air. These were left at 1240 from when the world
   was 2800 wide; HALF is now 950. */
var SCAT_R = HALF - 40;

function buildTrees() {
  var okTree = function (x, z, si, rng) {
    if (si.water || si.h < 3.5 || si.h > 195 || si.slope > 0.62) return false;
    if (si.riverD < 44) return false;
    var sfx = (x - 200) / 250, sfz = (z - 40) / 178;
    if (sfx * sfx + sfz * sfz < 1.0) return false;
    if (z > 300 && si.h < 8) return false;
    return true;
  };
  /* The broadleaf woods. NO outline: the inverted-hull ink line is what
     made the old cone trees read as drawn, but these have a real silhouette
     of a few thousand leaf cards, and a hard black line around every one of
     them is exactly the "cone tree with a black border" the user asked us
     to stop making. The toon ramp and the rim light carry the style now. */
  natureScatter({
    seed: 11, props: ['tree_a', 'tree_b'], sway: 0.17, bury: 0.03,
    fallback: function () { return { geo: broadleafGeo(31, true), mat: proceduralLeafMat() }; },
    tries: 9000, max: 450, range: SCAT_R,
    prob: function (x, z) { return forestDensity(x, z) * 0.85; },
    accept: okTree, scale: function (r) { return 0.85 + r() * 0.65; },
    tilt: 0.07, sink: -0.25, shadow: true
  });
  natureScatter({
    seed: 12, props: ['tree_c', 'tree_d'], sway: 0.15, bury: 0.03,
    fallback: function () { return { geo: broadleafGeo(77, false), mat: proceduralLeafMat() }; },
    tries: 9000, max: 470, range: SCAT_R,
    prob: function (x, z) { return forestDensity(x, z) * 0.8; },
    accept: okTree, scale: function (r) { return 0.9 + r() * 0.7; },
    tilt: 0.09, sink: -0.22, shadow: true
  });
  /* The blossom trees that line the walking path - the twisted trees from
     the kit, cut down to meadow scale by NATURE_FIT. */
  /* Blossom stays what it was meant to be - an avenue along the walk, not the
     whole meadow. Raising its share of the woods to 0.34 is what turned every
     view pink; it is back to a tenth, and the green twin below carries the
     rest of that silhouette. */
  natureScatter({
    seed: 21, props: ['blossom_a', 'blossom_b'], sway: 0.20, bury: 0.03,
    fallback: function () { return { geo: sakuraGeo(44), mat: proceduralLeafMat() }; },
    tries: 9000, max: 165, range: SCAT_R,
    prob: function (x, z) {
      var pd = Math.min(pathInfo(WALKPATH, x, z).d, pathInfo(BEACHPATH, x, z).d);
      var nearPath = smoothstep(60, 8, pd) * 0.88;
      return nearPath + 0.10 * forestDensity(x, z);
    },
    accept: function (x, z, si, rng) {
      if (si.water || si.h < 3.5 || si.h > 180 || si.slope > 0.55) return false;
      if (pathInfo(WALKPATH, x, z).d < 4.5 || pathInfo(BEACHPATH, x, z).d < 4.5) return false;
      return true;
    },
    scale: function (r) { return 0.92 + r() * 0.65; },
    tilt: 0.06, sink: -0.22, shadow: true
  });
  /* The same two twisted trees, in leaf. Identical geometry and identical
     LODs - only the leaf texture is re-pointed - so the shape you liked turns
     up in green as often as it does in blossom. */
  natureScatter({
    seed: 22, props: ['blossom_a', 'blossom_b'], sway: 0.20, bury: 0.03,
    matSwap: { Leaves_TwistedTree: 'Leaves_TwistedGreen' },
    fallback: function () { return { geo: broadleafGeo(77, true), mat: proceduralLeafMat() }; },
    tries: 10000, max: 300, range: SCAT_R,
    prob: function (x, z) {
      var pd = Math.min(pathInfo(WALKPATH, x, z).d, pathInfo(BEACHPATH, x, z).d);
      return smoothstep(80, 10, pd) * 0.34 + forestDensity(x, z) * 0.72;
    },
    accept: function (x, z, si, rng) {
      if (si.water || si.h < 3.5 || si.h > 180 || si.slope > 0.55) return false;
      if (pathInfo(WALKPATH, x, z).d < 4.5 || pathInfo(BEACHPATH, x, z).d < 4.5) return false;
      return true;
    },
    scale: function (r) { return 0.92 + r() * 0.65; },
    tilt: 0.06, sink: -0.22, shadow: true
  });
  natureScatter({
    seed: 13, props: ['pine_a', 'pine_b', 'pine_c'], sway: 0.10, bury: 0.03,
    fallback: function () { return { geo: pineGeo(53), mat: proceduralLeafMat() }; },
    tries: 8000, max: 340, range: SCAT_R,
    prob: function (x, z) { return forestDensity(x, z) * 0.55 + (z < -300 ? 0.22 : 0); },
    accept: function (x, z, si, rng) {
      if (si.water || si.h < 6 || si.h > 300 || si.slope > 0.85) return false;
      if (si.riverD < 44) return false;
      return true;
    },
    scale: function (r) { return 0.8 + r() * 0.75; },
    tilt: 0.05, sink: -0.3, shadow: true
  });
  /* ------------------------------------------------------------------
     The hand-written trees, planted BESIDE the models rather than replaced
     by them. Swapping the woods over wholesale threw away a silhouette that
     was already working; two shapes of tree in one wood reads as a wood,
     one shape repeated 400 times reads as wallpaper. These use their own
     seeds, so they are extra trees rather than the same positions redrawn -
     the meadow ends up denser, which is what was asked for.

     sakuraGeo is the pink one and broadleafGeo the green, and they are
     scattered on the SAME probability field, so the two colours land mixed
     through each other instead of in separate stands. */
  /* These three had no level of detail of ANY kind: 860 trees, about two
     thousand triangles each, drawn at full resolution whether they were
     four metres away or nine hundred - 1.27 million triangles that no
     distance test could ever remove, which on a phone is most of a frame
     all by itself. They get the same hand-off the modelled trees have had
     since the nature set landed: the real mesh out to 330 metres, then a
     photograph of that same mesh, taken here, at boot, with its own
     material under the scene's own lights. Same silhouette, same colour,
     same lighting - a distant tree is a picture of the near tree, which is
     the whole reason this technique is safe to use on a look this
     deliberate.

     One atlas for all three, baked in a single pass: readRenderTargetPixels
     stalls the GPU, and doing it once costs a third of doing it per tree. */
  var gSakura = sakuraGeo(44), gBroad = broadleafGeo(31, true), gPine = pineGeo(53);
  var procLeaf = proceduralLeafMat(PROC_NEAR);
  var procSet = null;
  try {
    /* photographed with the UNBANDED material - a capture must not dither
       itself away, exactly as in buildNatureImpostors */
    var flat = proceduralLeafMat();
    procSet = bakeGeoImpostors([
      { geo: gSakura, mat: flat }, { geo: gBroad, mat: flat }, { geo: gPine, mat: flat }
    ]);
  } catch (e) { console.warn('[meadow] procedural impostors unavailable', e); }
  /* No atlas means no far band, so the mesh has to keep drawing forever -
     which is exactly the behaviour this file shipped with. */
  if (!procSet) { procLeaf = proceduralLeafMat(); }
  function procImp(i) { return procSet ? { tex: procSet.tex, imp: procSet.imps[i] } : null; }

  scatter({
    seed: 51, geo: gSakura, mat: procLeaf, impostor: procImp(0),
    tries: 9000, max: 300, range: SCAT_R,
    prob: function (x, z) {
      var pd = Math.min(pathInfo(WALKPATH, x, z).d, pathInfo(BEACHPATH, x, z).d);
      return smoothstep(90, 10, pd) * 0.55 + forestDensity(x, z) * 0.60;
    },
    accept: okTree, scale: function (r) { return 0.88 + r() * 0.62; },
    tilt: 0.07, sink: -0.22, shadow: true
  });

  scatter({
    seed: 52, geo: gBroad, mat: procLeaf, impostor: procImp(1),
    tries: 9000, max: 320, range: SCAT_R,
    prob: function (x, z) { return forestDensity(x, z) * 0.75; },
    accept: okTree, scale: function (r) { return 0.85 + r() * 0.70; },
    tilt: 0.07, sink: -0.25, shadow: true
  });

  scatter({
    seed: 53, geo: gPine, mat: procLeaf, impostor: procImp(2),
    tries: 8000, max: 240, range: SCAT_R,
    prob: function (x, z) { return forestDensity(x, z) * 0.42 + (z < -300 ? 0.18 : 0); },
    accept: function (x, z, si, rng) {
      if (si.water || si.h < 6 || si.h > 300 || si.slope > 0.85) return false;
      if (si.riverD < 44) return false;
      return true;
    },
    scale: function (r) { return 0.8 + r() * 0.7; },
    tilt: 0.05, sink: -0.3, shadow: true
  });

  /* undergrowth - bushes and ferns, no shadow (a thousand shadow casters
     for something knee-high is not where the shadow budget goes) */
  natureScatter({
    seed: 14, props: ['bush_a', 'fern_a'], sway: 0.09, bury: 0.05,
    fallback: function () { return { geo: bushGeo(97), mat: proceduralLeafMat() }; },
    tries: 11000, max: 1000, range: SCAT_R,
    prob: function (x, z) { return forestDensity(x, z) * 0.9 + 0.06; },
    accept: function (x, z, si, rng) {
      if (si.water || si.h < 2.0 || si.h > 220 || si.slope > 0.8) return false;
      if (si.riverD < 36) return false;
      return true;
    },
    scale: function (r) { return 0.7 + r() * 0.9; },
    tilt: 0.14, sink: -0.15, shadow: false
  });
}

function flowerGeo(seed) {
  var rng = mulberry32(seed);
  var gb = new GB();
  gb.add(new THREE.CylinderGeometry(0.012, 0.018, 0.42, 3, 1, true), M4(0, 0.21, 0), new THREE.Color(0x4f8c31), 0.05, rng);
  var petal = new THREE.CircleGeometry(0.5, 3);
  var white = new THREE.Color(0xffffff);
  for (var i = 0; i < 6; i++) {
    var a = i / 6 * TAU;
    var m = new THREE.Matrix4();
    m.compose(new THREE.Vector3(Math.cos(a) * 0.060, 0.44, Math.sin(a) * 0.060),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(-PI / 2 + 0.40, a, 0, 'YXZ')),
      new THREE.Vector3(0.12, 0.18, 0.12));
    gb.add(petal, m, white, 0.0, rng);
  }
  gb.add(new THREE.CircleGeometry(0.055, 6), M4(0, 0.462, 0, -PI / 2, 0, 0), new THREE.Color(0xffcb24), 0.0, rng);
  return gb.build();
}

function buildFlowers() {
  var mat = swayMaterial(0.10, SMALL_SCATTER.flower);
  /* vivid anime wildflower field palette (Images 3 & 5) */
  var palette = [
    0xff4d85, // vivid pink cosmos
    0xff73a3, // cosmos magenta
    0xff9ec0, // soft sakura pink
    0xffffff, // pristine white daisy
    0xffcb24, // golden buttercup
    0x4da6ff, // sky bluebell
    0x9e6ef5, // alpine lavender
    0xffa882  // sunlit peach
  ];
  /* About a thousand flowers on the whole map, down from eight thousand.
     Fewer PATCHES, and each one tighter rather than thinner: 170 clumps of
     four to fourteen metres across reads as a meadow with flowers in it,
     whereas spreading the same thousand over the old 620 wide patches would
     have read as a meadow that had been mown. */
  var patches = [];
  var prng = mulberry32(505);
  for (var i = 0; i < 170; i++) {
    patches.push({
      x: (prng() * 2 - 1) * 900, z: (prng() * 2 - 1) * 620 - 40,
      r: 4 + prng() * 10, c: palette[Math.floor(prng() * palette.length)]
    });
  }
  var rng = mulberry32(606);
  var mats = [], cols = [];
  var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  var pos = new THREE.Vector3(), scl = new THREE.Vector3();
  for (var pi = 0; pi < patches.length && mats.length < 1000; pi++) {
    var P = patches[pi];
    var base = new THREE.Color(P.c);
    var n = 7 + Math.floor(rng() * 14);
    for (var k = 0; k < n; k++) {
      var a = rng() * TAU, rr = Math.sqrt(rng()) * P.r;
      var x = P.x + Math.cos(a) * rr, z = P.z + Math.sin(a) * rr;
      var si = siteInfo(x, z);
      if (si.water || si.h < 2.4 || si.h > 170 || si.slope > 0.55 || si.riverD < 42) continue;
      var s = 0.85 + rng() * 0.9;
      pos.set(x, groundY(x, z) - 0.04, z);
      e.set((rng() - 0.5) * 0.3, rng() * TAU, (rng() - 0.5) * 0.3, 'YXZ');
      q.setFromEuler(e); scl.set(s, s * (0.85 + rng() * 0.4), s);
      m4.compose(pos, q, scl);
      mats.push(m4.clone());
      var v = 0.9 + rng() * 0.2;
      cols.push(base.clone().multiplyScalar(v));
      /* after the draws, for the same reason as placeProps above */
      if (volcanoBare(x, z) > 0.30) { mats.pop(); cols.pop(); }
    }
  }
  cullBand(emitInstances(flowerGeo(321), mat, mats, cols, 190, false), SMALL_SCATTER.flower);
}

function reedGeo(seed) {
  var rng = mulberry32(seed);
  var gb = new GB();
  for (var i = 0; i < 6; i++) {
    var a = rng() * TAU, r = rng() * 0.3, hgt = 1.1 + rng() * 1.5;
    var m = new THREE.Matrix4();
    m.compose(new THREE.Vector3(Math.cos(a) * r, hgt / 2, Math.sin(a) * r),
      new THREE.Quaternion().setFromEuler(new THREE.Euler((rng() - 0.5) * 0.5, rng() * TAU, (rng() - 0.5) * 0.5, 'YXZ')),
      new THREE.Vector3(1, 1, 1));
    var c = new THREE.Color().setHSL(0.22 + rng() * 0.09, 0.44, 0.28 + rng() * 0.14);
    gb.add(new THREE.CylinderGeometry(0.012, 0.035, hgt, 3, 1, true), m, c, 0.05, rng);
  }
  return gb.build();
}

function buildReeds() {
  var mat = swayMaterial(0.055, SMALL_SCATTER.flower);
  scatter({
    seed: 31, geo: reedGeo(88), mat: mat, band: SMALL_SCATTER.flower,
    tries: 22000, max: 1700, range: SCAT_R,
    prob: function (x, z) { return 1; },
    accept: function (x, z, si, rng) {
      if (si.h > 40 || si.slope > 0.7) return false;
      var nearRiver = si.riverD > 22 && si.riverD < 40 && z > -340 && z < 460;
      var nearPool = si.poolD > 34 && si.poolD < 52;
      var coast = (fbm(x * 0.0032 + 21.7, 8.3, 3) - 0.5) * 130;
      var nearSea = (z + coast) > 330 && si.h > 0.6 && si.h < 3.4;
      if (!(nearRiver || nearPool || nearSea)) return false;
      if (si.water) return false;
      return true;
    },
    scale: function (r) { return 0.8 + r() * 0.8; }, tilt: 0.12, sink: -0.1
  });
}

function rockGeo(seed, flat) {
  var g = new THREE.IcosahedronGeometry(1, 1);
  var p = g.attributes.position, v = new THREE.Vector3();
  for (var i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    var d = v.clone().normalize();
    var f = 0.62 + 0.72 * vnoise(d.x * 3.1 + seed, d.z * 3.1 + d.y * 2.4 + seed);
    p.setXYZ(i, v.x * f, v.y * f * (flat ? 0.48 : 0.80), v.z * f);
  }
  g.computeVertexNormals();
  var gb = new GB();
  gb.add(g, new THREE.Matrix4(), new THREE.Color(0x77726a), 0.10, mulberry32(seed | 0));
  return gb.build();
}

function buildRocks() {
  var fallbackMat = function () {
    return new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonRamp() });
  };
  /* Rocks get a deeper burial than anything else (bury 0.14 against 0.03
     for a tree): a boulder that touches the ground on a tangent looks
     dropped, one that is a third under it looks like it has been there
     since the ice. No outline here either - a black line around a stone is
     the single most cartoon-looking thing this world had. */
  natureScatter({
    seed: 41, props: ['rock_a', 'rock_b', 'rock_c'], sway: 0, bury: 0.14, onBare: 'allow',
    fallback: function () { return { geo: rockGeo(5, false), mat: fallbackMat() }; },
    tries: 18000, max: 240, range: SCAT_R,
    prob: function (x, z) { return 1; },
    accept: function (x, z, si, rng) {
      if (si.h < -6 || si.h > 420) return false;
      var beachy = si.h > -1.5 && si.h < 5 && z > 240;
      /* Boulders belong at the TOP of the river, not the bottom. Water
         carries stone downhill and drops it where it slows, so the
         head-waters and the plunge pool are where the big rock is and the
         slow lower reach near the sea is where it is not - which is also
         where they were cluttering the view over the water. The lower
         river ends at z = 60 now; below that the bank is left clear. */
      var riverside = si.riverD < 42 && si.riverD > 12 && z > -340 && z < 60;
      var poolside = si.poolD < 74 && si.poolD > 22;
      /* and along the brook that feeds the fall, above the cliff */
      var bd = pathInfo(BROOK, x, z).d;
      var brookside = bd < 40 && bd > 7;
      var stony = si.slope > 0.55 || si.h > 150;
      return (beachy && rng() < 0.5) || riverside || poolside || brookside ||
             (stony && rng() < 0.55);
    },
    scale: function (r, si) { return 0.6 + r() * (si.h > 120 ? 5.5 : 2.6); },
    tilt: 0.6, sink: -0.35, shadow: true
  });
  /* the low water-worn stones along the shoreline - flatter, so they are
     buried harder still and tilted less */
  natureScatter({
    seed: 42, props: ['rock_c', 'rock_a'], sway: 0, bury: 0.30, onBare: 'allow',
    fallback: function () { return { geo: rockGeo(19, true), mat: fallbackMat() }; },
    tries: 7000, max: 70, range: SCAT_R,
    prob: function (x, z) { return 1; },
    accept: function (x, z, si, rng) {
      return si.h > -2 && si.h < 6 && z > 250;
    },
    scale: function (r) { return 1.0 + r() * 3.4; },
    tilt: 0.35, sink: -0.4, shadow: true
  });
}

function buildBridge() {
  var idx = 4;
  var a = RIVER[idx], b = RIVER[idx + 1];
  var cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2, cy = (a.y + b.y) / 2;
  var ang = Math.atan2(b.x - a.x, b.z - a.z);      /* the river's heading */
  var px = Math.cos(ang), pz = -Math.sin(ang);     /* across it */
  var SPAN = 58, W = 3.4, RISE = 2.3, NP = 32;
  var e1 = terrainHeight(cx + px * SPAN * 0.5, cz + pz * SPAN * 0.5);
  var e2 = terrainHeight(cx - px * SPAN * 0.5, cz - pz * SPAN * 0.5);
  var deck = Math.max(e1, e2, cy + 2.0) + 0.25;

  var rng = mulberry32(1234);
  var gb = new GB();
  var wood = new THREE.Color(0x8a6440), woodD = new THREE.Color(0x6b4c30);
  function arch(u) { return deck + RISE * (1 - u * u); }
  function tilt(u) { return Math.atan(-4 * RISE * u / SPAN); }

  for (var i = 0; i < NP; i++) {
    var t = (i + 0.5) / NP, u = (t - 0.5) * 2;
    gb.add(new THREE.BoxGeometry(SPAN / NP * 0.88, 0.16, W),
      M4((t - 0.5) * SPAN, arch(u), 0, 0, 0, tilt(u)), wood, 0.09, rng);
  }
  for (var sgn = -1; sgn <= 1; sgn += 2) {
    for (var j = 0; j <= 9; j++) {
      var t2 = j / 9, u2 = (t2 - 0.5) * 2;
      gb.add(new THREE.CylinderGeometry(0.09, 0.11, 1.2, 5),
        M4((t2 - 0.5) * SPAN * 0.95, arch(u2) + 0.58, sgn * W * 0.46), woodD, 0.08, rng);
    }
    for (var k = 0; k < 26; k++) {
      var t3 = (k + 0.5) / 26, u3 = (t3 - 0.5) * 2;
      gb.add(new THREE.BoxGeometry(SPAN / 26 * 0.96, 0.12, 0.16),
        M4((t3 - 0.5) * SPAN * 0.96, arch(u3) + 1.12, sgn * W * 0.46, 0, 0, tilt(u3)), wood, 0.07, rng);
    }
  }
  /* piers, sunk well into the bank */
  for (var q = -1; q <= 1; q += 2) {
    for (var w = -1; w <= 1; w += 2) {
      var uu = q * 0.86;
      gb.add(new THREE.CylinderGeometry(0.24, 0.30, 9, 6),
        M4(q * SPAN * 0.43, arch(uu) - 4.6, w * W * 0.46), woodD, 0.08, rng);
    }
  }
  var mesh = new THREE.Mesh(gb.build(), new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonRamp() }));
  BRIDGE = { cx: cx, cz: cz, px: px, pz: pz, tx: Math.sin(ang), tz: Math.cos(ang),
             span: SPAN, w: W * 0.46, deck: deck, rise: RISE };
  mesh.position.set(cx, 0, cz);
  mesh.rotation.y = ang;
  mesh.castShadow = true; mesh.receiveShadow = true;
  scene.add(mesh);
}

function buildGardenAccents() {
  var gb = new GB();
  var wood = new THREE.Color(0x8a6242), woodD = new THREE.Color(0x5e4129);
  var rng = mulberry32(888);

  function addBench(x, z, ry) {
    var h = groundY(x, z) - 0.05;
    var q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry);
    // Planks
    for (var i = -1; i <= 1; i++) {
      var m = new THREE.Matrix4().compose(
        new THREE.Vector3(0, 0.58, i * 0.24),
        new THREE.Quaternion(),
        new THREE.Vector3(1, 1, 1)
      );
      var worldM = new THREE.Matrix4().compose(new THREE.Vector3(x, h, z), q, new THREE.Vector3(1, 1, 1)).multiply(m);
      gb.add(new THREE.BoxGeometry(2.4, 0.08, 0.20), worldM, wood, 0.06, rng);
    }
    // Legs
    for (var lx = -0.92; lx <= 0.92; lx += 1.84) {
      for (var lz = -0.22; lz <= 0.22; lz += 0.44) {
        var lm = new THREE.Matrix4().compose(
          new THREE.Vector3(lx, 0.28, lz),
          new THREE.Quaternion(),
          new THREE.Vector3(1, 1, 1)
        );
        var lWorld = new THREE.Matrix4().compose(new THREE.Vector3(x, h, z), q, new THREE.Vector3(1, 1, 1)).multiply(lm);
        gb.add(new THREE.CylinderGeometry(0.045, 0.055, 0.58, 4), lWorld, woodD, 0.05, rng);
      }
    }
  }

  // Bench 1: Near spawn overlooking the blooming meadow and distant lake (Image 5)
  addBench(56, 214, -0.4);
  // Bench 2: Nestled near the bridge entrance & wildflower meadow
  addBench(-48, 122, 0.85);
  // Bench 3: Overlooking the sparkling turquoise ocean shoreline
  addBench(42, 385, 0.15);

  // Rustic wooden posts along sections of the garden path (Image 4)
  var postP = [
    { x: 52, z: 202 }, { x: 44, z: 194 }, { x: 34, z: 184 },
    { x: 20, z: 176 }, { x: 6, z: 164 }, { x: -8, z: 152 },
    { x: -24, z: 136 }, { x: -38, z: 118 },
    { x: 62, z: 242 }, { x: 60, z: 275 }, { x: 54, z: 320 }
  ];
  for (var p = 0; p < postP.length; p++) {
    var pt = postP[p];
    var ph = groundY(pt.x, pt.z) - 0.08;
    gb.add(new THREE.CylinderGeometry(0.07, 0.09, 1.25, 5), M4(pt.x, ph + 0.60, pt.z), woodD, 0.07, rng);
  }

  var mesh = new THREE.Mesh(gb.build(), new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonRamp() }));
  mesh.castShadow = true; mesh.receiveShadow = true;
  scene.add(mesh);
}

var BRIDGE = null;

function bridgeY(x, z) {
  if (!BRIDGE) { return -1e9; }
  var dx = x - BRIDGE.cx, dz = z - BRIDGE.cz;
  var lx = dx * BRIDGE.px + dz * BRIDGE.pz;
  var lz = dx * BRIDGE.tx + dz * BRIDGE.tz;
  if (Math.abs(lz) > BRIDGE.w || Math.abs(lx) > BRIDGE.span * 0.5) { return -1e9; }
  var u = lx / (BRIDGE.span * 0.5);
  return BRIDGE.deck + BRIDGE.rise * (1 - u * u) + 0.17;
}

/* ------------------------------------------------------- downloaded trees
   The models are no longer optional and no longer a comparison mode - see
   natureScatter() above, which is what buildTrees(), buildRocks() and
   buildSunflowers() go through. This is kept because main.js's ?models=1
   hook calls it, and because a one-line answer to "did the assets make it?"
   is worth having in the console. */
function useModelTrees() {
  return natureReady.then(function (lib) {
    if (lib) {
      console.log('[meadow] nature set in use: ' + lib.order.length + ' props' +
        (lib.impostorTex ? ' + impostor atlas' : ' (no impostors)'));
      return lib.order.length;
    }
    console.log('[meadow] nature set unavailable - procedural props in use');
    return 0;
  });
}

export { useModelTrees, setPropLODScale, dumpLODReport, SCATTERED, BRIDGE, FORESTS, blobGeo, bridgeY, broadleafGeo, buildBridge, buildFlowers, buildGardenAccents, buildReeds, buildRocks, buildSunflowers, buildTrees, bushGeo, emitInstances, emitNature, flowerGeo, forestDensity, groundY, natureReady, natureScatter, pineGeo, placeProps, reedGeo, rockGeo, sakuraGeo, scatter, sunflowerGeometry, swayMaterial };
