/* ==========================================================================
   WHISPERING MEADOW - settings

   A plain script (not a module) so both worlds can reach it: the ES modules
   under game/ and the classic scripts net.js / voice.js. Publishes
   window.MeadowSettings.

   Everything is kept in localStorage, which is per-device by design: your
   phone can have a lower look sensitivity than your laptop without the two
   fighting each other.
   ========================================================================== */
(function () {
'use strict';

var KEY = 'meadow.settings.v1';

var DEFAULTS = {
  /* Multiplier on the base look speed. Each input has its own BASE constant
     in player.js (0.0021 rad/px for the mouse, 0.0055 for a thumb), so 1.0
     means "the tuned default" on both and the two no longer fight. */
  lookSens: 1.0,
  touchSens: 1.0,
  name: '',
  invertY: false
};

var S = {};

function load() {
  var raw = null;
  try { raw = localStorage.getItem(KEY); } catch (e) { /* private mode */ }
  var parsed = {};
  if (raw) { try { parsed = JSON.parse(raw) || {}; } catch (e) { parsed = {}; } }
  for (var k in DEFAULTS) {
    S[k] = (parsed[k] === undefined) ? DEFAULTS[k] : parsed[k];
  }
  S.lookSens = clampNum(S.lookSens, 0.2, 3.0);
  S.touchSens = clampNum(S.touchSens, 0.25, 2.5);
  /* v1 stored touchSens as raw radians-per-pixel because player.js was
     missing its base constant. Those saved values mean nothing now, so a
     stored default-era number is reset rather than silently misapplied. */
  if (parsed.touchSens !== undefined && parseFloat(parsed.touchSens) < 0.25) {
    S.touchSens = DEFAULTS.touchSens;
  }
  S.name = cleanName(S.name);
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* ignore */ }
  fire();
}

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

var listeners = [];
function fire() {
  for (var i = 0; i < listeners.length; i++) {
    try { listeners[i](S); } catch (e) { /* a bad listener must not break saving */ }
  }
}

load();

window.MeadowSettings = {
  get: function () { return S; },
  lookSens: function () { return S.lookSens; },
  touchSens: function () { return S.touchSens; },
  invertY: function () { return !!S.invertY; },

  /* Falls back to "Walker <id>" so nobody is ever nameless in chat. */
  displayName: function (id) {
    return S.name || ('Walker ' + (id || '?'));
  },
  hasName: function () { return !!S.name; },

  set: function (k, v) {
    if (!(k in DEFAULTS)) { return; }
    if (k === 'name') { S.name = cleanName(v); }
    else if (k === 'invertY') { S.invertY = !!v; }
    else { S[k] = clampNum(v, k === 'touchSens' ? 0.25 : 0.2, k === 'touchSens' ? 2.5 : 3.0); }
    save();
  },

  onChange: function (fn) { if (typeof fn === 'function') { listeners.push(fn); } },
  defaults: function () { return DEFAULTS; },

  /* Fullscreen is a browser-gesture-only API, so this must be called straight
     from a real tap handler or it silently does nothing. */
  toggleFullscreen: function () {
    try {
      var el = document.documentElement;
      if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        var req = el.requestFullscreen || el.webkitRequestFullscreen;
        if (req) {
          var r = req.call(el);
          if (r && r.catch) { r.catch(function () {}); }
        }
        /* Landscape lock is unsupported on iOS Safari - must not throw. */
        try {
          if (screen.orientation && screen.orientation.lock) {
            var p = screen.orientation.lock('landscape');
            if (p && p.catch) { p.catch(function () {}); }
          }
        } catch (e) { /* ignore */ }
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
