/* ==========================================================================
   WHISPERING MEADOW - multiplayer client

   Drop-in. The game stays exactly as it is except for one line, added once
   the world is built:

       MeadowNet.attach({ THREE: THREE, scene: scene, getPlayer: ... });

   From then on this file runs its own loop: it sends your position a few
   times a second and draws everybody else. It never touches the game's
   renderer, camera or update loop.

   Nothing about the world is sent or received. The meadow is generated from
   fixed seeds on every machine, so all that travels is where people stand.
   ========================================================================== */
(function () {
'use strict';

/* ---- must match src/protocol.js ----------------------------------------- */
var MSG = { HELLO: 1, MOVE: 2, SNAP: 3, LEAVE: 4, FULL: 5 };
var Q = { XZ: 16, Y: 64, ANGLE: 10000 };
var PLAYER_BYTES = 13;
var FLAG = { MOVING: 1, RUNNING: 2, AIRBORNE: 4 };

/* ---- tuning ------------------------------------------------------------- */
var SEND_HZ      = 8;      // our own position, only when it actually changes
var LERP_DELAY   = 0.15;   // render others 150ms in the past, so motion is smooth
var MOVE_EPS     = 0.05;   // below this we are standing still: send nothing
var ANGLE_EPS    = 0.02;
var PING_MS      = 20000;  // auto-answered by the server, keeps the socket warm
var DRAW_RADIUS  = 600;    // hide distant people entirely - cheap on weak GPUs

var net = {
  ws: null, id: 0, connected: false,
  players: {},        // id -> { mesh, buf: [snapshots], cur: {} }
  scene: null, THREE: null, getPlayer: null,
  lastSend: 0, lastPing: 0, sent: { x: 1e9, z: 1e9, yaw: 0, pitch: 0 },
  retry: 0, retryTimer: null, running: false,
  geo: null, mats: [], group: null,
  onCount: null
};

/* ==========================================================================
   A stand-in body. Deliberately simple - swap buildAvatar() for the real
   character once it exists; nothing else here needs to change.
   ========================================================================== */
function buildAvatar(THREE, id) {
  /* The real character lives in game/character.js. It publishes itself on
     window because this file is a plain script and cannot import. If it has
     not loaded yet, fall back to a simple figure so people are never
     invisible - a missing body is worse than a plain one. */
  var C = window.MeadowCharacter;
  if (C) {
    var ch = C.build(THREE, id, { firstPerson: false });
    ch.root.userData.ch = ch;
    return ch.root;
  }
  if (!net.geo) {
    var g = new THREE.CylinderGeometry(0.17, 0.30, 1.15, 7, 1);
    g.translate(0, 0.575, 0);
    net.geo = g;
    net.headGeo = new THREE.SphereGeometry(0.20, 10, 8);
  }
  var hue = ((id * 47) % 360) / 360;
  var mat = new THREE.MeshLambertMaterial({ color: new THREE.Color().setHSL(hue, 0.42, 0.62) });
  net.mats.push(mat);
  var body = new THREE.Mesh(net.geo, mat);
  var head = new THREE.Mesh(net.headGeo, mat);
  head.position.y = 1.34;
  var root = new THREE.Group();
  root.add(body);
  root.add(head);
  return root;
}

/* ==========================================================================
   Connection
   ========================================================================== */
function url() {
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var room = new URLSearchParams(location.search).get('room') || 'meadow-1';
  return proto + '//' + location.host + '/ws?room=' + encodeURIComponent(room);
}

function connect() {
  if (net.ws || !net.running) { return; }
  var ws;
  try { ws = new WebSocket(url()); } catch (e) { scheduleRetry(); return; }
  ws.binaryType = 'arraybuffer';
  net.ws = ws;

  ws.onopen = function () {
    net.connected = true;
    net.retry = 0;
    net.sent.x = 1e9;           // force a first send
  };

  ws.onmessage = function (ev) {
    if (typeof ev.data === 'string') { handleText(ev.data); return; }
    handle(new DataView(ev.data));
  };

  ws.onclose = function (ev) {
    var wasConnected = net.connected;
    net.connected = false;
    net.ws = null;
    clearEveryone();
    /* the server answers 503 when a meadow is full; without this the client
       just retries forever and the player never learns why nobody is here */
    if (!wasConnected && net.retry >= 3) {
      addChat(0, 'Could not reach the meadow. Still trying...', false, true);
    }
    scheduleRetry();
  };

  ws.onerror = function () { try { ws.close(); } catch (e) {} };
}

function scheduleRetry() {
  if (!net.running || net.retryTimer) { return; }
  net.retry = Math.min(net.retry + 1, 6);
  var wait = Math.min(500 * Math.pow(2, net.retry), 20000);
  net.retryTimer = setTimeout(function () {
    net.retryTimer = null;
    connect();
  }, wait);
}

/* ==========================================================================
   Incoming
   ========================================================================== */
function readPlayer(view, off) {
  return {
    id:    view.getUint16(off, true),
    x:     view.getInt16(off + 2, true) / Q.XZ,
    y:     view.getInt16(off + 4, true) / Q.Y,
    z:     view.getInt16(off + 6, true) / Q.XZ,
    yaw:   view.getInt16(off + 8, true) / Q.ANGLE,
    pitch: view.getInt16(off + 10, true) / Q.ANGLE,
    flags: view.getUint8(off + 12)
  };
}

function handle(view) {
  var type = view.getUint8(0), i, n, off, p;

  if (type === MSG.HELLO) {
    net.id = view.getUint16(1, true);
    if (window.MeadowVoice) { window.MeadowVoice.setSelfId(net.id); }
    n = view.getUint16(3, true);
    off = 5;
    for (i = 0; i < n; i++) { ingest(readPlayer(view, off)); off += PLAYER_BYTES; }
    report();
    return;
  }

  if (type === MSG.SNAP) {
    n = view.getUint16(1, true);
    off = 3;
    var seen = {};
    for (i = 0; i < n; i++) {
      p = readPlayer(view, off); off += PLAYER_BYTES;
      seen[p.id] = 1;
      if (p.id !== net.id) { ingest(p); }
    }
    /* anyone missing from a full snapshot has gone */
    for (var k in net.players) {
      if (!seen[k]) { remove(k | 0); }
    }
    report();
    return;
  }

  if (type === MSG.LEAVE) {
    remove(view.getUint16(1, true));
    report();
    return;
  }
}

/* ---- chat + voice setup (text frames) ----------------------------------- */
function handleText(raw) {
  if (raw === 'P') { return; }              // keepalive reply
  var m;
  try { m = JSON.parse(raw); } catch (e) { return; }
  if (!m || !m.t) { return; }

  if (m.t === 'chat') {
    addChat(m.from, m.text, m.from === net.id, false, m.name);
    return;
  }
  if (m.t === 'signal' && window.MeadowVoice) {
    window.MeadowVoice.handleSignal(m.from, m.data);
    return;
  }
  if (m.t === 'sys') { addChat(0, m.text, false, true); }
}

function sendJSON(obj) {
  if (!net.connected || !net.ws) { return; }
  try { net.ws.send(JSON.stringify(obj)); } catch (e) {}
}

function ingest(p) {
  var e = net.players[p.id];
  if (!e) {
    e = net.players[p.id] = {
      mesh: buildAvatar(net.THREE, p.id),
      buf: [],
      cur: { x: p.x, y: p.y, z: p.z, yaw: p.yaw }
    };
    e.mesh.position.set(p.x, p.y, p.z);
    net.group.add(e.mesh);
  }
  e.buf.push({ t: now(), x: p.x, y: p.y, z: p.z, yaw: p.yaw, flags: p.flags });
  if (e.buf.length > 12) { e.buf.shift(); }
}

function remove(id) {
  var e = net.players[id];
  if (!e) { return; }
  net.group.remove(e.mesh);
  /* each avatar gets its own material for its colour, so it has to be freed
     or every player who ever joined leaks one for the life of the session */
  var ch = e.mesh.userData && e.mesh.userData.ch;
  if (ch && window.MeadowCharacter) {
    window.MeadowCharacter.dispose(ch);
  } else {
    e.mesh.traverse(function (o) {
      if (o.material && o.material.dispose) { o.material.dispose(); }
    });
  }
  delete net.players[id];
}

function clearEveryone() {
  for (var k in net.players) { remove(k | 0); }
}

function report() {
  if (net.onCount) {
    var c = 0;
    for (var k in net.players) { c++; }
    net.onCount(c + 1);      // everyone else, plus you
  }
}

/* ==========================================================================
   Outgoing - only when we have actually moved
   ========================================================================== */
function send(me) {
  var t = now();
  if (t - net.lastSend < 1 / SEND_HZ) { return; }

  var moved = Math.abs(me.x - net.sent.x) > MOVE_EPS ||
              Math.abs(me.z - net.sent.z) > MOVE_EPS ||
              Math.abs(me.yaw - net.sent.yaw) > ANGLE_EPS ||
              Math.abs(me.pitch - net.sent.pitch) > ANGLE_EPS;

  if (!moved) {
    /* Standing still costs nothing. In a game about looking at scenery this
       is most of the time, and it is the single biggest saving there is. */
    if (t - net.lastPing > PING_MS / 1000) {
      net.lastPing = t;
      try { net.ws.send('p'); } catch (e) {}
    }
    return;
  }

  net.lastSend = t;
  net.sent.x = me.x; net.sent.z = me.z;
  net.sent.yaw = me.yaw; net.sent.pitch = me.pitch;

  var flags = (me.moving ? FLAG.MOVING : 0) |
              (me.running ? FLAG.RUNNING : 0) |
              (me.airborne ? FLAG.AIRBORNE : 0);

  var buf = new ArrayBuffer(1 + PLAYER_BYTES);
  var v = new DataView(buf);
  v.setUint8(0, MSG.MOVE);
  v.setUint16(1, 0, true);                 // server fills in our real id
  v.setInt16(3, Math.round(me.x * Q.XZ), true);
  v.setInt16(5, Math.round(me.y * Q.Y), true);
  v.setInt16(7, Math.round(me.z * Q.XZ), true);
  v.setInt16(9, Math.round(me.yaw * Q.ANGLE), true);
  v.setInt16(11, Math.round(me.pitch * Q.ANGLE), true);
  v.setUint8(13, flags);
  try { net.ws.send(buf); } catch (e) {}
}

/* ==========================================================================
   Smoothing - draw everyone a moment in the past so motion is continuous
   even though updates arrive ten times a second
   ========================================================================== */
var dtFrame = 0.016, lastFrameT = 0;
function interpolate() {
  var tNow = now();
  dtFrame = lastFrameT ? Math.min(0.05, tNow - lastFrameT) : 0.016;
  lastFrameT = tNow;
  var target = tNow - LERP_DELAY;
  var me = net.getPlayer ? net.getPlayer() : null;

  for (var k in net.players) {
    var e = net.players[k], b = e.buf;
    if (b.length === 0) { continue; }

    var a = null, c = null;
    for (var i = 0; i < b.length - 1; i++) {
      if (b[i].t <= target && b[i + 1].t >= target) { a = b[i]; c = b[i + 1]; break; }
    }
    if (!a) { a = c = b[b.length - 1]; }

    var f = (c.t === a.t) ? 0 : (target - a.t) / (c.t - a.t);
    f = f < 0 ? 0 : f > 1 ? 1 : f;

    var x = a.x + (c.x - a.x) * f;
    var y = a.y + (c.y - a.y) * f;
    var z = a.z + (c.z - a.z) * f;

    /* speed comes from the last two snapshots, so the walk cycle matches
       what the person is really doing rather than being faked */
    var dtq = Math.max(0.001, c.t - a.t);
    var spd = Math.sqrt((c.x - a.x) * (c.x - a.x) + (c.z - a.z) * (c.z - a.z)) / dtq;
    if (c === a) { spd = 0; }

    e.mesh.position.set(x, y, z);
    var yaw = lerpAngle(a.yaw, c.yaw, f);
    var ch = e.mesh.userData.ch;
    var C = window.MeadowCharacter;
    if (ch && C) {
      C.face(ch, yaw, 0);
      C.animate(ch, Math.min(0.05, dtFrame), spd, !!(c.flags & FLAG.AIRBORNE));
    } else {
      e.mesh.rotation.y = yaw;
    }

    /* far away? do not draw them at all */
    if (me) {
      var dx = x - me.x, dz = z - me.z;
      e.mesh.visible = (dx * dx + dz * dz) < DRAW_RADIUS * DRAW_RADIUS;
    }

    while (b.length > 2 && b[1].t < target) { b.shift(); }
  }
}

function lerpAngle(a, b, f) {
  var d = b - a;
  while (d > Math.PI) { d -= Math.PI * 2; }
  while (d < -Math.PI) { d += Math.PI * 2; }
  return a + d * f;
}

function now() {
  return (window.performance && performance.now ? performance.now() : Date.now()) / 1000;
}

/* ==========================================================================
   Chat panel and voice button

   Built here in script rather than in the page, so the game's HTML file does
   not need to change. Typing is captured before the game sees it, so WASD
   never leaks into a message and the message never walks you into the river.
   ========================================================================== */
var ui = { root: null, log: null, entry: null, typing: false, buf: '',
           voiceBtn: null, chatBtn: null, count: null, input: null };

/* On a phone there is no Enter key and no physical keyboard, so the custom
   key-capture chat cannot work: we need a real focused <input> to make the
   on-screen keyboard appear at all. */
var IS_TOUCH = (function () {
  /* honour the same ?touch=1 / ?touch=0 override game/touch.js uses, so the
     two layers can never disagree about whether this is a phone */
  try {
    var q = new URLSearchParams(location.search).get('touch');
    if (q === '1') { return true; }
    if (q === '0') { return false; }
  } catch (e) {}
  var coarse = false;
  try { coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches; } catch (e) {}
  return (navigator.maxTouchPoints > 0 || 'ontouchstart' in window) && coarse;
})();

var CSS =
'#mn-ui{position:fixed;left:14px;bottom:14px;z-index:30;width:min(330px,42vw);' +
  'font-family:ui-sans-serif,system-ui,"Segoe UI",sans-serif;pointer-events:none;' +
  '-webkit-user-select:none;user-select:none}' +
'#mn-log{display:flex;flex-direction:column;gap:5px;margin-bottom:8px;max-height:34vh;overflow:hidden}' +
'.mn-msg{background:rgba(10,20,28,.62);border-left:2px solid rgba(246,217,138,.55);' +
  'padding:5px 9px;border-radius:0 4px 4px 0;font-size:13px;line-height:1.45;color:#f1efe6;' +
  'backdrop-filter:blur(2px);animation:mn-in .18s ease-out;word-wrap:break-word}' +
'.mn-msg.me{border-left-color:rgba(159,227,201,.7)}' +
'.mn-msg.sys{border-left-color:rgba(255,255,255,.25);font-style:italic;opacity:.75}' +
'.mn-who{font-weight:700;font-size:11px;letter-spacing:.06em;text-transform:uppercase;' +
  'opacity:.8;margin-right:6px}' +
'@keyframes mn-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}' +
'#mn-entry{display:none;pointer-events:auto;background:rgba(10,20,28,.85);' +
  'border:1px solid rgba(246,217,138,.4);border-radius:5px;padding:8px 11px;font-size:13.5px;' +
  'color:#fdfaf2;min-height:34px;line-height:1.4;word-wrap:break-word}' +
'#mn-entry.on{display:block}' +
'#mn-entry .cur{display:inline-block;width:7px;background:#f6d98a;animation:mn-blink 1.05s steps(1) infinite;' +
  'margin-left:1px;vertical-align:-2px;height:15px}' +
'@keyframes mn-blink{50%{opacity:0}}' +
'#mn-bar{position:fixed;right:14px;bottom:14px;z-index:30;display:flex;gap:8px;align-items:center;' +
  'font-family:ui-sans-serif,system-ui,sans-serif;pointer-events:none}' +
'#mn-bar button{pointer-events:auto;cursor:pointer;font:inherit;font-size:11.5px;font-weight:600;' +
  'letter-spacing:.08em;text-transform:uppercase;padding:7px 13px;border-radius:999px;' +
  'background:rgba(10,20,28,.7);color:#f1efe6;border:1px solid rgba(255,255,255,.18);' +
  'transition:background .15s,border-color .15s}' +
'#mn-bar button:hover{background:rgba(10,20,28,.9);border-color:rgba(246,217,138,.5)}' +
'#mn-bar button.live{border-color:rgba(159,227,201,.75);color:#9fe3c9}' +
'#mn-bar button.muted{border-color:rgba(255,180,162,.7);color:#ffb4a2}' +
'#mn-bar button:focus-visible{outline:2px solid #f6d98a;outline-offset:2px}' +
'#mn-count{pointer-events:none;font-size:11.5px;letter-spacing:.08em;color:#f1efe6;opacity:.62;' +
  'background:rgba(10,20,28,.55);padding:6px 11px;border-radius:999px}' +
'#mn-input{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:31;' +
  'width:min(560px,86vw);display:none;font:inherit;font-size:16px;padding:12px 14px;' +
  'border-radius:8px;border:1px solid rgba(246,217,138,.5);background:rgba(10,20,28,.94);' +
  'color:#fdfaf2;outline:none;-webkit-appearance:none}' +
'#mn-input.on{display:block}' +
'body.mn-touch #mn-bar{gap:10px;flex-direction:column;align-items:flex-end;' +
  'right:calc(112px + env(safe-area-inset-right));bottom:calc(14px + env(safe-area-inset-bottom))}' +
'body.mn-touch #mn-bar button{font-size:13px;padding:12px 20px;min-height:46px}' +
'body.mn-touch #mn-ui{left:calc(14px + env(safe-area-inset-left));width:min(300px,38vw)}' +
'#mn-panel{position:fixed;inset:0;z-index:40;display:none;align-items:center;' +
  'justify-content:center;background:rgba(6,12,18,.72);font-family:ui-sans-serif,system-ui,sans-serif}' +
'#mn-panel.on{display:flex}' +
'#mn-panel .box{width:min(420px,90vw);max-height:86vh;overflow:auto;background:#101c26;' +
  'border:1px solid rgba(246,217,138,.35);border-radius:10px;padding:20px 22px;color:#f1efe6}' +
'#mn-panel h3{margin:0 0 4px;font-size:15px;letter-spacing:.14em;text-transform:uppercase;' +
  'color:#f6d98a;font-weight:700}' +
'#mn-panel label{display:block;font-size:12.5px;opacity:.85;margin:16px 0 6px;letter-spacing:.04em}' +
'#mn-panel input[type=text]{width:100%;font:inherit;font-size:16px;padding:10px 12px;' +
  'border-radius:6px;border:1px solid rgba(255,255,255,.2);background:rgba(0,0,0,.35);' +
  'color:#fdfaf2;outline:none;-webkit-appearance:none}' +
'#mn-panel input[type=range]{width:100%;accent-color:#f6d98a}' +
'#mn-panel .row{display:flex;gap:10px;margin-top:22px}' +
'#mn-panel .row button{flex:1;cursor:pointer;font:inherit;font-size:12.5px;font-weight:600;' +
  'letter-spacing:.08em;text-transform:uppercase;padding:13px;border-radius:6px;' +
  'background:rgba(246,217,138,.14);color:#f6d98a;border:1px solid rgba(246,217,138,.45)}' +
'#mn-panel .val{float:right;font-variant-numeric:tabular-nums;color:#f6d98a}' +
'@media (max-width:640px){#mn-ui{width:70vw}}';

function buildUI() {
  var st = document.createElement('style');
  st.textContent = CSS;
  document.head.appendChild(st);

  ui.root = document.createElement('div');
  ui.root.id = 'mn-ui';
  ui.log = document.createElement('div');
  ui.log.id = 'mn-log';
  ui.entry = document.createElement('div');
  ui.entry.id = 'mn-entry';
  ui.root.appendChild(ui.log);
  ui.root.appendChild(ui.entry);
  document.body.appendChild(ui.root);

  var bar = document.createElement('div');
  bar.id = 'mn-bar';

  ui.count = document.createElement('span');
  ui.count.id = 'mn-count';
  ui.count.textContent = 'alone';

  ui.voiceBtn = document.createElement('button');
  ui.voiceBtn.type = 'button';
  ui.voiceBtn.textContent = 'Talk';
  ui.voiceBtn.title = 'Speak to people near you';
  ui.voiceBtn.addEventListener('click', function (e) {
    e.stopPropagation();               // do not re-lock the pointer
    toggleVoice();
  });

  bar.appendChild(ui.count);

  if (IS_TOUCH) {
    document.body.classList.add('mn-touch');
    ui.chatBtn = document.createElement('button');
    ui.chatBtn.type = 'button';
    ui.chatBtn.textContent = 'Chat';
    ui.chatBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openChat();
    });
    bar.appendChild(ui.chatBtn);

    /* a real input: focusing it is the only way to raise the soft keyboard */
    ui.input = document.createElement('input');
    ui.input.id = 'mn-input';
    ui.input.type = 'text';
    ui.input.maxLength = 200;
    ui.input.setAttribute('placeholder', 'Say something...');
    ui.input.setAttribute('autocomplete', 'off');
    ui.input.setAttribute('autocorrect', 'off');
    ui.input.addEventListener('keydown', function (e) {
      e.stopPropagation();                 // never let chat keys drive the game
      if (e.key === 'Enter') { closeChat(true); }
      else if (e.key === 'Escape') { closeChat(false); }
    });
    ui.input.addEventListener('blur', function () {
      if (ui.typing) { closeChat(true); }
    });
    document.body.appendChild(ui.input);
  }

  bar.appendChild(ui.voiceBtn);

  var gear = document.createElement('button');
  gear.type = 'button';
  gear.textContent = IS_TOUCH ? 'Menu' : 'Settings';
  gear.title = 'Name, sensitivity, fullscreen';
  gear.addEventListener('click', function (e) { e.stopPropagation(); openSettings(); });
  bar.appendChild(gear);

  document.body.appendChild(bar);

  buildSettings();
  addChat(0, IS_TOUCH
    ? 'Tap CHAT to talk. People nearby can hear your voice.'
    : 'Press Enter to chat. Others hear you when you are close.', false, true);
}

