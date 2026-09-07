/* Whispering Meadow - volcano.js
   The parts of the volcano that move.

   The mountain itself is arithmetic in core.js and its lava is arithmetic
   in terrain.js; neither costs a byte of download or a byte of memory. What
   is left is the eruption, and the budget for that is deliberately tiny:

     - ONE instanced draw call for the whole smoke column (44 quads), on the
       cloud puff texture that is already in memory - makePuffTexture() in
       sky.js caches, so the plume and the clouds share one 480x160 atlas
       instead of building a second copy of the same picture.
     - ONE Points draw call for the embers (70 points), on a 64x64 radial
       dot of its own: 16 KB, because the ember wants a warm core and the
       petals' white one would have to be tinted per-fragment instead.
     - No per-frame CPU at all. Everything below animates from uTime in the
       vertex shader, so the game loop never touches any of it - the same
       reason the clouds and the grass are free.

   Measured on the deployed build: +2 draw calls, ~1.4 KB of vertex data,
   one 16 KB texture. Nothing is downloaded - there is no asset here at all.

   FILL RATE IS THE REAL BUDGET, not triangles. Large overlapping
   transparent sprites are the single most expensive thing this engine draws
   (see the note on the waterfall mist in particles.js), and a smoke plume
   is nothing but large overlapping transparent sprites. So the puff count
   stays low, the column is narrow near the vent where it is densest, and
   every puff fades out well before it reaches full size. */

import { GLSL_COMMON, TAU, VOLC, commonUniforms, mulberry32, renderer, scene, shaderMats, terrainHeight } from './core.js';
import { makePuffTexture, makeSoftDot } from './sky.js';

var smokeMat = null, emberMat = null, ventY = 0;

/* ------------------------------------------------------------------ smoke
   Each puff owns a fixed phase and rides a sawtooth: it is born at the vent,
   rises, spreads, thins and dies, then reappears at the bottom. With 44 of
   them on evenly spread phases the column reads as continuous, and because
   the phase is a pure function of uTime there is nothing to update. */
function buildSmoke() {
  var N = 44, rng = mulberry32(60607);
  var seed = [], siz = [], varI = [], swirl = [];
  for (var i = 0; i < N; i++) {
    /* evenly spread phases, jittered - a perfectly even column pulses */
    seed.push((i + rng() * 0.8) / N);
    siz.push(20 + rng() * 26);
    varI.push(Math.floor(rng() * 3));
    swirl.push(rng() * TAU);
  }

  var g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(new Float32Array(seed), 1));
  g.setAttribute('aSize', new THREE.InstancedBufferAttribute(new Float32Array(siz), 1));
  g.setAttribute('aVar', new THREE.InstancedBufferAttribute(new Float32Array(varI), 1));
  g.setAttribute('aSwirl', new THREE.InstancedBufferAttribute(new Float32Array(swirl), 1));
  g.instanceCount = N;

  smokeMat = new THREE.ShaderMaterial({
    /* OPAQUE, like the clouds. A plume is a stack of big overlapping cards
       and blending them was the most expensive thing on the volcano by a
       wide margin. depthWrite is ON here (unlike the clouds): the smoke sits
       at about 800 units, close enough that the composite's haze reading its
       depth is correct rather than ruinous, and writing depth is what lets
       the puffs occlude each other properly now that they cannot blend. */
    transparent: false, depthWrite: true, side: THREE.DoubleSide, fog: false,
    uniforms: commonUniforms({
      uMap: { value: makePuffTexture(3) },
      uVent: { value: new THREE.Vector3(VOLC.x, ventY, VOLC.z) },
      uHot: { value: new THREE.Color(0xff8a24) },
      uDark: { value: new THREE.Color(0x17161a) },
      uPale: { value: new THREE.Color(0x53525c) }
    }),
    vertexShader: [
      'attribute float aSeed; attribute float aSize; attribute float aVar; attribute float aSwirl;',
      'uniform float uTime; uniform vec3 uVent;',
      'varying vec2 vUv; varying float vT; varying float vDist; varying float vA;',
      'void main(){',
      '  vUv = vec2((uv.x + aVar) / 3.0, uv.y);',
      /* one full life every ~62 seconds; slow is the point - fast smoke
         reads as a smoke machine, not as a mountain venting */
      '  float t = fract(aSeed + uTime * 0.0162);',
      '  vT = t;',
      /* Rise fast out of the throat, then slow as it loses buoyancy. The
         square root is what gives the column its shape: tight and quick at
         the vent, broad and lazy at the top. */
      '  float climb = sqrt(t);',
      '  float y = uVent.y + climb * 405.0;',
      /* spread: a narrow throat opening into a cauliflower head */
      '  float spread = 7.0 + t * t * 132.0;',
      '  float a = aSwirl + t * 2.1;',
      '  vec3 o = uVent + vec3(cos(a) * spread, y - uVent.y, sin(a) * spread * 0.85);',
      /* the same wind that walks the clouds east, leaning the plume over */
      '  o.x += t * t * 92.0;',
      '  o.z += t * t * 26.0;',
      /* puffs grow as they cool and entrain air */
      '  float sc = aSize * (0.40 + climb * 2.75);',
      '  vec3 rgt = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);',
      '  vec3 upv = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);',
      '  vec3 wp = o + rgt * position.x * sc + upv * position.y * sc;',
      '  vec4 mv = viewMatrix * vec4(wp, 1.0);',
      '  vDist = -mv.z;',
      /* born quickly, dead long before it reaches full size - an old puff
         that is still opaque is just wasted fill rate */
      '  vA = smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.44, 1.0, t));',
      '  gl_Position = projectionMatrix * mv;',
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform sampler2D uMap; uniform vec3 uHot; uniform vec3 uDark; uniform vec3 uPale;',
      'varying vec2 vUv; varying float vT; varying float vDist; varying float vA;',
      GLSL_COMMON,
      /* An ordered-dither cut, not a hard one. A puff is born, rises and
         dies, and a plain alpha test would make each one snap in and out of
         existence. Comparing against a 4x4 Bayer threshold instead dissolves
         it pixel by pixel - the same screen-door trick the tree LODs use in
         models.js - so it fades like smoke while still being opaque. */
      'float sB2(vec2 a){ a = floor(a); return fract(a.x*0.5 + a.y*a.y*0.75); }',
      'float sB4(vec2 a){ return sB2(a*0.5)*0.25 + sB2(a); }',
      'void main(){',
      '  float a = texture2D(uMap, vUv).a * vA;',
      '  if (a < sB4(gl_FragCoord.xy)) discard;',
      /* Lit from below by the vent for the first stretch, then the ash
         itself takes over and it goes near-black, then it thins to pale
         grey as it disperses. That three-stage read is what separates an
         eruption column from a chimney. */
      '  vec3 col = mix(uHot * 2.4, uDark, smoothstep(0.0, 0.155, vT));',
      '  col = mix(col, uPale, smoothstep(0.52, 1.0, vT));',
      '  col = applyFog(col, vDist * 0.55);',
      '  gl_FragColor = vec4(col, 1.0);',
      '}'
    ].join('\n')
  });
  var m = new THREE.Mesh(g, smokeMat);
  m.frustumCulled = false;      /* one draw call; a cull test costs more */
  m.renderOrder = 7;
  scene.add(m);
  shaderMats.push(smokeMat);
}

