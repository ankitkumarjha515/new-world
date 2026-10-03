/* ==========================================================================
   WHISPERING MEADOW - touch controls

   Replaces game/touch.js. Three differences that matter:

   1. BOTH ORIENTATIONS. The old file put a full-screen "turn your device
      sideways" wall in front of anyone holding their phone upright, which is
      how most people pick a phone up. Layout is now entirely CSS (see the
      orientation blocks in ui.css) and this file never asks which way up the
      device is.

   2. POINTER EVENTS, not touch events. One code path instead of four, and
      setPointerCapture() means a drag that leaves the zone keeps being
      delivered - the old handlers lost the look-drag the moment a thumb
      crossed into the other half of the screen.

   3. SPRINT WITHOUT A SECOND THUMB. Double-tap the move zone to toggle
      sprint. The sprint pad stays for discoverability, but on a phone held
      in two hands the stick thumb is the only one free while walking.

   Exposes the same read-only shape player.js already consumes - isActive /
   getMove / consumeLook / isJumping / isSprinting - so the movement code is
   untouched.
   ========================================================================== */

import { icon } from './icons.js';

/* ==========================================================================
   Detection
   ========================================================================== */
var _isTouch = null;

function isTouchDevice() {
  if (_isTouch !== null) { return _isTouch; }
  /* ?touch=1 forces the controls on so the phone UI can be driven from a
     desktop browser; ?touch=0 forces them off. Without this there is no way
     to test either layout without the hardware in hand. */
  try {
    var q = new URLSearchParams(location.search).get('touch');
    if (q === '1') { _isTouch = true; return true; }
    if (q === '0') { _isTouch = false; return false; }
  } catch (e) { /* no URLSearchParams: fall through to detection */ }

  var hasTouch = ('ontouchstart' in window) ||
    (navigator.maxTouchPoints > 0) ||
    (navigator.msMaxTouchPoints > 0);
  var coarse = false;
  try { coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }
  catch (e) { /* matchMedia missing entirely: assume not coarse */ }
  _isTouch = !!(hasTouch && coarse);
  return _isTouch;
}

/* ==========================================================================
   State
   ========================================================================== */
var dom = null;
var active = false;               /* true while the player is actually playing */

var moveVec = { x: 0, y: 0 };
var lookAcc = { dx: 0, dy: 0 };
var jumpHeld = false;
var sprintOn = false;

/* One live pointer per role, tracked by pointerId. */
var movePtr = null;               /* { id, baseX, baseY } */
var lookPtr = null;               /* { id, lastX, lastY } */
var jumpPtr = null;

var STICK_MAX = 44;               /* px the knob may travel from its base */
var TAP_MS = 290, TAP_PX = 38;    /* what counts as a double-tap */
var lastTapT = 0, lastTapX = 0, lastTapY = 0;

/* ==========================================================================
   Haptics

   Opt-out in settings, and silently absent on iOS - navigator.vibrate has
   never existed in Safari. Wrapped because a few Android browsers throw
   rather than return false when the page has no user-activation yet.
   ========================================================================== */
function buzz(ms) {
  var S = window.MeadowSettings;
  if (S && S.get && S.get().haptics === false) { return; }
  try { if (navigator.vibrate) { navigator.vibrate(ms); } } catch (e) { /* ignore */ }
}

/* ==========================================================================
   DOM
   ========================================================================== */
function build(root) {
  var wrap = document.createElement('div');
  wrap.id = 'controls';
  wrap.innerHTML =
    '<div class="zone" id="zone-look"></div>' +
    '<div class="zone" id="zone-move"></div>' +
    '<div id="stick"><div id="stick-knob"></div></div>' +
    '<button type="button" class="pad" id="pad-jump" aria-label="Jump">Jump</button>' +
    '<button type="button" class="pad" id="pad-sprint" aria-label="Sprint" aria-pressed="false">Sprint</button>';
  root.appendChild(wrap);

  dom = {
    wrap: wrap,
    look: wrap.querySelector('#zone-look'),
    move: wrap.querySelector('#zone-move'),
    stick: wrap.querySelector('#stick'),
    knob: wrap.querySelector('#stick-knob'),
    jump: wrap.querySelector('#pad-jump'),
    sprint: wrap.querySelector('#pad-sprint')
  };
  return dom;
}