/* ---------------------------------------------------------------- settings
   Name, look sensitivity and fullscreen. Values live in settings.js and are
   stored per device, so a phone can be far less sensitive than a laptop. */
function buildSettings() {
  var St = window.MeadowSettings;
  if (!St) { return; }

  var panel = document.createElement('div');
  panel.id = 'mn-panel';
  var box = document.createElement('div');
  box.className = 'box';
  panel.appendChild(box);

  var h = document.createElement('h3');
  h.textContent = 'Settings';
  box.appendChild(h);

  function label(txt, valTxt) {
    var l = document.createElement('label');
    l.appendChild(document.createTextNode(txt));
    if (valTxt !== undefined) {
      var v = document.createElement('span');
      v.className = 'val';
      v.textContent = valTxt;
      l.appendChild(v);
      l._val = v;
    }
    box.appendChild(l);
    return l;
  }

  label('Your name (other players see this)');
  var nameIn = document.createElement('input');
  nameIn.type = 'text';
  nameIn.maxLength = 16;
  nameIn.placeholder = 'Walker';
  nameIn.value = St.get().name || '';
  nameIn.setAttribute('autocomplete', 'off');
  nameIn.addEventListener('keydown', function (e) { e.stopPropagation(); });
  nameIn.addEventListener('input', function () { St.set('name', nameIn.value); });
  box.appendChild(nameIn);

  var sensKey = IS_TOUCH ? 'touchSens' : 'lookSens';
  var lSens = label(IS_TOUCH ? 'Touch look sensitivity' : 'Mouse look sensitivity',
                    St.get()[sensKey].toFixed(2));
  var sens = document.createElement('input');
  sens.type = 'range';
  sens.min = IS_TOUCH ? '0.10' : '0.20';
  sens.max = IS_TOUCH ? '2.00' : '3.00';
  sens.step = '0.05';
  sens.value = St.get()[sensKey];
  sens.addEventListener('input', function () {
    St.set(sensKey, sens.value);
    lSens._val.textContent = parseFloat(sens.value).toFixed(2);
  });
  box.appendChild(sens);

  var invWrap = document.createElement('label');
  var inv = document.createElement('input');
  inv.type = 'checkbox';
  inv.checked = St.invertY();
  inv.style.marginRight = '8px';
  inv.addEventListener('change', function () { St.set('invertY', inv.checked); });
  invWrap.appendChild(inv);
  invWrap.appendChild(document.createTextNode('Invert vertical look'));
  box.appendChild(invWrap);

  var row = document.createElement('div');
  row.className = 'row';

  var fsBtn = document.createElement('button');
  fsBtn.type = 'button';
  fsBtn.textContent = St.isFullscreen() ? 'Exit fullscreen' : 'Fullscreen';
  fsBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    St.toggleFullscreen();
    setTimeout(function () {
      fsBtn.textContent = St.isFullscreen() ? 'Exit fullscreen' : 'Fullscreen';
    }, 140);
  });
  row.appendChild(fsBtn);

  var close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Done';
  close.addEventListener('click', function (e) {
    e.stopPropagation();
    panel.classList.remove('on');
  });
  row.appendChild(close);
  box.appendChild(row);

  panel.addEventListener('click', function (e) {
    e.stopPropagation();
    if (e.target === panel) { panel.classList.remove('on'); }
  });
  document.body.appendChild(panel);
  ui.panel = panel;
}

