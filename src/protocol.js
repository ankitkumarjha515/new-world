/* ==========================================================================
   WHISPERING MEADOW - wire protocol
   Shared by the Worker (src/index.js) and the browser (public/net.js).

   Positions are quantised to 16-bit integers. A full player update is 13
   bytes, so a 30-player snapshot fits in ~400 bytes. Small messages matter:
   Cloudflare bills INCOMING websocket messages; outgoing ones are free.
   ========================================================================== */

/* Binary frames carry position, which is sent constantly and must be tiny. */
export const MSG = {
  HELLO: 1,   // server -> client, once: "you are id N, here is who is here"
  MOVE:  2,   // client -> server: my position
  SNAP:  3,   // server -> client: everyone's position
  LEAVE: 4,   // server -> client: someone left
  FULL:  5    // server -> client: this meadow is full, try another
};

/* Text frames carry chat and voice setup. Both are rare, so readable JSON
   costs nothing and is far easier to debug:

     { t: "chat",   text }                 client -> server
     { t: "chat",   from, text, at }       server -> client
     { t: "signal", to, data }             client -> server  (voice setup)
     { t: "signal", from, data }           server -> client
     { t: "sys",    text }                 server -> client  (notices)

   Voice audio itself never touches the server. Browsers connect directly to
   each other with WebRTC; the server only passes these few setup messages so
   two people can find each other. */
export const LIMITS = {
  CHAT_CHARS:   200,
  CHAT_PER_SEC: 2,     // per player, server-enforced
  SIGNAL_PER_SEC: 40   // bursty during connection setup, then silent
};

/* quantisation scales - chosen so each value fits in a signed 16-bit int */
export const Q = {
  XZ:    16,     // +/-890 world units -> +/-14240 (int16 holds +/-2047m)
  Y:     64,     // -12..250 world units -> -768..16000
  ANGLE: 10000   // -PI..PI              -> +/-31416
};

export const PLAYER_BYTES = 13;

/* flags bitfield - room for animation state later */
export const FLAG = {
  MOVING:   1,
  RUNNING:  2,
  AIRBORNE: 4
};

/* --- one player: id, position, look direction, state ---------------------- */
export function writePlayer(view, off, p) {
  view.setUint16(off, p.id, true);
  view.setInt16(off + 2, Math.round(p.x * Q.XZ), true);
  view.setInt16(off + 4, Math.round(p.y * Q.Y), true);
  view.setInt16(off + 6, Math.round(p.z * Q.XZ), true);
  view.setInt16(off + 8, Math.round(p.yaw * Q.ANGLE), true);
  view.setInt16(off + 10, Math.round(p.pitch * Q.ANGLE), true);
  view.setUint8(off + 12, p.flags | 0);
  return off + PLAYER_BYTES;
}

export function readPlayer(view, off) {
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