/* ----------------------------------------------------------------- embers
   Thrown out of the vent on ballistic arcs and burning out on the way down.
   Additive and tiny, so they cost almost nothing to blend, and they are
   what makes the summit read as violent rather than merely smoky. */
function buildEmbers() {
  var N = 70, rng = mulberry32(90210);
  var pos = [], seed = [], siz = [];
  for (var i = 0; i < N; i++) {
    var a = rng() * TAU, r = rng() * 0.9;
    /* launch direction, stored in position and reused in the shader */
    pos.push(Math.cos(a) * r, 0.55 + rng() * 0.75, Math.sin(a) * r);
    seed.push(rng());
    siz.push(0.5 + rng() * 1.5);
  }
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1));
  g.setAttribute('aSize', new THREE.Float32BufferAttribute(siz, 1));

  emberMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false,
    blending: THREE.AdditiveBlending,
    uniforms: commonUniforms({
      uMap: { value: makeSoftDot('rgba(255,255,255,1)', 'rgba(255,190,90,0.55)') },
      uVent: { value: new THREE.Vector3(VOLC.x, ventY, VOLC.z) },
      uPR: { value: renderer.getPixelRatio() }
    }),
    vertexShader: [
      'attribute float aSeed; attribute float aSize;',
      'uniform float uTime; uniform vec3 uVent; uniform float uPR;',
      'varying float vA; varying float vDist; varying float vT;',
      'void main(){',
      '  float t = fract(aSeed + uTime * 0.085);',
      '  vT = t;',
      /* up fast, then gravity takes it - a real ballistic arc, which is
         cheaper than it sounds: one multiply-add per axis */
      '  float vy = position.y * 150.0;',
      '  vec3 p = uVent;',
      '  p.x += position.x * 62.0 * t + t * t * 34.0;',
      '  p.z += position.z * 62.0 * t;',
      '  p.y += vy * t - 190.0 * t * t;',
      '  vec4 mv = viewMatrix * vec4(p, 1.0);',
      '  vDist = -mv.z;',
      '  gl_PointSize = clamp(aSize * 260.0 * uPR / max(vDist, 1.0), 1.0, 9.0 * uPR);',
      '  gl_Position = projectionMatrix * mv;',
      '  vA = smoothstep(0.0, 0.04, t) * (1.0 - smoothstep(0.35, 0.95, t));',
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform sampler2D uMap;',
      'varying float vA; varying float vDist; varying float vT;',
      'void main(){',
      '  float a = texture2D(uMap, gl_PointCoord).a * vA;',
      '  if (a < 0.01) discard;',
      /* white-hot on the way up, cooling to deep red as it falls */
      '  vec3 c = mix(vec3(1.9, 1.35, 0.55), vec3(1.1, 0.16, 0.02), smoothstep(0.05, 0.6, vT));',
      '  gl_FragColor = vec4(c * a, a);',
      '}'
    ].join('\n')
  });
  var pts = new THREE.Points(g, emberMat);
  pts.frustumCulled = false;
  pts.renderOrder = 8;
  scene.add(pts);
  shaderMats.push(emberMat);
}

function buildVolcano() {
  /* the crater floor, so the column starts inside the throat rather than
     hovering above the rim */
  ventY = terrainHeight(VOLC.x, VOLC.z) + 6;
  buildSmoke();
  buildEmbers();
}

export { buildVolcano, emberMat, smokeMat, ventY };