function openSettings() {
  if (ui.panel) { ui.panel.classList.add('on'); }
}

function addChat(from, text, mine, sys, who) {
  if (!ui.log) { return; }
  var d = document.createElement('div');
  d.className = 'mn-msg' + (mine ? ' me' : '') + (sys ? ' sys' : '');
  if (!sys) {
    var w = document.createElement('span');
    w.className = 'mn-who';
    w.textContent = mine ? 'you' : (who || ('walker ' + from));
    d.appendChild(w);
  }
  d.appendChild(document.createTextNode(text));   // textContent: never parsed as HTML
  ui.log.appendChild(d);
  while (ui.log.children.length > 7) { ui.log.removeChild(ui.log.firstChild); }
  clearTimeout(d._t);
  d._t = setTimeout(function () {
    d.style.transition = 'opacity .6s'; d.style.opacity = '0';
    setTimeout(function () { if (d.parentNode) { d.remove(); } }, 650);
  }, 22000);
}

function drawEntry() {
  ui.entry.textContent = '';
  ui.entry.appendChild(document.createTextNode(ui.buf));
  var c = document.createElement('span');
  c.className = 'cur';
  ui.entry.appendChild(c);
}

function openChat() {
  if (ui.typing) { return; }
  ui.typing = true;
  ui.buf = '';
  /* the game clears its held keys on blur, so this stops us walking */
  window.dispatchEvent(new Event('blur'));

  if (IS_TOUCH && ui.input) {
    ui.input.value = '';
    ui.input.classList.add('on');
    ui.input.focus();                      // raises the on-screen keyboard
    return;
  }
  ui.entry.classList.add('on');
  drawEntry();
}

