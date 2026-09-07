/* Whispering Meadow - player.js
   Extracted from the original single file. Logic unchanged. */

import { footstep } from './audio.js';
import { _e, HALF, camera, clamp, terrainHeight } from './core.js';
import { onResize } from './post.js';
import { bridgeY } from './props.js';
var P = {
  pos: null, vel: null, yaw: 0.12, pitch: -0.03,
  ground: 0, onGround: true, bob: 0, bobAmt: 0
};

var keys = {}, playing = false, started = false, ready = false;

var WALK = 4.6, RUN = 9.4, EYE = 1.82;
var TOUCH_LOOK = 0.0055;   /* radians of turn per screen pixel of thumb drag */   /* raised from 1.68 - the view sat too low */

/* ---------------------------------------------------------------- touch?
   Pointer lock does not exist on phones, and the game gates `playing` on
   pointerlockchange - so on a touch device the world would load and then
   never start. Everything below routes around that. */
var _isTouch = null;
function isTouchDevice() {
  if (_isTouch !== null) { return _isTouch; }
  var coarse = false;
  try { coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches; } catch (e) {}
  _isTouch = (navigator.maxTouchPoints > 0 || 'ontouchstart' in window) && coarse;
  return _isTouch;
}

/* main.js flips this once the player has tapped Enter on a touch device */
function setPlaying(v) { playing = v; }

/* The touch layer (game/touch.js) registers itself here. On desktop this
   stays null and nothing below costs anything. */
var touchAPI = null;
function setTouchAPI(api) { touchAPI = api; }

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
  if (touchAPI && touchAPI.isActive()) {
    var mv = touchAPI.getMove();
    if (mv && (mv.x || mv.y)) { f = mv.y; s = mv.x; }
    var lk = touchAPI.consumeLook();
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
    if (touchAPI.isSprinting()) { keys.shift = true; } else { keys.shift = false; }
    keys.space = !!touchAPI.isJumping();
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
  var bobY = Math.sin(P.bob * 2) * 0.034 * P.bobAmt;
  var bobR = Math.sin(P.bob) * 0.0035 * P.bobAmt;
  camera.position.set(P.pos.x, P.pos.y + EYE + bobY, P.pos.z);
  _e.set(P.pitch, P.yaw, bobR, 'YXZ');
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
  window.addEventListener('blur', function () { keys = {}; });
  document.addEventListener('mousemove', function (e) {
    if (!playing) { return; }
    var St = window.MeadowSettings;
    var ms = St ? St.lookSens() : 1.0;
    var inv = St && St.invertY() ? -1 : 1;
    P.yaw -= e.movementX * 0.0021 * ms;
    P.pitch -= e.movementY * 0.0021 * ms * inv;
    P.pitch = clamp(P.pitch, -1.45, 1.42);
  });
  document.addEventListener('pointerlockchange', function () {
    /* On a touch device there is no pointer lock to gain or lose, so this
       must not be allowed to force `playing` back to false. */
    if (isTouchDevice()) { return; }
    var locked = document.pointerLockElement === document.body;
    playing = locked && started;
    document.getElementById('paused').classList.toggle('hidden', !(started && !locked));
    document.getElementById('frame').classList.toggle('on', playing);
    if (!locked) { keys = {}; }
  });

  /* Phones pause by being backgrounded, not by losing a pointer lock. */
  document.addEventListener('visibilitychange', function () {
    if (!isTouchDevice()) { return; }
    if (document.hidden) { playing = false; keys = {}; }
    else if (started) { playing = true; }
  });
  window.addEventListener('resize', onResize);
}

function lockPointer() {
  var el = document.body;
  if (el.requestPointerLock) { el.requestPointerLock(); }
}

/* ======================================================================== *
 *  BOOT
 * ======================================================================== */

/* main.js drives the boot sequence, so it needs to flip these */
function setReady(v) { ready = v; }
function setStarted(v) { started = v; }

export { setTouchAPI, setPlaying, isTouchDevice, setReady, setStarted, EYE, P, RUN, WALK, bindInput, canStand, keyName, keys, lockPointer, playerStart, playing, ready, started, updatePlayer };