/* ==========================================================================
   Stick
   ========================================================================== */
function showStick(x, y) {
  dom.stick.style.left = x + 'px';
  dom.stick.style.top = y + 'px';
  dom.stick.classList.add('on');
  dom.knob.style.transform = 'translate(0px, 0px)';
}

function hideStick() {
  dom.stick.classList.remove('on');
  dom.knob.style.transform = 'translate(0px, 0px)';
}

function setKnob(kx, ky) {
  dom.knob.style.transform = 'translate(' + kx + 'px, ' + ky + 'px)';
}

function syncSprintUI() {
  dom.sprint.classList.toggle('on', sprintOn);
  dom.sprint.setAttribute('aria-pressed', sprintOn ? 'true' : 'false');
  dom.stick.classList.toggle('sprint', sprintOn);
}

function toggleSprint() {
  sprintOn = !sprintOn;
  syncSprintUI();
  buzz(sprintOn ? 12 : 6);
}

/* ==========================================================================
   Move zone
   ========================================================================== */
function onMoveDown(e) {
  if (movePtr !== null) { return; }
  e.preventDefault();

  /* Double-tap to sprint. Checked before the stick is engaged so the second
     tap still starts a normal drag - you can tap-tap-and-go in one motion. */
  var now = (window.performance && performance.now) ? performance.now() : Date.now();
  var near = Math.abs(e.clientX - lastTapX) < TAP_PX &&
             Math.abs(e.clientY - lastTapY) < TAP_PX;
  if (now - lastTapT < TAP_MS && near) {
    toggleSprint();
    lastTapT = 0;
  } else {
    lastTapT = now; lastTapX = e.clientX; lastTapY = e.clientY;
  }

  movePtr = { id: e.pointerId, baseX: e.clientX, baseY: e.clientY };
  showStick(e.clientX, e.clientY);
  try { dom.move.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ }
}

function onMoveMove(e) {
  if (!movePtr || e.pointerId !== movePtr.id) { return; }
  e.preventDefault();
  var dx = e.clientX - movePtr.baseX, dy = e.clientY - movePtr.baseY;
  var dist = Math.sqrt(dx * dx + dy * dy);
  var k = dist > STICK_MAX ? STICK_MAX / dist : 1;
  var kx = dx * k, ky = dy * k;
  setKnob(kx, ky);
  moveVec.x = kx / STICK_MAX;
  moveVec.y = -ky / STICK_MAX;      /* drag up is forward, matching f/s in player.js */
}

function onMoveUp(e) {
  if (!movePtr || e.pointerId !== movePtr.id) { return; }
  movePtr = null;
  moveVec.x = 0; moveVec.y = 0;
  hideStick();
}

/* ==========================================================================
   Look zone
   ========================================================================== */
function onLookDown(e) {
  if (lookPtr !== null) { return; }
  e.preventDefault();
  lookPtr = { id: e.pointerId, lastX: e.clientX, lastY: e.clientY };
  try { dom.look.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ }
}

function onLookMove(e) {
  if (!lookPtr || e.pointerId !== lookPtr.id) { return; }
  e.preventDefault();
  lookAcc.dx += e.clientX - lookPtr.lastX;
  lookAcc.dy += e.clientY - lookPtr.lastY;
  lookPtr.lastX = e.clientX;
  lookPtr.lastY = e.clientY;
}

function onLookUp(e) {
  if (!lookPtr || e.pointerId !== lookPtr.id) { return; }
  lookPtr = null;
}

/* ==========================================================================
   Pads
   ========================================================================== */
function bindJump() {
  dom.jump.addEventListener('pointerdown', function (e) {
    if (jumpPtr !== null) { return; }
    e.preventDefault(); e.stopPropagation();
    jumpPtr = e.pointerId;
    jumpHeld = true;
    dom.jump.classList.add('down');
    buzz(10);
    try { dom.jump.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ }
  });
  function release(e) {
    if (e.pointerId !== jumpPtr) { return; }
    jumpPtr = null;
    jumpHeld = false;
    dom.jump.classList.remove('down');
  }
  dom.jump.addEventListener('pointerup', release);
  dom.jump.addEventListener('pointercancel', release);
}