function closeChat(send) {
  if (!ui.typing) { return; }
  var text;
  if (IS_TOUCH && ui.input) {
    text = (ui.input.value || '').trim();
    ui.input.classList.remove('on');
    ui.input.value = '';
    ui.input.blur();
  } else {
    text = ui.buf.trim();
    ui.entry.classList.remove('on');
    ui.entry.textContent = '';
  }
  ui.typing = false;
  ui.buf = '';
  if (send && text) {
    var St2 = window.MeadowSettings;
    sendJSON({ t: 'chat', text: text.slice(0, 200), name: St2 ? St2.get().name : '' });
  }
}

/* Capture phase on window: we see the key before the game does, and
   stopPropagation keeps it from ever reaching the game's handler. */
function onKey(e) {
  if (IS_TOUCH && ui.input) { return; }   // the real input handles its own keys
  if (!ui.typing) {
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault(); e.stopPropagation();
      openChat();
    }
    return;
  }
  e.preventDefault();
  e.stopPropagation();

  if (e.code === 'Escape') { closeChat(false); return; }
  if (e.code === 'Enter' || e.code === 'NumpadEnter') { closeChat(true); return; }
  if (e.code === 'Backspace') { ui.buf = ui.buf.slice(0, -1); drawEntry(); return; }
  if (e.key && e.key.length === 1 && ui.buf.length < 200) {
    ui.buf += e.key;
    drawEntry();
  }
}

