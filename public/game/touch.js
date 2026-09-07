/* Whispering Meadow - touch.js
   Mobile touch controls: floating left-thumb joystick (move), right-thumb
   drag-to-look, and JUMP / SPRINT buttons. PUBG-Mobile style, landscape only.

   Self-contained, like net.js: this file builds its own DOM overlay and
   injects its own <style>. index.html needs no changes for the UI itself.

   Desktop is untouched - if the device does not look like a touchscreen,
   initTouch() builds nothing and returns a no-op API. */

/* ==========================================================================
   Detection
   ========================================================================== */
function detectTouch() {
  /* ?touch=1 forces the controls on so they can be checked on a desktop
     browser; ?touch=0 forces them off. Without this there is no way to test
     the phone UI without a phone. */
  try {
    var q = new URLSearchParams(location.search).get('touch');
    if (q === '1') { return true; }
    if (q === '0') { return false; }
  } catch (e) {}
  var hasTouch = ('ontouchstart' in window) ||
    (navigator.maxTouchPoints > 0) ||
    (navigator.msMaxTouchPoints > 0);
  var coarse = false;
  try { coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches; }
  catch (e) { /* matchMedia missing entirely: assume no */ }
  return !!(hasTouch && coarse);
}

/* ==========================================================================
   Style - one stylesheet, injected once
   ========================================================================== */
var CSS =
'#tm-root{position:fixed;inset:0;z-index:8;pointer-events:none;' +
  '-webkit-user-select:none;user-select:none}' +
'.tm-zone{position:absolute;top:0;bottom:0;pointer-events:auto;touch-action:none}' +
'#tm-move{left:0;width:50%}' +
'#tm-look{right:0;width:50%}' +
'#tm-joy-base{position:fixed;width:112px;height:112px;border-radius:999px;' +
  'left:0;top:0;transform:translate(-50%,-50%);opacity:0;transition:opacity .12s ease;' +
  'background:rgba(20,30,40,.32);border:2px solid rgba(255,255,255,.35);pointer-events:none;z-index:1}' +
'#tm-joy-knob{position:absolute;left:50%;top:50%;width:52px;height:52px;border-radius:999px;' +
  'transform:translate(-50%,-50%);background:rgba(246,217,138,.55);border:2px solid rgba(255,255,255,.55);' +
  'pointer-events:none}' +
'.tm-btn{position:fixed;pointer-events:auto;touch-action:none;z-index:2;' +
  'border-radius:999px;display:flex;align-items:center;justify-content:center;' +
  'font-family:ui-sans-serif,system-ui,"Segoe UI",sans-serif;font-weight:700;' +
  'letter-spacing:.06em;text-transform:uppercase;color:#f1efe6;' +
  'background:rgba(20,30,40,.42);border:2px solid rgba(255,255,255,.35);' +
  '-webkit-tap-highlight-color:transparent}' +
'.tm-btn:active{background:rgba(20,30,40,.62)}' +
'#tm-jump{width:78px;height:78px;font-size:12px;' +
  'right:calc(22px + env(safe-area-inset-right));' +
  'bottom:calc(118px + env(safe-area-inset-bottom))}' +
'#tm-sprint{width:66px;height:66px;font-size:10.5px;' +
  'right:calc(38px + env(safe-area-inset-right));' +
  'bottom:calc(28px + env(safe-area-inset-bottom))}' +
'#tm-sprint.on{background:rgba(159,227,201,.55);border-color:rgba(159,227,201,.85);color:#123043}' +
/* Fullscreen toggle. Top-right, small, and deliberately quiet: it is the
   one control you want present but never in the way of a thumb. The glyph
   is drawn from text - no image asset, nothing to download. */
'#tm-full{width:40px;height:40px;font-size:17px;line-height:1;padding:0;' +
  'letter-spacing:0;text-transform:none;font-weight:400;' +
  'background:rgba(20,30,40,.30);border-color:rgba(255,255,255,.26);' +
  'top:calc(12px + env(safe-area-inset-top));' +
  'right:calc(12px + env(safe-area-inset-right))}' +
