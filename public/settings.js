/* ==========================================================================
   WHISPERING MEADOW - settings

   A plain script (not a module) so both worlds can reach it: the ES modules
   under game/ and ui/, and the classic scripts net.js / voice.js. Publishes
   window.MeadowSettings.

   Everything is kept in localStorage, which is per-device by design: your
   phone can have a lower look sensitivity and a lower quality tier than your
   laptop without the two fighting each other.

   v2 adds the graphics and audio keys. Until now this file stored four
   values that NOTHING IN THE GAME COULD CHANGE - there was no settings panel
   anywhere, so lookSens, touchSens, invertY and name were read by player.js
   and net.js and written by nobody. ui/screens.js is the other half of that
   contract, finally.
   ========================================================================== */
(function () {
'use strict';

var KEY = 'meadow.settings.v2';
var KEY_V1 = 'meadow.settings.v1';

/* Every key, its default, and how it is validated. Anything not listed here
   is refused by set() - a typo in a caller cannot invent a setting. */
var DEFAULTS = {
  /* ---- input ---------------------------------------------------------- */
  /* Multipliers on the base look speed. Each input has its own BASE constant
     in player.js (0.0021 rad/px for the mouse, 0.0055 for a thumb), so 1.0
     means "the tuned default" on both and the two no longer fight. */
  lookSens: 1.0,
  touchSens: 1.0,
  invertY: false,
  haptics: true,

  /* ---- identity -------------------------------------------------------- */
  name: '',

  /* ---- graphics -------------------------------------------------------- */
  /* 'auto' lets detectTier() in post.js decide from the hardware; the other
     three pin it. Pinning matters because detectTier() cannot tell a current
     flagship phone from a budget one - both report a coarse pointer and
     neither will admit to a GPU name. */
  quality: 'auto',
  /* 0 means "let the tier and the frame-time governor choose". Anything from
     0.5 to 1.0 pins the 3D render scale and switches the governor off, so a
     player who prefers a sharp still image over a smooth one can have it. */
  resScale: 0,
  /* 'auto' follows the tier, 'on'/'off' override it. */
  bloom: 'auto',
  fov: 68,

  /* ---- audio ----------------------------------------------------------- */
  volume: 0.8,

  /* ---- debug ----------------------------------------------------------- */
  showPerf: false
};

/* Numeric ranges, so clamping lives next to the defaults instead of being
   spelled out at each call site the way v1 did it. */
var RANGE = {
  lookSens:  [0.20, 3.00],
  touchSens: [0.25, 2.50],
  resScale:  [0.50, 1.00],
  fov:       [55, 88],
  volume:    [0, 1]
};

var ENUM = {
  quality: ['auto', 'low', 'medium', 'high'],
  bloom: ['auto', 'on', 'off']
};

var BOOL = { invertY: 1, haptics: 1, showPerf: 1 };

var S = {};

function clampNum(v, lo, hi) {
  v = parseFloat(v);
  if (!isFinite(v)) { return lo; }
  return v < lo ? lo : (v > hi ? hi : v);
}

/* Names are shown to other players, so they are stripped here as well as on
   the server. Never trust either side alone. */
function cleanName(n) {
  return String(n || '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
}

/* One coercion path for every key, used by both load() and set(). */
function coerce(k, v) {
  if (k === 'name') { return cleanName(v); }
  if (BOOL[k]) { return !!v; }
  if (ENUM[k]) { return ENUM[k].indexOf(String(v)) >= 0 ? String(v) : DEFAULTS[k]; }
  if (RANGE[k]) {
    /* resScale is the one number where 0 is meaningful - it is the "auto"
       sentinel - so it is allowed through below its own floor. */
    if (k === 'resScale' && (v === 0 || v === '0')) { return 0; }
    return clampNum(v, RANGE[k][0], RANGE[k][1]);
  }
  return v;
}

function readRaw(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }  /* private mode */
}

function load() {
  var parsed = {};
  var raw = readRaw(KEY);

  if (raw) {
    try { parsed = JSON.parse(raw) || {}; } catch (e) { parsed = {}; }
  } else {
    /* Migrate from v1 rather than silently resetting someone's sensitivity.
       v1 only ever held the four input keys, and one of them was stored in
       the wrong unit - see below. */
    var rawV1 = readRaw(KEY_V1);
    if (rawV1) {
      try { parsed = JSON.parse(rawV1) || {}; } catch (e) { parsed = {}; }
      /* v1 stored touchSens as raw radians-per-pixel, because player.js was
         missing its base constant at the time. Those saved values mean
         nothing now, so a stored default-era number is reset rather than
         silently misapplied as a 476x sensitivity. */
      if (parsed.touchSens !== undefined && parseFloat(parsed.touchSens) < 0.25) {
        delete parsed.touchSens;
      }
    }
  }

  for (var k in DEFAULTS) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, k)) { continue; }
    S[k] = (parsed[k] === undefined) ? DEFAULTS[k] : coerce(k, parsed[k]);
  }
}

var listeners = [];

/* Listeners are told WHICH key changed, so post.js does not rebuild its
   render targets because somebody moved the volume slider. */
function fire(key) {
  for (var i = 0; i < listeners.length; i++) {
    try { listeners[i](S, key); } catch (e) { /* a bad listener must not break saving */ }
  }
}

function save(key) {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* ignore */ }
  fire(key);
}

load();

window.MeadowSettings = {
  get: function () { return S; },

  /* Named readers, kept because net.js, voice.js and player.js already call
     them and there is no reason to churn those files. */
  lookSens: function () { return S.lookSens; },
  touchSens: function () { return S.touchSens; },
  invertY: function () { return !!S.invertY; },
  quality: function () { return S.quality; },
  resScale: function () { return S.resScale; },
  bloom: function () { return S.bloom; },
  fov: function () { return S.fov; },
  volume: function () { return S.volume; },
  haptics: function () { return !!S.haptics; },
  showPerf: function () { return !!S.showPerf; },

  /* Falls back to "Walker <id>" so nobody is ever nameless in chat. */
  displayName: function (id) {
    return S.name || ('Walker ' + (id || '?'));
  },
  hasName: function () { return !!S.name; },

  set: function (k, v) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, k)) { return; }
    var next = coerce(k, v);
    if (S[k] === next) { return; }   /* no event for a no-op write */
    S[k] = next;
    save(k);
  },

  /* Used by the Reset button in the settings panel. One event at the end
     rather than one per key, so nothing downstream rebuilds twelve times. */
  reset: function () {
    for (var k in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) { S[k] = DEFAULTS[k]; }
    }
    save(null);
  },

  onChange: function (fn) { if (typeof fn === 'function') { listeners.push(fn); } },
  defaults: function () { return DEFAULTS; },
  range: function (k) { return RANGE[k] || null; },

  /* Fullscreen is a browser-gesture-only API, so this must be called straight
     from a real tap handler or it silently does nothing.

     No orientation lock any more: the game supports portrait and landscape
     properly now, and forcing the device sideways was the single most
     complained-about thing about playing on a phone. */
  toggleFullscreen: function () {
    try {
      var el = document.documentElement;
      if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        var req = el.requestFullscreen || el.webkitRequestFullscreen;
        if (req) {
          var r = req.call(el);
          if (r && r.catch) { r.catch(function () {}); }
        }
        return true;
      }
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) {
        var r2 = exit.call(document);
        if (r2 && r2.catch) { r2.catch(function () {}); }
      }
      return false;
    } catch (e) { return false; }
  },

  isFullscreen: function () {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }
};

})();
