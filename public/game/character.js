/* ==========================================================================
   WHISPERING MEADOW - the character

   One builder used for two jobs:
     - YOUR body, seen looking down (first person, so: no head - a head in
       front of the camera is just a wall of skull)
     - EVERYONE ELSE's body, seen from outside, complete with head

   The body is a real, rigged, hand-modelled character: KayKit's Rogue, by
   Kay Lousberg, CC0. See assets/character/SOURCE.md for what it is, where it
   came from, and how the 3.6 MB original was cut down to the 372 KB the game
   actually ships. It is 6 377 triangles with a 16 KB palette texture and a
   20-deform-bone skeleton, which is small enough that a phone can download it
   in a moment and an integrated GPU can skin a meadow full of them.

   Behind it, still here and still complete, is the old hand-jointed figure
   built from boxes and tapered cylinders. It is not dead code:

     - buildCharacter() has to return a body SYNCHRONOUSLY, because net.js
       calls it the instant somebody joins and adds the result to the scene
       on the same line. Loading a glTF is not synchronous. So every body is
       born as the jointed figure and quietly swaps itself for the real model
       the moment the model is ready - usually before the player has walked
       ten paces, and invisibly if the model was already warm.
     - if the model cannot be had at all (no network, blocked CDN, a 404,
       an ancient browser with no import maps) the jointed figure simply
       stays. A plain body is worse than a good one; an INVISIBLE body is
       worse than both, and that is the failure this guards against.

   ========================================================================== */

import { toonRamp, withRim } from './core.js';

/* ==========================================================================
   The model
   ========================================================================== */

var MODEL_URL = 'assets/character/traveller.glb';

/* The model's own bind pose is 2.187 units tall, feet on zero. Everything
   below is derived from that one number, so changing the height here moves
   the body AND retimes its walk in step - see refSpeeds(). */
var MODEL_H = 1.95;
var BIND_H = 2.187;

/* Ground speed, in model units per second, that each clip covers when played
   at timeScale 1. Measured off the baked bone transforms - the foot's
   fore/aft travel relative to the hips IS the step length, because the ground
   is what moves under it. The table and the script that produced it are in
   assets/character/SOURCE.md. This is the whole trick to a walk that does not
   skate: play the clip at the rate the ground is actually going past. */
var CLIP_SPEED = { walk: 0.96, run: 2.30 };

/* Which of the six shipped clips each gait uses. */
var CLIPS = { idle: 'Idle', walk: 'Walking_A', run: 'Running_A', air: 'Jump_Idle' };

/* Palette-atlas rectangles, in UV space, that the per-player recolour is
   allowed to touch. The texture is an 8x4 grid of gradient swatches and every
   part of the character samples from it, so a rectangle here is really "this
   material on this character": cells (1,0)+(1,1) are the tunic, cape and
   sleeves; cell (2,3) is the trousers and boots; cell (0,1) is the hair.
   Skin, leather and metal are deliberately NOT in this list - tinting the
   whole mesh would give somebody a green face. */
var TINT_RECTS = [
  { key: 'uGarment', u0: 0.0,   u1: 0.25, v0: 0.25, v1: 0.5  },
  { key: 'uTrouser', u0: 0.375, u1: 0.5,  v0: 0.5,  v1: 0.75 },
  { key: 'uHair',    u0: 0.125, u1: 0.25, v0: 0.0,  v1: 0.25 }
];

/* ==========================================================================
   Palettes

   Soft and slightly desaturated, so bodies read against bright grass. Shared
   by the model's recolour and by the fallback figure, so a body that swaps
   mid-session does not change colour when it does.
   ========================================================================== */
var SKIN = [0xf3c9a4, 0xe0a97e, 0xc98a5f, 0xa96b41, 0x7d4b2c];
var SHIRT = [0xe8695f, 0x5b93d6, 0x6fbf73, 0xe8b44a, 0xa76fd0,
             0xef8fb5, 0x4fc0c4, 0xf0f0ea, 0x59616e];