'#tm-rotate{position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;' +
  'text-align:center;background:#0d1620;color:#fdfaf2;' +
  'font-family:ui-sans-serif,system-ui,"Segoe UI",sans-serif;pointer-events:auto}' +
'#tm-rotate.show{display:flex}' +
'#tm-rotate .card{max-width:80vw;padding:6vh 6vw}' +
'#tm-rotate .glyph{font-size:52px;margin-bottom:18px;display:inline-block;' +
  'animation:tm-spin 1.6s ease-in-out infinite}' +
'@keyframes tm-spin{0%,100%{transform:rotate(0deg)}50%{transform:rotate(-90deg)}}' +
'#tm-rotate .msg{font-size:15px;letter-spacing:.03em;opacity:.85}';

function injectStyle() {
  var st = document.createElement('style');
  st.textContent = CSS;
  document.head.appendChild(st);
}

/* ==========================================================================
   State
   ========================================================================== */
var engaged = false;               // true once the player has tapped Enter/Resume
var moveVec = { x: 0, y: 0 };
var lookAcc = { dx: 0, dy: 0 };
var jumpHeld = false;
var sprintOn = false;

var moveTouch = null;              // { id, baseX, baseY }
var lookTouch = null;              // { id, lastX, lastY }
var jumpTouchId = null;
var sprintTouchId = null;

var JOY_MAX = 42;                  // px the knob may travel from its base

var dom = null;                    // built lazily, once

/* ==========================================================================
   DOM
   ========================================================================== */
function buildDOM() {
  var root = document.createElement('div');
  root.id = 'tm-root';

  var moveZone = document.createElement('div');
  moveZone.id = 'tm-move';
  moveZone.className = 'tm-zone';

  var lookZone = document.createElement('div');
  lookZone.id = 'tm-look';
  lookZone.className = 'tm-zone';

  var joyBase = document.createElement('div');
  joyBase.id = 'tm-joy-base';
  var joyKnob = document.createElement('div');
  joyKnob.id = 'tm-joy-knob';
  joyBase.appendChild(joyKnob);

  var jumpBtn = document.createElement('button');
  jumpBtn.type = 'button';
  jumpBtn.id = 'tm-jump';
  jumpBtn.className = 'tm-btn';
  jumpBtn.textContent = 'Jump';

  var sprintBtn = document.createElement('button');
  sprintBtn.type = 'button';
  sprintBtn.id = 'tm-sprint';
  sprintBtn.className = 'tm-btn';
  sprintBtn.textContent = 'Sprint';

  var fullBtn = document.createElement('button');
  fullBtn.type = 'button';
  fullBtn.id = 'tm-full';
  fullBtn.className = 'tm-btn';
  fullBtn.setAttribute('aria-label', 'Toggle full screen');
  fullBtn.textContent = '⛶';        /* the expand-arrows glyph */

  root.appendChild(moveZone);
  root.appendChild(lookZone);
  root.appendChild(joyBase);
  root.appendChild(jumpBtn);
  root.appendChild(sprintBtn);
  root.appendChild(fullBtn);
  document.body.appendChild(root);

  var rotate = document.createElement('div');
  rotate.id = 'tm-rotate';
  var card = document.createElement('div');
  card.className = 'card';
  var glyph = document.createElement('div');
  glyph.className = 'glyph';
  glyph.textContent = '↻';           /* rotation arrow, no image asset needed */
  var msg = document.createElement('div');
  msg.className = 'msg';
  msg.textContent = 'Turn your device sideways to enter the meadow';
  card.appendChild(glyph);
  card.appendChild(msg);
  rotate.appendChild(card);
  document.body.appendChild(rotate);

  return {
    root: root, moveZone: moveZone, lookZone: lookZone,
    joyBase: joyBase, joyKnob: joyKnob,
    jumpBtn: jumpBtn, sprintBtn: sprintBtn, fullBtn: fullBtn, rotate: rotate
  };
}

