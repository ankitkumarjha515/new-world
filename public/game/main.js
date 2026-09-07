/* Whispering Meadow - main.js
   Extracted from the original single file. Logic unchanged. */

import { audioIn, initAudio, updateAudio } from './audio.js';
import { initTouch } from './touch.js';
import { buildCharacter, animateCharacter } from './character.js';
import { SUN, camera, clamp, clock, initEngine, renderer, scene, smoothstep, terrainHeight, timeU } from './core.js';
import { buildCreatures, butterflies, updateCreatures } from './creatures.js';
import { buildGrassGrid, fillGrassTile, grassMat, grassQueue, updateGrass } from './grass.js';
import { buildMist, buildRainbow } from './particles.js';
import { setTouchAPI, setPlaying, isTouchDevice, WALK, setReady, setStarted, P, bindInput, lockPointer, playerStart, playing, ready, started, updatePlayer } from './player.js';
import { applyPostFX, getLODScale, initQuality, updatePerfHUD, autoQuality, fsPass, onResize, rtScene, setupPost } from './post.js';
import { useModelTrees, setPropLODScale, buildBridge, buildFlowers, buildGardenAccents, buildLandmarks, buildReeds, buildRocks, buildSunflowers, buildTrees, dumpLODReport, natureReady } from './props.js';
import { buildActors, updateActors } from './actors.js';
import { buildClouds, buildSky, skyMesh } from './sky.js';
import { buildVolcano } from './volcano.js';
import { buildCliffWall, genTerrain } from './terrain.js';
import { buildInlandWater, buildOcean, buildWaterfall, oceanMesh } from './water.js';
function setProgress(msg, f) {
  var el = document.getElementById('loadmsg');
  if (el) { el.textContent = msg + '…'; }
  var bar = document.querySelector('#bar > i');
  if (bar) { bar.style.width = Math.round(clamp(f, 0, 1) * 100) + '%'; }
}

function* boot() {
  yield ['Opening the sky', 0.01];
  buildSky();
  yield ['Opening the sky', 0.02];
  yield* genTerrain();
  yield ['Carving the cliff', 0.75];
  buildCliffWall();
  yield ['Letting the water in', 0.78];
  buildOcean();
  buildInlandWater();
  var fall = buildWaterfall();
  yield ['Gathering clouds', 0.81];
  buildClouds();
  yield ['Waking the mountain', 0.82];
  buildVolcano();
  yield ['Planting the woods', 0.83];
  buildTrees();
  yield ['Sowing the sunflowers', 0.87];
  buildSunflowers();
  yield ['Scattering wildflowers', 0.90];
  buildFlowers();
  yield ['Reeds by the water', 0.92];
  buildReeds();
  yield ['Setting the stones', 0.93];
  buildRocks();
  buildBridge();
  buildGardenAccents();
  /* AFTER every scatter above, and that ordering is the whole design:
     buildLandmarks() places into the gaps the others left, and it can only
     see those gaps once they exist. placeProps() is synchronous even for
     the modelled props - only their meshes arrive late - so by this line
     every position in the world has been decided. */
  yield ['Raising the old stones', 0.94];
  buildLandmarks();
  yield ['Waking the butterflies', 0.95];
  buildCreatures();
  buildActors();
  buildMist(fall);
  buildRainbow();
  yield ['Growing the grass', 0.96];
  buildGrassGrid();
  playerStart();
  updateGrass(P.pos.x, P.pos.z, 0);
  var total = grassQueue.length;
  while (grassQueue.length) {
    var job = grassQueue.shift();
    fillGrassTile(job[0], job[1], job[2]);
    if ((grassQueue.length & 3) === 0) {
      yield ['Growing the grass', 0.96 + 0.038 * (1 - grassQueue.length / Math.max(1, total))];
    }
  }
  setupPost();
  onResize();
  yield ['Ready', 1.0];
}