var TROUSER = [0x3f4a5c, 0x5c4a3f, 0x2f3b45, 0x6b5f4a, 0x44405a];
var HAIR = [0x2b2018, 0x4a3423, 0x77503a, 0x1b1b20, 0x8f6b3f, 0xc9a24a];
var EYE = 0x241c22; /* near-black with a hint of warmth, never pure 0 */

/* Everyone with the same id sees the same person, on every machine, with
   nothing sent over the wire. Same trick the world itself uses. */
function pick(list, id, salt) {
  var n = (Math.imul(id + 1, 2654435761) ^ Math.imul(salt + 1, 40503)) >>> 0;
  return list[n % list.length];
}

/* ==========================================================================
   Loading the model

   GLTFLoader is not part of the THREE global this game loads from a CDN, and
   getting hold of it needs an import map. models.js already does exactly that
   dance and caches the result; borrow it rather than doing it twice and
   ending up with two import maps fighting over the "three" specifier.

   Imported dynamically, not statically, for two reasons: character.js must
   not fail to parse if models.js ever does, and the module is not needed
   until the first body is built.
   ========================================================================== */
function gltfLoaderClass() {
  return import('./models.js')
    .then(function (m) {
      return m && m.getGLTFLoaderClass ? m.getGLTFLoaderClass() : null;
    })
    .catch(function (err) {
      console.warn('[character] could not reach the glTF loader:', err);
      return null;
    });
}

/* _asset is the one shared copy of the model: one set of geometries, one
   texture, one set of AnimationClips. Every body on screen clones the object
   graph but points at these, so a meadow of twenty people costs one download
   and one upload to the GPU. */
var _asset = null;
var _assetPromise = null;

function loadAsset() {
  if (_assetPromise) { return _assetPromise; }
  _assetPromise = gltfLoaderClass().then(function (Loader) {
    if (!Loader || !window.THREE) { return null; }
    return new Promise(function (resolve) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) { return; }
        settled = true;
        console.warn('[character] ' + MODEL_URL + ' timed out; keeping the jointed body');
        resolve(null);
      }, 20000);
      new Loader().load(MODEL_URL, function (gltf) {
        if (settled) { return; }
        settled = true; clearTimeout(timer);
        try { resolve(prepareAsset(gltf)); }
        catch (err) { console.warn('[character] model loaded but could not be prepared:', err); resolve(null); }
      }, undefined, function (err) {
        if (settled) { return; }
        settled = true; clearTimeout(timer);
        console.warn('[character] ' + MODEL_URL + ' failed to load; keeping the jointed body:', err);
        resolve(null);
      });
    });
  }).then(function (asset) {
    _asset = asset;
    flushPending();
    return asset;
  });
  return _assetPromise;
}

/* Pull the loaded glTF apart into the handful of things we actually reuse. */
function prepareAsset(gltf) {
  var src = gltf.scene || (gltf.scenes && gltf.scenes[0]);
  if (!src) { throw new Error('glTF had no scene'); }

  var map = null;
  src.traverse(function (o) {
    if (o.isMesh && o.material && o.material.map && !map) { map = o.material.map; }
    if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; }
  });

  var clips = {};
  var list = gltf.animations || [];
  for (var i = 0; i < list.length; i++) { clips[list[i].name] = list[i]; }
  for (var key in CLIPS) {
    if (!clips[CLIPS[key]]) { throw new Error('model is missing the ' + CLIPS[key] + ' clip'); }
  }

  /* No mixer ever plays on the source graph - it is a template - so freeze
     its matrices out of the per-frame update. */
  src.updateMatrixWorld(true);

  return { src: src, map: map, clips: clips, scale: MODEL_H / BIND_H };
}

/* Bodies built before the model arrived, waiting to be swapped. Held weakly
   in spirit if not in fact: disposeCharacter() marks them dead and they are
   dropped here rather than resurrected. */
var _pending = [];
function flushPending() {
  var list = _pending;
  _pending = [];
  for (var i = 0; i < list.length; i++) {
    if (!list[i].dead) { dressInModel(list[i]); }
  }
}