/* ------------------------------------------------------- full screen
   Entering full screen was already done for you when you tapped "Step
   outside", but there was no way back out and no way back in if the browser
   refused it the first time - and on a phone, being stuck in full screen
   with no visible way out is genuinely annoying. This is that way out.

   Every vendor spelling is checked because Safari on iPhone still only has
   the webkit ones, and on an iPhone the request will often be refused
   outright; the glyph tracks whatever actually happened via the
   fullscreenchange event rather than assuming the tap worked. */
function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement ||
         document.mozFullScreenElement || document.msFullscreenElement || null;
}

function exitFullscreen() {
  try {
    var ex = document.exitFullscreen || document.webkitExitFullscreen ||
             document.mozCancelFullScreen || document.msExitFullscreen;
    if (ex) {
      var p = ex.call(document);
      if (p && p.catch) { p.catch(function () {}); }
    }
  } catch (e) { /* nothing to do - we are simply not in full screen */ }
}

function syncFullscreenGlyph() {
  if (!dom || !dom.fullBtn) { return; }
  var on = !!fullscreenElement();
  /* expand arrows when it will grow, collapse arrows when it will shrink */
  dom.fullBtn.textContent = on ? '✕' : '⛶';
  dom.fullBtn.setAttribute('aria-label', on ? 'Leave full screen' : 'Enter full screen');
}

function bindFullscreenButton() {
  if (!dom || !dom.fullBtn) { return; }
  function toggle(e) {
    e.preventDefault();
    e.stopPropagation();
    if (fullscreenElement()) { exitFullscreen(); } else { tryFullscreenAndLock(); }
  }
  /* touchend AND click: touchend is what a phone actually fires first, and
     the click guard stops the same tap being counted twice. Also stops the
     tap reaching the page-wide "click to resume" handler underneath. */
  dom.fullBtn.addEventListener('touchend', toggle, { passive: false });
  dom.fullBtn.addEventListener('click', toggle);
  dom.fullBtn.addEventListener('touchstart', function (e) { e.stopPropagation(); }, { passive: true });
  ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange']
    .forEach(function (n) { document.addEventListener(n, syncFullscreenGlyph); });
  syncFullscreenGlyph();
}

/* ==========================================================================
   Joystick (left thumb, floating)
   ========================================================================== */
function showJoystickAt(x, y) {
  dom.joyBase.style.left = x + 'px';
  dom.joyBase.style.top = y + 'px';
  dom.joyBase.style.opacity = '1';
  dom.joyKnob.style.transform = 'translate(-50%,-50%)';
}

function hideJoystick() {
  dom.joyBase.style.opacity = '0';
}

function setKnob(kx, ky) {
  dom.joyKnob.style.transform =
    'translate(calc(-50% + ' + kx + 'px), calc(-50% + ' + ky + 'px))';
}

function onMoveStart(e) {
  if (moveTouch) { return; }
  var t = e.changedTouches[0];
  moveTouch = { id: t.identifier, baseX: t.clientX, baseY: t.clientY };
  showJoystickAt(t.clientX, t.clientY);
  e.preventDefault();
}

function onMoveMove(e) {
  if (!moveTouch) { return; }
  for (var i = 0; i < e.changedTouches.length; i++) {
    var t = e.changedTouches[i];
    if (t.identifier !== moveTouch.id) { continue; }
    var dx = t.clientX - moveTouch.baseX, dy = t.clientY - moveTouch.baseY;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var scale = dist > JOY_MAX ? JOY_MAX / dist : 1;
    var kx = dx * scale, ky = dy * scale;
    setKnob(kx, ky);
    moveVec.x = kx / JOY_MAX;
    moveVec.y = -ky / JOY_MAX;         /* drag up -> forward */
    e.preventDefault();
    break;
  }
}

function onMoveEnd(e) {
  if (!moveTouch) { return; }
  for (var i = 0; i < e.changedTouches.length; i++) {
    if (e.changedTouches[i].identifier === moveTouch.id) {
      moveTouch = null;
      moveVec.x = 0; moveVec.y = 0;
      hideJoystick();
      e.preventDefault();
      break;
    }
  }
}

