/* ==========================================================================
   WHISPERING MEADOW - HUD

   The chrome around the picture: a wordmark and clock top-left, a little
   sky / earth / grass switch top-centre that follows where you are looking,
   the presence count under it, and a sound card bottom-left.

   This file used to hold NO heads-up display at all, on the rule "nothing
   permanent over the picture, and nothing that costs a frame". The second
   half of that rule still stands and is why this is built the way it is:

   - Everything is static DOM, built once. No element is created or removed
     while the world is running.
   - Nothing is written per frame. One 4 Hz timer reads the camera pitch, the
     player count and the clock, and touches the DOM only when one of them
     has actually CHANGED - which, standing still, is never.
   - No backdrop-filter, filter or animated shadow anywhere in it (see the
     performance rule at the top of ui.css). Motion is transform and opacity.

   The old compass strip and region announcer stay gone. The switch at the
   top is not navigation: it names what is in front of you, the way the
   reference does, and it is the only thing on screen that moves.

   The performance readout (F3) also lives here, unchanged.
   ========================================================================== */

import { icon } from './icons.js';

var dom = null;
var timer = 0;
var last = { mode: '', count: -1, clock: '', phase: '', vol: -1 };
var hintShown = false;
var hintTimer = 0;
var lastVolume = 0.8;

/* Words for what is in front of you. Pitch is radians, positive up. */
var MODES = {
  sky:   { motto: 'look up, quiet walker',      tilt: -40 },
  earth: { motto: 'keep walking, quiet walker', tilt: 0 },
  grass: { motto: 'touch grass, quiet walker',  tilt: 40 }
};

/* The time of day is the player's own, not the world's: it is what makes
   the sound card read "Golden hour" when it is golden hour where you are. */
function phaseOf(h) {
  if (h >= 5 && h < 8) { return 'first light'; }
  if (h >= 8 && h < 11) { return 'morning'; }
  if (h >= 11 && h < 15) { return 'high noon'; }
  if (h >= 15 && h < 17) { return 'afternoon'; }
  if (h >= 17 && h < 20) { return 'golden hour'; }
  if (h >= 20 && h < 22) { return 'blue hour'; }
  return 'moonlight';
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }

function el(tag, cls, html) {
  var n = document.createElement(tag);
  if (cls) { n.className = cls; }
  if (html !== undefined) { n.innerHTML = html; }
  return n;
}

function buildHUD(root) {
  var diag = el('div');
  diag.id = 'diag';
  root.appendChild(diag);

  var chrome = el('div');
  chrome.id = 'chrome';

  /* ---- top-left: wordmark and clock ---------------------------------- */
  var brand = el('div', 'hud-brand',
    '<div class="wordmark"><b>whispering</b>meadow<span>.world</span></div>' +
    '<div class="hud-meta"><span data-clock>--:--</span> &middot; the meadow &middot; ' +
      '<span data-phase>&nbsp;</span></div>' +
    '<div class="hud-meta hud-meta-2">headphones <span class="chip">better &#9679;</span></div>');
  chrome.appendChild(brand);

  /* ---- top-centre: the switch ---------------------------------------- */
  var center = el('div', 'hud-center',
    '<div class="lever" aria-hidden="true"><i class="lever-stick"><b></b></i></div>' +
    '<div class="hud-modes" aria-hidden="true">' +
      '<span data-m="sky">Sky</span><span data-m="earth">Earth</span><span data-m="grass">Grass</span>' +
    '</div>' +
    '<div class="hud-motto">&nbsp;</div>' +
    '<div class="hud-chip"><span data-count>just you</span></div>');
  chrome.appendChild(center);

  /* ---- bottom-left: the sound card ----------------------------------- */
  var player = el('div', 'hud-player',
    '<span class="disc" aria-hidden="true"><i></i></span>' +
    '<span class="track"><b data-track>Meadow</b><small>meadow wind &middot; ambient</small></span>');
  var muteBtn = el('button', 'round-btn play', icon('pause'));
  muteBtn.type = 'button';
  var volBtn = el('button', 'round-btn ghost', icon('sound'));
  volBtn.type = 'button';
  volBtn.setAttribute('aria-label', 'Sound settings');
  volBtn.title = 'Sound settings';
  player.appendChild(muteBtn);
  player.appendChild(volBtn);
  chrome.appendChild(player);

  /* ---- bottom-centre: a one-time hint on first entering -------------- */
  var hint = el('div', 'hud-hint');
  chrome.appendChild(hint);

  root.appendChild(chrome);

  dom = {
    diag: diag,
    chrome: chrome,
    clock: brand.querySelector('[data-clock]'),
    phase: brand.querySelector('[data-phase]'),
    center: center,
    stick: center.querySelector('.lever-stick'),
    modes: center.querySelectorAll('[data-m]'),
    motto: center.querySelector('.hud-motto'),
    count: center.querySelector('[data-count]'),
    player: player,
    track: player.querySelector('[data-track]'),
    mute: muteBtn,
    vol: volBtn,
    hint: hint
  };

  /* Play/pause on the card is the master mute. It writes through settings,
     so the Volume slider and the card can never disagree, and un-muting
     puts back whatever level the player had chosen. */
  muteBtn.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    var S = window.MeadowSettings;
    if (!S) { return; }
    if (S.volume() > 0) { lastVolume = S.volume(); S.set('volume', 0); }
    else { S.set('volume', lastVolume > 0 ? lastVolume : 0.8); }
  });
  volBtn.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    if (window.MeadowUI) { window.MeadowUI.openSettings(); }
  });

  var S = window.MeadowSettings;
  if (S) {
    if (S.volume() > 0) { lastVolume = S.volume(); }
    S.onChange(function (s, key) {
      if (key === null || key === 'volume') { syncVolume(); }
    });
  }
  syncVolume();
  poll();
  return dom;
}