function bindSprint() {
  dom.sprint.addEventListener('pointerdown', function (e) {
    e.preventDefault(); e.stopPropagation();
    toggleSprint();
  });
}

function bindZones() {
  dom.move.addEventListener('pointerdown', onMoveDown);
  dom.move.addEventListener('pointermove', onMoveMove);
  dom.move.addEventListener('pointerup', onMoveUp);
  dom.move.addEventListener('pointercancel', onMoveUp);

  dom.look.addEventListener('pointerdown', onLookDown);
  dom.look.addEventListener('pointermove', onLookMove);
  dom.look.addEventListener('pointerup', onLookUp);
  dom.look.addEventListener('pointercancel', onLookUp);
}

/* iOS fires pinch-zoom and double-tap-zoom outside the pointer-event model,
   so touch-action alone does not stop them. Only suppressed while playing -
   a player reading the settings panel may legitimately want to pinch. */
function blockGestures() {
  ['gesturestart', 'gesturechange'].forEach(function (n) {
    document.addEventListener(n, function (e) {
      if (active) { try { e.preventDefault(); } catch (er) { /* ignore */ } }
    }, { passive: false });
  });
  var last = 0;
  document.addEventListener('touchend', function (e) {
    if (!active) { return; }
    var t = Date.now();
    if (t - last < 350) { try { e.preventDefault(); } catch (er) { /* ignore */ } }
    last = t;
  }, { passive: false });
}

/* ==========================================================================
   Reset

   A pointer that never gets its pointerup - app backgrounded mid-drag, or
   the OS stealing the gesture - would otherwise leave the player walking
   forward forever. Called on pause and on losing visibility.
   ========================================================================== */
function reset() {
  movePtr = null; lookPtr = null; jumpPtr = null;
  moveVec.x = 0; moveVec.y = 0;
  lookAcc.dx = 0; lookAcc.dy = 0;
  jumpHeld = false;
  sprintOn = false;
  if (dom) {
    hideStick();
    dom.jump.classList.remove('down');
    syncSprintUI();
  }
}

function setActive(on) {
  active = !!on;
  if (!dom) { return; }
  dom.wrap.classList.toggle('on', active);
  /* pointer-events on the zones is what makes the controls "there". Leaving
     them live under a menu meant a tap meant for a button could start a
     look-drag underneath it. */
  dom.wrap.style.pointerEvents = active ? '' : 'none';
  dom.look.style.pointerEvents = active ? 'auto' : 'none';
  dom.move.style.pointerEvents = active ? 'auto' : 'none';
  dom.jump.style.pointerEvents = active ? 'auto' : 'none';
  dom.sprint.style.pointerEvents = active ? 'auto' : 'none';
  if (!active) { reset(); }
}

/* ==========================================================================
   Public
   ========================================================================== */
var API = {
  isSupported: function () { return false; },
  isActive: function () { return false; },
  getMove: function () { return moveVec; },
  consumeLook: function () { return { dx: 0, dy: 0 }; },
  isJumping: function () { return false; },
  isSprinting: function () { return false; },
  setActive: function () {},
  reset: function () {}
};

function initControls(root) {
  if (!isTouchDevice()) { return API; }

  build(root);
  bindZones();
  bindJump();
  bindSprint();
  blockGestures();
  syncSprintUI();
  setActive(false);

  API = {
    isSupported: function () { return true; },
    isActive: function () { return active; },
    getMove: function () { return moveVec; },
    /* Raw screen-pixel delta since the last call, then cleared. player.js
       multiplies this by its own radians-per-pixel constant, exactly as it
       does for the mouse. */
    consumeLook: function () {
      var d = { dx: lookAcc.dx, dy: lookAcc.dy };
      lookAcc.dx = 0; lookAcc.dy = 0;
      return d;
    },
    isJumping: function () { return jumpHeld; },
    isSprinting: function () { return sprintOn; },
    setActive: setActive,
    reset: reset
  };
  return API;
}

export { initControls, isTouchDevice };