function toggleVoice() {
  var V = window.MeadowVoice;
  if (!V) { return; }
  if (!V.isSupported()) { addChat(0, 'This browser cannot do voice chat.', false, true); return; }
  if (!V.isOn()) {
    V.enable().then(function (ok) {
      if (ok) { addChat(0, 'Microphone on. People nearby can hear you.', false, true); }
    });
  } else if (!V.isMuted()) {
    V.setMuted(true);
    addChat(0, 'Muted. You cannot hear anyone and nobody can hear you.', false, true);
  } else {
    V.setMuted(false);
    addChat(0, 'Unmuted. People nearby can hear you again.', false, true);
  }
}

function voiceStatus(s) {
  if (!ui.voiceBtn) { return; }
  ui.voiceBtn.classList.remove('live', 'muted');
  if (s === 'on') { ui.voiceBtn.textContent = 'Talking'; ui.voiceBtn.classList.add('live'); }
  else if (s === 'muted') { ui.voiceBtn.textContent = 'Muted'; ui.voiceBtn.classList.add('muted'); }
  else if (s === 'asking') { ui.voiceBtn.textContent = 'Allow mic…'; }
  else if (s === 'denied') {
    ui.voiceBtn.textContent = 'Mic blocked';
    /* "Blocked" with no prompt is nearly always a permission the browser has
       already remembered, so say where to undo it rather than just failing. */
    addChat(0, IS_TOUCH
      ? 'Mic blocked. Tap the lock icon next to the address bar, then Permissions, and allow Microphone.'
      : 'Mic blocked. Click the icon at the left of the address bar and allow Microphone, then press Talk again.',
      false, true);
  }
  else if (s === 'nomic') { ui.voiceBtn.textContent = 'No mic'; addChat(0, 'No microphone was found on this device.', false, true); }
  else if (s === 'insecure') { ui.voiceBtn.textContent = 'No voice'; addChat(0, 'Voice chat needs a https address. Open the game over https and try again.', false, true); }
  else if (s === 'unsupported') { ui.voiceBtn.textContent = 'No voice'; }
  else { ui.voiceBtn.textContent = 'Talk'; }
}

