/* ==========================================================================
   WHISPERING MEADOW - multiplayer backend

   One Durable Object == one meadow. Everyone connected to the same object
   sees each other. The world itself is never sent: it is generated from
   fixed seeds and pure noise functions, so every browser builds a
   bit-identical meadow on its own. All we move over the wire is where
   people are standing.

   Cost shape on the Cloudflare free plan (100,000 requests/day):
     - outgoing websocket messages are FREE
     - incoming ones are billed at a 20:1 discount
     - a hibernating object is billed nothing at all
   So we batch: clients send at most ~8 small messages a second, and the
   room answers with ONE snapshot containing everybody. When the last
   player leaves we drop the timer so the object can hibernate.
   ========================================================================== */

import { DurableObject } from "cloudflare:workers";
import { MSG, PLAYER_BYTES, LIMITS, writePlayer, readPlayer } from "./protocol.js";

/* ---- tuning ------------------------------------------------------------- */
const MAX_PLAYERS   = 30;     // per meadow; beyond this we open meadow-2, -3...
const TICK_MS       = 100;    // snapshot rate: 10/sec, smoothed on the client
const IDLE_KICK_MS  = 300000; // 5 min silent -> disconnect so we can hibernate
const WORLD_LIMIT   = 890;    // matches EDGE (HALF - 60) in the game's updatePlayer
const MAX_SPEED     = 14;     // RUN is 9.4; leave headroom for slopes + jumps

/* ==========================================================================
   The meadow
   ========================================================================== */