function runBoot() {
  var it = boot();
  function step() {
    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    var r;
    do {
      r = it.next();
      if (r.value) { setProgress(r.value[0], r.value[1]); }
      var t1 = (window.performance && performance.now) ? performance.now() : Date.now();
      if (t1 - t0 > 20) { break; }
    } while (!r.done);
    if (r.done) { onReady(); return; }
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

/* ?models=1 prints a one-line answer to "did the modelled prop set make it,
   and did its impostor atlas get baked?" - the quickest way to tell a
   asset-loading problem apart from a rendering one. Nothing is swapped:
   the nature set is the woods now, and the hand-written trees are planted
   beside it either way. */
function maybeUseModelTrees() {
  try {
    if (new URLSearchParams(location.search).get('models') === '1') {
      useModelTrees();
    }
  } catch (e) { /* never let this break the world */ }
}

/* Your own body. No head - a head in front of the camera is a wall of skull.
   Id 0 is reserved for "me" until the server hands out a real one. */
var selfBody = null;
function buildSelfBody() {
  if (selfBody) { return; }
  selfBody = buildCharacter(THREE, 0, { firstPerson: true });
  scene.add(selfBody.root);
}

function updateSelfBody(dt) {
  if (!selfBody) { return; }
  var hs = Math.sqrt(P.vel.x * P.vel.x + P.vel.z * P.vel.z);
  selfBody.root.position.set(P.pos.x, P.pos.y, P.pos.z);
  selfBody.root.rotation.y = P.yaw;
  animateCharacter(selfBody, dt, hs, !P.onGround);
}

/* Hand the network layer a read-only view of the player. It runs its own
   loop from here on and never touches the renderer, camera or game loop.
   If the server is unreachable the game simply carries on single-player. */
function connectMultiplayer() {
  if (!window.MeadowNet) { return; }
  try {
    window.MeadowNet.attach({
      THREE: THREE,
      scene: scene,
      getPlayer: function () {
        var hs = Math.sqrt(P.vel.x * P.vel.x + P.vel.z * P.vel.z);
        return {
          x: P.pos.x, y: P.pos.y, z: P.pos.z,
          yaw: P.yaw, pitch: P.pitch,
          moving: hs > 0.4,
          running: hs > WALK * 1.25,
          airborne: !P.onGround
        };
      }
    });
  } catch (e) { console.warn('[meadow] multiplayer unavailable', e); }
}

/* A read-only handle on the engine, for the perf HUD's benefit and for
   measuring a build from the console or a headless browser: draw calls,
   triangles and scene size are the numbers every decision in post.js and
   props.js is supposed to be answering to, and there was no way to read
   them from outside. Costs one property assignment, once. */
function exposeDebug() {
  try {
    window.__meadow = {
      renderer: renderer, scene: scene, camera: camera, player: P,
      /* draw one full frame - scene pass plus the whole post chain - without
         advancing the clock, so a screenshot of a given viewpoint is
         reproducible between builds */
      /* An explicit fade sticks, deliberately: the opening fade-to-black
         only lifts once you are actually playing, so a caller asking for
         fade 0 wants every frame from here on to be the world, not just
         this one - otherwise the next frame the browser happens to present
         is black again. */
      frame: function (fade) {
        if (fade !== undefined) { fadeIn = fade; }
        renderFrame(0);
      },
      /* ground height under a point, so an external camera can stand on
         the terrain instead of guessing a Y and ending up inside a hill */
      groundAt: function (x, z) { return terrainHeight(x, z); },
      stats: function () {
        var i = renderer.info;
        return {
          calls: i.render.calls, triangles: i.render.triangles,
          programs: i.programs ? i.programs.length : 0,
          textures: i.memory.textures, geometries: i.memory.geometries,
          children: scene.children.length
        };
      }
    };
    window.__renderOnce = function () { window.__meadow.frame(0); };
    /* Every natureScatter() registered its emit callback on this promise
       during boot, so a handler registered here runs after all of them:
       the flag means "the modelled props are actually in the scene", which
       is the only reliable point at which a screenshot is comparable. */
    window.__meadowSettled = false;
    natureReady.then(function (lib) {
      window.__natureProps = lib ? lib.order.length : 0;
      window.__meadowSettled = true;
      /* Every scatter has emitted by now, so every prop has chosen its rung.
         One table showing what each one measured and where it landed - the
         old hand-assigned classes hid their own mistakes, because a prop on
         the wrong distance looks exactly like a prop on the right one until
         you walk out to find it. */
      dumpLODReport();
    });
  } catch (e) { /* never let a debug hook break the world */ }
}

function onReady() {
  setReady(true);
  exposeDebug();
  document.getElementById('loading').classList.add('hidden');
  document.getElementById('start').classList.remove('hidden');
  /* draw one frame so the world is already there behind the title */
  updatePlayer(0.0001);
  renderFrame(0);
  setTouchAPI(initTouch({}));
  buildSelfBody();
  connectMultiplayer();
  animate();
  maybeUseModelTrees();
}

/* ======================================================================== *
 *  FRAME
 * ======================================================================== */

var _sunNDC = null, fadeIn = 1.0;

function renderFrame(dt) {
  /* The sky and the sea follow you; the sun no longer does. It used to be
     dragged along every frame to keep the shadow camera centred, and with
     shadows gone a directional light's position means nothing - only the
     direction from position to target, which is now fixed once in
     initEngine(). Two matrix updates a frame, deleted. */
  var px = P.pos.x, py = P.pos.y, pz = P.pos.z;
  skyMesh.position.set(px, py, pz);
  oceanMesh.position.set(Math.round(px / 8) * 8, 0, Math.round(pz / 8) * 8);
  if (grassMat) { grassMat.uniforms.uCam.value.set(px, py, pz); }

  renderer.setRenderTarget(rtScene);
  renderer.render(scene, camera);

  /* where is the sun on screen? */
  _sunNDC.set(px + SUN.x * 3000, py + SUN.y * 3000, pz + SUN.z * 3000).project(camera);
  var behind = _sunNDC.z > 1 || _sunNDC.z < -1;
  var offx = Math.abs(_sunNDC.x), offy = Math.abs(_sunNDC.y);
  var amt = behind ? 0 : (1 - smoothstep(0.5, 1.6, Math.max(offx, offy))) * 0.18;   /* sun shafts were washing the beach out */

  /* One call: on the LOW tier this skips bright-extract, god rays and both
     blur passes and composites straight from the scene target - 4 of the 6
     full-screen passes gone, which is where a weak GPU's time actually goes. */
  applyPostFX({ x: _sunNDC.x * 0.5 + 0.5, y: _sunNDC.y * 0.5 + 0.5 }, amt, fadeIn);
}

var tAcc = 0;

function animate() {
  requestAnimationFrame(animate);
  var dt = clock.getDelta();
  if (dt > 0.06) { dt = 0.06; }
  /* Nothing is drawn while a veil is up. Behind the title screen the frame
     came out solid black anyway - the opening fade only lifts once you are
     playing - so the phone was rendering the entire world, six full-screen
     passes and all, to produce black underneath an opaque menu. Paused is
     the same deal with a different picture: the canvas simply keeps the
     last frame it drew, which is the world you were standing in.
     The listener at the bottom of this file redraws once on resize, which
     is the one case where a stale canvas would show through wrong. */
  if (!playing) { return; }
  tAcc += dt;
  timeU.value = tAcc;
  updatePlayer(dt);
  updateSelfBody(dt);
  updatePerfHUD(dt);
  updateAudio(dt, P.pos.x, P.pos.y, P.pos.z);
  updateGrass(P.pos.x, P.pos.z, 1);
  updateCreatures(tAcc, P.pos.x, P.pos.z);
  updateActors(dt, P.pos.x, P.pos.z);
  if (fadeIn > 0) { fadeIn = Math.max(0, fadeIn - dt * 0.75); }
  else { autoQuality(dt); }
  renderFrame(dt);
}

/* The one case a frozen canvas gets it wrong: turning the phone, or
   resizing the window, while paused or on the title screen. post.js has
   already rebuilt its buffers by the time this runs (player.js registers
   that listener first, during bindInput), so one frame here is enough to
   refill a canvas that would otherwise be stretched or blank. */
window.addEventListener('resize', function () {
  if (ready && !playing) { renderFrame(0); }
});

/* ======================================================================== *
 *  GO
 * ======================================================================== */
window.__startWorld = function () {
  try {
    initEngine();
  } catch (err) {
    document.getElementById('loadmsg').textContent =
      'This browser could not start WebGL. Try Chrome, Edge or Firefox.';
    return;
  }
  _sunNDC = new THREE.Vector3();
  /* MUST run before runBoot(): buildGrassGrid() inside boot() reads the
     quality tier to size the grass ring, and that is baked in at build time.
     Called after boot it would have no effect on grass at all. */
  initQuality();
  /* MUST be between initQuality() and runBoot(). initQuality() is what
     decides which tier this device is on, and runBoot() is what plants the
     woods - and every hand-over distance is compiled into a shader as a
     literal the first time a prop's material is built, so a change made
     after that point would be read by nothing. */
  setPropLODScale(getLODScale());
  bindInput();
  runBoot();

  function enter() {
    if (!ready) { return; }
    if (!started) { setStarted(true); initAudio(); }
    audioIn();
    if (isTouchDevice()) {
      /* no pointer lock on a phone - just start */
      setPlaying(true);
      document.getElementById('frame').classList.add('on');
    } else {
      lockPointer();
    }
    document.getElementById('start').classList.add('hidden');
    document.getElementById('paused').classList.add('hidden');
  }
  document.getElementById('enter').addEventListener('click', enter);
  document.getElementById('resume').addEventListener('click', enter);
  document.addEventListener('click', function () {
    if (started && !playing) { enter(); }
  });
};

export { _sunNDC, animate, boot, fadeIn, onReady, renderFrame, runBoot, setProgress, tAcc };
