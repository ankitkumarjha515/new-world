/* ==========================================================================
   WHISPERING MEADOW - proximity voice

   Talk to people standing near you. The closer they are, the louder they
   are; past VOICE_OFF metres you cannot hear them at all, and the
   connection is dropped entirely.

   The audio goes straight from one browser to the other (WebRTC). It never
   passes through Cloudflare, so it costs nothing and has no lag penalty.
   The server only relays a few small "how do I reach you" messages when two
   people first come within earshot.

   We only connect to people who are actually near, which keeps the number
   of live connections small - usually two or three, never everyone.
   ========================================================================== */
(function () {
'use strict';

var VOICE_ON     = 38;    // start connecting at this distance (world units)
var VOICE_OFF    = 52;    // ...and hang up past this (gap prevents flapping)
var REF_DIST     = 6;     // full volume within this
var ROLLOFF      = 1.7;   // how fast it fades
var MAX_PEERS    = 6;     // hard cap, protects weak laptops

var ICE = {
  iceServers: [
    /* free and unlimited, per Cloudflare's docs */
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' }
  ]
};

var V = {
  on: false, ctx: null, mic: null, micSource: null,
  peers: {},              // id -> { pc, panner, gain, audio, el, polite }
  sendSignal: null, onStatus: null, selfId: 0,
  muted: false, supported: !!(window.RTCPeerConnection && navigator.mediaDevices)
};

function status(s, detail) {
  if (V.onStatus) { V.onStatus(s, detail); }
}

/* ==========================================================================
   Microphone
   ========================================================================== */
var MIC_CONSTRAINTS = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  video: false
};

/* Ask once, and if the browser refuses without ever showing a prompt, try to
   work out why instead of just saying "blocked".

   The case that actually bit us on Android: Chrome will not raise a
   permission prompt while the page is in fullscreen. Tapping FULLSCREEN and
   then TALK therefore fails instantly with NotAllowedError and the player
   never sees a dialog at all. So on that specific failure we drop out of
   fullscreen, ask again, and put fullscreen back afterwards. */
function askForMic() {
  return navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS)
    .catch(function (err) {
      var name = err && err.name;
      var fs = document.fullscreenElement || document.webkitFullscreenElement;
      if (name !== 'NotAllowedError' || !fs) { throw err; }

      status('asking');
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (!exit) { throw err; }
      return Promise.resolve(exit.call(document))
        .catch(function () {})
        .then(function () { return wait(320); })
        .then(function () { return navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS); })
        .then(function (stream) {
          /* Only re-enter on success; if it failed again the player needs to
             see the browser's own site-settings UI, not a fullscreen game. */
          var el = document.documentElement;
          var req = el.requestFullscreen || el.webkitRequestFullscreen;
          if (req) { try { var r = req.call(el); if (r && r.catch) { r.catch(function () {}); } } catch (e) {} }
          return stream;
        });
    });
}

function wait(ms) {
  return new Promise(function (res) { setTimeout(res, ms); });
}

function enable() {
  if (!V.supported) { status('unsupported'); return Promise.resolve(false); }
  if (V.on) { return Promise.resolve(true); }

  /* getUserMedia only exists on a secure origin. Without this check the
     failure looks identical to the player refusing permission. */
  if (!window.isSecureContext) { status('insecure'); return Promise.resolve(false); }

  status('asking');

  return askForMic().then(function (stream) {
    V.mic = stream;
    V.ctx = new (window.AudioContext || window.webkitAudioContext)();
    /* Phones hand back a SUSPENDED context even inside a user gesture, and a
       suspended context produces silence with no error. Resume explicitly,
       and again whenever the tab comes back to the foreground. */
    if (V.ctx.state === 'suspended' && V.ctx.resume) {
      V.ctx.resume().catch(function () {});
    }
    if (!V._visBound) {
      V._visBound = true;
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden && V.ctx && V.ctx.state === 'suspended' && V.ctx.resume) {
          V.ctx.resume().catch(function () {});
        }
      });
    }
    V.on = true;
    status('on');
    return true;
  }).catch(function (err) {
    var name = (err && err.name) || 'UnknownError';
    /* Distinguish "there is no microphone" from "you said no" - they need
       completely different things from the player. */
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      status('nomic', name);
    } else {
      status('denied', name);
    }
    return false;
  });
}

/* Has the player already permanently blocked us? Chrome and Edge answer this
   without prompting; Safari does not implement it and we just get 'unknown'. */