/* ==========================================================================
   Look (right thumb, drag anywhere)
   ========================================================================== */
function onLookStart(e) {
  if (lookTouch) { return; }
  var t = e.changedTouches[0];
  lookTouch = { id: t.identifier, lastX: t.clientX, lastY: t.clientY };
  e.preventDefault();
}

function onLookMove(e) {
  if (!lookTouch) { return; }
  for (var i = 0; i < e.changedTouches.length; i++) {
    var t = e.changedTouches[i];
    if (t.identifier !== lookTouch.id) { continue; }
    lookAcc.dx += t.clientX - lookTouch.lastX;
    lookAcc.dy += t.clientY - lookTouch.lastY;
    lookTouch.lastX = t.clientX;
    lookTouch.lastY = t.clientY;
    e.preventDefault();
    break;
  }
}

function onLookEnd(e) {
  if (!lookTouch) { return; }
  for (var i = 0; i < e.changedTouches.length; i++) {
    if (e.changedTouches[i].identifier === lookTouch.id) {
      lookTouch = null;
      e.preventDefault();
      break;
    }
  }
}

/* ==========================================================================
   Buttons
   ========================================================================== */
function bindButtons() {
  dom.jumpBtn.addEventListener('touchstart', function (e) {
    if (jumpTouchId !== null) { return; }
    jumpTouchId = e.changedTouches[0].identifier;
    jumpHeld = true;
    e.preventDefault();
  }, { passive: false });

  function releaseJump(e) {
    for (var i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === jumpTouchId) {
        jumpTouchId = null;
        jumpHeld = false;
        e.preventDefault();
        break;
      }
    }
  }
  dom.jumpBtn.addEventListener('touchend', releaseJump, { passive: false });
  dom.jumpBtn.addEventListener('touchcancel', releaseJump, { passive: false });

  dom.sprintBtn.addEventListener('touchstart', function (e) {
    if (sprintTouchId !== null) { return; }
    sprintTouchId = e.changedTouches[0].identifier;
    sprintOn = !sprintOn;
    dom.sprintBtn.classList.toggle('on', sprintOn);
    e.preventDefault();
  }, { passive: false });

  function releaseSprint(e) {
    for (var i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === sprintTouchId) {
        sprintTouchId = null;
        e.preventDefault();
        break;
      }
    }
  }
  dom.sprintBtn.addEventListener('touchend', releaseSprint, { passive: false });
  dom.sprintBtn.addEventListener('touchcancel', releaseSprint, { passive: false });
}

function bindZones() {
  dom.moveZone.addEventListener('touchstart', onMoveStart, { passive: false });
  dom.moveZone.addEventListener('touchmove', onMoveMove, { passive: false });
  dom.moveZone.addEventListener('touchend', onMoveEnd, { passive: false });
  dom.moveZone.addEventListener('touchcancel', onMoveEnd, { passive: false });

  dom.lookZone.addEventListener('touchstart', onLookStart, { passive: false });
  dom.lookZone.addEventListener('touchmove', onLookMove, { passive: false });
  dom.lookZone.addEventListener('touchend', onLookEnd, { passive: false });
  dom.lookZone.addEventListener('touchcancel', onLookEnd, { passive: false });
}

/* Belt and braces against iOS pinch-zoom / double-tap-zoom while playing.
   touch-action:none on the zones covers most of it, but Safari's pinch
   gesture fires outside normal touch events too. */
function blockGestures() {
  document.addEventListener('gesturestart', function (e) {
    if (engaged) { try { e.preventDefault(); } catch (er) {} }
  });
  var lastTap = 0;
  document.addEventListener('touchend', function (e) {
    if (!engaged) { return; }
    var t = Date.now();
    if (t - lastTap < 350) { e.preventDefault(); }
    lastTap = t;
  }, { passive: false });
}