/* ==========================================================================
   Cloning the rig

   three ships SkeletonUtils.clone() for this, but it is another addon behind
   another dynamic import and another chance to fail at exactly the moment
   somebody joins. It is also forty lines. Object3D.clone() already copies the
   graph - bones included, and shares geometry, which is what we want - it
   just leaves every cloned SkinnedMesh bound to the ORIGINAL skeleton, so all
   the clones would move as one. Rebinding is the whole job.
   ========================================================================== */
function cloneRig(THREE, src) {
  var clone = src.clone(true);

  var srcSkinned = [], dstSkinned = [], dstBones = {};
  src.traverse(function (o) { if (o.isSkinnedMesh) { srcSkinned.push(o); } });
  clone.traverse(function (o) {
    if (o.isSkinnedMesh) { dstSkinned.push(o); }
    if (o.isBone) { dstBones[o.name] = o; }
  });

  for (var i = 0; i < dstSkinned.length; i++) {
    var s = srcSkinned[i], d = dstSkinned[i];
    var bones = [], ok = true;
    for (var b = 0; b < s.skeleton.bones.length; b++) {
      var bone = dstBones[s.skeleton.bones[b].name];
      if (!bone) { ok = false; break; }
      bones.push(bone);
    }
    if (!ok) { continue; } /* leave it bound to the template rather than crash */
    d.bind(new THREE.Skeleton(bones, s.skeleton.boneInverses), s.bindMatrix);
  }
  return clone;
}

/* ==========================================================================
   The one material each body wears

   Every part of the character samples the same 16 KB palette atlas, so one
   MeshToonMaterial dresses the whole figure - one material, one program, one
   texture upload, per person. Per-player colour is three uniforms and three
   rectangle tests in the fragment shader: inside a rectangle the texel is
   flattened to its own luminance and re-tinted, which swaps the colour while
   keeping the hand-painted light-to-dark gradient the artist put in the
   swatch. Outside them - skin, leather, metal, eyes - nothing is touched.
   ========================================================================== */
function bodyMaterial(THREE, map, id) {
  var m = new THREE.MeshToonMaterial({ map: map, gradientMap: toonRamp() });

  var tints = {
    uGarment: new THREE.Color(pick(SHIRT, id, 2)),
    uTrouser: new THREE.Color(pick(TROUSER, id, 3)),
    uHair: new THREE.Color(pick(HAIR, id, 4))
  };

  m.onBeforeCompile = function (sh) {
    /* r152 renamed the map varying from vUv to vMapUv. onBeforeCompile runs
       before the #includes are resolved, so the varying is not in the shader
       text yet - ask the chunk it comes from instead of betting on whichever
       three the CDN handed us. */
    var chunk = (THREE.ShaderChunk && THREE.ShaderChunk.map_fragment) || '';
    var uv = chunk.indexOf('vMapUv') >= 0 ? 'vMapUv' : 'vUv';
    var decl = '', body = '';
    for (var i = 0; i < TINT_RECTS.length; i++) {
      var r = TINT_RECTS[i];
      sh.uniforms[r.key] = { value: tints[r.key] };
      decl += 'uniform vec3 ' + r.key + ';\n';
      body += '    if (' + uv + '.x >= ' + r.u0.toFixed(4) + ' && ' + uv + '.x < ' + r.u1.toFixed(4) +
              ' && ' + uv + '.y >= ' + r.v0.toFixed(4) + ' && ' + uv + '.y < ' + r.v1.toFixed(4) + ') { _tint = ' + r.key + '; _on = 1.0; }\n';
    }
    sh.fragmentShader = decl + sh.fragmentShader.replace(
      '#include <map_fragment>',
      '#include <map_fragment>\n' +
      '  {\n' +
      '    vec3 _tint = vec3(1.0); float _on = 0.0;\n' + body +
      '    float _l = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));\n' +
      '    diffuseColor.rgb = mix(diffuseColor.rgb, _tint * (0.30 + _l * 1.05), _on * 0.92);\n' +
      '  }\n'
    );
  };

  withRim(m, 0.30);
  /* withRim stamps its own cache key, which would let three hand this
     material the untinted program compiled for some other object */
  m.customProgramCacheKey = function () { return 'meadow-body'; };
  return m;
}

/* ==========================================================================
   Swapping the jointed placeholder for the real body
   ========================================================================== */