function syncVolume() {
  if (!dom) { return; }
  var S = window.MeadowSettings;
  var v = S ? S.volume() : 1;
  var on = v > 0;
  if ((on ? 1 : 0) === last.vol) { return; }
  last.vol = on ? 1 : 0;
  dom.mute.innerHTML = icon(on ? 'pause' : 'play');
  var label = on ? 'Mute the meadow' : 'Play the meadow';
  dom.mute.setAttribute('aria-label', label);
  dom.mute.title = label;
  dom.player.classList.toggle('muted', !on);
  dom.vol.innerHTML = icon(on ? 'sound' : 'mute');
}

/* ---- the 4 Hz read ------------------------------------------------------ */
function poll() {
  if (!dom) { return; }

  /* clock and phase */
  var d = new Date();
  var clock = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  if (clock !== last.clock) {
    last.clock = clock;
    dom.clock.textContent = clock;
    var phase = phaseOf(d.getHours());
    if (phase !== last.phase) {
      last.phase = phase;
      dom.phase.textContent = phase;
      dom.track.textContent = phase.charAt(0).toUpperCase() + phase.slice(1);
      dom.player.setAttribute('data-phase', phase.replace(' ', '-'));
    }
  }

  /* where the camera is pointing. window.__meadow is the read-only handle
     main.js publishes; before the world has booted there is no pitch, and
     the switch rests on "earth". */
  var m = window.__meadow;
  var pitch = (m && m.player) ? m.player.pitch : 0;
  var mode = pitch > 0.22 ? 'sky' : (pitch < -0.32 ? 'grass' : 'earth');
  if (mode !== last.mode) {
    last.mode = mode;
    for (var i = 0; i < dom.modes.length; i++) {
      dom.modes[i].classList.toggle('on', dom.modes[i].getAttribute('data-m') === mode);
    }
    dom.motto.textContent = MODES[mode].motto;
    dom.stick.style.transform = 'rotate(' + MODES[mode].tilt + 'deg)';
  }

  /* who else is here */
  var N = window.MeadowNet;
  var n = (N && N.count) ? N.count() : 0;
  if (n !== last.count) {
    last.count = n;
    var txt;
    if (!N || !N.isConnected || !N.isConnected()) { txt = 'just you &middot; offline'; }
    else if (n <= 1) { txt = 'just you &middot; here now'; }
    else { txt = '<b>' + n + '</b> walkers &middot; here now'; }
    dom.count.innerHTML = txt;
    dom.center.classList.toggle('live', n > 1);
  }
}

/* Which screen is up decides how much chrome there is. Hidden entirely on
   the boot card, which has its own wordmark. */
function setScreen(state) {
  if (!dom) { return; }
  dom.chrome.setAttribute('data-screen', state);
  var visible = state !== 'boot';
  dom.chrome.classList.toggle('on', visible);
  if (visible && !timer) { timer = setInterval(poll, 250); poll(); }
  if (!visible && timer) { clearInterval(timer); timer = 0; }
}

/* Entering the world the first time shows how to move, once, then gets out
   of the way. */
function show(playing) {
  if (!dom || !playing || hintShown) { return; }
  hintShown = true;
  var touch = document.body.classList.contains('is-touch');
  dom.hint.innerHTML = touch
    ? '<span><b>left thumb</b> walk</span><span><b>drag</b> look</span><span><b>double-tap</b> run</span>'
    : '<span><b>wasd</b> walk</span><span><b>mouse</b> look</span><span><b>shift</b> run</span>' +
      '<span><b>space</b> jump</span><span><b>esc</b> pause</span>';
  dom.hint.classList.add('on');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(function () { dom.hint.classList.remove('on'); }, 7000);
}

function setDiag(text) {
  if (!dom) { return; }
  dom.diag.textContent = text;
}

function showDiag(on) {
  if (!dom) { return; }
  dom.diag.classList.toggle('on', !!on);
}

function diagVisible() {
  return !!(dom && dom.diag.classList.contains('on'));
}

/* Kept as no-ops so ui.js and main.js have one shape to call into. */
function tick() {}
function measure() {}
function setHeading() {}
function setRegion() {}
function setPlayers() {}

export { buildHUD, setDiag, showDiag, diagVisible, show, setScreen, tick, measure, setHeading, setRegion, setPlayers };
