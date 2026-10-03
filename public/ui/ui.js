/* ==========================================================================
   WHISPERING MEADOW - interface layer

   ONE owner of "what is on screen". That is the whole point of this file.

   Before, screen state was spread across three places that did not know
   about each other: hardcoded veils in index.html, a self-injecting DOM
   island in game/touch.js, and `playing` in game/player.js driven by
   pointerlockchange. That is why pause was broken on phones - pointer lock
   does not exist on touch, so the branch that showed the pause screen could
   never run, and a document-wide click handler in main.js resumed play on
   any stray tap.

   Now there is a state machine here, and `playing` is DERIVED from it:

       boot -> title -> playing <-> paused
                          |           |
                          +-> settings <-+      (modal over either)

   Pointer lock follows the state instead of driving it. The game asks
   MeadowUI.isPlaying(); it never sets it.

   Published as window.MeadowUI, the same way net.js publishes MeadowNet and
   settings.js publishes MeadowSettings - the game modules are ES modules and
   these are not, and a global handshake is the existing idiom for crossing
   that line in this project.
   ========================================================================== */

import { buildBoot, buildTitle, buildPause, buildSettings, iconBtn } from './screens.js';
import { initControls, isTouchDevice } from './controls.js';
import { icon } from './icons.js';
import * as hud from './hud.js';

/* ==========================================================================
   State
   ========================================================================== */
var STATE = { BOOT: 'boot', TITLE: 'title', PLAYING: 'playing', PAUSED: 'paused', SETTINGS: 'settings' };

var state = STATE.BOOT;
var prevState = STATE.TITLE;      /* where Done on the settings panel returns to */
var hasPlayed = false;            /* has the player entered the world at least once */

var root = null;
var screens = {};
var topRight = null;
var fullBtn = null, pauseBtn = null;
var input = null;

var listeners = {};

function emit(name) {
  var l = listeners[name];
  if (!l) { return; }
  for (var i = 0; i < l.length; i++) {
    try { l[i](); } catch (e) { console.warn('[meadow:ui] listener failed', name, e); }
  }
}

function on(name, fn) {
  if (typeof fn !== 'function') { return; }
  if (!listeners[name]) { listeners[name] = []; }
  listeners[name].push(fn);
}

/* ==========================================================================
   Pointer lock - desktop only, and it FOLLOWS state
   ========================================================================== */
function wantLock() {
  return !isTouchDevice() && state === STATE.PLAYING;
}

function syncPointerLock() {
  if (isTouchDevice()) { return; }
  var locked = document.pointerLockElement === document.body;
  if (wantLock() && !locked) {
    try { if (document.body.requestPointerLock) { document.body.requestPointerLock(); } }
    catch (e) { /* refused: the Escape-to-pause path below still works */ }
  } else if (!wantLock() && locked) {
    try { if (document.exitPointerLock) { document.exitPointerLock(); } }
    catch (e) { /* ignore */ }
  }
}

/* ==========================================================================
   Screen switching
   ========================================================================== */
function showScreen(which) {
  screens.boot.screen.classList.toggle('on', which === STATE.BOOT);
  screens.title.screen.classList.toggle('on', which === STATE.TITLE);
  screens.pause.screen.classList.toggle('on', which === STATE.PAUSED);
  /* Settings is a modal: whatever it opened over stays visible behind it. */
  var settingsOpen = which === STATE.SETTINGS;
  screens.settings.screen.classList.toggle('on', settingsOpen);
  if (settingsOpen) {
    screens.title.screen.classList.toggle('on', prevState === STATE.TITLE);
    screens.pause.screen.classList.toggle('on', prevState === STATE.PAUSED);
  }
}

function syncTopRight() {
  if (!topRight) { return; }
  var playing = state === STATE.PLAYING;
  var touch = isTouchDevice();

  /* A pause button only exists on touch, and only while playing - on a
     keyboard Escape is the pause button, and leaving a visible one in the
     frame would be clutter over a picture. */
  pauseBtn.style.display = (touch && playing) ? '' : 'none';

  /* Fullscreen is hidden during desktop play so nothing sits over the
     picture, and hidden inside the settings panel, which has its own
     controls and its own scrim. */
  var showFull = state !== STATE.SETTINGS && !(playing && !touch);
  fullBtn.style.display = showFull ? '' : 'none';

  topRight.classList.toggle('hide', !showFull && pauseBtn.style.display === 'none');
}

