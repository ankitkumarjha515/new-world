/* Whispering Meadow - creatures.js
   Extracted from the original single file. Logic unchanged. */

import { toonRamp, PI, RIVER, RIVER_BB, TAU, _e, _m4, _pv, _q, _v3, mulberry32, pathFar, pathInfo, scene, terrainHeight, timeU } from './core.js';
import { GB, M4 } from './geom.js';
var butterflies = [], birdList = [], butterflyMesh, birdMesh;

function flapMaterial(rate, amp) {
  var m = new THREE.MeshToonMaterial({ vertexColors: true, side: THREE.DoubleSide, gradientMap: toonRamp() });
  m.onBeforeCompile = function (sh) {
    sh.uniforms.uTime = timeU;
    sh.uniforms.uRate = { value: rate };
    sh.uniforms.uAmp = { value: amp };
    sh.vertexShader = 'uniform float uTime; uniform float uRate; uniform float uAmp;\n' +
      sh.vertexShader.replace('#include <begin_vertex>',
        '#include <begin_vertex>\n' +
        '#ifdef USE_INSTANCING\n' +
        ' float ph = instanceMatrix[3][0]*3.13 + instanceMatrix[3][2]*1.77;\n' +
        '#else\n float ph = 0.0;\n#endif\n' +
        ' float fl = sin(uTime*uRate + ph)*uAmp;\n' +
        ' float sg = transformed.x >= 0.0 ? 1.0 : -1.0;\n' +
        ' float ca = cos(fl), sa = sin(fl*sg);\n' +
        ' float nx = transformed.x*ca - transformed.y*sa*sg;\n' +
        ' float ny = transformed.x*sa + transformed.y*ca;\n' +
        ' transformed.x = nx; transformed.y = ny;\n');
  };
  return m;
}

function wingGeo(len, wid, colA, colB) {
  var gb = new GB();
  var rng = mulberry32(9);
  var w = new THREE.CircleGeometry(0.5, 5);
  gb.add(w, M4(len * 0.52, 0, 0, -PI / 2, 0, 0, len, wid, 1), colA, 0.05, rng);
  gb.add(w, M4(-len * 0.52, 0, 0, -PI / 2, 0, 0, len, wid, 1), colA, 0.05, rng);
  gb.add(w, M4(len * 0.34, 0, -wid * 0.42, -PI / 2, 0, 0, len * 0.66, wid * 0.7, 1), colB, 0.05, rng);
  gb.add(w, M4(-len * 0.34, 0, -wid * 0.42, -PI / 2, 0, 0, len * 0.66, wid * 0.7, 1), colB, 0.05, rng);
  gb.add(new THREE.CylinderGeometry(0.012, 0.012, len * 0.7, 4), M4(0, 0, 0, PI / 2, 0, 0),
    new THREE.Color(0x2a2118), 0.02, rng);
  return gb.build();
}

/* butterflies/birds are opaque instanced meshes with a handful of triangles
   each - unlike grass/petals/mist they cost almost nothing per instance, so
   bumping their counts (38->50, 22->30) is a cheap way to add life and charm
   without touching the fill-rate budget. */
var BUTTERFLY_N = 50, BIRD_N = 30;

