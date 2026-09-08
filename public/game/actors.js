/* Whispering Meadow - actors.js
 *
 *  The two things in this world that MOVE under their own power, as
 *  opposed to swaying (props), drifting (creatures) or being driven by the
 *  player. A wolf that walks the meadow, and a tractor that works a loop
 *  across it.
 *
 *  ---------------------------------------------------- why not props.js
 *  Everything in props.js is an InstancedMesh sharing one geometry and one
 *  band-patched material, because there are four and a half thousand of
 *  them and that is the only way that number is affordable. These two are
 *  the opposite case in every respect: there is ONE of each, they are
 *  skinned or multi-part, and their transforms change every frame. Pushing
 *  them through the instancing path would mean an instance buffer of one,
 *  rewritten per frame, and a shader that cannot deform.
 *
 *  So they get a plain THREE.Group each, and the saving that instancing
 *  would have given is taken back the only way that is left: they are
 *  simply not drawn when they are far away, on the same rung ladder every
 *  prop in models.js uses. A wolf is about 1.4 metres of extent, which is
 *  the shortest rung on the ladder - it is invisible past roughly 165
 *  metres, and past that point it costs one distance compare per frame.
 *
 *  ------------------------------------------------------------ the wolf
 *  Quaternius's animated wolf, which ships with twelve clips. Two are
 *  used: Walk while it is going somewhere and Idle while it is not. It
 *  picks a destination, walks there, stands for a while, picks another -
 *  and the destination test uses the same siteInfo() every scatter uses,
 *  so it will not walk into the river or up the cinder cone.
 *
 *  --------------------------------------------------------- the tractor
 *  Kenney's car kit, whose models are built as a `body` node plus four
 *  separately named wheel nodes. That is the whole reason this one was
 *  chosen over a prettier vehicle: the wheels can be found by name and
 *  spun, so the thing reads as DRIVING rather than sliding. Wheel spin is
 *  derived from distance travelled rather than from time, which is what
 *  stops it looking like an ice rink when the tractor slows on a climb.
 *
 *  It follows a closed loop of waypoints laid out at boot on ground that
 *  passes the same tests the wolf's destinations do, and it leans into the
 *  hill it is on by sampling the terrain under its own axles.
 * ======================================================================== */

import { TAU, scene, toonRamp, mulberry32 } from './core.js';
import { siteInfo } from './geom.js';
import { loadModel, rungFor } from './models.js';
import { groundY } from './props.js';

var ACTOR_DIR = 'assets/actors/models/';

var wolf = null;                 /* { root, mixer, walk, idle, ... }        */
var tractor = null;              /* { root, wheels[], path[], ... }         */
var actorsReady = null;

/* ------------------------------------------------------------ materials
   The downloaded models arrive as MeshStandardMaterial, which in this
   world is simply the wrong material - nothing else here is lit that way,
   and a PBR surface next to a toon-ramped one reads as a sticker. Swap in
   MeshToonMaterial through the SAME 4-step ramp everything else uses,
   carrying over whatever colour or map the original had.

   Materials are cached by source uuid so the tractor's five nodes, which
   all point at the one `colormap` material, still end up sharing one. */
var _toonCache = {};
function toonify(root) {
  root.traverse(function (n) {
    if (!n.isMesh || !n.material) { return; }
    var src = Array.isArray(n.material) ? n.material[0] : n.material;
    var hit = _toonCache[src.uuid];
    if (!hit) {
      hit = new THREE.MeshToonMaterial({
        color: src.color ? src.color.clone() : new THREE.Color(0xffffff),
        map: src.map || null,
        vertexColors: !!(n.geometry && n.geometry.attributes.color),
        gradientMap: toonRamp()
        /* no `skinning` flag - three has bound that automatically since
           r131, and this project is on r155 */
      });
      /* glTF colour maps are authored in sRGB; three needs telling when the
         texture did not come through its own GLTF material path. */
      if (hit.map) { hit.map.colorSpace = THREE.SRGBColorSpace; }
      _toonCache[src.uuid] = hit;
    }
    n.material = hit;
    n.castShadow = true;
    n.receiveShadow = false;
  });
}

