/* Whispering Meadow - grass.js
   Extracted from the original single file. Logic unchanged. */

import { BEACHPATH, BEACH_BB, BROOK, BROOK_BB, GLSL_COMMON, PI, POOL, RIVER, RIVER_BB, VOLC, WALKPATH, WALK_BB, clamp, commonUniforms, fbm, lerp, mulberry32, pathInfo, scene, shaderMats, smoothstep, terrainHeight, volcanoBare } from './core.js';
import { getTier } from './post.js';
var GT = 36, GR = 4, GM = GR * 2 + 1, GFAR = GT * (GR + 0.5);

/* Ring radius (draw distance, in tiles-out-from-player) and instance density
   per quality tier. HIGH reproduces the original fixed 9x9 grid exactly -
   GR:4 -> GM:9 - so desktop keeps its full meadow. LOW cuts both: a smaller
   grid (fewer tile slots = fewer draw calls and less far-field overdraw) AND
   a lower density multiplier (fewer blades shaded per tile, applied in
   fillGrassTile below). Memory is not the constraint here - GCAP still sizes
   every slot's buffers at the HIGH cap so density can be tuned at runtime
   without rebuilding geometry - fill rate is. */
var GRASS_TIERS = {
  /* A thin meadow reads as a bug, not as a setting - so the DENSITY stays
     where it was and only the reach comes in. The ring is measured in
     36-unit tiles out from the player, so ring 2 is 90 metres and ring 3 is
     126. The phone gets 90, everything else 126, down from 162.
     Blades do not pop out at the edge: the shader shrinks each tuft to
     nothing over the last fifth of the radius (see `fade` below), so
     pulling the radius in moves that dissolve closer rather than putting a
     hard line on the ground. */
  LOW: { ring: 2, density: 0.70 },
  MEDIUM: { ring: 3, density: 0.88 },
  HIGH: { ring: 3, density: 1.0 }
};

/* Why LOW only moved from 0.80 to 0.70, when the phone was the thing being
   fixed: the big saving in this pass was switching the 4-pass glow chain off
   on LOW, where the TIERS table in post.js had been leaving it ON despite its
   own comment. That is worth several times what grass density is worth, and
   DESIGN-AGENT.md is explicit that changes go in one at a time with a
   screenshot - stacking a big win and a speculative one makes it impossible
   to tell which did the work.

   So: grass is the SECOND knob, and this is a conservative turn of it. If a
   phone still misses frame budget after the glow chain is gone, come back
   here before touching the ring - the shader dissolves each tuft over the
   last fifth of the radius, so pulling `ring` in moves that dissolve closer
   rather than drawing a hard line on the ground, but at ring 1 the circle is
   only 54 units and the edge of it becomes visible as you walk. */

var grassDensity = 1.0;

var grassSlots = [], grassQueue = [], grassCam = null, grassMat = null;

var grassTileI = 1e9, grassTileJ = 1e9;

/* how long updateGrass() may spend refilling tiles in one frame */
var GRASS_MS = 2.5;

var TUFT = (function () {
  /* 5 blades instead of 3: geometry is instanced (cheap on this hardware),
     unlike the transparent particle systems, so a fuller silhouette here
     costs almost nothing. Uneven angles/heights/widths so a tuft doesn't
     read as a stamped fan - real clumps are irregular. */
  var pos = [], idx = [];
  var blades = [
    [0.0, 0.0, 0.00, 1.00, 1.00], [2.3, 1.1, 1.15, 0.90, 0.85],
    [-1.6, 2.0, 2.35, 0.82, 0.92], [1.4, -2.1, 3.55, 0.95, 0.78],
    [-2.4, -0.9, 5.05, 0.76, 0.88]
  ];
  for (var b = 0; b < blades.length; b++) {
    var ox = blades[b][0], oz = blades[b][1], a = blades[b][2], hs = blades[b][3], ws = blades[b][4];
    var ca = Math.cos(a), sa = Math.sin(a);
    var base = pos.length / 3;
    var prof = [[-0.62, 0], [0.62, 0], [-0.42, 0.52], [0.42, 0.52], [0, 1]];
    for (var k = 0; k < prof.length; k++) {
      var lx = prof[k][0] * ws, ly = prof[k][1];
      pos.push(lx * ca + ox, ly * hs, lx * sa + oz);
    }
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2, base + 2, base + 3, base + 4);
  }
  return { pos: pos, idx: idx };
})();