function dressInModel(ch) {
  if (!_asset || ch.rig || ch.dead) { return; }
  var THREE = window.THREE;
  if (!THREE) { return; }

  var rig;
  try { rig = cloneRig(THREE, _asset.src); }
  catch (err) { console.warn('[character] could not clone the rig:', err); return; }

  var mat = bodyMaterial(THREE, _asset.map, ch.id);
  var head = null;
  rig.traverse(function (o) {
    if (!o.isMesh) { return; }
    o.material = mat;
    o.castShadow = false;
    o.receiveShadow = false;
    /* a skinned mesh's bounds are the bind pose, which is a T-pose two metres
       wide - culling against that is worse than not culling at all here */
    o.frustumCulled = false;
    if (/head/i.test(o.name)) { head = o; }
  });

  /* you cannot see your own head */
  if (ch.firstPerson && head) { head.visible = false; }

  rig.scale.setScalar(_asset.scale);
  rig.position.y = 0;
  /* KayKit authors its characters facing +Z. Everything in this game - the
     jointed fallback body, faceCharacter(), and the yaw that comes down the
     wire - assumes -Z is forward, so without this the model is turned a full
     half-circle: you see people's backs when they face you, and anyone
     walking towards you appears to be walking away backwards. Rotating the
     rig INSIDE root, rather than adding PI in faceCharacter(), keeps the
     correction with the asset that needs it and leaves the fallback right. */
  rig.rotation.y = Math.PI;

  /* the placeholder has done its job */
  if (ch.fallback) {
    ch.root.remove(ch.fallback.group);
    disposeBranch(ch.fallback.group);
    for (var i = 0; i < ch.fallback.mats.length; i++) {
      if (ch.fallback.mats[i].dispose) { ch.fallback.mats[i].dispose(); }
    }
    ch.fallback = null;
  }

  ch.root.add(rig);
  ch.rig = rig;
  ch.mats = [mat];
  ch.parts = {};
  ch.headBone = null;
  rig.traverse(function (o) { if (o.isBone && o.name === 'head') { ch.headBone = o; } });

  ch.mixer = new THREE.AnimationMixer(rig);
  ch.actions = {};
  ch.weight = {};
  for (var key in CLIPS) {
    var a = ch.mixer.clipAction(_asset.clips[CLIPS[key]]);
    a.setLoop(THREE.LoopRepeat, Infinity);
    a.enabled = (key === 'idle');
    a.setEffectiveWeight(key === 'idle' ? 1 : 0);
    a.play();
    ch.actions[key] = a;
    ch.weight[key] = (key === 'idle') ? 1 : 0;
  }
  ch.state = 'idle';

  /* metres per second each gait covers at timeScale 1, once the model has
     been scaled to MODEL_H */
  ch.refWalk = CLIP_SPEED.walk * _asset.scale;
  ch.refRun = CLIP_SPEED.run * _asset.scale;
  /* the walk is allowed to be played up to WALK_MAX faster than natural
     before it stops reading as a walk; past that speed it hands over */
  ch.runFrom = ch.refWalk * WALK_MAX;
}

/* ==========================================================================
   The fallback body - jointed, not skinned

   Kept intact from before the model existed. Deliberately jointed: a rigged
   body needs a loader and a download, and this one has to exist before either
   of those can finish. A few hundred triangles, animated on the CPU for
   almost nothing, and correct the instant it is built.
   ========================================================================== */
function box(THREE, w, h, d) { return new THREE.BoxGeometry(w, h, d); }

/* tapered limb: wide end at local +Y, narrow end at local -Y. Six sides is
   enough for the eye to read "rounded" under banded toon light while
   staying at 4 * segments triangles. */
function cyl(THREE, topR, botR, h, seg) {
  return new THREE.CylinderGeometry(topR, botR, h, seg || 6);
}

function cone(THREE, r, h, seg) { return new THREE.ConeGeometry(r, h, seg || 6); }

function limbMat(THREE, colour) {
  return withRim(new THREE.MeshToonMaterial({
    color: new THREE.Color(colour),
    gradientMap: toonRamp()
  }), 0.35);
}