function updateCount() {
  if (!ui.count) { return; }
  var c = 0;
  for (var k in net.players) { c++; }
  var v = window.MeadowVoice ? window.MeadowVoice.peerCount() : 0;
  ui.count.textContent = c === 0 ? 'alone here'
    : (c + (c === 1 ? ' other' : ' others')) + (v ? '  ·  ' + v + ' in earshot' : '');
}

/* pull in the voice engine so the page only needs one script tag */
function loadVoice(cb) {
  if (window.MeadowVoice) { cb(); return; }
  var s = document.createElement('script');
  s.src = 'voice.js';
  s.onload = cb;
  s.onerror = function () { cb(); };     // chat still works without it
  document.head.appendChild(s);
}

/* ==========================================================================
   Loop
   ========================================================================== */
var uiAcc = 0;
function frame() {
  if (!net.running) { return; }
  requestAnimationFrame(frame);

  var me = net.getPlayer ? net.getPlayer() : null;
  if (net.connected && me) { send(me); }
  interpolate();

  /* keep each voice positioned where its owner is standing */
  var V = window.MeadowVoice;
  if (V && V.isOn() && me) {
    var list = [];
    for (var k in net.players) {
      var e = net.players[k];
      list.push({ id: k | 0, x: e.mesh.position.x, y: e.mesh.position.y, z: e.mesh.position.z });
    }
    V.update(me, list);
  }

  uiAcc++;
  if ((uiAcc & 31) === 0) { updateCount(); }
}