function permissionState() {
  try {
    if (!navigator.permissions || !navigator.permissions.query) {
      return Promise.resolve('unknown');
    }
    return navigator.permissions.query({ name: 'microphone' })
      .then(function (p) { return p.state; })
      .catch(function () { return 'unknown'; });
  } catch (e) { return Promise.resolve('unknown'); }
}

function disable() {
  V.on = false;
  for (var id in V.peers) { drop(id | 0); }
  if (V.mic) {
    V.mic.getTracks().forEach(function (t) { t.stop(); });
    V.mic = null;
  }
  if (V.ctx) { try { V.ctx.close(); } catch (e) {} V.ctx = null; }
  status('off');
}

/* One gain per peer, all gated together. `Muted` has to silence BOTH
   directions, because there is exactly one button and it says "Muted" - not
   "mic off". Stopping only the microphone while everyone else keeps coming
   through your speakers is what a conference call does, and it is the wrong
   model for a proximity chat you dip in and out of: someone who has muted
   themselves has left the conversation, and expects to stop overhearing it.
   Gating the gain rather than tearing the connection down means unmuting is
   instant, with no second handshake. */
function applyOutputGate() {
  var quiet = !V.on || V.muted;
  for (var id in V.peers) {
    var g = V.peers[id].gain;
    if (g) { g.gain.value = quiet ? 0 : 1; }
  }
}

function setMuted(m) {
  V.muted = !!m;
  if (V.mic) {
    V.mic.getAudioTracks().forEach(function (t) { t.enabled = !V.muted; });
  }
  applyOutputGate();
  status(V.on ? (V.muted ? 'muted' : 'on') : 'off');
}

/* ==========================================================================
   One connection to one nearby person
   ========================================================================== */
function makePeer(id, initiator) {
  if (V.peers[id] || !V.on) { return null; }
  if (count() >= MAX_PEERS) { return null; }

  var pc = new RTCPeerConnection(ICE);
  var p = { pc: pc, src: null, panner: null, gain: null, el: null, initiator: initiator };
  V.peers[id] = p;

  /* our microphone goes out */
  V.mic.getTracks().forEach(function (t) { pc.addTrack(t, V.mic); });

  /* their voice comes in and gets placed in 3D space */
  pc.ontrack = function (ev) {
    var stream = ev.streams[0];
    if (!stream) { return; }

    /* Chrome will not decode a WebRTC stream unless it is also attached to
       a media element, even when we route it through Web Audio. */
    var el = document.createElement('audio');
    el.srcObject = stream;
    el.autoplay = true;
    el.muted = true;              // real output goes through the panner
    el.playsInline = true;
    el.style.display = 'none';
    document.body.appendChild(el);
    p.el = el;
    el.play().catch(function () {});

    var src = V.ctx.createMediaStreamSource(stream);
    var panner = V.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = REF_DIST;
    panner.maxDistance = VOICE_OFF;
    panner.rolloffFactor = ROLLOFF;

    var gain = V.ctx.createGain();
    /* a peer that connects while you are muted must arrive silent, not
       blare and then be turned down on the next toggle */
    gain.gain.value = (!V.on || V.muted) ? 0 : 1;

    src.connect(panner);
    panner.connect(gain);
    gain.connect(V.ctx.destination);

    p.src = src;
    p.panner = panner;
    p.gain = gain;
  };

  pc.onicecandidate = function (ev) {
    if (ev.candidate && V.sendSignal) {
      V.sendSignal(id, { kind: 'ice', candidate: ev.candidate });
    }
  };

  pc.onconnectionstatechange = function () {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      drop(id);
    }
  };

  if (initiator) {
    pc.onnegotiationneeded = function () {
      pc.createOffer()
        .then(function (o) { return pc.setLocalDescription(o); })
        .then(function () {
          if (V.sendSignal) { V.sendSignal(id, { kind: 'offer', sdp: pc.localDescription }); }
        })
        .catch(function () {});
    };
  }

  return p;
}

function drop(id) {
  var p = V.peers[id];
  if (!p) { return; }
  try { p.pc.close(); } catch (e) {}
  /* Unhook the audio graph. Closing the connection stops new samples
     arriving, but source -> panner -> gain -> destination stayed wired to
     the output and kept the MediaStream alive with it - so every person who
     walked past left three nodes and a stream behind for the lifetime of the
     session. Disconnect from the end backwards, and let each one fail
     independently: a node that was never reached (ontrack had not fired yet)
     must not stop the rest being cleaned up. */
  try { if (p.gain) { p.gain.disconnect(); } } catch (e) {}
  try { if (p.panner) { p.panner.disconnect(); } } catch (e) {}
  try { if (p.src) { p.src.disconnect(); } } catch (e) {}
  if (p.el) { try { p.el.pause(); p.el.srcObject = null; p.el.remove(); } catch (e) {} }
  p.src = p.panner = p.gain = p.el = null;
  delete V.peers[id];
}