/* The extent this actor covers, for picking its rung. Measured off the
   loaded model rather than declared, exactly like every prop. */
function extentOf(root, scale) {
  var box = new THREE.Box3().setFromObject(root);
  var d = new THREE.Vector3();
  box.getSize(d);
  return Math.max(d.x, d.y, d.z) * (scale || 1);
}

/* ---------------------------------------------------------- somewhere to go
   Open, dry, walkable ground. Deliberately the same shape of test the
   scatters use, so an actor cannot end up standing somewhere no tree would
   have grown. */
function walkable(x, z) {
  var si = siteInfo(x, z);
  return !si.water && si.h > 3.5 && si.h < 150 && si.slope < 0.34 && si.riverD > 34;
}

function pickDestination(rng, cx, cz, radius) {
  for (var i = 0; i < 40; i++) {
    var a = rng() * TAU, r = radius * (0.35 + 0.65 * rng());
    var x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    if (walkable(x, z)) { return { x: x, z: z }; }
  }
  return null;
}

/* ================================================================= wolf */
function buildWolf(root) {
  var rng = mulberry32(701);
  var start = pickDestination(rng, 0, 0, 620) || { x: 40, z: 40 };

  root.scale.setScalar(1.35);          /* Quaternius ships it a shade small
                                          for a world whose trees are 9m */
  root.position.set(start.x, groundY(start.x, start.z), start.z);
  toonify(root);
  scene.add(root);

  var mixer = new THREE.AnimationMixer(root);
  var clips = root.animations || [];
  var find = function (name) {
    for (var i = 0; i < clips.length; i++) {
      /* the file carries every clip twice, once bare and once prefixed
         "AnimalArmature|" - either spelling is the same animation */
      var n = clips[i].name;
      if (n === name || n === 'AnimalArmature|' + name) { return clips[i]; }
    }
    return null;
  };
  var walkClip = find('Walk'), idleClip = find('Idle');
  var walk = walkClip ? mixer.clipAction(walkClip) : null;
  var idle = idleClip ? mixer.clipAction(idleClip) : null;
  if (idle) { idle.play(); }

  wolf = {
    root: root, mixer: mixer, walk: walk, idle: idle, rng: rng,
    dest: null, wait: 2 + rng() * 4, speed: 2.6,
    cull: rungFor(extentOf(root, 1)).dist
  };
}

function updateWolf(dt, px, pz) {
  if (!wolf) { return; }
  var r = wolf.root, p = r.position;

  /* Not drawn, not simulated. A wolf nobody can see does not need to have
     walked anywhere, and the mixer is the expensive half of this. */
  var dx0 = p.x - px, dz0 = p.z - pz;
  var vis = dx0 * dx0 + dz0 * dz0 < wolf.cull * wolf.cull;
  r.visible = vis;
  if (!vis) { return; }

  if (wolf.wait > 0) {
    wolf.wait -= dt;
    if (wolf.wait <= 0) {
      wolf.dest = pickDestination(wolf.rng, p.x, p.z, 140);
      if (wolf.dest && wolf.walk) { wolf.walk.reset().fadeIn(0.3).play(); if (wolf.idle) { wolf.idle.fadeOut(0.3); } }
      /* Forty rejection samples in a 140m disc can legitimately all miss -
         the wolf may have ended its last leg against the river, the cinder
         cone or a steep bank, where walkable() turns down everything within
         reach. Re-arm the timer when that happens. Without this the wait
         stays expired AND dest stays null, so neither branch is ever entered
         again and the wolf stands in Idle for the rest of the session. */
      if (!wolf.dest) { wolf.wait = 1 + wolf.rng() * 2; }
    }
  } else if (wolf.dest) {
    var dx = wolf.dest.x - p.x, dz = wolf.dest.z - p.z;
    var d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1.6) {
      wolf.dest = null;
      wolf.wait = 3 + wolf.rng() * 7;
      if (wolf.idle) { wolf.idle.reset().fadeIn(0.3).play(); }
      if (wolf.walk) { wolf.walk.fadeOut(0.3); }
    } else {
      var step = Math.min(d, wolf.speed * dt);
      p.x += dx / d * step;
      p.z += dz / d * step;
      /* Turn toward travel rather than snapping: a wolf that pivots on the
         spot reads as a cursor, not an animal. */
      var want = Math.atan2(dx, dz);
      var turn = want - r.rotation.y;
      while (turn > Math.PI) { turn -= TAU; }
      while (turn < -Math.PI) { turn += TAU; }
      r.rotation.y += turn * Math.min(1, dt * 3.2);
    }
  }
  p.y = groundY(p.x, p.z);
  wolf.mixer.update(dt);
}