/* ==========================================================================
   Public API
   ========================================================================== */
window.MeadowNet = {
  /* opts: { THREE, scene, getPlayer(), onCount(n) } */
  attach: function (opts) {
    if (net.running) { return; }
    net.THREE = opts.THREE;
    net.scene = opts.scene;
    net.getPlayer = opts.getPlayer;
    net.onCount = opts.onCount || null;

    net.group = new opts.THREE.Group();
    net.group.matrixAutoUpdate = false;
    opts.scene.add(net.group);

    buildUI();
    window.addEventListener('keydown', onKey, true);   // before the game sees it

    loadVoice(function () {
      if (window.MeadowVoice) {
        window.MeadowVoice.setup({
          sendSignal: function (to, data) { sendJSON({ t: 'signal', to: to, data: data }); },
          onStatus: voiceStatus
        });
        /* voice.js loads asynchronously, so the server's HELLO may already
           have arrived and set net.id before this ran. Without this line
           voice keeps selfId = 0, the "lower id starts the call" test never
           passes, and nobody ever connects - silently. */
        if (net.id) { window.MeadowVoice.setSelfId(net.id); }
      }
    });

    net.running = true;
    connect();
    requestAnimationFrame(frame);
  },

  detach: function () {
    net.running = false;
    clearEveryone();
    if (net.ws) { try { net.ws.close(); } catch (e) {} }
    net.ws = null;
  },

  count: function () {
    var c = 0;
    for (var k in net.players) { c++; }
    return net.connected ? c + 1 : 0;
  },

  isConnected: function () { return net.connected; }
};

})();