/* ==========================================================================
   Portrait / fullscreen / orientation lock
   ========================================================================== */
function isPortrait() {
  try { return window.matchMedia('(orientation: portrait)').matches; }
  catch (e) { return window.innerHeight > window.innerWidth; }
}

function updateRotateOverlay() {
  if (!dom) { return; }
  dom.rotate.classList.toggle('show', isPortrait());
}

/* Must run synchronously inside a user-gesture handler - no awaits before it. */
function tryFullscreenAndLock() {
  try {
    var el = document.documentElement;
    var req = el.requestFullscreen || el.webkitRequestFullscreen ||
      el.mozRequestFullScreen || el.msRequestFullscreen;
    if (req) {
      var p = req.call(el);
      if (p && p.catch) { p.catch(function () {}); }
    }
  } catch (e) { /* fullscreen refused or unsupported: fine, keep playing */ }

  try {
    if (screen.orientation && screen.orientation.lock) {
      var lp = screen.orientation.lock('landscape');
      if (lp && lp.catch) { lp.catch(function () {}); }
    }
  } catch (e) { /* not supported on this browser: must not throw */ }
}

function onEngage() {
  engaged = true;
  tryFullscreenAndLock();
}

/* Hooks the page's existing Enter / Resume buttons (from index.html) rather
   than requiring index.html to call into us - same trick net.js uses to stay
   a drop-in. Multiple listeners on the same element are fine. */
function wireEngageButtons() {
  var enter = document.getElementById('enter');
  var resume = document.getElementById('resume');
  if (enter) { enter.addEventListener('click', onEngage); }
  if (resume) { resume.addEventListener('click', onEngage); }
  if (dom && dom.rotate) { dom.rotate.addEventListener('click', tryFullscreenAndLock); }
}

/* Mirrors the keys={} reset on window blur in player.js: a touch that never
   gets its touchend (app backgrounded mid-drag) must not stick forever. */
function bindLifecycle() {
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { return; }
    moveTouch = null; lookTouch = null;
    jumpTouchId = null; sprintTouchId = null;
    moveVec.x = 0; moveVec.y = 0;
    lookAcc.dx = 0; lookAcc.dy = 0;
    jumpHeld = false;
    if (dom) { hideJoystick(); }
  });
}

/* ==========================================================================
   Public API
   ========================================================================== */
function noopAPI() {
  return {
    isSupported: function () { return false; },
    isActive: function () { return false; },
    getMove: function () { return moveVec; },
    consumeLook: function () { return { dx: 0, dy: 0 }; },
    isJumping: function () { return false; },
    isSprinting: function () { return false; }
  };
}

function initTouch(opts) {
  opts = opts || {};
  if (!detectTouch()) { return noopAPI(); }

  injectStyle();
  dom = buildDOM();
  bindZones();
  bindButtons();
  bindFullscreenButton();
  blockGestures();
  bindLifecycle();
  wireEngageButtons();
  updateRotateOverlay();
  window.addEventListener('resize', updateRotateOverlay);
  window.addEventListener('orientationchange', updateRotateOverlay);

  return {
    isSupported: function () { return true; },
    /* true once the player has tapped Enter/Resume on a touch device - this
       is the "treat this as playing" signal main.js/player.js need, since
       pointerlockchange never fires on mobile. */
    isActive: function () { return engaged; },
    /* {x, y} in [-1, 1], (0,0) when the left thumb is not down. y is
       forward-positive, matching the f/s convention in player.js. */
    getMove: function () { return moveVec; },
    /* accumulated screen-pixel delta since the last call, then reset -
       drop straight into the same math the mousemove handler uses
       (P.yaw -= dx * 0.0021; P.pitch -= dy * 0.0021;). */
    consumeLook: function () {
      var d = { dx: lookAcc.dx, dy: lookAcc.dy };
      lookAcc.dx = 0; lookAcc.dy = 0;
      return d;
    },
    isJumping: function () { return jumpHeld; },
    isSprinting: function () { return sprintOn; }
  };
}

export { initTouch };
