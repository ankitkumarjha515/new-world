/* Whispering Meadow - audio.js
   Extracted from the original single file. Logic unchanged. */

import { clamp } from './core.js';
var actx = null, aMaster = null, aWind = null, aFall = null, aSea = null, aNoiseBuf = null;

var chirpIn = 2.5, stepPhase = 0;

/* The level audioIn() ramps up to, reached by ear long before there was a
   volume slider. The slider is a multiplier on it rather than a replacement,
   so 100% still means the balance everything else was mixed against. */
var FULL_GAIN = 0.62;

function volumeScale() {
  var S = window.MeadowSettings;
  var v = S ? S.volume() : 1;
  return (typeof v === 'number' && isFinite(v)) ? clamp(v, 0, 1) : 1;
}

/* The target master gain right now. Floored just above zero because the ramp
   below is exponential, and an exponential ramp to exactly 0 is undefined -
   in practice it throws or silently does nothing depending on the browser. */
function targetGain() {
  return Math.max(0.0001, FULL_GAIN * volumeScale());
}

/* Applied immediately when the slider moves, with a short ramp so dragging it
   does not click. Registered once, lazily, from initAudio(). */
function bindVolume() {
  var S = window.MeadowSettings;
  if (!S) { return; }
  S.onChange(function (st, key) {
    if (key !== null && key !== 'volume') { return; }
    if (!actx || !aMaster) { return; }
    try {
      var t = actx.currentTime;
      aMaster.gain.cancelScheduledValues(t);
      aMaster.gain.setValueAtTime(Math.max(0.0001, aMaster.gain.value), t);
      aMaster.gain.exponentialRampToValueAtTime(targetGain(), t + 0.12);
    } catch (e) { /* a browser that dislikes the ramp is not worth throwing over */ }
  });
}

function initAudio() {
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { return; }
    actx = new AC();
    aMaster = actx.createGain(); aMaster.gain.value = 0.0001; aMaster.connect(actx.destination);
    var len = Math.floor(actx.sampleRate * 2.5);
    aNoiseBuf = actx.createBuffer(1, len, actx.sampleRate);
    var d = aNoiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) { d[i] = Math.random() * 2 - 1; }
    function src() { var s = actx.createBufferSource(); s.buffer = aNoiseBuf; s.loop = true; s.start(); return s; }

    aWind = actx.createGain(); aWind.gain.value = 0.17;
    var wf = actx.createBiquadFilter(); wf.type = 'lowpass'; wf.frequency.value = 400; wf.Q.value = 0.6;
    var wl = actx.createOscillator(); wl.frequency.value = 0.063;
    var wg = actx.createGain(); wg.gain.value = 0.10;
    wl.connect(wg); wg.connect(aWind.gain); wl.start();
    src().connect(wf); wf.connect(aWind); aWind.connect(aMaster);

    aFall = actx.createGain(); aFall.gain.value = 0.0;
    var ff = actx.createBiquadFilter(); ff.type = 'bandpass'; ff.frequency.value = 850; ff.Q.value = 0.35;
    src().connect(ff); ff.connect(aFall); aFall.connect(aMaster);

    aSea = actx.createGain(); aSea.gain.value = 0.0;
    var sf = actx.createBiquadFilter(); sf.type = 'lowpass'; sf.frequency.value = 520; sf.Q.value = 0.9;
    var sl = actx.createOscillator(); sl.frequency.value = 0.105;
    var sg = actx.createGain(); sg.gain.value = 300;
    sl.connect(sg); sg.connect(sf.frequency); sl.start();
    src().connect(sf); sf.connect(aSea); aSea.connect(aMaster);
    bindVolume();
  } catch (e) { actx = null; }
}

function audioIn() {
  if (!actx) { return; }
  if (actx.state === 'suspended' && actx.resume) { actx.resume(); }
  try {
    aMaster.gain.cancelScheduledValues(actx.currentTime);
    aMaster.gain.setValueAtTime(Math.max(0.0001, aMaster.gain.value), actx.currentTime);
    aMaster.gain.exponentialRampToValueAtTime(targetGain(), actx.currentTime + 2.4);
  } catch (e) { }
}

function chirp() {
  if (!actx) { return; }
  var t0 = actx.currentTime;
  var n = 2 + Math.floor(Math.random() * 3);
  for (var i = 0; i < n; i++) {
    var t = t0 + i * (0.075 + Math.random() * 0.1);
    var o = actx.createOscillator(); o.type = 'sine';
    var g = actx.createGain();
    var f0 = 1900 + Math.random() * 1900;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * (0.55 + Math.random() * 0.85), t + 0.085);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.035, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.115);
    o.connect(g); g.connect(aMaster);
    o.start(t); o.stop(t + 0.15);
  }
}

function footstep(wet) {
  if (!actx) { return; }
  var t = actx.currentTime;
  var s = actx.createBufferSource(); s.buffer = aNoiseBuf;
  s.playbackRate.value = 0.7 + Math.random() * 0.6;
  var f = actx.createBiquadFilter();
  f.type = 'bandpass'; f.frequency.value = wet ? 900 : 420 + Math.random() * 260; f.Q.value = 1.1;
  var g = actx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(wet ? 0.10 : 0.055, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
  s.connect(f); f.connect(g); g.connect(aMaster);
  s.start(t, Math.random() * 2); s.stop(t + 0.2);
}

function updateAudio(dt, px, py, pz) {
  if (!actx) { return; }
  var dx = px + 240, dy = py - 20, dz = pz + 362;
  var df = Math.sqrt(dx * dx + dy * dy + dz * dz);
  var want = clamp(1 - df / 300, 0, 1);
  aFall.gain.value += (want * want * 0.55 - aFall.gain.value) * Math.min(1, dt * 2.2);
  var seaNear = clamp((pz - 90) / 360, 0, 1);
  aSea.gain.value += (seaNear * seaNear * 0.40 - aSea.gain.value) * Math.min(1, dt * 2.2);
  chirpIn -= dt;
  if (chirpIn <= 0) { chirpIn = 3.5 + Math.random() * 9; chirp(); }
}

/* ======================================================================== *
 *  THE PLAYER
 * ======================================================================== */

export { FULL_GAIN, targetGain, aFall, aMaster, aNoiseBuf, aSea, aWind, actx, audioIn, chirp, chirpIn, footstep, initAudio, stepPhase, updateAudio };