function bladeGeometry(cap) {
  var g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(TUFT.pos, 3));
  g.setIndex(TUFT.idx);
  g.setAttribute('aPos', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3));
  g.setAttribute('aRot', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
  g.setAttribute('aScale', new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2));
  g.setAttribute('aCol', new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3));
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
  return g;
}

function grassMaterial() {
  var m = new THREE.ShaderMaterial({
    side: THREE.DoubleSide, fog: false,
    uniforms: commonUniforms({ uFar: { value: GFAR }, uCam: { value: new THREE.Vector3() } }),
    vertexShader: [
      'attribute vec3 aPos; attribute float aRot; attribute vec2 aScale; attribute vec3 aCol;',
      'uniform float uTime; uniform float uFar; uniform vec3 uCam; uniform vec3 uSun;',
      'varying vec3 vCol; varying float vDist;',
      'void main(){',
      '  float hf = position.y;',
      '  float s = sin(aRot), c = cos(aRot);',
      '  vec3 p = vec3(position.x*aScale.y, position.y*aScale.x, position.z*aScale.y);',
      '  vec3 rp = vec3(p.x*c - p.z*s, p.y, p.x*s + p.z*c);',
      '  float w = sin(uTime*1.75 + aPos.x*0.115 + aPos.z*0.132)*0.5 + 0.5;',
      '  float g = sin(uTime*0.38 + aPos.x*0.0125 + aPos.z*0.0102)*0.5 + 0.5;',
      '  float bend = (0.14 + 0.52*g) * (0.35 + 0.65*w) * hf*hf * aScale.x;',
      '  rp.x += bend*0.88; rp.z += bend*0.34;',
      '  float d = distance(aPos, uCam);',
      '  float fade = 1.0 - smoothstep(uFar*0.80, uFar, d);',
      '  vec3 wp = aPos + rp*fade;',
      '  float lit = 0.88 + 0.20*max(dot(normalize(vec3(c,0.55,s)), normalize(uSun)), 0.0);',
      /* painterly vertical gradient: dark, slightly desaturated at the root
         (shadowed, in contact with soil) rising to a brighter, warmer tip
         catching the sun. hf is 0 at base / 1 at tip. Final clamp keeps every
         blade under the ~0.72 albedo ceiling no matter how aCol is tuned. */
      '  float grad = hf*hf*(3.0-2.0*hf);',
      '  vec3 baseShade = aCol*0.34 + vec3(0.02,0.03,0.01);',
      '  vec3 tipShade = aCol*1.15 + vec3(0.03,0.02,-0.02);',
      '  vCol = clamp(mix(baseShade, tipShade, grad) * lit, 0.0, 0.72);',
      /* backlight: blades between you and a low sun glow gold at the tips */
      '  vec3 vd = normalize(wp - uCam);',
      '  float back = pow(max(dot(vd, normalize(uSun)), 0.0), 3.0);',
      '  vCol += vec3(0.55, 0.36, 0.12) * back * grad * 0.55;',
      '  vDist = d;',
      '  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);',
      '}'
    ].join('\n'),
    fragmentShader: [
      'varying vec3 vCol; varying float vDist;',
      GLSL_COMMON,
      'void main(){ gl_FragColor = vec4(applyFog(vCol, vDist), 1.0); }'
    ].join('\n')
  });
  shaderMats.push(m);
  return m;
}