/* flat, unlit accent for the eyes - they read as dark shapes at any light
   angle, the way a painted anime face does, not as shaded geometry. */
function eyeMat(THREE) {
  return new THREE.MeshBasicMaterial({ color: new THREE.Color(EYE) });
}

function buildJointedBody(THREE, id, firstPerson) {
  var skin = limbMat(THREE, pick(SKIN, id, 1));
  var shirt = limbMat(THREE, pick(SHIRT, id, 2));
  var trouser = limbMat(THREE, pick(TROUSER, id, 3));
  var hair = limbMat(THREE, pick(HAIR, id, 4));

  var group = new THREE.Group();
  var parts = {};
  var eyeMaterial = null;

  /* --- torso: shoulders wider than the waist, so the silhouette reads as a
     body rather than a crate */
  var torso = new THREE.Mesh(cyl(THREE, 0.205, 0.165, 0.58), shirt);
  torso.position.y = 1.16;
  group.add(torso);
  parts.torso = torso;
  parts.torsoBaseY = 1.16;

  /* pelvis is its own group so the walk can counter-rotate the hips against
     the shoulders - real gait, cheap to fake */
  var pelvis = new THREE.Group();
  pelvis.position.y = 0.86;
  pelvis.add(new THREE.Mesh(cyl(THREE, 0.15, 0.185, 0.16), trouser));
  group.add(pelvis);
  parts.pelvis = pelvis;
  parts.pelvisBaseY = 0.86;

  if (!firstPerson) {
    var neck = new THREE.Mesh(box(THREE, 0.12, 0.07, 0.12), skin);
    neck.position.y = 1.48;
    group.add(neck);

    var head = new THREE.Group();
    head.position.y = 1.66;
    var skull = new THREE.Mesh(new THREE.SphereGeometry(0.155, 8, 6), skin);
    skull.scale.set(1.0, 1.08, 0.9);
    head.add(skull);

    eyeMaterial = eyeMat(THREE);
    var eyeGeo = new THREE.CircleGeometry(0.028, 8);
    var eyeL = new THREE.Mesh(eyeGeo, eyeMaterial);
    eyeL.position.set(-0.058, 0.005, 0.148);
    eyeL.rotation.y = -0.15;
    head.add(eyeL);
    var eyeR = new THREE.Mesh(eyeGeo, eyeMaterial);
    eyeR.position.set(0.058, 0.005, 0.148);
    eyeR.rotation.y = 0.15;
    head.add(eyeR);

    var hairCap = new THREE.Mesh(
      new THREE.SphereGeometry(0.168, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.62), hair);
    hairCap.position.y = 0.05;
    head.add(hairCap);

    var hairBack = new THREE.Mesh(box(THREE, 0.27, 0.22, 0.10), hair);
    hairBack.position.set(0, -0.02, -0.095);
    head.add(hairBack);

    var bangL = new THREE.Mesh(cone(THREE, 0.05, 0.16, 6), hair);
    bangL.position.set(-0.10, 0.06, 0.115);
    bangL.rotation.set(-1.65, 0, 0.35);
    head.add(bangL);
    var bangR = new THREE.Mesh(cone(THREE, 0.05, 0.16, 6), hair);
    bangR.position.set(0.10, 0.06, 0.115);
    bangR.rotation.set(-1.65, 0, -0.35);
    head.add(bangR);

    group.add(head);
    parts.head = head;
    parts.headBaseY = 1.66;
  }

  function arm(side) {
    var shoulder = new THREE.Group();
    shoulder.position.set(side * 0.265, 1.42, 0);
    var upper = new THREE.Mesh(cyl(THREE, 0.062, 0.05, 0.30), shirt);
    upper.position.y = -0.15;
    shoulder.add(upper);
    var elbow = new THREE.Group();
    elbow.position.y = -0.30;
    shoulder.add(elbow);
    var lower = new THREE.Mesh(cyl(THREE, 0.05, 0.038, 0.28), skin);
    lower.position.y = -0.14;
    elbow.add(lower);
    group.add(shoulder);
    return { shoulder: shoulder, elbow: elbow };
  }
  var armL = arm(-1), armR = arm(1);
  parts.armL = armL.shoulder; parts.armR = armR.shoulder;
  parts.elbowL = armL.elbow; parts.elbowR = armR.elbow;

  function leg(side) {
    var hip = new THREE.Group();
    hip.position.set(side * 0.115, 0.86, 0);
    var upper = new THREE.Mesh(cyl(THREE, 0.095, 0.072, 0.36), trouser);
    upper.position.y = -0.18;
    hip.add(upper);
    var knee = new THREE.Group();
    knee.position.y = -0.36;
    hip.add(knee);
    var lower = new THREE.Mesh(cyl(THREE, 0.068, 0.05, 0.34), trouser);
    lower.position.y = -0.17;
    knee.add(lower);
    var foot = new THREE.Mesh(box(THREE, 0.13, 0.08, 0.24), hair);
    foot.position.set(0, -0.375, 0.04);
    knee.add(foot);
    group.add(hip);
    return { hip: hip, knee: knee };
  }
  var legL = leg(-1), legR = leg(1);
  parts.legL = legL.hip; parts.legR = legR.hip;
  parts.kneeL = legL.knee; parts.kneeR = legR.knee;

  group.traverse(function (o) {
    if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; }
  });

  var mats = [skin, shirt, trouser, hair];
  if (eyeMaterial) { mats.push(eyeMaterial); }
  return { group: group, parts: parts, mats: mats };
}

