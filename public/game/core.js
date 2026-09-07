/* Whispering Meadow - core.js
   Extracted from the original single file. Logic unchanged. */
var PI = Math.PI, TAU = PI * 2, DEG = PI / 180;

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

function lerp(a, b, t) { return a + (b - a) * t; }

function smoothstep(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* value noise -------------------------------------------------------------- */

function hash2(i, j) {
  var n = Math.imul(i, 374761393) + Math.imul(j, 668265263);
  n = Math.imul(n ^ n >>> 13, 1274126177);
  n = n ^ n >>> 16;
  return (n >>> 0) / 4294967296;
}

function vnoise(x, y) {
  var xi = Math.floor(x), yi = Math.floor(y);
  var xf = x - xi, yf = y - yi;
  var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  var a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x, y, oct) {
  oct = oct || 4;
  var s = 0, amp = 0.5, f = 1, norm = 0;
  for (var i = 0; i < oct; i++) {
    s += amp * vnoise(x * f + i * 17.31, y * f - i * 11.77);
    norm += amp; amp *= 0.5; f *= 2.03;
  }
  return s / norm;
}

function ridged(x, y, oct) {
  var s = 0, amp = 0.5, f = 1, norm = 0;
  for (var i = 0; i < oct; i++) {
    var n = 1 - Math.abs(vnoise(x * f + i * 5.13, y * f + i * 9.41) * 2 - 1);
    s += amp * n * n; norm += amp; amp *= 0.5; f *= 2.07;
  }
  return s / norm;
}

/* ------------------------------------------------------------- world shape */

var SEA = 0;                       // sea level

var WORLD = 1900, WSEG = 304;      // terrain plate size / resolution
/* Shrunk from 2800/384. The landmarks - waterfall, river, beach, sunflower
   field - always lived inside roughly +/-400, so the outer 1000 units were
   empty meadow you had to cross to reach anything. Cutting the plate pulls
   the mountains in to frame the view instead of sitting on the horizon, and
   the finer WSEG spacing (6.25 units/quad vs 7.3) means the smaller world is
   also a more detailed one at a slightly LOWER vertex count.
   WSEG MUST STAY DIVISIBLE BY 8: terrain.js splits the plate into an 8x8
   grid of chunks (`seg = WSEG / CH`). A remainder there gives fractional
   vertex indices, which makes every position NaN and the ground vanishes
   to black with nothing but a boundingSphere warning to show for it. */

var HALF = WORLD / 2;

/* the river: authored spine, x/z with the height of its WATER SURFACE */

var RIVER = [
  { x: -240, z: -352, y: 14.0 },
  { x: -216, z: -262, y: 13.1 },
  { x: -178, z: -158, y: 11.7 },
  { x: -130, z: -50, y: 10.1 },
  { x: -80, z: 68, y: 8.1 },
  { x: -32, z: 188, y: 5.6 },
  { x: 14, z: 302, y: 3.0 },
  { x: 48, z: 406, y: 0.9 },
  { x: 68, z: 502, y: -0.8 },
  { x: 84, z: 630, y: -1.6 }
];

/* the little brook on top of the plateau that feeds the fall */

var BROOK = [
  { x: -300, z: -520, y: 136.0 },
  { x: -276, z: -470, y: 134.4 },
  { x: -254, z: -428, y: 132.9 },
  { x: -240, z: -392, y: 132.0 }
];

/* the garden stone walkway winding through the meadow and across the bridge */

var WALKPATH = [
  { x: 60, z: 205 },
  { x: 38, z: 190 },
  { x: 10, z: 172 },
  { x: -16, z: 148 },
  { x: -42, z: 115 },
  { x: -56, z: 76 },
  { x: -44, z: 32 },
  { x: -14, z: -6 },
  { x: 36, z: -14 },
  { x: 102, z: 8 },
  { x: 172, z: 30 },
  { x: 232, z: 42 }
];

/* stone path branching down to the turquoise beach */

var BEACHPATH = [
  { x: 60, z: 205 },
  { x: 64, z: 250 },
  { x: 58, z: 300 },
  { x: 52, z: 355 },
  { x: 46, z: 410 },
  { x: 38, z: 470 }
];

function pathInfo(path, x, z) {
  var best = 1e9, by = 0;
  for (var i = 0; i < path.length - 1; i++) {
    var a = path[i], b = path[i + 1];
    var dx = b.x - a.x, dz = b.z - a.z;
    var t = clamp(((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz), 0, 1);
    var px = a.x + dx * t, pz = a.z + dz * t;
    var ddx = x - px, ddz = z - pz;
    var d = Math.sqrt(ddx * ddx + ddz * ddz);
    if (d < best) { best = d; by = a.y + (b.y - a.y) * t; }
  }
  return { d: best, y: by };
}

/* ------------------------------------------------------------- path bounds
   pathInfo() walks every segment of a spine and is the hottest function in
   the whole engine: terrainHeight() calls it twice, siteInfo() calls it
   twice more on top of THREE terrainHeight() calls, and fillGrassTile()
   calls it four times per candidate blade. Almost every one of those calls
   is made about a point hundreds of units away from the water, where the
   answer is only ever compared against a threshold of 12 to 150.

   pathFar() is the cheap conservative reject: the distance from the point
   to the spine's axis-aligned bounding box is a LOWER BOUND on the distance
   to the spine itself, so if that bound already exceeds the threshold the
   real answer cannot be under it and the walk can be skipped entirely.
   Nothing about the result changes - only work that could not have altered
   an outcome is removed. Boxes are derived from the arrays at load, so they
   cannot drift out of step with a hand-edited spine. */
function pathBounds(path) {
  var b = { x0: 1e9, x1: -1e9, z0: 1e9, z1: -1e9 };
  for (var i = 0; i < path.length; i++) {
    if (path[i].x < b.x0) { b.x0 = path[i].x; }
    if (path[i].x > b.x1) { b.x1 = path[i].x; }
    if (path[i].z < b.z0) { b.z0 = path[i].z; }
    if (path[i].z > b.z1) { b.z1 = path[i].z; }
  }
  return b;
}

function pathFar(b, x, z, r) {
  var dx = x < b.x0 ? b.x0 - x : (x > b.x1 ? x - b.x1 : 0);
  var dz = z < b.z0 ? b.z0 - z : (z > b.z1 ? z - b.z1 : 0);
  return dx * dx + dz * dz > r * r;
}

var RIVER_BB = pathBounds(RIVER);
var BROOK_BB = pathBounds(BROOK);
var WALK_BB = pathBounds(WALKPATH);
var BEACH_BB = pathBounds(BEACHPATH);

var CLIFF_S = -377, CLIFF_N = -395;   // the great cliff wall lives between these

/* the cliff meanders - except right at the fall, where the geometry is hand-fitted */

function cliffWave(x) {
  var damp = 1 - smoothstep(190, 45, Math.abs(x + 240));
  return ((vnoise(x * 0.0026 + 318.9, 2.7) - 0.5) * 140 +
          (vnoise(x * 0.0094 + 7.1, 5.5) - 0.5) * 46 +
          (vnoise(x * 0.031 + 2.4, 9.1) - 0.5) * 12) * damp;
}

function cliffCrest(x) {
  /* `damp` keeps the crest flat right at the waterfall so the fall still has
     a clean lip; everywhere else we want it RAGGED. A flat-topped cliff reads
     as a fence across the horizon, which is the single worst thing in frame.
     The ridged term adds angular peaks so the mountains behind show through
     the low spots, the way they do in the reference paintings. */
  var damp = 1 - smoothstep(210, 55, Math.abs(x + 240));
  var rolling = (vnoise(x * 0.0040 + 17.9, 8.4) - 0.5) * 104 +
                (vnoise(x * 0.0135 + 3.6, 1.9) - 0.5) * 34;
  var peaks = (ridged(x * 0.0062 + 51.3, 4.2, 3) - 0.42) * 58;
  return 118 + (rolling + peaks) * damp;
}

var POOL = { x: -240, z: -352, r: 40 };

/* ======================================================================== *
 *  THE VOLCANO
 *
 *  The big mountain on the sunflower field's side. It is not a model and it
 *  is not a texture - it is nine lines of arithmetic inside terrainHeight()
 *  below, so it weighs nothing to download, nothing to keep in memory, and
 *  it is bit-identical in every player's browser for free, exactly like the
 *  cliff and the river.
 *
 *  Placement is not arbitrary. It sits east-south-east of the sunflower
 *  field at about 540 units, which puts its summit around 33 degrees above
 *  the horizon from the middle of the field - dominant in frame without
 *  needing to be tall enough to dwarf the northern range. It is far enough
 *  from the natural peak at (875, -160) that the two do not stack into one
 *  lumpy mass, and its southern skirt runs out into the shoreline instead
 *  of stopping dead, which is what puts its foot in the sea.
 * ======================================================================== */
var VOLC = { x: 760, z: 175, r: 360, rise: 300, base: 120, crater: 34, depth: 58, lip: 16 };

/* Height the cone adds at `r` units from the axis. `dx`/`dz` are the same
   offset uncomposed, used only for the gullies.

   The profile is pow(1 - t, 1.3): a slope of about 45 degrees at the summit
   easing to flat where it meets the range, which is the silhouette a
   stratovolcano has and, more to the point, the one in the reference. Both
   ends matter - the exponent being above 1 is what makes the derivative
   fall to zero at the foot, so the cone joins the existing terrain without
   a crease no amount of colour work could hide.

   The gullies are sampled on the UNIT direction rather than on an angle.
   atan2 has a seam at +/-pi and noise sampled across it would draw a hard
   line straight down one flank; a direction vector closes the circle for
   free. They cost one vnoise, and they are what the lava channels in the
   ground shader follow downhill. */
function volcanoProfile(r, dx, dz) {
  var t = r / VOLC.r;
  var cone = VOLC.rise * Math.pow(1 - t, 1.3);
  var inv = 1 / (r > 0.001 ? r : 0.001);
  var flute = (vnoise(dx * inv * 6.4 + 41.3, dz * inv * 6.4 - 17.9) - 0.5) *
              18 * smoothstep(0.10, 0.34, t) * (1 - t);
  /* the crater: a bowl scooped out inside a raised rim. The rim is a
     Lorentzian ring rather than a Gaussian one - same shape to the eye, and
     it costs a divide instead of an exp on every vertex of the plate. */
  var bowl = VOLC.depth * (1 - smoothstep(VOLC.crater * 0.30, VOLC.crater, r));
  var q = (r - VOLC.crater) / (VOLC.crater * 0.55);
  var lip = VOLC.lip / (1 + q * q);
  return cone + flute + lip - bowl;
}

/* How volcanic a spot is: 0 out on the green apron, 1 on bare cinder.
   ONE definition, shared by the ground colour (terrain.js), the scatterers
   and the grass - because three separate guesses at where the treeline sits
   is three chances for a pine to end up standing in a lava channel. Driven
   by radius rather than height so it follows the cone instead of drawing a
   level contour round it, and roughened by a low-frequency noise so the
   edge wanders the way a real treeline does.

   Cheap where it matters: outside the cone it costs two multiplies and a
   compare, which is what every scatter test in the world will pay. */
function volcanoBare(x, z) {
  var dx = x - VOLC.x, dz = z - VOLC.z;
  var d2 = dx * dx + dz * dz;
  if (d2 > VOLC.r * VOLC.r) { return 0; }
  var t = Math.sqrt(d2) / VOLC.r;
  var edgeN = (fbm(x * 0.0075 + 13.1, z * 0.0075 - 7.7, 3) - 0.5) * 0.22;
  /* Bare almost to the foot. The first pass put the treeline at 0.5 of the
     radius, which sounds like halfway down and is not: the cone profile is
     pow(1-t, 1.3), so half the RADIUS is already four fifths of the way up
     the HEIGHT, and the mountain came out green over its whole lower half.
     0.74 puts the treeline near the bottom, where the reference has it.
     The second smoothstep is not decoration - it forces the mask to zero
     exactly where the radius guard above cuts it off, so a positive noise
     offset cannot leave a step in the colour at the edge of the cone. */
  return smoothstep(0.96 + edgeN, 0.74 + edgeN, t) * smoothstep(1.0, 0.90, t);
}

/* the one true height function - used by the mesh, the player, and by every
   blade of grass that has to decide whether it may grow. */

function terrainHeight(x, z) {
  /* rolling meadow */
  var h = 8
    + (fbm(x * 0.0018 + 11.3, z * 0.0018 - 4.7, 4) - 0.5) * 30
    + (fbm(x * 0.0075 + 3.1, z * 0.0075 + 7.9, 3) - 0.5) * 7
    + (fbm(x * 0.028 + 21.4, z * 0.028 - 6.6, 2) - 0.5) * 1.7;

  /* the northern plateau, ending in a sheer cliff */
  var cw = cliffWave(x);
  var cm = smoothstep(CLIFF_S + cw, CLIFF_N + cw, z);
  /* cliffCrest() is five octaves of noise and it is multiplied by cm. South
     of the wall cm is exactly 0, which is most of the map, and 0 * anything
     finite is 0 - so the whole term can be skipped there rather than
     computed and thrown away. Identical output, by construction. */
  if (cm > 0) { h = h * (1 - 0.55 * cm) + cliffCrest(x) * cm; }

  /* far mountains: north, and two flanking ranges east and west */
  /* Both ranges moved in with the shrinking plate. The northern range now
     starts rising just behind the cliff crest instead of 225 units past it,
     which is what closes the dead gap that made the waterfall wall read as a
     fence with nothing behind it. */
  var mm = smoothstep(-430, -880, z);
  var ms = smoothstep(520, 900, Math.abs(x));
  var mMask = clamp(mm + ms * 0.95, 0, 1);
  if (mMask > 0.001) {
    var r = ridged(x * 0.0011 + 5.5, z * 0.0011 - 2.2, 5);
    h += mMask * (55 + 580 * r * r);
    h += mMask * (fbm(x * 0.009, z * 0.009, 3) - 0.5) * 34;
  }

  /* the volcano, raised on top of whatever the range was already doing here
     - a real cone is built on the ground it erupted through, not instead of
     it. Placed BEFORE the coast on purpose, so the shoreline below can eat
     its southern skirt rather than the skirt paving over the sea. */
  var vdx = x - VOLC.x, vdz = z - VOLC.z;
  var vd2 = vdx * vdx + vdz * vdz;
  if (vd2 < VOLC.r * VOLC.r) {
    var vd = Math.sqrt(vd2);
    /* Level the ground the cone stands on before raising it. The eastern
       range climbs about a hundred units across this footprint, and a cone
       added straight on top of that tilt comes out with one flank buried
       and a crater that pours out of its low side - the summit ends up
       forty units off-axis instead of ringing the vent. Flattening most of
       the way toward a single base height first is what buys a level rim
       and a crater that holds. It is not fully flattened: the last fifth of
       the underlying shape survives, so the apron still remembers which way
       the range was going. */
    var vm = smoothstep(VOLC.r, VOLC.r * 0.55, vd) * 0.82;
    h = h * (1 - vm) + VOLC.base * vm;
    h += volcanoProfile(vd, vdx, vdz);
  }

  /* the coast: a wandering shoreline in the south.
     `coast` is bounded by +/-54 (fbm returns 0..1, scaled by 108 about its
     midpoint), so north of z = 330 - 54 the shoreline term is exactly zero
     no matter what the noise says - and the noise need not be evaluated. */
  if (z > 276) {
    var coast = (fbm(x * 0.0032 + 21.7, 8.3, 3) - 0.5) * 108;
    var zc = z + coast;
    var beach = smoothstep(330, 452, zc);
    h = h * (1 - beach) + (-2.6) * beach;
    var deep = smoothstep(458, 830, zc);
    h = h * (1 - deep) + (-72) * deep;
  }

  /* the brook on the plateau - skipped outright once the bounding box says
     the answer cannot possibly land under 90 (see pathFar above) */
  if (!pathFar(BROOK_BB, x, z, 90)) {
    var bi = pathInfo(BROOK, x, z);
    if (bi.d < 90) {
      var bbed = bi.y - 2.0;
      var bprof = bbed + Math.min(9, Math.max(0, bi.d - 5) * 0.6);
      var bw = smoothstep(90, 14, bi.d) * smoothstep(-380 + cw, -400 + cw, z);
      h = h * (1 - bw) + bprof * bw;
    }
  }

  /* the river valley */
  if (!pathFar(RIVER_BB, x, z, 150)) {
    var ri = pathInfo(RIVER, x, z);
    if (ri.d < 150) {
      var bed = ri.y - 2.6;
      var prof = bed + Math.min(10, Math.max(0, ri.d - 17) * 0.5);
      var w = smoothstep(150, 30, ri.d)
        * smoothstep(-396 + cw, -352, z)  // do not eat into the cliff
        * smoothstep(505, 395, z);      // let the mouth dissolve into the sea
      h = h * (1 - w) + prof * w;
    }
  }

  /* the plunge pool under the waterfall */
  var pdx = x - POOL.x, pdz = z - POOL.z;
  var pd = Math.sqrt(pdx * pdx + pdz * pdz);
  if (pd < 58) {
    var pw = smoothstep(58, 22, pd) * smoothstep(-388 + cw, -374 + cw, z);
    var pbed = 10.2 + (fbm(x * 0.045 + 6.1, z * 0.045 - 2.3, 2) - 0.5) * 1.8;
    h = h * (1 - pw) + pbed * pw;
  }
  return h;
}

/* cheap slope estimate */

function terrainSlope(x, z) {
  var e = 2.0;
  var hx = terrainHeight(x + e, z) - terrainHeight(x - e, z);
  var hz = terrainHeight(x, z + e) - terrainHeight(x, z - e);
  return Math.sqrt(hx * hx + hz * hz) / (2 * e);
}

/* where the cliff wall's crown sits, for any x */

function wallTop(x) { return terrainHeight(x, CLIFF_N - 1 + cliffWave(x)) + 0.6; }

/* the profile the cliff face (and the falling water) follows, v: 0 top -> 1 bottom */

function cliffZ(v) { return CLIFF_N + 18 * smoothstep(0.0, 0.16, v); }

/* ======================================================================== *
 *  ENGINE STATE
 * ======================================================================== */

var renderer, scene, camera, clock;

/* Fog is exponential in DISTANCE, so shrinking the world by 0.68 without
   touching the density would have quietly removed a third of the aerial
   perspective - the one cue the reference paintings lean on hardest.
   Both constants are divided by 0.68 to hold the haze at a given
   fraction-of-the-world constant. */
var SUN, SUNCOL, FOGCOL, FOGDENS = 0.00074;

var sunLight;

var timeU = { value: 0 };           // shared clock uniform

var shaderMats = [];

/* ---------------------------------------------------------------- toon ramp
   The anime look comes from light landing in a few flat steps instead of a
   smooth fade. This little 1-pixel-tall texture is the ladder: three rungs,
   sampled with NEAREST so there is no blending between them.

   It is also FASTER than smooth shading on a laptop with no graphics card,
   which is why the art direction and the performance budget agree here. */
var _toonRamp = null;
function toonRamp() {
  if (_toonRamp) { return _toonRamp; }
  /* deep cool shadow -> mid -> bright, then a hot rim step */
  var d = new Uint8Array([150, 168, 202, 255,
                          198, 206, 196, 255,
                          238, 238, 220, 255,
                          255, 255, 252, 255]);
  var t = new THREE.DataTexture(d, 4, 1, THREE.RGBAFormat);
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  _toonRamp = t;
  return t;
}

/* Every solid surface in the world is built through this, so the whole scene
   shares one lighting model. Swap the ramp above and everything follows. */
function toonMaterial(opts) {
  opts = opts || {};
  var m = new THREE.MeshToonMaterial({
    vertexColors: opts.vertexColors !== false,
    gradientMap: toonRamp(),
    side: opts.side || THREE.FrontSide
  });
  return m;
}

/* ------------------------------------------------------------- rim light
   The bright fringe where sunlight wraps around the edge of a leaf. Every
   cel-shaded game does this (Genshin, Breath of the Wild) because banded
   lighting alone leaves objects looking like flat cutouts - the rim is what
   puts them back in the air. Costs a dot product and a pow. */
function withRim(m, amt, col) {
  var prev = m.onBeforeCompile;
  m.onBeforeCompile = function (sh) {
    if (prev) { prev.call(this, sh); }
    sh.uniforms.uRimCol = { value: new THREE.Color(col === undefined ? 0xffe9bd : col) };
    sh.uniforms.uRimAmt = { value: amt === undefined ? 0.42 : amt };
    sh.fragmentShader = 'uniform vec3 uRimCol;\nuniform float uRimAmt;\n' +
      sh.fragmentShader.replace(
        '#include <dithering_fragment>',
        '  float _rim = 1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0);\n' +
        '  gl_FragColor.rgb += uRimCol * pow(_rim, 2.6) * uRimAmt;\n' +
        '#include <dithering_fragment>'
      );
  };
  m.customProgramCacheKey = function () { return 'rim' + (amt === undefined ? 0.42 : amt); };
  m.needsUpdate = true;
  return m;
}

function commonUniforms(extra) {
  var u = {
    uTime: timeU,
    uSun: { value: SUN },
    uSunCol: { value: SUNCOL },
    uFogCol: { value: FOGCOL },
    uFogDens: { value: FOGDENS }
  };
  if (extra) { for (var k in extra) { u[k] = extra[k]; } }
  return u;
}

var GLSL_COMMON = [
  'uniform vec3 uFogCol; uniform float uFogDens;',
  'vec3 applyFog(vec3 c, float d){',
  '  float f = 1.0 - exp(-d*d*uFogDens*uFogDens);',
  '  return mix(c, uFogCol, clamp(f,0.0,1.0));',
  '}',
  'float h21(vec2 p){ p = fract(p*vec2(123.34,345.45)); p += dot(p,p+34.345); return fract(p.x*p.y); }',
  'float vn(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);',
  '  float a=h21(i), b=h21(i+vec2(1.0,0.0)), c=h21(i+vec2(0.0,1.0)), d=h21(i+vec2(1.0,1.0));',
  '  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y); }',
  'float fbm2(vec2 p){ float s=0.0,a=0.5; for(int i=0;i<5;i++){ s+=a*vn(p); p=p*2.03+11.7; a*=0.5;} return s; }',
  'float fbm3(vec2 p){ float s=0.0,a=0.5; for(int i=0;i<3;i++){ s+=a*vn(p); p=p*2.11+5.3; a*=0.5;} return s; }'
].join('\n');

var _m4 = null, _q = null, _e = null, _v3 = null, _pv = null;

function initEngine() {
  THREE.ColorManagement.enabled = false;
  SUN = new THREE.Vector3(0.30, 0.40, 0.865).normalize();
  SUNCOL = new THREE.Color(0xfff0c8);
  FOGCOL = new THREE.Color(0xbfe6f5);
  FOGDENS = 0.00062;
  _m4 = new THREE.Matrix4(); _q = new THREE.Quaternion();
  _e = new THREE.Euler(); _v3 = new THREE.Vector3(); _pv = new THREE.Vector3();

  renderer = new THREE.WebGLRenderer({ antialias: false, stencil: false, powerPreference: 'high-performance' });
  /* This cap is why the phone looked so much worse than the laptop, and it
     had nothing to do with the quality tiers. A laptop reports a pixel ratio
     of 1, so it was never capped at all. A phone reports 2.6 to 3.5, so it
     was rendering at barely a third of the linear resolution of its own
     screen and letting the browser upscale the difference - which is exactly
     what "blurry" looks like. 2.0 is where the returns flatten on a screen
     held at arm's length, and it is what shipped games settle on; going to a
     true 3.0 would cost 2.25x the pixels for a difference nobody can see. */
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2.0));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  /* SHADOWS ARE OFF, EVERYWHERE. They were the most expensive single thing
     in the frame: a 1536x1536 depth map - larger than a phone's whole
     screen - redrawn every frame from every casting object, and then the
     soft filter made every lit pixel in the world sample that map several
     times over. Turning the map off here also strips the shadow sampling
     out of every compiled shader, so the saving is paid twice.

     The per-object castShadow / receiveShadow flags in props.js and
     terrain.js are deliberately LEFT ALONE. They cost nothing while the map
     is off, and they mean shadows can be brought back by flipping this line
     and sunLight.castShadow below - two lines, not a hunt through every
     scatter in the world. */
  renderer.shadowMap.enabled = false;
  renderer.autoClear = true;
  document.getElementById('app').appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(FOGCOL, FOGDENS);
  camera = new THREE.PerspectiveCamera(68, window.innerWidth / window.innerHeight, 0.35, 5200);
  clock = new THREE.Clock();

  /* All three lights down about a tenth. Removing the shadows took the only
     genuinely dark surfaces out of the world, and what was a balanced
     midday before that came out glaring without them - nothing to fall in
     shade any more, so every surface sits near its lit value. Trimmed
     together rather than just the sun, so the ratio between direct light
     and sky fill is unchanged and the meadow does not go flat. */
  sunLight = new THREE.DirectionalLight(0xfff4d2, 1.75);
  sunLight.castShadow = false;
  /* A directional light has no position, only a DIRECTION - position minus
     target. The pair used to be dragged along behind the player every
     single frame, but that was never about the lighting: it was to keep the
     shadow camera's 176-unit box centred on wherever you were standing.
     With no shadow camera to aim there is nothing left to follow, so the
     sun is placed once, here, and never touched again. */
  sunLight.position.set(SUN.x * 400, SUN.y * 400, SUN.z * 400);
  sunLight.target.position.set(0, 0, 0);
  scene.add(sunLight);
  scene.add(sunLight.target);
  /* low fill is what gives anime art its crisp light/shade split */
  scene.add(new THREE.HemisphereLight(0x9fd4ff, 0x6fae44, 1.28));
  scene.add(new THREE.AmbientLight(0xa8d0ee, 0.41));
}

export { withRim, toonRamp, toonMaterial, VOLC, volcanoBare, volcanoProfile, BEACHPATH, BEACH_BB, BROOK, BROOK_BB, CLIFF_N, CLIFF_S, DEG, FOGCOL, FOGDENS, GLSL_COMMON, HALF, PI, POOL, RIVER, RIVER_BB, SEA, SUN, SUNCOL, TAU, WALKPATH, WALK_BB, WORLD, WSEG, _e, _m4, _pv, _q, _v3, camera, clamp, cliffCrest, cliffWave, cliffZ, clock, commonUniforms, fbm, hash2, initEngine, lerp, mulberry32, pathBounds, pathFar, pathInfo, renderer, ridged, scene, shaderMats, smoothstep, sunLight, terrainHeight, terrainSlope, timeU, vnoise, wallTop };
