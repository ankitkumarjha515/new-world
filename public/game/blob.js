/* ==========================================================================
   WHISPERING MEADOW - the little ones

   Everybody in the wood is one of these: a round, egg-shaped creature about
   waist-high to the grass, with big eyes, stubby legs, two little arm nubs,
   and either a jar lid with a knob or a curly antenna on top. Seen from
   behind, in third person, waddling down the path.

   Everything is built from a handful of primitives, so there is no model to
   download, no loader to wait on, and a body is ready the instant net.js asks
   for one (it adds the result to the scene on the same line). Each player's
   look - body colour, lid or antenna, scarf or none - is picked from their id
   alone, so every browser dresses the same person the same way.

   Same public shape as the old character.js, which this replaces:
     build(THREE, id, opts) -> ch      ch.root is the Object3D to add
     animate(ch, dt, speed, airborne)
     face(ch, yaw, pitch)
     dispose(ch)
     preload()

   Forward is local -Z, as it is for the camera, so `root.rotation.y = yaw`
   points a body the way that person is looking.
   ========================================================================== */

import { toonRamp, withRim } from './core.js';

/* Body colours: soft, slightly dusty, all readable against dark grass. */
var BODY = [0x5fa79a, 0xe0807c, 0xd2574c, 0xe2b553, 0xa48bd3, 0x9cc48a,
            0x6d8fd0, 0xe39a62, 0x4f9fb8, 0xc87aa8];
var TRIM = [0xe8d7a8, 0xf0c45a, 0x2e2a3a, 0xf3efe6, 0x7a4fb0, 0xd6573f];
var EYE_WHITE = 0xf6f3ec, EYE_DARK = 0x16131a;

function pick(list, id, salt) {
  var h = Math.imul((id | 0) + 0x9e37 * (salt + 1), 2654435761) >>> 0;
  h ^= h >>> 15;
  return list[h % list.length];
}
function bit(id, salt) {
  var h = Math.imul((id | 0) ^ (salt * 0x45d9f3b), 0x27d4eb2d) >>> 0;
  return ((h >>> 11) & 1) === 1;
}

function mat(THREE, colour, rim) {
  var m = new THREE.MeshToonMaterial({ color: new THREE.Color(colour), gradientMap: toonRamp() });
  return rim ? withRim(m, rim, 0xffd7a0) : m;
}