function disposeBranch(obj) {
  obj.traverse(function (o) {
    if (o.geometry && o.geometry.dispose) { o.geometry.dispose(); }
  });
}

/* ==========================================================================
   Build one body. Returns { root, parts, ... }; net.js adds root to the scene
   on the very next line, so this MUST stay synchronous and MUST return
   something with a body already in it.
   ========================================================================== */
function buildCharacter(THREE, id, opts) {
  opts = opts || {};
  var firstPerson = !!opts.firstPerson;

  var ch = {
    root: new THREE.Group(),
    parts: {}, mats: [],
    phase: 0, idlePhase: Math.random() * 6.28,
    id: id | 0, firstPerson: firstPerson,
    rig: null, mixer: null, actions: null, weight: null,
    headBone: null, pitch: 0, dead: false
  };

  var fb = buildJointedBody(THREE, ch.id, firstPerson);
  ch.root.add(fb.group);
  ch.fallback = fb;
  ch.parts = fb.parts;
  ch.mats = fb.mats;

  if (_asset) {
    dressInModel(ch);            /* model already warm: no placeholder is ever seen */
  } else {
    _pending.push(ch);
    loadAsset();
  }
  return ch;
}

/* ==========================================================================
   Animation

   Two bodies, two ways to move them. The rigged path drives the real clips
   through an AnimationMixer; the jointed path is the old hand-written walk
   cycle, unchanged, for as long as the placeholder is standing in.
   ========================================================================== */