var GCAP = 1150; /* raised from 520: grass is opaque + instanced, so instance
  count is the cheap lever (unlike petals/mist below, which are transparent
  overdraw). Tuft template also went 3->5 blades for the same reason. */

/* Squared gap between a spine's bounding box and this tile's box. A tile is
   36 units across and the water/paths it has to dodge are threaded through a
   1900-unit world, so for the overwhelming majority of tiles the answer is
   "nowhere near" - and that is worth knowing ONCE per tile instead of
   re-deriving it, with a full polyline sweep, for every one of six hundred
   candidate blades. Nothing about which blades survive changes: the box gap
   is a lower bound on the real distance, so a tile that clears it could not
   have had a single blade inside the threshold anyway. */
function boxFar(b, x0, z0, x1, z1, r) {
  var dx = x0 > b.x1 ? x0 - b.x1 : (b.x0 > x1 ? b.x0 - x1 : 0);
  var dz = z0 > b.z1 ? z0 - b.z1 : (b.z0 > z1 ? b.z0 - z1 : 0);
  return dx * dx + dz * dz > r * r;
}

function fillGrassTile(slot, ti, tj) {
  var ring = Math.max(Math.abs(ti - grassTileI), Math.abs(tj - grassTileJ));
  /* ratios (220/620, 110/620) preserved from the original fixed tuning so
     HIGH (density 1.0) fills tiles identically to before tiers existed */
  var cap = Math.max(4, Math.round(GCAP * grassDensity));
  var count = ring <= 1 ? cap : (ring <= 2 ? Math.round(cap * 0.355) : Math.round(cap * 0.177));
  var rng = mulberry32((Math.imul(ti, 73856093) ^ Math.imul(tj, 19349663)) >>> 0);
  var x0 = ti * GT, z0 = tj * GT;
  var g = slot.geo;
  var aPos = g.attributes.aPos.array, aRot = g.attributes.aRot.array;
  var aScale = g.attributes.aScale.array, aCol = g.attributes.aCol.array;

  /* coarse height grid -> cheap slope */
  var SG = 9, step = GT / (SG - 1), gh = slot.gh;
  for (var b = 0; b < SG; b++) {
    for (var a = 0; a < SG; a++) { gh[b * SG + a] = terrainHeight(x0 + a * step, z0 + b * step); }
  }

  /* which of the per-blade exclusion tests can possibly bite in this tile */
  var x1 = x0 + GT, z1 = z0 + GT;
  var doWalk = !boxFar(WALK_BB, x0, z0, x1, z1, 2.7);
  var doBeach = !boxFar(BEACH_BB, x0, z0, x1, z1, 2.7);
  var doRiver = !boxFar(RIVER_BB, x0, z0, x1, z1, 34) && z1 > -360 && z0 < 470;
  var doBrook = !boxFar(BROOK_BB, x0, z0, x1, z1, 14);
  var pcx = POOL.x < x0 ? x0 - POOL.x : (POOL.x > x1 ? POOL.x - x1 : 0);
  var pcz = POOL.z < z0 ? z0 - POOL.z : (POOL.z > z1 ? POOL.z - z1 : 0);
  var doPool = pcx * pcx + pcz * pcz < POOL.r * POOL.r;
  /* `coast` is bounded by +/-65, so north of 350 - 65 the sand term is zero
     however the noise falls and its three octaves need never be evaluated */
  var doSand = z1 > 215;
  /* grass does not grow on the cinder cone. Tested once per tile, since the
     volcano is one object in a 1900-unit world and all but a handful of
     tiles are nowhere near it. */
  var vcx = VOLC.x < x0 ? x0 - VOLC.x : (VOLC.x > x1 ? VOLC.x - x1 : 0);
  var vcz = VOLC.z < z0 ? z0 - VOLC.z : (VOLC.z > z1 ? VOLC.z - z1 : 0);
  var doVolc = vcx * vcx + vcz * vcz < VOLC.r * VOLC.r;
  var n = 0, minY = 1e9, maxY = -1e9;
  for (var k = 0; k < count; k++) {
    var fx = rng(), fz = rng();
    var x = x0 + fx * GT, z = z0 + fz * GT;
    var ga = clamp(Math.floor(fx * (SG - 1)), 0, SG - 2), gb2 = clamp(Math.floor(fz * (SG - 1)), 0, SG - 2);
    var hA = gh[gb2 * SG + ga];
    var sx = (gh[gb2 * SG + ga + 1] - hA) / step, sz = (gh[(gb2 + 1) * SG + ga] - hA) / step;
    var slope = Math.sqrt(sx * sx + sz * sz);
    if (slope > 0.95) continue;
    var h = terrainHeight(x, z);
    if (h < 1.1 || h > 205) continue;
    if (doVolc && volcanoBare(x, z) > 0.30) continue;

    /* keep grass clear of stone walkway and beach path (Images 4 & 5) */
    if (doWalk && pathInfo(WALKPATH, x, z).d < 2.7) continue;
    if (doBeach && pathInfo(BEACHPATH, x, z).d < 2.7) continue;

    var dens = 1.0;
    dens *= 1 - smoothstep(0.42, 0.92, slope);
    dens *= smoothstep(240, 175, h);
    /* sand and shoreline: sparse, pale tufts */
    var sandy = 0;
    if (doSand) {
      var coast = (fbm(x * 0.0032 + 21.7, 8.3, 3) - 0.5) * 130;
      sandy = smoothstep(280, 350, z + coast) * smoothstep(7.5, 2.2, h);
      dens *= (1 - sandy * 0.82);
    }
    /* keep out of the water */
    if (doRiver) {
      var ri = pathInfo(RIVER, x, z);
      if (z > -360 && z < 470 && ri.d < 34 && h < ri.y + 0.5) continue;
      /* Thin it right back along the bank. Water is the most expensive
         surface in the game to shade, and a screen full of river is a
         screen where every blade of grass standing in front of it is being
         drawn ON TOP of that cost rather than instead of it. It also lets
         the soil bank underneath actually show. */
      dens *= 0.14 + 0.86 * smoothstep(30, 62, ri.d);
    }
    if (doBrook) {
      var bi = pathInfo(BROOK, x, z);
      if (bi.d < 14 && h < bi.y + 0.5) continue;
    }
    if (doPool) {
      var pdx = x - POOL.x, pdz = z - POOL.z;
      if (pdx * pdx + pdz * pdz < POOL.r * POOL.r && h < 14.5) continue;
    }
    /* thicker in the low hollows */
    var patch = fbm(x * 0.021 + 5.5, z * 0.021 - 2.2, 3);
    dens *= 0.55 + 0.80 * patch;
    if (rng() > dens) continue;

    /* Tall forest-edge grass: knee to waist high on the little character,
       and tallest right at the path shoulders, where it leans in. */
    var hh = (0.55 + rng() * 0.85) * (0.75 + 0.55 * patch);
    if (sandy > 0.3) hh *= 1.35;
    var tint = fbm(x * 0.013 + 4.2, z * 0.013 - 8.8, 3);
    var dry = smoothstep(0.58, 0.90, fbm(x * 0.0026 + 19.4, z * 0.0026 + 2.1, 3));
    /* deep, cool forest green with olive in it; a little straw in the dry
       patches, never the bright meadow green this used to be */
    var r = lerp(0.16, 0.32, tint), gg = lerp(0.34, 0.54, tint), bb = lerp(0.07, 0.13, tint);
    r = lerp(r, 0.52, dry * 0.35); gg = lerp(gg, 0.56, dry * 0.35); bb = lerp(bb, 0.22, dry * 0.35);
    r = lerp(r, 0.72, sandy * 0.6); gg = lerp(gg, 0.73, sandy * 0.6); bb = lerp(bb, 0.47, sandy * 0.6);
    var f = rng() * 0.20 - 0.05;
    aPos[n * 3] = x; aPos[n * 3 + 1] = h - 0.05; aPos[n * 3 + 2] = z;
    aRot[n] = rng() * PI;
    aScale[n * 2] = hh; aScale[n * 2 + 1] = 0.045 + rng() * 0.055;
    aCol[n * 3] = clamp(r + f, 0, 1); aCol[n * 3 + 1] = clamp(gg + f, 0, 1); aCol[n * 3 + 2] = clamp(bb + f, 0, 1);
    if (h < minY) minY = h; if (h > maxY) maxY = h;
    n++;
    if (n >= GCAP) break;
  }
  g.attributes.aPos.needsUpdate = true;
  g.attributes.aRot.needsUpdate = true;
  g.attributes.aScale.needsUpdate = true;
  g.attributes.aCol.needsUpdate = true;
  g.instanceCount = n;
  if (n === 0) { minY = maxY = 0; }
  g.boundingSphere.center.set(x0 + GT * 0.5, (minY + maxY) * 0.5, z0 + GT * 0.5);
  g.boundingSphere.radius = GT * 0.75 + (maxY - minY) * 0.5 + 3;
  slot.ti = ti; slot.tj = tj;
}