function count() {
  var n = 0;
  for (var k in V.peers) { n++; }
  return n;
}

/* ==========================================================================
   Handshake relayed by the server
   ========================================================================== */
function handleSignal(from, data) {
  if (!V.on || !data) { return; }
  var p = V.peers[from];

  if (data.kind === 'offer') {
    if (!p) { p = makePeer(from, false); }
    if (!p) { return; }
    p.pc.setRemoteDescription(new RTCSessionDescription(data.sdp))
      .then(function () { return p.pc.createAnswer(); })
      .then(function (a) { return p.pc.setLocalDescription(a); })
      .then(function () {
        if (V.sendSignal) { V.sendSignal(from, { kind: 'answer', sdp: p.pc.localDescription }); }
      })
      .catch(function () {});
    return;
  }

  if (!p) { return; }

  if (data.kind === 'answer') {
    p.pc.setRemoteDescription(new RTCSessionDescription(data.sdp)).catch(function () {});
    return;
  }

  if (data.kind === 'ice') {
    p.pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(function () {});
  }
}

/* ==========================================================================
   Called every frame: connect to whoever is near, hang up on whoever left,
   and move each voice to where its owner is standing.
   ========================================================================== */
function update(self, others) {
  if (!V.on || !V.ctx || !self) { return; }

  /* the listener is you: where you are and which way you face */
  var L = V.ctx.listener;
  var fx = -Math.sin(self.yaw), fz = -Math.cos(self.yaw);
  if (L.positionX) {
    var t = V.ctx.currentTime;
    L.positionX.setValueAtTime(self.x, t);
    L.positionY.setValueAtTime(self.y, t);
    L.positionZ.setValueAtTime(self.z, t);
    L.forwardX.setValueAtTime(fx, t);
    L.forwardY.setValueAtTime(0, t);
    L.forwardZ.setValueAtTime(fz, t);
    L.upX.setValueAtTime(0, t); L.upY.setValueAtTime(1, t); L.upZ.setValueAtTime(0, t);
  } else if (L.setPosition) {
    L.setPosition(self.x, self.y, self.z);
    L.setOrientation(fx, 0, fz, 0, 1, 0);
  }

  var near = {};
  for (var i = 0; i < others.length; i++) {
    var o = others[i];
    var dx = o.x - self.x, dz = o.z - self.z;
    var d = Math.sqrt(dx * dx + dz * dz);
    var p = V.peers[o.id];

    if (p) {
      near[o.id] = 1;
      if (d > VOICE_OFF) { drop(o.id); continue; }
      if (p.panner) {
        if (p.panner.positionX) {
          var tt = V.ctx.currentTime;
          p.panner.positionX.setValueAtTime(o.x, tt);
          p.panner.positionY.setValueAtTime(o.y + 1.5, tt);
          p.panner.positionZ.setValueAtTime(o.z, tt);
        } else if (p.panner.setPosition) {
          p.panner.setPosition(o.x, o.y + 1.5, o.z);
        }
      }
    } else if (d < VOICE_ON) {
      near[o.id] = 1;
      /* Only one side may offer, or both would talk over each other.
         The lower id always starts it - both browsers agree without asking. */
      if (V.selfId && V.selfId < o.id) { makePeer(o.id, true); }
    }
  }

  /* anyone who vanished entirely */
  for (var k in V.peers) {
    if (!near[k]) { drop(k | 0); }
  }
}

/* ==========================================================================
   Public API
   ========================================================================== */
window.MeadowVoice = {
  setup: function (opts) {
    V.sendSignal = opts.sendSignal;
    V.onStatus = opts.onStatus || null;
  },
  setSelfId: function (id) { V.selfId = id; },
  enable: enable,
  disable: disable,
  setMuted: setMuted,
  isOn: function () { return V.on; },
  isMuted: function () { return V.muted; },
  permissionState: permissionState,
  isSupported: function () { return V.supported; },
  handleSignal: handleSignal,
  update: update,
  peerCount: count,
  RANGE: VOICE_ON
};

})();
