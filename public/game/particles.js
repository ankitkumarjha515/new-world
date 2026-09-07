/* Whispering Meadow - particles.js
   Extracted from the original single file. Logic unchanged. */

import { GLSL_COMMON, PI, POOL, TAU, clamp, commonUniforms, lerp, mulberry32, renderer, scene, shaderMats, smoothstep } from './core.js';
import { butterflies } from './creatures.js';
import { makeSoftDot } from './sky.js';
var mistMat;

/* a radial grid: dense under your feet, reaching all the way to the horizon */

/* ---- calm inland water (river + pool) ---------------------------------- */

/* build a ribbon that follows a spine */

/* ---- the waterfall ------------------------------------------------------ */

/* ======================================================================== *
 *  A TINY GEOMETRY BUILDER  (merges parts into one vertex-coloured mesh)
 * ======================================================================== */

/* is this a decent spot for something to grow? */

/* ======================================================================== *
 *  GRASS  -  hardware-optimized wrapping grid of instanced anime tufts
 * ======================================================================== */

/* one instance is a soft painterly tuft with full anime silhouettes (Images 2 & 3) */

/* ======================================================================== *
 *  SUNFLOWERS
 * ======================================================================== */

/* ======================================================================== *
 *  TREES, FLOWERS, REEDS, STONES
 * ======================================================================== */

/* radiant anime cherry blossom tree (Sakura - Images 4 & 5) */

/* one mesh per world cell: everything behind you stops being drawn */

/* ---- little flowers (Images 3, 4 & 5) ----------------------------------- */

/* ---- reeds along the water ---------------------------------------------- */

/* ---- stones -------------------------------------------------------------- */

/* ---- a small wooden bridge over the river -------------------------------- */

/* ---- garden park benches and rustic wooden fences (Images 4 & 5) -------- */

/* ======================================================================== *
 *  LIVING THINGS  -  butterflies and distant birds
 * ======================================================================== */

/* ======================================================================== *
 *  DRIFTING PETALS AND WATERFALL MIST (Hardware-Efficient Particle Counts)
 * ======================================================================== */

/* The drifting sakura petals used to live here. They were 56 transparent
   points blended over the whole screen every frame - cheap-sounding, and
   exactly the kind of cost a phone feels - and they are gone by request. */

function buildMist(fall) {
  /* 80 -> 50, and every puff shrunk: large overlapping transparent sprites
     are the single most expensive thing on this hardware, and mist is
     exactly that - viewed near the falls at a low angle, this cluster used
     to stack many 70px-wide (at 1x DPR) discs on top of each other every
     frame. Tighter radius (hugs the falls instead of spreading across the
     screen) + smaller/fewer puffs + a lighter fragment alpha (below) cut
     both the puff count and the average puff footprint. */
  var N = 50, rng = mulberry32(818);
  var pos = [], seed = [], siz = [];
  for (var i = 0; i < N; i++) {
    var col = i < N * 0.62;
    if (col) {
      var a = rng() * TAU, r = Math.sqrt(rng()) * 17;
      pos.push(fall.x + Math.cos(a) * r, 13.0, POOL.z - 18 + Math.sin(a) * r * 0.8);
      siz.push(1.6 + rng() * 3.5);
    } else {
      pos.push(fall.x + (rng() - 0.5) * 26, lerp(fall.botY, fall.topY, rng()), POOL.z - 22 + (rng() - 0.5) * 8);
      siz.push(0.8 + rng() * 1.8);
    }
    seed.push(rng());
  }
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1));
  g.setAttribute('aSize', new THREE.Float32BufferAttribute(siz, 1));
  mistMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false,
    uniforms: commonUniforms({
      uMap: { value: makeSoftDot('rgba(255,255,255,0.85)', 'rgba(255,255,255,0.30)') },
      uPR: { value: renderer.getPixelRatio() }
    }),
    vertexShader: [
      'attribute float aSeed; attribute float aSize;',
      'uniform float uTime; uniform float uPR;',
      'varying float vA; varying float vDist;',
      'void main(){',
      '  float life = fract(aSeed + uTime*0.055);',
      '  vec3 p = position;',
      '  p.y += life*34.0;',
      '  float spread = 1.0 + life*1.5;',
      '  p.x += (aSeed-0.5)*22.0*life + sin(uTime*0.6 + aSeed*20.0)*2.5*life;',
      '  p.z += life*16.0 + cos(uTime*0.5 + aSeed*17.0)*2.0*life;',
      '  vec4 mv = viewMatrix * vec4(p, 1.0);',
      '  vDist = -mv.z;',
      '  gl_PointSize = clamp(aSize * spread * 140.0 * uPR / max(vDist, 1.0), 3.0, 46.0 * uPR);',
      '  gl_Position = projectionMatrix * mv;',
      '  vA = smoothstep(0.0, 0.12, life) * (1.0 - smoothstep(0.45, 1.0, life));',
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform sampler2D uMap;',
      'uniform vec3 uFogCol; uniform float uFogDens;',
      'varying float vA; varying float vDist;',
      'void main(){',
      '  float a = texture2D(uMap, gl_PointCoord).a * vA * 0.24;',
      '  if(a < 0.005) discard;',
      '  float f = 1.0 - exp(-vDist*vDist*uFogDens*uFogDens);',
      '  vec3 c = mix(vec3(0.96,0.99,1.0), uFogCol, clamp(f,0.0,1.0));',
      '  gl_FragColor = vec4(c, a);',
      '}'
    ].join('\n')
  });
  var pts = new THREE.Points(g, mistMat);
  pts.frustumCulled = false;
  pts.renderOrder = 9;
  scene.add(pts);
  shaderMats.push(mistMat);
}

/* a rainbow, because the mist deserves one */

function buildRainbow() {
  var g = new THREE.RingGeometry(30, 47, 110, 1, PI * 0.08, PI * 0.84);
  var mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uIn: { value: 30 }, uOut: { value: 47 } },
    vertexShader: [
      'varying vec2 vP;',
      'void main(){ vP = position.xy;',
      ' gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }'
    ].join('\n'),
    fragmentShader: [
      'uniform float uIn; uniform float uOut;',
      'varying vec2 vP;',
      'vec3 spectrum(float t){',
      '  return vec3(0.55 + 0.45*cos(6.2831*(t*0.85 + 0.00)),',
      '              0.52 + 0.45*cos(6.2831*(t*0.85 + 0.33)),',
      '              0.55 + 0.45*cos(6.2831*(t*0.85 + 0.66)));',
      '}',
      'void main(){',
      '  float r = length(vP);',
      '  float t = clamp((r - uIn)/(uOut - uIn), 0.0, 1.0);',
      '  float a = pow(sin(t*3.14159), 1.6) * 0.30;',
      '  float ang = atan(vP.y, vP.x)/3.14159;',
      '  a *= smoothstep(0.06, 0.30, ang) * (1.0 - smoothstep(0.72, 0.95, ang));',
      '  gl_FragColor = vec4(spectrum(t) * a, a);',
      '}'
    ].join('\n')
  });
  var m = new THREE.Mesh(g, mat);
  m.position.set(-236, 20, -324);
  m.rotation.y = 0.08;
  m.renderOrder = 10;
  scene.add(m);
}

/* ======================================================================== *
 *  POST PROCESSING  -  bloom, sun shafts, grade, vignette
 * ======================================================================== */

export { buildMist, buildRainbow, mistMat };