function buildCreatures() {
  var geo = wingGeo(0.30, 0.34, new THREE.Color(0xffffff), new THREE.Color(0xffe9a8));
  butterflyMesh = new THREE.InstancedMesh(geo, flapMaterial(15.0, 0.85), BUTTERFLY_N);
  butterflyMesh.frustumCulled = false;
  scene.add(butterflyMesh);
  var rng = mulberry32(2024);
  var cols = [0xfff6e0, 0xffd9e8, 0xd8ecff, 0xffe07a, 0xffffff, 0xffc98a, 0xc9f2d8];
  for (var i = 0; i < BUTTERFLY_N; i++) {
    butterflies.push({
      cx: 0, cz: 0, a: rng() * TAU, r: 3 + rng() * 14, sp: 0.5 + rng() * 0.9,
      ph: rng() * 10, up: 0.7 + rng() * 2.2, w: 0.4 + rng() * 0.9, init: false
    });
    butterflyMesh.setColorAt(i, new THREE.Color(cols[Math.floor(rng() * cols.length)]));
  }
  if (butterflyMesh.instanceColor) { butterflyMesh.instanceColor.needsUpdate = true; }

  var bgeo = wingGeo(0.95, 1.5, new THREE.Color(0x3b4450), new THREE.Color(0x2b323b));
  birdMesh = new THREE.InstancedMesh(bgeo, flapMaterial(4.2, 0.7), BIRD_N);
  birdMesh.frustumCulled = false;
  scene.add(birdMesh);
  for (i = 0; i < BIRD_N; i++) {
    var flock = Math.floor(i / 10);
    birdList.push({
      cx: -300 + flock * 420, cz: -560 - flock * 130, cy: 150 + flock * 55 + rng() * 40,
      r: 110 + rng() * 190, a: rng() * TAU, sp: 0.10 + rng() * 0.07, ph: rng() * 9
    });
    birdMesh.setColorAt(i, new THREE.Color(0.9 + rng() * 0.2, 0.9, 0.92));
  }
  if (birdMesh.instanceColor) { birdMesh.instanceColor.needsUpdate = true; }
}

function updateCreatures(t, px, pz) {
  var i, b, x, z, y;
  for (i = 0; i < butterflies.length; i++) {
    b = butterflies[i];
    var dx = b.cx - px, dz = b.cz - pz;
    if (!b.init || dx * dx + dz * dz > 110 * 110) {
      /* Pick a new patch to circle, and keep it off the water. Butterflies
         are almost free in themselves - a handful of triangles each - but
         the river is the most expensive surface in the game to shade, and
         anything hovering in front of it is drawn ON TOP of that cost.
         Four attempts, then take whatever came up: a bounded loop cannot
         stall, and a stray butterfly over the river now and then is a far
         smaller problem than a frame that occasionally never ends. */
      for (var tr = 0; tr < 4; tr++) {
        var a = Math.random() * TAU, r = 18 + Math.random() * 62;
        b.cx = px + Math.cos(a) * r; b.cz = pz + Math.sin(a) * r;
        if (pathFar(RIVER_BB, b.cx, b.cz, 52) || pathInfo(RIVER, b.cx, b.cz).d > 52) { break; }
      }
      b.init = true;
    }
    b.a += b.sp * 0.016;
    x = b.cx + Math.cos(b.a) * b.r + Math.sin(t * 0.7 + b.ph) * 2.2;
    z = b.cz + Math.sin(b.a * 1.3) * b.r + Math.cos(t * 0.6 + b.ph) * 2.2;
    y = terrainHeight(x, z) + b.up + Math.sin(t * 1.9 + b.ph) * 0.55;
    _e.set(0.25 + Math.sin(t * 2.2 + b.ph) * 0.3, -b.a * 1.1 + Math.sin(t + b.ph) * 0.4, 0, 'YXZ');
    _q.setFromEuler(_e);
    _v3.set(b.w, b.w, b.w);
    _pv.set(x, y, z);
    _m4.compose(_pv, _q, _v3);
    butterflyMesh.setMatrixAt(i, _m4);
  }
  butterflyMesh.instanceMatrix.needsUpdate = true;

  for (i = 0; i < birdList.length; i++) {
    b = birdList[i];
    b.a += b.sp * 0.016;
    x = b.cx + Math.cos(b.a) * b.r;
    z = b.cz + Math.sin(b.a) * b.r * 0.75;
    y = b.cy + Math.sin(t * 0.5 + b.ph) * 12;
    _e.set(0, -b.a + PI / 2, Math.sin(b.a) * 0.25, 'YXZ');
    _q.setFromEuler(_e);
    _v3.set(1, 1, 1);
    _pv.set(x, y, z);
    _m4.compose(_pv, _q, _v3);
    birdMesh.setMatrixAt(i, _m4);
  }
  birdMesh.instanceMatrix.needsUpdate = true;
}

export { birdList, birdMesh, buildCreatures, butterflies, butterflyMesh, flapMaterial, updateCreatures, wingGeo };
