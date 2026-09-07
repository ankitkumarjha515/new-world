/* Whispering Meadow - sky.js
   Extracted from the original single file. Logic unchanged. */

import { GLSL_COMMON, TAU, clamp, commonUniforms, fbm, mulberry32, scene, shaderMats, smoothstep } from './core.js';
var skyMesh;

/* GLSL shared by every hand-written material */

/* ======================================================================== *
 *  SKY
 * ======================================================================== */

function buildSky() {
  var mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: commonUniforms({
      uZenith: { value: new THREE.Color(0x0a3f92) },   /* deeper cobalt overhead - was 0x0d5fbe */
      uMid: { value: new THREE.Color(0x2f86e0) },      /* richer, less washed - was 0x4aa8f0 */
      uHorizon: { value: new THREE.Color(0xd6f2fb) },  /* pale, almost white */
      uWarm: { value: new THREE.Color(0xffe8ba) }
    }),
    vertexShader: [
      'varying vec3 vDir;',
      'void main(){ vDir = normalize(position);',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }'
    ].join('\n'),
    fragmentShader: [
      'uniform vec3 uZenith; uniform vec3 uMid; uniform vec3 uHorizon; uniform vec3 uWarm; uniform vec3 uSun;',
      'varying vec3 vDir;',
      GLSL_COMMON,
      'void main(){',
      '  vec3 d = normalize(vDir);',
      '  float h = d.y;',
      /* both transitions pulled down from the old 0.38/0.78 so the deep
         cobalt owns most of a normal upward glance, not just straight up -
         the reference paintings hold saturated blue well below the zenith */
      '  vec3 col = mix(uHorizon, uMid, smoothstep(-0.02, 0.30, h));',
      '  col = mix(col, uZenith, smoothstep(0.08, 0.56, h));',
      '  col = mix(uHorizon*0.96, col, smoothstep(-0.10, 0.04, h));',
      '  float sd = dot(d, normalize(uSun));',
      '  float sm = max(sd, 0.0);',
      '  col += uWarm * pow(sm, 4.0) * 0.20;',
      '  col += uWarm * pow(sm, 80.0) * 0.48;',
      '  float disc = smoothstep(0.99970, 0.99992, sd);',
      '  col = mix(col, vec3(0.99, 0.97, 0.90), disc * 0.80);',
      '  float band = pow(1.0 - abs(h), 7.0) * (sm*0.45 + 0.55);',
      '  col = mix(col, uWarm, band * 0.24);',
      '  col += (h21(gl_FragCoord.xy) - 0.5) * 0.005;',
      '  gl_FragColor = vec4(col, 1.0);',
      '}'
    ].join('\n')
  });
  skyMesh = new THREE.Mesh(new THREE.SphereGeometry(4600, 40, 24), mat);
  skyMesh.frustumCulled = false;
  skyMesh.renderOrder = -100;
  scene.add(skyMesh);
  shaderMats.push(mat);
}

/* ======================================================================== *
 *  CLOUDS - Towering Makoto Shinkai / Studio Ghibli Cumulus (Nyudougumo)
 * ======================================================================== */

/* Puffs used to be a soft radial blob multiplied by noise - round and fuzzy,
   which reads as a cotton ball, not a cauliflower. Reference cumulus have a
   hard-ish, LOBED silhouette: the edge bulges outward in rounded chunks.
   Perturbing the radius with low-frequency fbm before thresholding produces
   that lobed outline directly, instead of just adding grain to a circle.

   Three variants are packed into one atlas (tiled horizontally) so puffs
   drawn from the same instanced draw call don't all share one identical
   silhouette - cheap (built once at load, not per frame) and still a single
   texture / single draw call, so it costs nothing extra in fill rate. */
/* Built once and shared. The volcano's smoke column wants exactly the same
   lobed silhouette the clouds do, and a second 480x160 canvas for it would
   be pure duplication - three quarters of a megabyte of texture memory for
   a picture we already have. */
var _puffTex = null;