var STAND_STILL = 0.4;   /* m/s below which somebody is standing, not walking */
var WALK_MAX = 1.9;      /* fastest the walk clip may be pushed before it runs */
var RUN_MIN = 0.85, RUN_MAX = 1.85;
var BLEND_RATE = 11;     /* gait crossfades settle in about 100 ms */

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function animateRigged(ch, dt, speed, airborne) {
  var want = airborne ? 'air'
    : (speed < STAND_STILL ? 'idle' : (speed < ch.runFrom ? 'walk' : 'run'));

  /* Play each gait at the rate the ground is going past underneath it. The
     walk is exact until it saturates; the run's exponent lets a very fast
     sprint stay legible instead of turning into a blur - the same flattening
     the hand-written cycle used, for the same reason. */
  ch.actions.walk.timeScale = clamp(speed / ch.refWalk, 0.75, WALK_MAX);
  ch.actions.run.timeScale = clamp(Math.pow(speed / ch.refRun, 0.6), RUN_MIN, RUN_MAX);

  if (want !== ch.state) {
    var from = ch.actions[ch.state], to = ch.actions[want];
    if ((ch.state === 'walk' && want === 'run') || (ch.state === 'run' && want === 'walk')) {
      /* Hand the stride over mid-step instead of restarting it. Without this
         the moment you break into a run the near leg jumps back to whatever
         pose frame 0 of the run happens to be, and you get a visible hitch
         and a half-step every single time. */
      var d = from.getClip().duration;
      to.time = d > 0 ? (from.time % d) / d * to.getClip().duration : 0;
    } else if (want === 'walk' || want === 'run') {
      to.time = 0;   /* leaving idle or landing: start a clean stride */
    }
    to.enabled = true;
    ch.state = want;
  }

  var k = 1 - Math.exp(-dt * BLEND_RATE);
  for (var name in ch.actions) {
    var a = ch.actions[name];
    var w = ch.weight[name];
    w += ((name === ch.state ? 1 : 0) - w) * k;
    if (w < 0.002) { w = 0; }
    ch.weight[name] = w;
    /* a disabled action is skipped by the mixer outright - with four clips
       per person and a meadow full of people, not evaluating the three that
       contribute nothing is most of the animation budget */
    a.enabled = w > 0;
    a.setEffectiveWeight(w);
  }

  ch.mixer.update(dt);

  /* The mixer has just overwritten the head bone, so the look-up/look-down
     pitch has to go on afterwards or it is lost. Bones point along their own
     +Y, so a nod is a turn about local X. */
  if (ch.headBone && ch.pitch) {
    ch.headBone.rotateX(clamp(ch.pitch, -0.55, 0.55));
  }
}

/* `speed` is horizontal metres/sec, `dt` seconds. */
function animateCharacter(ch, dt, speed, airborne) {
  if (ch.mixer) { animateRigged(ch, dt, speed, airborne); return; }

  var p = ch.parts;
  var moving = speed > STAND_STILL;
  var running = speed > 6.2;

  /* idle clock always ticks, independent of stride, so breathing never
     freezes on whatever pose the legs happened to stop mid-stride. */
  ch.idlePhase = (ch.idlePhase || 0) + dt;

  var freq = moving ? Math.min(2.2 + speed * 0.62, 9.4) : 0;
  ch.phase += dt * freq;

  var swing = moving ? Math.min(speed / 4.6, 1.6) : 0;
  var s = Math.sin(ch.phase);
  var c = Math.cos(ch.phase);

  if (airborne) {
    if (p.legL) { p.legL.rotation.x = -0.55; }
    if (p.legR) { p.legR.rotation.x = -0.25; }
    if (p.kneeL) { p.kneeL.rotation.x = -1.15; }
    if (p.kneeR) { p.kneeR.rotation.x = -0.85; }
    if (p.armL) { p.armL.rotation.x = -1.5; p.armL.rotation.z = 0.09; }
    if (p.armR) { p.armR.rotation.x = -1.4; p.armR.rotation.z = -0.09; }
    if (p.elbowL) { p.elbowL.rotation.x = -0.9; }
    if (p.elbowR) { p.elbowR.rotation.x = -0.75; }
    if (p.torso) { p.torso.rotation.x = 0.12; p.torso.rotation.y = 0; }
    if (p.pelvis) { p.pelvis.rotation.y = 0; }
    return;
  }

  if (!moving) {
    var breathe = Math.sin(ch.idlePhase * 1.15);
    if (p.torso) {
      p.torso.position.y = p.torsoBaseY + breathe * 0.006;
      p.torso.rotation.x = breathe * 0.012;
      p.torso.rotation.y = 0;
    }
    if (p.pelvis) { p.pelvis.rotation.y = 0; p.pelvis.position.y = p.pelvisBaseY; }
    if (p.armL) { p.armL.rotation.x = breathe * 0.03; p.armL.rotation.z = 0.09; }
    if (p.armR) { p.armR.rotation.x = -breathe * 0.03; p.armR.rotation.z = -0.09; }
    if (p.elbowL) { p.elbowL.rotation.x = -0.12; }
    if (p.elbowR) { p.elbowR.rotation.x = -0.12; }
    if (p.legL) { p.legL.rotation.x = 0; }
    if (p.legR) { p.legR.rotation.x = 0; }
    if (p.kneeL) { p.kneeL.rotation.x = 0; }
    if (p.kneeR) { p.kneeR.rotation.x = 0; }
    if (p.head) {
      p.head.rotation.z = breathe * 0.012;
      p.head.rotation.y = Math.sin(ch.idlePhase * 0.4) * 0.04;
      p.head.position.y = p.headBaseY + breathe * 0.003;
    }
    return;
  }

  var gait = running ? 1.22 : 1.0;
  var strideAmt = 0.72 * swing * gait;
  var armAmt = 0.55 * swing * gait;

  if (p.legL) { p.legL.rotation.x = s * strideAmt; }
  if (p.legR) { p.legR.rotation.x = -s * strideAmt; }

  var kneeAmt = Math.min(1.35, (running ? 1.5 : 1.05) * swing);
  if (p.kneeL) { p.kneeL.rotation.x = -Math.max(0, -s) * kneeAmt; }
  if (p.kneeR) { p.kneeR.rotation.x = -Math.max(0, s) * kneeAmt; }

  if (p.armL) { p.armL.rotation.x = -s * armAmt; p.armL.rotation.z = 0.09; }
  if (p.armR) { p.armR.rotation.x = s * armAmt; p.armR.rotation.z = -0.09; }
  var elbowAmt = 0.85 * swing;
  if (p.elbowL) { p.elbowL.rotation.x = -0.12 - Math.max(0, s) * elbowAmt; }
  if (p.elbowR) { p.elbowR.rotation.x = -0.12 - Math.max(0, -s) * elbowAmt; }

  var bounce = (Math.abs(c) - 0.5) * 2 * 0.05 * swing;

  if (p.torso) {
    p.torso.position.y = p.torsoBaseY + bounce;
    p.torso.rotation.x = (running ? 0.16 : 0.045) * swing;
    p.torso.rotation.y = -s * 0.07 * swing;
  }
  if (p.pelvis) {
    p.pelvis.position.y = p.pelvisBaseY + bounce * 0.6;
    p.pelvis.rotation.y = s * 0.10 * swing;
  }
  if (p.head) {
    p.head.position.y = p.headBaseY + bounce * 0.25;
    p.head.rotation.y = s * 0.05 * swing;
    p.head.rotation.z = 0;
  }
}

