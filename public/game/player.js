/* Whispering Meadow - player.js
   Extracted from the original single file. Logic unchanged. */

import { footstep } from './audio.js';
import { _e, HALF, camera, clamp, terrainHeight } from './core.js';
import { onResize } from './post.js';
import { bridgeY } from './props.js';
var P = {
  pos: null, vel: null, yaw: 0.97, pitch: -0.10,   /* facing down the walkway, into the low sun */
  ground: 0, onGround: true, bob: 0, bobAmt: 0
};

var keys = {};

var WALK = 4.6, RUN = 9.4, EYE = 1.82;
/* Third person: the camera orbits a point just above the little one's head,
   CAM_DIST behind it along the view direction. Looking up swings the camera
   down toward the grass, which is exactly the "look up through the trees"
   shot the wood is built for. */
var CAM_DIST = 4.3, CAM_H = 1.45, CAM_FLOOR = 0.45;
var TOUCH_LOOK = 0.0055;   /* radians of turn per screen pixel of thumb drag */

/* ---------------------------------------------------------------- who owns
   `playing`?  ui/ui.js does, and that is the point.

   This file used to own it, and drive it from pointerlockchange. Pointer lock
   does not exist on a touch device, so on a phone the branch that showed the
   pause screen could never run - there was no pause at all - and the one that
   set `playing` had to be bypassed by main.js calling setPlaying(true) by
   hand. Two sources of truth for one piece of state, and the phone got the
   broken one.

   There is now one state machine, in the interface layer, and everything here
   reads from it. Pointer lock FOLLOWS that state instead of defining it. */
function uiPlaying() {
  var U = window.MeadowUI;
  return U ? U.isPlaying() : false;
}

/* The touch controls, if this device has any. Looked up lazily and cached:
   ui/ui.js builds them during DOMContentLoaded, which may be after this
   module is evaluated. */
var touchAPI = null;
function touch() {
  if (touchAPI) { return touchAPI; }
  var U = window.MeadowUI;
  if (U && U.input) { touchAPI = U.input(); }
  return touchAPI;
}

function playerStart() {
  P.pos = new THREE.Vector3(60, 0, 205);
  P.vel = new THREE.Vector3();
  P.ground = terrainHeight(P.pos.x, P.pos.z);
  P.pos.y = P.ground;
}

function canStand(x, z, fromH, moved) {
  var h = terrainHeight(x, z);
  var by = bridgeY(x, z);
  if (by > h) { h = by; }
  else if (h < -0.60) { return -999; }
  if (h - fromH > 2.4 * moved + 0.30) { return -999; }
  return h;
}