export class Meadow extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.tick = null;
    this.dirty = false;

    /* Cheap keepalive: the runtime answers "p" with "P" without ever waking
       this object, so idle tabs cost nothing. */
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("p", "P")
    );

    /* A hibernating object loses its memory but keeps its sockets, so on
       wake we rebuild state from what we attached to each socket. */
    if (this.ctx.getWebSockets().length > 0) this.startTicking();
  }

  /* ---- connection ------------------------------------------------------- */
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a websocket upgrade", { status: 426 });
    }

    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_PLAYERS) {
      return new Response("This meadow is full", { status: 503 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    /* acceptWebSocket (not server.accept) is what allows hibernation */
    this.ctx.acceptWebSocket(server);

    const id = this.nextId(sockets);
    const now = Date.now();
    server.serializeAttachment({
      id, x: 60, y: 0, z: 205, yaw: 0.12, pitch: -0.03,
      flags: 0, seen: now, joined: now
    });

    server.send(this.buildHello(id, sockets));
    this.startTicking();

    return new Response(null, { status: 101, webSocket: client });
  }

  /* Smallest free id, so ids stay compact and fit in a Uint16. */
  nextId(sockets) {
    const taken = new Set();
    for (const ws of sockets) {
      const a = ws.deserializeAttachment();
      if (a) taken.add(a.id);
    }
    let id = 1;
    while (taken.has(id)) id++;
    return id;
  }

  /* ---- messages --------------------------------------------------------- */
  async webSocketMessage(ws, data) {
    try { return this.onMessage(ws, data); } catch { /* bad frame, ignore */ }
  }

  onMessage(ws, data) {
    if (typeof data === "string") return this.handleText(ws, data);
    /* readPlayer() reads 13 bytes starting at offset 1, so anything under
       14 would run off the end of the buffer and throw inside the DO */
    if (data.byteLength < 1 + PLAYER_BYTES) return;

    const view = new DataView(data);
    if (view.getUint8(0) !== MSG.MOVE) return;

    const self = ws.deserializeAttachment();
    if (!self) return;

    /* The client sends its own id slot as zero; we trust only our own. */
    const p = readPlayer(view, 1);
    const now = Date.now();

    /* --- validation ----------------------------------------------------
       A peaceful walking game has nothing worth cheating for, so this is
       deliberately loose: keep people inside the map and stop anyone from
       teleporting across it. Terrain-height checks can be added here later
       by copying terrainHeight() from the game - it is a pure function of
       x and z with no Three.js dependency. */
    let x = clamp(p.x, -WORLD_LIMIT, WORLD_LIMIT);
    let z = clamp(p.z, -WORLD_LIMIT, WORLD_LIMIT);
    let y = clamp(p.y, -20, 400);

    const dt = Math.max(0.05, (now - self.seen) / 1000);
    const dx = x - self.x, dz = z - self.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const allowed = MAX_SPEED * dt + 2;
    if (dist > allowed) {
      /* Too fast to be real movement. Pull them back along the same
         heading rather than rejecting outright, so a lagged client
         recovers smoothly instead of rubber-banding forever. */
      const k = allowed / dist;
      x = self.x + dx * k;
      z = self.z + dz * k;
    }

    /* spread self first, so rate-limit counters survive a position update */
    ws.serializeAttachment({
      ...self,
      id: self.id, x, y, z,
      yaw: wrapAngle(p.yaw),
      pitch: clamp(p.pitch, -1.6, 1.6),
      flags: p.flags & 7,
      seen: now
    });

    this.dirty = true;
  }

  /* ---- chat, and setup for browser-to-browser voice ---------------------
     Both are rare compared to movement, so they travel as JSON. Voice audio
     never comes through here - browsers talk directly to each other. All we
     relay are the few "how do I reach you" messages. */
  handleText(ws, raw) {
    if (raw === "p") return;                 // keepalive, normally auto-answered
    if (raw.length > 4096) return;

    const self = ws.deserializeAttachment();
    if (!self) return;

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== "string") return;

    if (msg.t === "chat") {
      if (!this.allow(ws, self, "chat", LIMITS.CHAT_PER_SEC)) return;
      const text = String(msg.text || "").replace(/\s+/g, " ").trim().slice(0, LIMITS.CHAT_CHARS);
      if (!text) return;
      /* Names are chosen by players, so sanitise here too - the client also
         strips them, but never trust one side alone. */
      const name = String(msg.name || "")
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
        .replace(/\s+/g, " ").trim().slice(0, 16);
      this.sendAll(JSON.stringify({ t: "chat", from: self.id, name, text, at: Date.now() }));
      return;
    }

    if (msg.t === "signal") {
      if (!this.allow(ws, self, "sig", LIMITS.SIGNAL_PER_SEC)) return;
      const to = msg.to | 0;
      if (!to || to === self.id) return;
      /* Deliver only to the named person - this is a private handshake. */
      for (const peer of this.ctx.getWebSockets()) {
        const a = peer.deserializeAttachment();
        if (a && a.id === to) {
          try {
            peer.send(JSON.stringify({ t: "signal", from: self.id, data: msg.data }));
          } catch { /* peer is going away */ }
          return;
        }
      }
      return;
    }
  }

  /* Simple per-socket token bucket. Stops one person from running up the
     request bill for everyone. */
  allow(ws, self, kind, perSec) {
    const now = Date.now();
    const key = kind + "At";
    const cnt = kind + "N";
    let at = self[key] || 0;
    let n = self[cnt] || 0;
    if (now - at > 1000) { at = now; n = 0; }
    n++;
    ws.serializeAttachment({ ...self, [key]: at, [cnt]: n });
    return n <= perSec;
  }

  sendAll(payload) {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(payload); } catch { /* ignore */ }
    }
  }

  async webSocketClose(ws) {
    this.dropped(ws);
  }

  async webSocketError(ws) {
    this.dropped(ws);
  }

  dropped(ws) {
    const a = ws.deserializeAttachment();
    if (a) this.announceLeave(a.id);
    /* getWebSockets() still includes the closing socket during this
       callback, so 1 means "this was the last one". */
    if (this.ctx.getWebSockets().length <= 1) this.stopTicking();
  }

  /* ---- the broadcast loop ----------------------------------------------
     A plain setTimeout, not an alarm. Alarms are billed as requests, and
     at 10/sec they would burn the daily quota in under 3 hours. A timer
     costs only wall-clock time, which we are already paying while anyone
     is connected. */
  startTicking() {
    if (this.tick) return;
    const loop = () => {
      this.tick = setTimeout(() => {
        this.tick = null;
        const alive = this.broadcastSnapshot();
        if (alive > 0) loop();
      }, TICK_MS);
    };
    loop();
  }

  stopTicking() {
    if (this.tick) clearTimeout(this.tick);
    this.tick = null;
  }

  broadcastSnapshot() {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) { this.stopTicking(); return 0; }

    const now = Date.now();
    const players = [];

    for (const ws of sockets) {
      const a = ws.deserializeAttachment();
      if (!a) continue;
      if (now - a.seen > IDLE_KICK_MS) {
        try { ws.close(1000, "idle"); } catch { /* already gone */ }
        this.announceLeave(a.id);
        continue;
      }
      players.push(a);
    }

    if (players.length === 0) { this.stopTicking(); return 0; }

    /* Nothing moved since the last tick: skip the send entirely. In a
       game where people stand and look at the view, this is most ticks. */
    if (!this.dirty) return players.length;
    this.dirty = false;

    const buf = new ArrayBuffer(3 + players.length * PLAYER_BYTES);
    const view = new DataView(buf);
    view.setUint8(0, MSG.SNAP);
    view.setUint16(1, players.length, true);
    let off = 3;
    for (const p of players) off = writePlayer(view, off, p);

    for (const ws of sockets) {
      try { ws.send(buf); } catch { /* closing; the close handler cleans up */ }
    }
    return players.length;
  }

  announceLeave(id) {
    const buf = new ArrayBuffer(3);
    const view = new DataView(buf);
    view.setUint8(0, MSG.LEAVE);
    view.setUint16(1, id, true);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(buf); } catch { /* ignore */ }
    }
  }

  buildHello(id, sockets) {
    const others = [];
    for (const ws of sockets) {
      const a = ws.deserializeAttachment();
      if (a && a.id !== id) others.push(a);
    }
    const buf = new ArrayBuffer(5 + others.length * PLAYER_BYTES);
    const view = new DataView(buf);
    view.setUint8(0, MSG.HELLO);
    view.setUint16(1, id, true);
    view.setUint16(3, others.length, true);
    let off = 5;
    for (const p of others) off = writePlayer(view, off, p);
    return buf;
  }
}

/* ==========================================================================
   Worker: routes /ws to a meadow, everything else is a static asset
   ========================================================================== */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      /* ?room=meadow-2 lets us shard once one fills up. */
      const room = sanitiseRoom(url.searchParams.get("room") || "meadow-1");
      const stub = env.MEADOW.getByName(room);
      return stub.fetch(request);
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true, rooms: ["meadow-1"] });
    }

    /* Static assets are served before the Worker runs, so reaching here
       means the path matched nothing. */
    return new Response("Not found", { status: 404 });
  }
};

/* ---- helpers ------------------------------------------------------------ */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrapAngle(a) {
  if (!Number.isFinite(a)) return 0;
  const TAU = Math.PI * 2;
  return ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
}

function sanitiseRoom(name) {
  const clean = String(name).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32);
  return clean || "meadow-1";
}