/* Point a remote body along its heading, and tilt the head to match where
   that person is actually looking. net.js calls this immediately before
   animate(), which is where the rigged body's pitch is applied - the mixer
   would otherwise wipe it out on the same frame. */
function faceCharacter(ch, yaw, pitch) {
  ch.root.rotation.y = yaw;
  ch.pitch = pitch || 0;
  if (ch.parts.head) {
    ch.parts.head.rotation.x = clamp(pitch || 0, -0.6, 0.6);
  }
}

function disposeCharacter(ch) {
  ch.dead = true;
  if (ch.mixer) {
    ch.mixer.stopAllAction();
    if (ch.mixer.uncacheRoot) { ch.mixer.uncacheRoot(ch.rig); }
    ch.mixer = null;
  }
  /* The rig's geometries and its texture are the shared asset - every other
     person in the meadow is drawn with them. Only the placeholder's
     geometry, which was built per body, is ours to free. */
  if (ch.fallback) { disposeBranch(ch.fallback.group); }
  for (var i = 0; i < ch.mats.length; i++) {
    if (ch.mats[i] && ch.mats[i].dispose) { ch.mats[i].dispose(); }
  }
  ch.mats = [];
  if (ch.root.parent) { ch.root.parent.remove(ch.root); }
}

/* Start fetching the model now, so the first person to join is already
   wearing it. Safe to call more than once; safe to never call at all. */
function preloadCharacter() { return loadAsset(); }
preloadCharacter();

/* net.js is a plain script, not a module, so it cannot import. Publish the
   same functions on window for it to pick up. */
window.MeadowCharacter = {
  build: buildCharacter,
  animate: animateCharacter,
  face: faceCharacter,
  dispose: disposeCharacter,
  preload: preloadCharacter
};

export { buildCharacter, animateCharacter, faceCharacter, disposeCharacter, preloadCharacter };