function makePuffTexture(variantCount) {
  if (_puffTex) { return _puffTex; }
  var N = variantCount || 3, S = 160;
  var cv = document.createElement('canvas'); cv.width = S * N; cv.height = S;
  var ctx = cv.getContext('2d');
  var img = ctx.createImageData(S * N, S), d = img.data;
  for (var vi = 0; vi < N; vi++) {
    var sx = vi * 41.3 + 5.2, sy = vi * -23.7 - 2.8;
    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var nx = (x / S - 0.5) * 2, ny = (y / S - 0.5) * 2;
        var r = Math.sqrt(nx * nx + ny * ny);
        var bump = (fbm(nx * 2.05 + sx, ny * 2.05 + sy, 3) - 0.5) * 0.62;
        var a = smoothstep(0.98, 0.60, r - bump);
        var n = fbm(x * 0.07 + sx, y * 0.07 + sy, 3);
        a *= clamp(n * 0.9 + 0.55, 0, 1);
        a = smoothstep(0.30, 0.62, a);
        var px = vi * S + x;
        var i = (y * (S * N) + px) * 4;
        d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = a * 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  var tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;   /* mipmapping would blend across the atlas seams */
  tex.minFilter = THREE.LinearFilter;
  _puffTex = tex;
  return tex;
}

function makeSoftDot(c0, c1) {
  var S = 64;
  var cv = document.createElement('canvas'); cv.width = cv.height = S;
  var ctx = cv.getContext('2d');
  var g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, c0); g.addColorStop(0.42, c1); g.addColorStop(1, 'rgba(255,255,255,0.0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(cv);
}

function buildClouds() {
  var rng = mulberry32(9137);
  var off = [], siz = [], lit = [], spd = [], vary = [];

  // Towering cumulus banks: over the southern ocean and northern mountains
  /* Cumulus read as SHAPES only when there is blue sky between them.
     Keep them far out and modest in size: a puff 800 units wide sitting
     1400 units away fills the whole screen and turns into grey soup.
     Counts trimmed slightly versus the old layout - the gaps between banks
     matter more than the puff count, and it costs less fill rate too. */
  /* Positions AND sizes were all scaled by 0.68 when the world shrank from
     2800 to 1900 units across. Scaling both keeps every bank at exactly the
     angular size and bearing it was hand-tuned to have - the composition from
     the ground is unchanged - while putting them back in proportion to a
     landscape whose mountains are now much closer to the player. */
  var FORMATIONS = [
    { cx:  272, cz:  1836, cy: 422, rad: 258, height: 381, count: 40, scale: 1.10 },
    { cx: -612, cz:  1700, cy: 381, rad: 224, height: 320, count: 31, scale: 0.95 },
    { cx: -204, cz: -1904, cy: 476, rad: 286, height: 435, count: 43, scale: 1.20 },
    { cx: 1088, cz: -1428, cy: 408, rad: 231, height: 326, count: 29, scale: 1.00 },
    { cx: 1768, cz:   272, cy: 367, rad: 204, height: 272, count: 23, scale: 0.90 },
    { cx:-1700, cz:  -408, cy: 394, rad: 218, height: 292, count: 26, scale: 0.95 }
  ];

  for (var f = 0; f < FORMATIONS.length; f++) {
    var F = FORMATIONS[f];
    for (var i = 0; i < F.count; i++) {
      var v = i / (F.count - 1); // 0 (base) to 1 (towering peak)
      var ang = rng() * TAU;
      /* cumulus congestus bulge back out near the crown instead of tapering
         to a point - keeps the top read as a lobed head, not a cone */
      var crown = smoothstep(0.72, 1.0, v) * 0.40;
      var spread = (1.0 - v * 0.55 + crown) * F.rad;
      var px = F.cx + Math.cos(ang) * spread * Math.sqrt(rng());
      var pz = F.cz + Math.sin(ang) * spread * Math.sqrt(rng());
      var py = F.cy + v * F.height + (rng() - 0.5) * 80;
      /* explicit cap: a puff over ~250 units stops reading as a discrete
         shape and starts reading as grey soup at these distances */
      var s = Math.min(250, (80 + rng() * 90 + v * 55) * F.scale);
      off.push(px, py, pz);
      siz.push(s, s * (0.62 + rng() * 0.30));
      var l = clamp(0.30 + v * 0.62 + (rng() - 0.5) * 0.14, 0, 1);
      lit.push(l);
      spd.push(1.4 + rng() * 1.2);
      vary.push(Math.floor(rng() * 3));
    }
  }

  /* a handful of small stray puffs drifting alone in the gaps between banks -
     every reference painting has a few of these; without them the sky reads
     as "six clumps" instead of a sky with clouds scattered through it */
  var STRAYS = 26;
  for (var j = 0; j < STRAYS; j++) {
    var sang = rng() * TAU;
    var sr = 1200 + rng() * 1600;
    var sx = Math.cos(sang) * sr, sz = Math.sin(sang) * sr;
    var sy = 420 + rng() * 260;
    var ss = 45 + rng() * 55;
    off.push(sx, sy, sz);
    siz.push(ss, ss * (0.55 + rng() * 0.25));
    lit.push(clamp(0.55 + (rng() - 0.5) * 0.30, 0, 1));
    spd.push(1.2 + rng() * 1.4);
    vary.push(Math.floor(rng() * 3));
  }

  var g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.setAttribute('aOffset', new THREE.InstancedBufferAttribute(new Float32Array(off), 3));
  g.setAttribute('aSize', new THREE.InstancedBufferAttribute(new Float32Array(siz), 2));
  g.setAttribute('aLit', new THREE.InstancedBufferAttribute(new Float32Array(lit), 1));
  g.setAttribute('aSpd', new THREE.InstancedBufferAttribute(new Float32Array(spd), 1));
  g.setAttribute('aVar', new THREE.InstancedBufferAttribute(new Float32Array(vary), 1));
  g.instanceCount = lit.length;

  var mat = new THREE.ShaderMaterial({
    /* OPAQUE. Anime skies do not need see-through clouds - the whole look is
       flat shapes with hard edges - and see-through is the expensive part:
       141 large cards, each one blending itself into everything already
       drawn behind it, over a big share of the screen. Cutting the
       silhouette with a discard instead of fading it with alpha means the
       hardware can throw away half of every card before it shades it, and
       nothing has to be blended at all.
       depthWrite stays OFF, deliberately. The composite pass reads scene
       depth to decide how much aerial haze to add, and it treats far-plane
       depth as "this is sky, leave it alone". Letting clouds write depth
       would put them at 1000-3000 units and haze them into pale blue soup. */
    transparent: false, depthWrite: false, side: THREE.DoubleSide, fog: false,
    uniforms: commonUniforms({
      uMap: { value: makePuffTexture(3) },
      /* THREE shades, not two. Flat white cloud reads as paper; what makes
         a painted cumulus look solid is a lit top, a mid tone on the
         shoulder and a properly grey underside, with hard steps between
         them rather than a gradient. */
      uDark: { value: new THREE.Color(0x8d97a6) },
      uMid: { value: new THREE.Color(0xc4ccd8) },
      uWarm: { value: new THREE.Color(0xfff1dd) },
      uLight: { value: new THREE.Color(0xf8fafd) }
    }),
    vertexShader: [
      'attribute vec3 aOffset; attribute vec2 aSize; attribute float aLit; attribute float aSpd; attribute float aVar;',
      'uniform float uTime;',
      'varying vec2 vUv; varying float vLit; varying float vDist;',
      'void main(){',
      '  vUv = vec2((uv.x + aVar) / 3.0, uv.y); vLit = aLit;',
      '  vec3 o = aOffset;',
      '  o.x = mod(o.x + uTime*aSpd + 6000.0, 12000.0) - 6000.0;',
      '  vec3 rgt = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);',
      '  vec3 upv = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);',
      '  vec3 wp = o + rgt*position.x*aSize.x + upv*position.y*aSize.y;',
      '  vec4 mv = viewMatrix * vec4(wp, 1.0);',
      '  vDist = -mv.z;',
      '  gl_Position = projectionMatrix * mv;',
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform sampler2D uMap; uniform vec3 uDark; uniform vec3 uMid; uniform vec3 uWarm; uniform vec3 uLight;',
      'varying vec2 vUv; varying float vLit; varying float vDist;',
      GLSL_COMMON,
      'void main(){',
      '  float a = texture2D(uMap, vUv).a;',
      /* the silhouette is a hard cut now, not a fade. 0.45 sits in the
         middle of the puff texture's own edge ramp, so the lobed cauliflower
         shape it was drawn with survives intact - what goes is the soft
         feathering that was costing a blend on every edge pixel. */
      '  if(a < 0.45) discard;',
      /* tight banded step instead of the old wide 0.28-0.46 fade - the same
         "flat rungs, no gradient" logic as the ground toon ramp, so a top
         reads as a distinct sunlit shape against a separate shaded base
         instead of one shape gently dimming into another */
      '  float cel = smoothstep(0.26, 0.36, vLit);',
      '  float cel2 = smoothstep(0.54, 0.66, vLit);',
      '  vec3 col = mix(uDark, uMid, cel);',
      '  col = mix(col, uLight, cel2);',
      /* hot core only on the lit (cel) side - keeps undersides a flat dark
         shape instead of glowing the same as the tops */
      '  col = mix(col, uLight, pow(a, 2.2) * 0.26 * cel2);',
      '  float rim = pow(clamp(1.0 - abs(vLit - 0.68) * 1.5, 0.0, 1.0), 3.0) * (1.0 - a);',
      '  col = mix(col, uWarm, rim * 0.42 * cel2);',
      '  col = applyFog(col, vDist*0.38);',
      '  gl_FragColor = vec4(col, 1.0);',
      '}'
    ].join('\n')
  });
  var m = new THREE.Mesh(g, mat);
  m.frustumCulled = false;
  m.renderOrder = -50;
  scene.add(m);
  shaderMats.push(mat);
}

/* ======================================================================== *
 *  TERRAIN
 * ======================================================================== */

export { buildClouds, buildSky, makePuffTexture, makeSoftDot, skyMesh };