function buildGrassGrid() {
  var gt = GRASS_TIERS[getTier()] || GRASS_TIERS.HIGH;
  GR = gt.ring; GM = GR * 2 + 1; GFAR = GT * (GR + 0.5);
  grassDensity = gt.density;
  grassMat = grassMaterial();
  for (var a = 0; a < GM; a++) {
    for (var b = 0; b < GM; b++) {
      var geo = bladeGeometry(GCAP);
      var mesh = new THREE.Mesh(geo, grassMat);
      mesh.matrixAutoUpdate = false;
      scene.add(mesh);
      grassSlots.push({ geo: geo, mesh: mesh, ti: 1e9, tj: 1e9, a: a, b: b, gh: new Float32Array(81) });
    }
  }
}

function grassSlotTarget(a, ci) {
  var d = (((a - ci) % GM) + GM) % GM;
  if (d > GR) { d -= GM; }
  return ci + d;
}

function updateGrass(px, pz, budget) {
  var ci = Math.floor(px / GT), cj = Math.floor(pz / GT);
  if (ci !== grassTileI || cj !== grassTileJ) {
    grassTileI = ci; grassTileJ = cj;
    grassQueue.length = 0;
    for (var s = 0; s < grassSlots.length; s++) {
      var sl = grassSlots[s];
      var ti = grassSlotTarget(sl.a, ci), tj = grassSlotTarget(sl.b, cj);
      if (sl.ti !== ti || sl.tj !== tj) { grassQueue.push([sl, ti, tj]); }
    }
    /* nearest first */
    grassQueue.sort(function (A, B) {
      var da = Math.abs(A[1] - ci) + Math.abs(A[2] - cj);
      var db = Math.abs(B[1] - ci) + Math.abs(B[2] - cj);
      return da - db;
    });
  }
  if (budget <= 0 || !grassQueue.length) { return; }
  /* Crossing a tile boundary retires a whole row of slots at once - GM of
     them - and at one tile per frame the ring edge stays visibly stale for
     the better part of a fifth of a second while they catch up. Spend a
     fixed slice of the frame instead: enough to clear several tiles when
     they are cheap, and a hard ceiling when they are not, so a boundary
     crossing can never turn into a dropped frame. */
  var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
  do {
    var job = grassQueue.shift();
    fillGrassTile(job[0], job[1], job[2]);
  } while (grassQueue.length &&
    (((window.performance && performance.now) ? performance.now() : Date.now()) - t0) < GRASS_MS);
}

export { GCAP, GFAR, GM, GR, GRASS_TIERS, GT, TUFT, bladeGeometry, buildGrassGrid, fillGrassTile, grassCam, grassDensity, grassMat, grassMaterial, grassQueue, grassSlotTarget, grassSlots, grassTileI, grassTileJ, updateGrass };