function updatePlayer(dt) {
  var f = (keys.w ? 1 : 0) - (keys.s ? 1 : 0);
  var s = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);

  /* --- touch input folds in here, so everything downstream (collision,
     bob, footsteps, the network layer) works unchanged on a phone --- */
  var tc = touch();
  if (tc && tc.isActive()) {
    var mv = tc.getMove();
    if (mv && (mv.x || mv.y)) { f = mv.y; s = mv.x; }
    var lk = tc.consumeLook();
    if (lk && (lk.dx || lk.dy)) {
      var St = window.MeadowSettings;
      /* A thumb drag covers far less screen than a mouse sweep, so matching
         the mouse constant felt wildly fast. Default touchSens is 0.45. */
      var ts = St ? St.touchSens() : 1.0;
      var inv = St && St.invertY() ? -1 : 1;
      /* consumeLook() hands back RAW SCREEN PIXELS. The mouse path below
         multiplies those by 0.0021 rad/px; this path did not, so touchSens
         was being used as radians-per-pixel directly - about 476x too fast.
         That is why the phone felt uncontrollable even at the slider's
         minimum. TOUCH_LOOK is a little above the mouse constant on purpose:
         a thumb can only drag a fraction of the screen, so it needs more
         turn per pixel to cover 180 degrees in about two swipes. */
      P.yaw -= lk.dx * TOUCH_LOOK * ts;
      P.pitch = clamp(P.pitch - lk.dy * TOUCH_LOOK * ts * inv, -1.45, 1.42);
    }
    keys.shift = !!tc.isSprinting();
    keys.space = !!tc.isJumping();
  }
  var l = Math.sqrt(f * f + s * s);
  /* Was `l > 0`, which normalised EVERY input to a unit vector. Fine for
     boolean WASD, but it means a gentle joystick push runs at full speed -
     no analog control at all on a phone. `l > 1` only clamps the diagonal
     case, so keyboard behaviour is byte-identical and a soft push stays soft. */
  if (l > 1) { f /= l; s /= l; }
  var sy = Math.sin(P.yaw), cy = Math.cos(P.yaw);
  var wx = -sy * f + cy * s;
  var wz = -cy * f - sy * s;
  var spd = keys.shift ? RUN : WALK;
  /* the meadow slows you down a little; the beach does not */
  var rate = 1 - Math.exp(-(P.onGround ? 10.0 : 1.8) * dt);
  P.vel.x += (wx * spd - P.vel.x) * rate;
  P.vel.z += (wz * spd - P.vel.z) * rate;
  P.vel.y -= 21.5 * dt;

  var px = P.pos.x, pz = P.pos.z;
  /* Keep the player on the plate. Derived from HALF so shrinking the world
     in core.js cannot leave a stale literal letting people walk off the edge. */
  var EDGE = HALF - 60;
  var nx = clamp(px + P.vel.x * dt, -EDGE, EDGE);
  var nz = clamp(pz + P.vel.z * dt, -EDGE, EDGE);
  var moved = Math.sqrt((nx - px) * (nx - px) + (nz - pz) * (nz - pz));
  var h = canStand(nx, nz, P.ground, moved);
  if (h === -999) {
    h = canStand(nx, pz, P.ground, Math.abs(nx - px));
    if (h !== -999) { nz = pz; P.vel.z *= 0.4; }
    else {
      h = canStand(px, nz, P.ground, Math.abs(nz - pz));
      if (h !== -999) { nx = px; P.vel.x *= 0.4; }
      else { nx = px; nz = pz; h = P.ground; P.vel.x *= 0.2; P.vel.z *= 0.2; }
    }
  }
  P.pos.x = nx; P.pos.z = nz; P.ground = h;

  P.pos.y += P.vel.y * dt;
  if (P.pos.y <= P.ground) {
    P.pos.y = P.ground;
    if (!P.onGround) { footstep(P.ground < 0.6); }
    P.onGround = true; P.vel.y = 0;
    if (keys.space) { P.vel.y = 7.1; P.onGround = false; }
  } else {
    P.onGround = false;
  }

  var hs = Math.sqrt(P.vel.x * P.vel.x + P.vel.z * P.vel.z);
  var want = P.onGround ? clamp(hs / WALK, 0, 1.7) : 0;
  P.bobAmt += (want - P.bobAmt) * Math.min(1, dt * 7);
  var was = Math.sin(P.bob * 2);
  P.bob += dt * hs * 1.45;
  var now = Math.sin(P.bob * 2);
  if (P.onGround && hs > 0.8 && was > 0 && now <= 0) { footstep(P.ground < 0.6); }

  /* The side-to-side roll is what reads as "wobble" and it makes people
     queasy fast. Keep a little vertical bounce for weight, and cut the roll
     to about a third of what it was. */
  /* The body does the bobbing now (see blob.js); the camera only follows,
     with a trace of the step in it so it does not feel bolted on. */
  var bobY = Math.sin(P.bob * 2) * 0.012 * P.bobAmt;
  var cp = Math.cos(P.pitch);
  var fx = -Math.sin(P.yaw) * cp, fy = Math.sin(P.pitch), fz = -Math.cos(P.yaw) * cp;
  var tx = P.pos.x, ty = P.pos.y + CAM_H + bobY, tz = P.pos.z;
  var cx = tx - fx * CAM_DIST, cy = ty - fy * CAM_DIST, cz = tz - fz * CAM_DIST;
  /* never under the ground: on a slope, or looking up, the camera rides up
     over the grass instead of clipping into the hill */
  var floor = terrainHeight(cx, cz) + CAM_FLOOR;
  if (cy < floor) { cy = floor; }
  camera.position.set(cx, cy, cz);
  _e.set(P.pitch, P.yaw, 0, 'YXZ');
  camera.quaternion.setFromEuler(_e);
}

/* ======================================================================== *
 *  INPUT
 * ======================================================================== */

function keyName(e) {
  var c = e.code;
  if (c === 'KeyW' || c === 'ArrowUp') return 'w';
  if (c === 'KeyS' || c === 'ArrowDown') return 's';
  if (c === 'KeyA' || c === 'ArrowLeft') return 'a';
  if (c === 'KeyD' || c === 'ArrowRight') return 'd';
  if (c === 'ShiftLeft' || c === 'ShiftRight') return 'shift';
  if (c === 'Space') return 'space';
  return null;
}

function bindInput() {
  window.addEventListener('keydown', function (e) {
    var k = keyName(e);
    if (k) { keys[k] = true; if (k === 'space') { e.preventDefault(); } }
  });
  window.addEventListener('keyup', function (e) {
    var k = keyName(e); if (k) { keys[k] = false; }
  });
  /* Alt-tabbing away with W held would otherwise leave you walking into the
     sea while the tab is in the background. */
  window.addEventListener('blur', function () { keys = {}; });

  document.addEventListener('mousemove', function (e) {
    if (!uiPlaying()) { return; }
    var St = window.MeadowSettings;
    var ms = St ? St.lookSens() : 1.0;
    var inv = St && St.invertY() ? -1 : 1;
    P.yaw -= e.movementX * 0.0021 * ms;
    P.pitch -= e.movementY * 0.0021 * ms * inv;
    P.pitch = clamp(P.pitch, -1.45, 1.42);
  });

  /* Keys are dropped whenever play stops, from wherever it stopped - a lost
     pointer lock, Escape, the pause button, the app being backgrounded. The
     interface layer knows about all of those; this file no longer has to
     enumerate them, which is what the old pair of pointerlockchange and
     visibilitychange handlers here were doing (and getting wrong on touch). */
  var U = window.MeadowUI;
  if (U) {
    U.on('statechange', function () {
      if (!U.isPlaying()) { keys = {}; }
    });
  }

  /* MUST stay registered before post.js's own resize work is needed - main.js
     relies on this listener having run by the time it redraws a single frame
     after a rotation. */
  window.addEventListener('resize', onResize);
}

export { EYE, P, RUN, WALK, bindInput, canStand, keyName, keys, playerStart, updatePlayer };
