/* Whispering Meadow - textures.js
   Painted surface textures, generated on the fly with canvas 2D so nothing
   is downloaded and nothing is heavy - this has to run on integrated
   graphics with 8GB of RAM. Every generator below is cached (same pattern
   as toonRamp() in core.js) so the canvas work happens once per texture,
   not once per material. */

import { clamp, lerp, mulberry32 } from './core.js';

function newCanvas(S) {
  var cv = document.createElement('canvas');
  cv.width = cv.height = S;
  return cv;
}

/* ---------------------------------------------------------------- tiling
   Every texture here is built by stamping hundreds of little painted
   shapes onto a canvas. A shape stamped near an edge is invisible on one
   side and clipped on the other unless its mirror is also stamped just
   past the opposite edge - that is the classic seam. wrapStamp() draws a
   shape (and, whenever it is close enough to an edge to need one, its
   wrapped copy) so the tile always meets itself cleanly. `pad` is the
   shape's own bounding radius; everything closer than that to an edge
   gets a second, third or fourth stamp. Every random choice for the shape
   (position, angle, colour...) must be made BEFORE calling this, and the
   `draw` callback must only use those already-decided values - if it
   rolls new randomness itself, the wrapped copies stop matching and the
   seam comes right back. */
function wrapStamp(ctx, S, x, y, pad, draw) {
  var dxs = [0];
  if (x < pad) { dxs.push(S); }
  if (x > S - pad) { dxs.push(-S); }
  var dys = [0];
  if (y < pad) { dys.push(S); }
  if (y > S - pad) { dys.push(-S); }
  for (var i = 0; i < dxs.length; i++) {
    for (var j = 0; j < dys.length; j++) { draw(x + dxs[i], y + dys[j]); }
  }
}

/* ---------------------------------------------------------------- balance
   A texture that is MULTIPLIED into a colour is not free to have a hue of
   its own. groundMaterial() in terrain.js samples the grass texture and
   remaps it as `_tex * 1.55 + 0.30`, which is a no-op only where _tex sits
   at 0.4516; anything else scales the vertex colour underneath it. The
   first version of this texture averaged about (0.59, 0.67, 0.42), so every
   square metre of meadow was silently multiplied by roughly (1.21, 1.35,
   0.96) - a third of a stop of extra green on top of an already saturated
   green albedo, enough to clip the green channel to 1.0 and flatten out all
   the painted detail in it. That is most of the reason the ground read as
   fluorescent rather than painted.

   Per-stroke hue variation is what makes this look painted and it stays.
   A net hue SHIFT does not: the meadow's hue belongs to terrainColorAt().
   So the finished canvas is renormalised to a chosen mean, and the mean is
   picked so the 1.55/0.30 remap lands near 1.0 with a faint warm-olive
   lean - the direction sunlit grass actually goes in the reference
   paintings, and the opposite of the direction the texture used to push. */
function balanceMean(ctx, S, tr, tg, tb) {
  var img = ctx.getImageData(0, 0, S, S), d = img.data, n = S * S;
  var sr = 0, sg = 0, sb = 0, i, k;
  for (i = 0; i < n; i++) { k = i * 4; sr += d[k]; sg += d[k + 1]; sb += d[k + 2]; }
  /* guard against a divide by zero on a canvas that never got painted */
  var kr = tr / Math.max(sr / n, 1), kg = tg / Math.max(sg / n, 1), kb = tb / Math.max(sb / n, 1);
  for (i = 0; i < n; i++) {
    k = i * 4;
    /* ImageData is a Uint8ClampedArray - it rounds and clamps on write */
    d[k] = d[k] * kr; d[k + 1] = d[k + 1] * kg; d[k + 2] = d[k + 2] * kb;
  }
  ctx.putImageData(img, 0, 0);
}