/* ============================================================== tractor */
function buildTractor(root) {
  var rng = mulberry32(913);
  root.scale.setScalar(1.9);           /* Kenney's kit is ~2m to a car; this
                                          world's trees are 7-14m, so a
                                          life-size tractor has to come up */

  /* Yaw about the world, pitch about the axle line. On three's default 'XYZ'
     the X rotation is composed LAST and therefore applies in world space, so
     a tractor driving east or west would roll onto its side rather than tip
     nose-up - the exact artefact the fore/aft ground sampling in
     updateTractor() exists to produce. Every other yaw+tilt in this project
     already sets this (props.js, creatures.js). */
  root.rotation.order = 'YXZ';

  /* The five named nodes are the whole reason this model was chosen. */
  var wheels = [];
  root.traverse(function (n) {
    if (n.name && n.name.indexOf('wheel') === 0) { wheels.push(n); }
  });

  /* A closed loop of waypoints on ground the tractor can actually work.
     Laid out as a ring so the loop cannot cross itself, then each point
     nudged until it lands somewhere walkable - a ring that ignored the
     terrain would drive it straight through the river.

     Seating the CORNERS is not enough, because the tractor drives the
     straight line between them. Ring neighbours start ~190m apart and a
     corner that could not be seated is dropped outright, doubling that, so
     the unchecked chord is long enough to cross the brook or clip a ridge -
     which is the exact failure the ring is here to rule out. Measured on the
     shipping seed: only two of nine legs were actually clear.

     What a leg has to satisfy is NOT walkable(). That is the test the
     scatters use to decide where a tree may take root, and its 34m river
     buffer and 0.34 slope ceiling describe good planting soil, not
     driveable ground. A tractor may pass within a few metres of the water
     and up a steeper bank than a tree would grow on; it just may not drive
     THROUGH the river or up the cinder cone. */
  function drivable(x, z) {
    var si = siteInfo(x, z);
    return !si.water && si.h > 3 && si.h < 150 && si.slope < 0.55 && si.riverD > 12;
  }
  function legClear(p, q) {
    var lx = q.x - p.x, lz = q.z - p.z;
    var steps = Math.max(2, Math.ceil(Math.sqrt(lx * lx + lz * lz) / 12));
    for (var s = 1; s < steps; s++) {
      var t = s / steps;
      if (!drivable(p.x + lx * t, p.z + lz * t)) { return false; }
    }
    return true;
  }
  function ringAt(cx, cz, R, N) {
    var out = [];
    for (var i = 0; i < N; i++) {
      var a = i / N * TAU, hit = null;
      for (var k = 0; k < 26 && !hit; k++) {
        var rr = R * (1 - k * 0.03);
        var x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
        if (walkable(x, z)) { hit = { x: x, z: z }; }
      }
      if (hit) { out.push(hit); }
    }
    return out;
  }
  /* Drop the corners whose approach does not hold. Whatever survives is a
     loop every leg of which has been checked - a shorter round, never a
     wrong one. */
  function pruned(ring) {
    var out = [];
    for (var i = 0; i < ring.length; i++) {
      if (!out.length || legClear(out[out.length - 1], ring[i])) { out.push(ring[i]); }
    }
    /* the loop closes, so the leg home has to hold too */
    while (out.length >= 3 && !legClear(out[out.length - 1], out[0])) { out.pop(); }
    return out;
  }

  /* Try whole rings and keep the first that holds all the way round. Failing
     that, the best pruned one. Every draw here comes off this function's own
     mulberry32(913), so hunting costs nothing anyone else can observe. */
  var N = 9, path = null, best = [];
  for (var attempt = 0; attempt < 60 && !path; attempt++) {
    var c = pickDestination(rng, 0, 0, 380);
    if (!c) { continue; }
    var ring = ringAt(c.x, c.z, 200 + rng() * 130, N);
    if (ring.length < 3) { continue; }
    var keep = pruned(ring);
    if (keep.length === ring.length && ring.length >= 5) { path = keep; }
    else if (keep.length > best.length) { best = keep; }
  }
  if (!path) { path = best; }
  if (path.length < 3) { return; }     /* nowhere to drive - skip it rather
                                          than drop a tractor in the river */

  /* Only now is the model certainly going to be used. toonify() allocates a
     material per source material and nothing disposes them on the bail
     above, which on the 8 GB machine this file targets is a leak for the
     rest of the session. */
  toonify(root);

  root.position.set(path[0].x, groundY(path[0].x, path[0].z), path[0].z);
  scene.add(root);

  tractor = {
    root: root, wheels: wheels, path: path, leg: 0, t: 0,
    speed: 5.4, spin: 0,
    /* Kenney's wheels are ~0.35 model units across; at this scale that is
       the radius the spin has to be derived from or the wheels slip. */
    wheelR: 0.35 * 1.9,
    cull: rungFor(extentOf(root, 1)).dist
  };
}