function setState(next) {
  if (state === next) { return; }
  state = next;

  /* Published on <body> so stylesheets can react to the screen without any
     JavaScript of their own. The multiplayer overrides at the bottom of
     ui.css use it to keep net.js's chat bar out of the menus - net.js is not
     edited for that, and could not be: DESIGN-AGENT.md puts it off limits. */
  try { document.body.setAttribute('data-meadow', state); } catch (e) { /* ignore */ }

  showScreen(state);

  var playing = state === STATE.PLAYING;
  hud.show(playing);
  if (input) { input.setActive(playing); }
  var frame = document.getElementById('frame');
  if (frame) { frame.classList.toggle('on', playing); }

  syncTopRight();
  syncPointerLock();
  emit('statechange');
}

/* ==========================================================================
   Transitions
   ========================================================================== */
function ready() {
  if (state !== STATE.BOOT) { return; }
  setState(STATE.TITLE);
  emit('ready');
}

/* Fullscreen and audio both need to be started from inside a real gesture
   handler, so enter() must be called straight from the click - never from a
   promise callback or a timeout. */
function enter() {
  if (state !== STATE.TITLE && state !== STATE.PAUSED) { return; }
  var first = !hasPlayed;
  hasPlayed = true;
  /* On a phone, going fullscreen reclaims the address bar - which is most of
     the reason the game felt cramped there. Not an orientation lock: both
     orientations are supported layouts now. */
  if (isTouchDevice()) {
    var S = window.MeadowSettings;
    if (S && !S.isFullscreen()) { S.toggleFullscreen(); }
  }
  setState(STATE.PLAYING);
  emit(first ? 'enter' : 'resume');
}

function pause() {
  if (state !== STATE.PLAYING) { return; }
  setState(STATE.PAUSED);
  emit('pause');
}

function openSettings() {
  if (state === STATE.SETTINGS || state === STATE.BOOT) { return; }
  /* Opening settings from inside the world pauses first, so nothing is
     walking off a cliff while a slider is being dragged. */
  if (state === STATE.PLAYING) { pause(); }
  prevState = state;
  screens.settings.sync();
  setState(STATE.SETTINGS);
}

function closeSettings() {
  if (state !== STATE.SETTINGS) { return; }
  setState(prevState === STATE.PAUSED ? STATE.PAUSED : STATE.TITLE);
}

/* ==========================================================================
   Boot progress
   ========================================================================== */
function progress(msg, frac) {
  if (!screens.boot) { return; }
  if (msg) { screens.boot.msg.textContent = msg + '…'; }
  var f = frac < 0 ? 0 : (frac > 1 ? 1 : frac);
  screens.boot.bar.style.width = Math.round(f * 100) + '%';
}

function failed(msg) {
  if (!screens.boot) { return; }
  screens.boot.msg.textContent = msg;
  screens.boot.msg.classList.add('error');
}

/* ==========================================================================
   Wiring
   ========================================================================== */
function buildTopRight() {
  topRight = document.createElement('div');
  topRight.id = 'top-right';

  pauseBtn = iconBtn('btn-pause', 'pause', 'Pause');
  fullBtn = iconBtn('btn-fullscreen', 'expand', 'Full screen');

  topRight.appendChild(pauseBtn);
  topRight.appendChild(fullBtn);
  root.appendChild(topRight);

  pauseBtn.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    pause();
  });

  fullBtn.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    var S = window.MeadowSettings;
    if (S) { S.toggleFullscreen(); }
  });

  /* The glyph tracks what actually happened rather than what was asked for:
     on an iPhone a fullscreen request is often refused outright, and a button
     that has flipped to "exit" while the page is still windowed is a lie. */
  function syncGlyph() {
    var S = window.MeadowSettings;
    var on = !!(S && S.isFullscreen());
    fullBtn.innerHTML = icon(on ? 'collapse' : 'expand');
    var label = on ? 'Leave full screen' : 'Full screen';
    fullBtn.setAttribute('aria-label', label);
    fullBtn.title = label;
  }
  ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (n) {
    document.addEventListener(n, syncGlyph);
  });
  syncGlyph();
}