function finishTexture(cv) {
  var tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/* ======================================================================== *
 *  GRASS / GROUND  -  512x512, tiles seamlessly
 *
 *  Three passes, biggest shapes first: soft mottled colour patches (the
 *  big brushed-in washes a painter lays down first), then short angled
 *  clump strokes (individual grass tufts), then a fine speckle pass for
 *  grain. Nothing here is a flat fill - every pass varies both brightness
 *  AND hue a little, which is what keeps it from reading as a tinted
 *  photo instead of a painting.
 * ======================================================================== */

var _grassTex = null;
function grassTexture() {
  if (_grassTex) { return _grassTex; }
  var S = 512;
  var cv = newCanvas(S);
  var ctx = cv.getContext('2d');
  var rng = mulberry32(7331);
  var i, x, y, r, ang, px, py;

  ctx.fillStyle = 'rgb(150,172,108)';
  ctx.fillRect(0, 0, S, S);

  /* pass 1: big soft washes - sunlit patches and shaded hollows */
  for (i = 0; i < 90; i++) {
    x = rng() * S; y = rng() * S;
    r = 34 + rng() * 84;
    ang = rng() * Math.PI;
    var ry = r * (0.55 + rng() * 0.5);
    var warm = rng() < 0.52;
    var col = warm
      ? 'rgba(198,208,120,' + (0.07 + rng() * 0.10) + ')'
      : 'rgba(84,112,58,' + (0.08 + rng() * 0.12) + ')';
    wrapStamp(ctx, S, x, y, r, (function (rr, rry, aa, cc) {
      return function (dx, dy) {
        ctx.save(); ctx.translate(dx, dy); ctx.rotate(aa);
        ctx.fillStyle = cc;
        ctx.beginPath(); ctx.ellipse(0, 0, rr, rry, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      };
    })(r, ry, ang, col));
  }

  /* pass 2: individual grass-clump brush strokes, hue jittered per stroke */
  for (i = 0; i < 1100; i++) {
    x = rng() * S; y = rng() * S;
    var len = 7 + rng() * 15, wid = 1.6 + rng() * 2.4;
    ang = rng() * Math.PI * 2;
    var shade = rng();
    /* The green channel used to swing over twice as far as red or blue
       (98->198 against 48->132 and 34->92), so the brightest strokes were
       also the most saturated ones and the texture's variance pushed hue,
       not just value. Narrowed toward the other two: the strokes still read
       as individual tufts, they just stop repainting the meadow green. */
    var rC = Math.round(lerp(58, 128, shade) + (rng() - 0.5) * 22);
    var gC = Math.round(lerp(92, 176, shade) + (rng() - 0.5) * 22);
    var bC = Math.round(lerp(40, 96, shade) + (rng() - 0.5) * 16);
    var alpha = 0.30 + rng() * 0.32;
    wrapStamp(ctx, S, x, y, len, (function (ll, ww, aa, style) {
      return function (dx, dy) {
        ctx.save(); ctx.translate(dx, dy); ctx.rotate(aa);
        ctx.fillStyle = style;
        ctx.beginPath(); ctx.ellipse(0, 0, ll * 0.5, ww * 0.5, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      };
    })(len, wid, ang, 'rgba(' + clamp(rC, 0, 255) + ',' + clamp(gC, 0, 255) + ',' + clamp(bC, 0, 255) + ',' + alpha + ')'));
  }

  /* pass 3: fine grain speckle so it doesn't go soft at a distance */
  for (i = 0; i < 2200; i++) {
    x = rng() * S; y = rng() * S;
    var sz = 0.6 + rng() * 1.4;
    var dark = rng() < 0.5;
    var a2 = 0.10 + rng() * 0.14;
    /* the light speckle was a yellow-green (216,222,150); warm neutral now,
       so the grain reads as sun catching a blade rather than more green */
    var c2 = dark ? 'rgba(42,56,34,' + a2 + ')' : 'rgba(226,220,188,' + a2 + ')';
    wrapStamp(ctx, S, x, y, sz, (function (ss, style) {
      return function (dx, dy) {
        ctx.fillStyle = style;
        ctx.beginPath(); ctx.arc(dx, dy, ss, 0, Math.PI * 2); ctx.fill();
      };
    })(sz, c2));
  }

  /* (124,113,106) -> _tex means (0.486,0.443,0.416) -> the terrain.js remap
     `_tex*1.55 + 0.30` lands on (1.054, 0.987, 0.944): essentially neutral,
     with the faint warm-olive lean described on balanceMean() above. */
  balanceMean(ctx, S, 124, 113, 106);

  _grassTex = finishTexture(cv);
  return _grassTex;
}

/* ======================================================================== *
 *  BARK  -  256x256, tiles seamlessly
 *
 *  Long thin near-vertical strokes for the grain, a few dark knots, and a
 *  scatter of warm highlight streaks for the dappled-sunlight look in the
 *  reference paintings.
 * ======================================================================== */

var _barkTex = null;
function barkTexture() {
  if (_barkTex) { return _barkTex; }
  var S = 256;
  var cv = newCanvas(S);
  var ctx = cv.getContext('2d');
  var rng = mulberry32(6614);
  var i, x, y;

  ctx.fillStyle = 'rgb(88,63,44)';
  ctx.fillRect(0, 0, S, S);

  /* base grain: tall thin strokes, mostly vertical with a little wander */
  for (i = 0; i < 420; i++) {
    x = rng() * S; y = rng() * S;
    var len = 34 + rng() * 130, wid = 1.2 + rng() * 3.0;
    var ang = (rng() - 0.5) * 0.28;
    var shade = rng();
    var rC = Math.round(lerp(54, 128, shade));
    var gC = Math.round(lerp(38, 92, shade));
    var bC = Math.round(lerp(24, 58, shade));
    var alpha = 0.28 + rng() * 0.30;
    wrapStamp(ctx, S, x, y, len, (function (ll, ww, aa, style) {
      return function (dx, dy) {
        ctx.save(); ctx.translate(dx, dy); ctx.rotate(aa);
        ctx.fillStyle = style;
        ctx.beginPath(); ctx.ellipse(0, 0, ww * 0.5, ll * 0.5, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      };
    })(len, wid, ang, 'rgba(' + rC + ',' + gC + ',' + bC + ',' + alpha + ')'));
  }

  /* warm sunlit highlight streaks, thinner and sparser */
  for (i = 0; i < 90; i++) {
    x = rng() * S; y = rng() * S;
    var len2 = 20 + rng() * 90, wid2 = 0.8 + rng() * 1.6;
    var ang2 = (rng() - 0.5) * 0.22;
    var a3 = 0.10 + rng() * 0.16;
    wrapStamp(ctx, S, x, y, len2, (function (ll, ww, aa, style) {
      return function (dx, dy) {
        ctx.save(); ctx.translate(dx, dy); ctx.rotate(aa);
        ctx.fillStyle = style;
        ctx.beginPath(); ctx.ellipse(0, 0, ww * 0.5, ll * 0.5, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      };
    })(len2, wid2, ang2, 'rgba(196,158,104,' + a3 + ')'));
  }

  /* knots */
  for (i = 0; i < 6; i++) {
    x = rng() * S; y = rng() * S;
    var r = 6 + rng() * 8;
    wrapStamp(ctx, S, x, y, r * 1.6, (function (rr) {
      return function (dx, dy) {
        var g = ctx.createRadialGradient(dx, dy, 0, dx, dy, rr * 1.6);
        g.addColorStop(0, 'rgba(36,24,16,0.55)');
        g.addColorStop(0.5, 'rgba(50,34,22,0.30)');
        g.addColorStop(1, 'rgba(50,34,22,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(dx, dy, rr * 1.6, 0, Math.PI * 2); ctx.fill();
      };
    })(r));
  }

  _barkTex = finishTexture(cv);
  return _barkTex;
}

/* barkColorAt() - CPU-side pixel lookup into the bark canvas above, so
   trunk/branch vertex colours can carry real grain and highlight streaks
   from the painted texture WITHOUT a UV-mapped material, a second draw
   call, or any GPU texture sampling at runtime. GB (geom.js) bakes one flat
   colour per shape into vertex colours at world-build time already - this
   just sources that colour from the bark painting instead of a flat hex,
   which is the cheapest possible way to "use" the texture on a fill-rate
   -bound machine. Read once into a plain array and cached; every call
   after the first is an array index. */
var _barkPixels = null, _barkPixelSize = 0;
function barkColorAt(u, v) {
  if (!_barkPixels) {
    var cv = barkTexture().image;
    _barkPixelSize = cv.width;
    _barkPixels = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  }
  var S = _barkPixelSize;
  var x = Math.floor((((u % 1) + 1) % 1) * S);
  var y = Math.floor((((v % 1) + 1) % 1) * S);
  var idx = (y * S + x) * 4;
  return [_barkPixels[idx] / 255, _barkPixels[idx + 1] / 255, _barkPixels[idx + 2] / 255];
}

/* ======================================================================== *
 *  LEAF CLUSTER CARD  -  256x256, NOT tiled - this is a single painted
 *  sprite (an irregular leaf-cluster silhouette, alpha cut out) meant for
 *  alphaTest quads, not a repeating surface.
 *
 *  Layout: the leaf cluster occupies most of the canvas; a small solid
 *  opaque WHITE square is reserved in the top-left corner. That corner
 *  lets props.js UV-map tree trunks into the SAME texture/material as the
 *  leaf cards - map colour there is pure white, so multiplying by the
 *  trunk's own vertex colour is a no-op. One shared atlas, one material,
 *  one draw call for a whole tree (trunk + cards together).
 *
 *  COLOUR IS NEAR-WHITE ON PURPOSE. This texture is multiplied into the
 *  card's vertex colour in props.js (the actual green/pink hue lives
 *  there, per species, per crown-height). A first version painted an
 *  actual warm-to-olive gradient INTO this texture - green x olive-brown
 *  desaturated to tan and the sakura pink disappeared entirely. Every RGB
 *  value below stays close to (1,1,1) with R/G/B within a few percent of
 *  each other - the light-to-dark "gradient across the cluster" and the
 *  brushwork are LUMINANCE-only, never hue, so multiplying by a saturated
 *  vertex colour brightens/darkens it without ever shifting it toward tan.
 *
 *  Three passes: soft overlapping dabs carve the alpha silhouette (dense
 *  and generously sized - this has to read as a full mass, not a wisp),
 *  a near-white light-to-dark gradient is painted "source-atop" (clipped
 *  to that silhouette so it can't spill outside it), then small near-
 *  white brush dabs break up the flat gradient. Mipmapping is turned off
 *  on the finished texture - alphaTest cutouts erode badly under mip-
 *  filtered alpha, and letting the edges shimmer a little at distance is
 *  the cheaper, safer trade on this hardware.
 * ======================================================================== */

var _leafTex = null;
function leafClusterTexture() {
  if (_leafTex) { return _leafTex; }
  var S = 256, TAU2 = Math.PI * 2;
  var cv = newCanvas(S);
  var ctx = cv.getContext('2d');
  var rng = mulberry32(9137);
  var i, a, rr, x, y;

  ctx.clearRect(0, 0, S, S);

  /* silhouette: many soft overlapping dabs, off-centre and away from the
     reserved corner, so the alpha shape reads as an irregular cluster
     instead of a circle or a rectangle. Big and dense on purpose - a
     sparse dab pattern here is what made the first version's cards read
     as small dusty puffs instead of full clusters. */
  var cx = S * 0.60, cy = S * 0.60;
  for (i = 0; i < 70; i++) {
    a = rng() * TAU2;
    rr = Math.pow(rng(), 0.5) * S * 0.32;
    x = cx + Math.cos(a) * rr;
    y = cy + Math.sin(a) * rr * 1.12 - rr * 0.10;
    var br = 22 + rng() * 40;
    var g = ctx.createRadialGradient(x, y, 0, x, y, br);
    var edge = 0.55 + rng() * 0.3;
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(edge, 'rgba(255,255,255,0.62)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, br, 0, TAU2); ctx.fill();
  }

  /* light-to-dark gradient across the cluster, clipped to the silhouette
     just carved - bright top, deep shade underneath, matching the same
     crown/shade split the tree-wide vertex colour gradient applies on
     top. Near-white to light-grey ONLY - see the note above. */
  ctx.globalCompositeOperation = 'source-atop';
  var grad = ctx.createLinearGradient(0, S * 0.10, 0, S * 0.94);
  grad.addColorStop(0, 'rgb(255,253,244)');
  grad.addColorStop(0.45, 'rgb(222,224,213)');
  grad.addColorStop(1, 'rgb(150,156,144)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, S, S);

  /* brushwork - small dabs, alternating lighter and darker than whatever
     they land on, so the gradient doesn't read as airbrushed. Kept
     near-neutral for the same reason as the gradient above. */
  for (i = 0; i < 240; i++) {
    x = rng() * S; y = rng() * S;
    var len = 4 + rng() * 10, wid = 2 + rng() * 4;
    var ang = (rng() - 0.5) * 1.4;
    var lite = rng() < 0.5;
    var al = 0.08 + rng() * 0.14;
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
    ctx.fillStyle = lite ? 'rgba(255,255,250,' + al + ')' : 'rgba(70,74,64,' + al + ')';
    ctx.beginPath(); ctx.ellipse(0, 0, len * 0.5, wid * 0.5, 0, 0, TAU2); ctx.fill();
    ctx.restore();
  }

  /* reserved opaque swatch, top-left corner - see the layout note above.
     Drawn LAST, in source-over, so it always ends up pure solid white
     regardless of anything painted near that corner before it. */
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = 'rgb(255,255,255)';
  ctx.fillRect(0, 0, 44, 44);

  var tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  _leafTex = tex;
  return _leafTex;
}

/* ======================================================================== *
 *  ROCK / STONE  -  256x256, tiles seamlessly
 *
 *  Cool blue-grey (never brown - that is what separates painted mountains
 *  from a mud heap at distance, per terrainColorAt's rock pass). Horizontal
 *  strata bands plus fine crack strokes and pebble speckle.
 * ======================================================================== */

var _rockTex = null;
function rockTexture() {
  if (_rockTex) { return _rockTex; }
  var S = 256;
  var cv = newCanvas(S);
  var ctx = cv.getContext('2d');
  var rng = mulberry32(2953);
  var i, x, y;

  ctx.fillStyle = 'rgb(112,120,134)';
  ctx.fillRect(0, 0, S, S);

  /* strata: wide flat-ish bands stacked with a bit of jitter */
  for (i = 0; i < 46; i++) {
    x = rng() * S; y = rng() * S;
    var w = 60 + rng() * 130, h = 10 + rng() * 26;
    var ang = (rng() - 0.5) * 0.5;
    var shade = rng();
    var rC = Math.round(lerp(78, 168, shade));
    var gC = Math.round(lerp(86, 174, shade));
    var bC = Math.round(lerp(100, 190, shade));
    var alpha = 0.16 + rng() * 0.18;
    var pad = Math.max(w, h);
    wrapStamp(ctx, S, x, y, pad, (function (ww, hh, aa, style) {
      return function (dx, dy) {
        ctx.save(); ctx.translate(dx, dy); ctx.rotate(aa);
        ctx.fillStyle = style;
        ctx.beginPath(); ctx.ellipse(0, 0, ww * 0.5, hh * 0.5, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      };
    })(w, h, ang, 'rgba(' + rC + ',' + gC + ',' + bC + ',' + alpha + ')'));
  }

  /* thin crack strokes, darker and more angular */
  for (i = 0; i < 70; i++) {
    x = rng() * S; y = rng() * S;
    var len = 10 + rng() * 46, wid = 0.8 + rng() * 1.6;
    var ang2 = rng() * Math.PI;
    var a2 = 0.10 + rng() * 0.18;
    wrapStamp(ctx, S, x, y, len, (function (ll, ww, aa, style) {
      return function (dx, dy) {
        ctx.save(); ctx.translate(dx, dy); ctx.rotate(aa);
        ctx.fillStyle = style;
        ctx.beginPath(); ctx.ellipse(0, 0, ll * 0.5, ww * 0.5, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      };
    })(len, wid, ang2, 'rgba(52,58,68,' + a2 + ')'));
  }

  /* pebble / mineral speckle */
  for (i = 0; i < 1400; i++) {
    x = rng() * S; y = rng() * S;
    var sz = 0.6 + rng() * 1.5;
    var lite = rng() < 0.5;
    var a3 = 0.08 + rng() * 0.14;
    var c3 = lite ? 'rgba(206,212,222,' + a3 + ')' : 'rgba(58,64,74,' + a3 + ')';
    wrapStamp(ctx, S, x, y, sz, (function (ss, style) {
      return function (dx, dy) {
        ctx.fillStyle = style;
        ctx.beginPath(); ctx.arc(dx, dy, ss, 0, Math.PI * 2); ctx.fill();
      };
    })(sz, c3));
  }

  _rockTex = finishTexture(cv);
  return _rockTex;
}

/* ======================================================================== *
 *  BRUSH-STROKE OVERLAY  -  256x256, tiles seamlessly
 *
 *  Neutral grey, centred on 0.5 so it can be multiplied over ANY surface
 *  to break up flatness without shifting hue:
 *
 *    diffuseColor.rgb *= texture2D(uBrush, uv).rgb * 2.0;
 *
 *  A texel of 0.5 grey -> *2.0 -> 1.0 -> no change. Darker/lighter texels
 *  darken or brighten the surface under them. That *2.0 is the whole trick
 *  and it must travel with this texture wherever it's sampled.
 * ======================================================================== */

var _brushTex = null;
function brushOverlayTexture() {
  if (_brushTex) { return _brushTex; }
  var S = 256;
  var cv = newCanvas(S);
  var ctx = cv.getContext('2d');
  var rng = mulberry32(4471);
  var i, x, y;

  ctx.fillStyle = 'rgb(128,128,128)';
  ctx.fillRect(0, 0, S, S);

  for (i = 0; i < 1000; i++) {
    x = rng() * S; y = rng() * S;
    var len = 5 + rng() * 22, wid = 1.5 + rng() * 4.0;
    var ang = rng() * Math.PI * 2;
    var lite = rng() < 0.5;
    var g = Math.round(128 + (lite ? 1 : -1) * (14 + rng() * 46));
    var alpha = 0.16 + rng() * 0.20;
    wrapStamp(ctx, S, x, y, len, (function (ll, ww, aa, style) {
      return function (dx, dy) {
        ctx.save(); ctx.translate(dx, dy); ctx.rotate(aa);
        ctx.fillStyle = style;
        ctx.beginPath(); ctx.ellipse(0, 0, ll * 0.5, ww * 0.5, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      };
    })(len, wid, ang, 'rgba(' + g + ',' + g + ',' + g + ',' + alpha + ')'));
  }

  _brushTex = finishTexture(cv);
  return _brushTex;
}

export { grassTexture, barkTexture, barkColorAt, leafClusterTexture, rockTexture, brushOverlayTexture, wrapStamp, newCanvas };