function updateTractor(dt, px, pz) {
  if (!tractor) { return; }
  var r = tractor.root, p = r.position, path = tractor.path;

  var dx0 = p.x - px, dz0 = p.z - pz;
  var vis = dx0 * dx0 + dz0 * dz0 < tractor.cull * tractor.cull;
  r.visible = vis;
  if (!vis) { return; }

  var b = path[(tractor.leg + 1) % path.length];
  var dx = b.x - p.x, dz = b.z - p.z;
  var d = Math.sqrt(dx * dx + dz * dz);
  if (d < 2.5) {
    tractor.leg = (tractor.leg + 1) % path.length;
  } else {
    var step = tractor.speed * dt;
    p.x += dx / d * step;
    p.z += dz / d * step;
    /* Spin from DISTANCE, not time - a wheel that turns at a constant rate
       while the tractor slows is the classic ice-rink tell. */
    tractor.spin -= step / tractor.wheelR;
    var want = Math.atan2(dx, dz);
    var turn = want - r.rotation.y;
    while (turn > Math.PI) { turn -= TAU; }
    while (turn < -Math.PI) { turn += TAU; }
    r.rotation.y += turn * Math.min(1, dt * 1.9);
  }

  for (var i = 0; i < tractor.wheels.length; i++) { tractor.wheels[i].rotation.x = tractor.spin; }

  /* Sit on the ground and lean into it. Sampling fore and aft of the body
     rather than under its centre is what makes it climb a rise nose-up
     instead of clipping through the brow of it. */
  var fx = Math.sin(r.rotation.y), fz = Math.cos(r.rotation.y), L = 1.7;
  var yF = groundY(p.x + fx * L, p.z + fz * L);
  var yB = groundY(p.x - fx * L, p.z - fz * L);
  p.y = (yF + yB) * 0.5 + 0.12;
  r.rotation.x = Math.atan2(yB - yF, L * 2);
}

/* ================================================================= boot */
function buildActors() {
  actorsReady = Promise.all([
    loadModel(ACTOR_DIR + 'wolf.glb').then(function (root) {
      if (root) { buildWolf(root); }
    }).catch(function (e) { console.warn('[actors] wolf:', e); }),
    loadModel(ACTOR_DIR + 'tractor.glb').then(function (root) {
      if (root) { buildTractor(root); }
    }).catch(function (e) { console.warn('[actors] tractor:', e); })
  ]);
  return actorsReady;
}

function updateActors(dt, px, pz) {
  /* A tab that has been in the background hands back one enormous dt, and
     an enormous dt teleports both of these across the map. */
  var d = Math.min(dt, 0.1);
  updateWolf(d, px, pz);
  updateTractor(d, px, pz);
}

export { buildActors, updateActors, actorsReady, wolf, tractor };