function bindButtons() {
  screens.title.enter.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    enter();
  });
  screens.title.settings.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    openSettings();
  });
  screens.pause.resume.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    enter();
  });
  screens.pause.settings.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    openSettings();
  });
  screens.settings.close.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    closeSettings();
  });
  screens.settings.done.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    closeSettings();
  });
  /* Tapping the scrim outside the sheet closes it, which is what every
     phone user expects of a sheet. */
  screens.settings.screen.addEventListener('click', function (e) {
    if (e.target === screens.settings.screen) { closeSettings(); }
  });
}

function bindKeys() {
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' && e.code !== 'Escape') { return; }
    /* While pointer-locked, Escape is swallowed by the browser to release
       the lock and this never fires - pointerlockchange handles that case.
       This is for the unlocked ones: the settings panel and the menus. */
    if (state === STATE.SETTINGS) { closeSettings(); }
    else if (state === STATE.PLAYING) { pause(); }
  });

  /* F3 writes through to settings so the switch in the panel agrees with it
     and the choice survives a reload. */
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'F3' && e.code !== 'F3') { return; }
    e.preventDefault();
    var S = window.MeadowSettings;
    if (S) { S.set('showPerf', !S.showPerf()); }
  });
}

function bindLifecycle() {
  document.addEventListener('pointerlockchange', function () {
    if (isTouchDevice()) { return; }
    var locked = document.pointerLockElement === document.body;
    /* Losing the lock while playing IS the pause gesture on a desktop. The
       reverse - gaining it - is not a transition: entering play is what
       asked for the lock in the first place. */
    if (!locked && state === STATE.PLAYING) { pause(); }
  });

  /* Backgrounding the app pauses, on every platform, and does NOT silently
     resume on return. The old touch path set playing = true again the moment
     the tab became visible, so you came back already walking. */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && state === STATE.PLAYING) { pause(); }
  });

  window.addEventListener('blur', function () {
    if (state === STATE.PLAYING && !isTouchDevice()) { pause(); }
  });

  /* A rotation changes which layout the controls use, which is pure CSS -
     all this has to do is make sure no half-finished drag survives it. */
  window.addEventListener('orientationchange', function () {
    if (input) { input.reset(); }
  });
}

function bindSettingsEvents() {
  var S = window.MeadowSettings;
  if (!S) { return; }
  S.onChange(function (s, key) {
    if (key === null || key === 'showPerf') {
      hud.showDiag(!!s.showPerf);
    }
    /* Keep the panel's own controls honest when something else writes a
       setting - F3, or Reset, or a second tab. */
    if (state === STATE.SETTINGS) { screens.settings.sync(); }
  });
  hud.showDiag(!!S.showPerf());
}

/* ==========================================================================
   Init
   ========================================================================== */
function init() {
  root = document.createElement('div');
  root.id = 'ui';
  document.body.appendChild(root);

  screens.boot = buildBoot(root);
  screens.title = buildTitle(root);
  screens.pause = buildPause(root);
  screens.settings = buildSettings(root);

  hud.buildHUD(root);
  input = initControls(root);

  buildTopRight();
  bindButtons();
  bindKeys();
  bindLifecycle();
  bindSettingsEvents();

  showScreen(STATE.BOOT);
  syncTopRight();
  try { document.body.setAttribute('data-meadow', STATE.BOOT); } catch (e) { /* ignore */ }
}

/* ==========================================================================
   Public
   ========================================================================== */
var MeadowUI = {
  STATE: STATE,

  /* ---- boot ---- */
  progress: progress,
  failed: failed,
  ready: ready,

  /* ---- state ---- */
  state: function () { return state; },
  isPlaying: function () { return state === STATE.PLAYING; },
  hasPlayed: function () { return hasPlayed; },
  /* True when the world may still be drawn although nobody is playing. Only
     the title screen asks, and even there main.js stops as soon as the
     opening fade has lifted - a menu must not hold the GPU open. Paused never
     asks: the canvas keeps the last frame it drew, which is the view you were
     standing in, and freezing it is both prettier and free. */
  idleRender: function () { return state === STATE.TITLE; },

  enter: enter,
  pause: pause,
  openSettings: openSettings,
  closeSettings: closeSettings,

  /* ---- subsystems ---- */
  hud: hud,
  input: function () { return input; },

  on: on
};

window.MeadowUI = MeadowUI;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

export { MeadowUI };