function buildCharacter(THREE, id, opts) {
  id = id | 0;
  var ch = {
    root: new THREE.Group(), body: new THREE.Group(), parts: {},
    mats: [], geos: [], phase: 0, idle: Math.random() * 6.28,
    id: id, pitch: 0, dead: false, land: 0, wasAir: false
  };
  var root = ch.root, body = ch.body;
  root.add(body);

  function keep(m) { ch.mats.push(m); return m; }
  function geo(g) { ch.geos.push(g); return g; }
  function mesh(g, m, x, y, z) {
    var o = new THREE.Mesh(g, m);
    o.position.set(x || 0, y || 0, z || 0);
    return o;
  }

  /* Id 0 is you (until the server assigns a real id, and your own body
     keeps it): always the teal one with the cream jar lid. */
  var bodyHex = id === 0 ? 0x4f9d93 : pick(BODY, id, 1);
  var trimHex = id === 0 ? 0xd9cdb2 : pick(TRIM, id, 2);
  var skin = keep(mat(THREE, bodyHex, 0.38));
  var trim = keep(mat(THREE, trimHex, 0.25));
  var white = keep(new THREE.MeshBasicMaterial({ color: EYE_WHITE }));
  var dark = keep(new THREE.MeshBasicMaterial({ color: EYE_DARK }));
  var shade = keep(mat(THREE, new THREE.Color(bodyHex).multiplyScalar(0.72).getHex(), 0));

  /* ---- the egg ----------------------------------------------------- */
  var egg = mesh(geo(new THREE.SphereGeometry(0.42, 28, 20)), skin, 0, 0.66, 0);
  egg.scale.set(1.0, 1.14, 0.96);
  body.add(egg);
  ch.parts.egg = egg;

  /* a scarf band round the middle, on some */
  if (id !== 0 && bit(id, 3)) {
    var band = mesh(geo(new THREE.TorusGeometry(0.405, 0.055, 10, 32)), trim, 0, 0.50, 0);
    band.rotation.x = Math.PI / 2;
    band.scale.set(1.0, 0.96, 1.0);
    body.add(band);
    var tail = mesh(geo(new THREE.BoxGeometry(0.11, 0.24, 0.04)), trim, 0.16, 0.38, -0.36);
    tail.rotation.z = 0.25;
    body.add(tail);
  }

  /* ---- the face (on -Z, which is forward) ----------------------------- */
  var eyeG = geo(new THREE.SphereGeometry(0.105, 18, 12));
  var pupG = geo(new THREE.SphereGeometry(0.058, 14, 10));
  var glintG = geo(new THREE.SphereGeometry(0.018, 8, 6));
  for (var s = -1; s <= 1; s += 2) {
    var eye = mesh(eyeG, white, s * 0.155, 0.80, -0.355);
    eye.scale.set(1, 1.08, 0.7);
    body.add(eye);
    var pup = mesh(pupG, dark, s * 0.15, 0.79, -0.418);
    body.add(pup);
    body.add(mesh(glintG, white, s * 0.13, 0.82, -0.465));
  }

  /* ---- arms: little nubs ------------------------------------------- */
  var armG = geo(new THREE.SphereGeometry(0.095, 14, 10));
  var armL = mesh(armG, skin, -0.43, 0.56, 0.0);
  var armR = mesh(armG, skin, 0.43, 0.56, 0.0);
  armL.scale.set(0.8, 1.25, 0.8); armR.scale.set(0.8, 1.25, 0.8);
  body.add(armL); body.add(armR);
  ch.parts.armL = armL; ch.parts.armR = armR;

  /* ---- legs: stubby, pivoting at the hip ------------------------------ */
  var legG = geo(new THREE.CylinderGeometry(0.075, 0.085, 0.22, 10));
  legG.translate(0, -0.11, 0);
  var footG = geo(new THREE.SphereGeometry(0.1, 12, 8));
  ['L', 'R'].forEach(function (side, i) {
    var hip = new THREE.Group();
    hip.position.set(i ? 0.16 : -0.16, 0.26, 0);
    hip.add(mesh(legG, shade, 0, 0, 0));
    var foot = mesh(footG, shade, 0, -0.22, -0.035);
    foot.scale.set(1, 0.6, 1.3);
    hip.add(foot);
    root.add(hip);
    ch.parts['leg' + side] = hip;
  });

  /* ---- on top: a jar lid with a knob, or a curly antenna ------------ */
  var top = new THREE.Group();
  top.position.set(0, 1.08, 0);
  if (id === 0 || bit(id, 5)) {
    var lid = mesh(geo(new THREE.SphereGeometry(0.33, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2)), trim, 0, -0.04, 0);
    lid.scale.set(1, 0.55, 1);
    top.add(lid);
    var rim = mesh(geo(new THREE.TorusGeometry(0.325, 0.035, 8, 28)), trim, 0, -0.04, 0);
    rim.rotation.x = Math.PI / 2;
    top.add(rim);
    top.add(mesh(geo(new THREE.SphereGeometry(0.075, 12, 10)), trim, 0, 0.17, 0));
  } else {
    /* a question-mark curl, leaning back */
    /* a straight stem, then an arc that carries on upward and curls over
       backwards (+Z), tangent-continuous where they meet */
    var pts = [], k;
    for (k = 0; k <= 5; k++) { pts.push(new THREE.Vector3(0, 0.40 * k / 5, 0)); }
    for (k = 1; k <= 12; k++) {
      var th = Math.PI - k / 12 * (Math.PI + 0.4);
      pts.push(new THREE.Vector3(0, 0.40 + 0.12 * Math.sin(th), 0.12 + 0.12 * Math.cos(th)));
    }
    var curve = new THREE.CatmullRomCurve3(pts);
    top.add(mesh(geo(new THREE.TubeGeometry(curve, 24, 0.028, 6, false)), trim, 0, -0.05, 0.02));
    var tip = pts[pts.length - 1];
    top.add(mesh(geo(new THREE.SphereGeometry(0.07, 12, 10)), trim, tip.x, tip.y - 0.05, tip.z + 0.02));
  }
  body.add(top);
  ch.parts.top = top;

  /* every surface is a smooth curved primitive, so no outline pass */
  root.traverse(function (o) { if (o.isMesh) { o.castShadow = true; } });
  return ch;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/* A waddle: the egg rocks side to side with each step, the legs swing, the
   arms swing against them, and the whole body bobs. Landing squashes it. */
function animateCharacter(ch, dt, speed, airborne) {
  var p = ch.parts;
  ch.idle += dt;
  var moving = speed > 0.4 && !airborne;
  var swing = moving ? clamp(speed / 4.6, 0, 1.5) : 0;
  ch.phase += dt * (moving ? 5.5 + speed * 0.9 : 0);
  var s = Math.sin(ch.phase), c = Math.cos(ch.phase);

  /* landing squash, decaying */
  if (ch.wasAir && !airborne) { ch.land = 1; }
  ch.wasAir = airborne;
  ch.land = Math.max(0, ch.land - dt * 5);
  var squash = ch.land * 0.16;

  var b = ch.body;
  if (airborne) {
    b.position.y = 0.04;
    b.rotation.z = 0; b.rotation.x = -0.12;
    b.scale.set(0.94, 1.09, 0.94);
    p.legL.rotation.x = -0.6; p.legR.rotation.x = 0.3;
    p.armL.position.y = 0.66; p.armR.position.y = 0.66;
    p.top.rotation.x = 0.2;
    return;
  }
  if (moving) {
    b.position.y = Math.abs(s) * 0.07 * swing;
    b.rotation.z = c * 0.10 * swing;
    b.rotation.x = 0.07 * swing;
    p.legL.rotation.x = s * 0.75 * swing;
    p.legR.rotation.x = -s * 0.75 * swing;
    p.armL.position.z = -s * 0.07 * swing;
    p.armR.position.z = s * 0.07 * swing;
    p.armL.position.y = 0.56; p.armR.position.y = 0.56;
    p.top.rotation.x = -0.08 * swing + Math.sin(ch.phase * 2) * 0.04 * swing;
  } else {
    var br = Math.sin(ch.idle * 1.6);
    b.position.y = 0;
    b.rotation.z = Math.sin(ch.idle * 0.7) * 0.025;
    b.rotation.x = 0;
    p.legL.rotation.x = 0; p.legR.rotation.x = 0;
    p.armL.position.z = 0; p.armR.position.z = 0;
    p.armL.position.y = 0.56 + br * 0.008; p.armR.position.y = 0.56 + br * 0.008;
    p.top.rotation.x = br * 0.03;
    squash += br * 0.012;
  }
  b.scale.set(1 + squash * 0.6, 1 - squash, 1 + squash * 0.6);
}

function faceCharacter(ch, yaw, pitch) {
  ch.root.rotation.y = yaw;
  ch.pitch = pitch || 0;
}

function disposeCharacter(ch) {
  ch.dead = true;
  for (var i = 0; i < ch.geos.length; i++) { ch.geos[i].dispose(); }
  for (i = 0; i < ch.mats.length; i++) { ch.mats[i].dispose(); }
  ch.geos = []; ch.mats = [];
  if (ch.root.parent) { ch.root.parent.remove(ch.root); }
}

/* nothing to fetch */
function preloadCharacter() { return Promise.resolve(true); }

/* net.js is a plain script and cannot import; it finds bodies here. */
window.MeadowCharacter = {
  build: buildCharacter,
  animate: animateCharacter,
  face: faceCharacter,
  dispose: disposeCharacter,
  preload: preloadCharacter
};

export { buildCharacter, animateCharacter, faceCharacter, disposeCharacter, preloadCharacter };
