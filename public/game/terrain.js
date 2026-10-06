/* Whispering Meadow - terrain.js
   Extracted from the original single file. Logic unchanged. */

import { pineWood, withRim, toonRamp, BEACHPATH, BROOK, CLIFF_S, HALF, RIVER, VOLC, volcanoBare, WALKPATH, WORLD, WSEG, clamp, cliffWave, cliffZ, fbm, lerp, pathInfo, scene, smoothstep, terrainHeight, timeU, wallTop } from './core.js';
import { grassTexture } from './textures.js';
var terrainHeights, depthTex;

/* ======================================================================== *
 *  DESIRE LINES
 *
 *  The two authored stone paths in core.js (WALKPATH, BEACHPATH) are the
 *  formal routes. These are the informal ones: the bare-earth tracks people
 *  wear into a meadow by cutting between the places they actually want to
 *  go. They carry NO height change - they only paint the ground - so they
 *  cannot fight terrainHeight(), the player collider, or the grass grid.
 *
 *  They are authored polylines, not generated, for the same reason the
 *  stone paths are: every browser has to build a bit-identical world from
 *  the same seeds, and an authored spine is the cheapest possible way to
 *  guarantee that. Each is 4-5 points, so all four together cost ~16 extra
 *  segment tests per ground vertex.
 * ======================================================================== */

/* west off the walkway, down to the river bank */
var TRAIL_A = [
  { x: -16, z: 148 }, { x: -48, z: 152 }, { x: -86, z: 141 },
  { x: -120, z: 127 }, { x: -152, z: 120 }
];

/* north off the walkway, up through the open meadow toward the woods */
var TRAIL_B = [
  { x: 36, z: -14 }, { x: 59, z: -52 }, { x: 78, z: -104 },
  { x: 86, z: -159 }, { x: 74, z: -218 }
];

/* west off the beach path, following the river down to its mouth */
var TRAIL_C = [
  { x: 58, z: 300 }, { x: 21, z: 318 }, { x: -19, z: 331 },
  { x: -58, z: 344 }
];

/* south off the east end of the walkway, into the sunflower field */
var TRAIL_D = [
  { x: 172, z: 30 }, { x: 188, z: 74 }, { x: 196, z: 124 },
  { x: 184, z: 172 }
];

/* paint one vertex of the ground */

function terrainColorAt(x, z, h, ny, out, o) {
  var slope = clamp(1 - ny, 0, 1);
  /* True gradient magnitude, recovered from the vertex normal for free.
     ny = 1/sqrt(1+g*g), so g = sqrt(1-ny*ny)/ny. `slope` (1-ny) goes as
     g*g/2 for gentle ground, which squashes the whole meadow into the
     bottom two percent of its range - useless for deciding where soil
     shows through. `grad` is linear in the actual steepness, and it costs
     one sqrt instead of the four extra terrainHeight() calls a real
     terrainSlope() lookup would need on every one of ~93k vertices. */
  var nyc = ny < 0.02 ? 0.02 : ny;
  var grad = Math.sqrt(clamp(1 - nyc * nyc, 0, 1)) / nyc;
  var n1 = fbm(x * 0.013 + 4.2, z * 0.013 - 8.8, 3);
  var n2 = fbm(x * 0.0026 + 19.4, z * 0.0026 + 2.1, 3) * 0.62 +
           fbm(x * 0.0115 + 6.7, z * 0.0115 - 3.4, 3) * 0.38;
  var n3 = fbm(x * 0.055, z * 0.055, 2);
  /* dedicated, decorrelated low-frequency noise for the snow LINE itself
     (~900-unit wavelength) - see the snow block below */
  var n4 = fbm(x * 0.0011 + 51.2, z * 0.0011 - 33.8, 3);

  /* --- meadow green ----------------------------------------------------
     The blue channel is what makes or breaks this. It used to sit at
     0.12-0.22 against a green of 0.60-0.88, which is a more saturated green
     than any pigment, let alone any plant - that is the "hurts the eyes"
     the player reported, and no grade downstream can rescue an albedo that
     extreme. Real sunlit grass carries a lot of bounced blue from the sky,
     and Ghibli greens read as vivid because they sit between warm light and
     cool shadow, not because the pigment is loud. So: blue up hard, green
     down, red up. */
  var t = clamp(n1 * 0.75 + n2 * 0.5 - 0.1, 0, 1);
  var r = lerp(0.26, 0.55, t);
  var g = lerp(0.50, 0.74, t);
  var b = lerp(0.22, 0.33, t);
  /* sun-bleached golden hilltops */
  var dry = smoothstep(0.48, 0.88, n2) * 0.75;
  r = lerp(r, 0.74, dry); g = lerp(g, 0.80, dry); b = lerp(b, 0.38, dry);
  /* deep shaded green in the hollows - cooled, not merely darkened, so a
     hollow reads as being in shadow rather than as a different plant */
  var deepg = smoothstep(0.52, 0.10, n2) * 0.60;
  r = lerp(r, 0.18, deepg); g = lerp(g, 0.36, deepg); b = lerp(b, 0.27, deepg);
  /* the golden wash of the sunflower field */
  var sfx = (x - 200) / 235, sfz = (z - 40) / 165;
  var sfd = Math.sqrt(sfx * sfx + sfz * sfz);
  var sfm = smoothstep(1.05, 0.55, sfd) * 0.55;
  r = lerp(r, 0.64, sfm); g = lerp(g, 0.70, sfm); b = lerp(b, 0.18, sfm);
  r += (n3 - 0.5) * 0.035; g += (n3 - 0.5) * 0.04; b += (n3 - 0.5) * 0.025;

  /* --- the pine wood floor -------------------------------------------
     Under the trees the ground is not meadow: it is needle-litter and moss,
     darker, browner, and patchy. Most of what makes the wood read as a
     wood at your feet. */
  var wood = pineWood(x, z);
  if (wood > 0.001) {
    var litter = fbm(x * 0.045 + 9.3, z * 0.045 - 1.2, 3);
    var fr = lerp(0.17, 0.27, litter), fg = lerp(0.22, 0.25, litter), fb = lerp(0.10, 0.12, litter);
    var wm = smoothstep(0.05, 0.55, wood) * 0.85;
    r = lerp(r, fr, wm); g = lerp(g, fg, wm); b = lerp(b, fb, wm);
  }

  /* --- the cobblestone garden walkway & beach path (Images 4 & 5) ----- */
  var wp = pathInfo(WALKPATH, x, z);
  var bp = pathInfo(BEACHPATH, x, z);
  var pathD = Math.min(wp.d, bp.d);
  if (pathD < 2.8 && h > 0.8 && h < 140) {
    var pathM = smoothstep(2.8, 1.4, pathD);
    var stoneF = fbm(x * 0.35, z * 0.35, 2);
    /* Was 0.85-0.94, and the dapple below pushed it past 1.0 - pure white
       glare once the grade hits it. Under this colour grade, no ground
       albedo should go above about 0.72. */
    /* Forest-floor dirt now, not garden stone: the shader paints the
       crisp edge and the pebbles, this is the colour it settles to far off */
    var sr2 = lerp(0.30, 0.38, stoneF), sg2 = lerp(0.22, 0.28, stoneF), sb2 = lerp(0.15, 0.19, stoneF);
    // dappled sunlit tree shadow effect on stones
    var dapple = fbm(x * 0.085 + 2.1, z * 0.085 - 1.7, 2);
    var dappleM = 0.80 + 0.20 * dapple;   /* never exceeds 1.0 */
    sr2 *= dappleM; sg2 *= dappleM; sb2 *= dappleM;
    r = lerp(r, sr2, pathM);
    g = lerp(g, sg2, pathM);
    b = lerp(b, sb2, pathM);
  }

  /* --- the river bed -------------------------------------------------- */
  var ri = pathInfo(RIVER, x, z);
  if (ri.d < 46 && z > -360 && z < 470) {
    var wet = smoothstep(46, 14, ri.d) * smoothstep(ri.y + 2.2, ri.y - 0.4, h);
    var pr = 0.44 + n3 * 0.16, pg = 0.52 + n3 * 0.15, pb = 0.48 + n3 * 0.13;
    r = lerp(r, pr, wet); g = lerp(g, pg, wet); b = lerp(b, pb, wet);
    /* --- the bank: soil, not sand -------------------------------------
       This used to be a pale tan (0.62, 0.60, 0.40), which under the grade
       came out as a beach - a strip of holiday sand running the length of a
       cold mountain river. A riverbank is EARTH: dark and almost black
       where the water keeps it wet, drying to a crumbly red-brown a few
       metres up, with grass closing back over it after that. The wet-to-dry
       ramp is the part that sells it; a single flat brown reads as a
       painted stripe just as much as the sand did. */
    var bank = smoothstep(34, 15, ri.d) * (1 - wet);
    if (bank > 0.001) {
      var soilN = fbm(x * 0.10 + 3.7, z * 0.10 - 5.1, 2);
      var damp = smoothstep(26, 7, ri.d);
      var soR = lerp(0.300, 0.180, damp) + (soilN - 0.5) * 0.085;
      var soG = lerp(0.222, 0.132, damp) + (soilN - 0.5) * 0.065;
      var soB = lerp(0.150, 0.100, damp) + (soilN - 0.5) * 0.045;
      r = lerp(r, soR, bank * 0.94); g = lerp(g, soG, bank * 0.94); b = lerp(b, soB, bank * 0.94);
    }
  }
  var bi = pathInfo(BROOK, x, z);
  if (bi.d < 20) {
    var bw = smoothstep(20, 7, bi.d) * smoothstep(bi.y + 1.6, bi.y - 0.6, h);
    r = lerp(r, 0.48, bw); g = lerp(g, 0.54, bw); b = lerp(b, 0.50, bw);
  }

  /* --- the beach: radiant anime sunlit sand (Image 1) ---------------- */
  var coast = (fbm(x * 0.0032 + 21.7, 8.3, 3) - 0.5) * 130;
  var zc = z + coast;
  var sandm = smoothstep(280, 350, zc) * smoothstep(7.5, 2.0, h);
  /* was 0.98/0.92/0.77 - near-white, and the colour grade pushed it to pure
     white glare. Warm sand instead, with more grain variation. */
  var sr = 0.720 - n3 * 0.095, sg = 0.655 - n3 * 0.095, sb = 0.520 - n3 * 0.100;
  r = lerp(r, sr, sandm); g = lerp(g, sg, sandm); b = lerp(b, sb, sandm);

  /* --- rock on the steeps --------------------------------------------- */
  var rockm = smoothstep(0.30, 0.62, slope);
  rockm = Math.max(rockm, smoothstep(150, 230, h));
  /* Rock in the reference paintings is COOL blue-grey, never brown. The
     blue is what separates a mountain from a mud heap at distance. */
  var strat = fbm(x * 0.02, h * 0.09, 3);
  /* Quantize into 4 flat bands (was 3) and blend harder toward the quantized
     value (was 0.65) so the rock reads as painted strata instead of a smooth
     gradient - the reference peaks (see mountain screenshot) show crisp
     horizontal bands, not a continuous fade. Still soft enough that grid
     seams stay invisible. */
  var stratQ = Math.floor(clamp(strat, 0, 0.999) * 4) / 3;
  strat = lerp(strat, stratQ, 0.72);
  var rr = lerp(0.355, 0.585, strat), rg = lerp(0.395, 0.625, strat), rb = lerp(0.470, 0.700, strat);
  rr = lerp(rr, 0.44, n1 * 0.34); rg = lerp(rg, 0.47, n1 * 0.34); rb = lerp(rb, 0.55, n1 * 0.34);
  /* a bright sunstruck band right where bare rock meets the snowline - the
     rim of light that separates grey rock from white cap in the reference.
     Stays well under the 0.72 ceiling even at full weight (~0.62/0.64/0.70). */
  var ridgeLight = smoothstep(120, 150, h) * smoothstep(190, 150, h) * smoothstep(0.30, 0.55, slope);
  rr = lerp(rr, 0.62, ridgeLight * 0.45); rg = lerp(rg, 0.64, ridgeLight * 0.45); rb = lerp(rb, 0.70, ridgeLight * 0.45);
  r = lerp(r, rr, rockm); g = lerp(g, rg, rockm); b = lerp(b, rb, rockm);

  /* --- snow ------------------------------------------------------------
     Standard slope-based accumulation (every stylized-snow writeup agrees on
     this): snow does not just start at a height, it starts LOWER on flat
     ledges and needs to climb much higher on a steep face before it can
     stick - the rest slides off as scree. `ledgeBias` bends the height
     threshold itself by slope instead of only fading a fixed threshold by
     slope, so shelves hold snow while spires beside them stay bare rock at
     the same altitude. `n4` is on its own decorrelated coordinates (not n1,
     which also shapes the meadow bumps) so the line sweeps in big drifts
     across the whole range instead of drawing a contour ring around every
     individual peak. Floor of 115 keeps it mountains-only - the valley floor
     never gets an isolated cold patch. Edge sharpened further to a near-hard
     scallop, and the two-tone banding (sunlit cap / cool blue-grey shade)
     stays for banded light. Both tones sit above 0.72; documented snow
     exception (distant, behind fog). */
  /* --- the volcano: basalt, ash and bare ground -----------------------
     The mountain shader further down paints the lava, because lava has to
     move and glow. Everything that does NOT move belongs here instead, in
     the vertex colour, where it is computed once at boot and costs nothing
     to draw ever again: the dark andesite of the cone, the paler ash that
     settles on the shallower ledges, and a rust-red scorch on the upper
     third where the ground has been cooked.

     `volc` deliberately fades in with HEIGHT as well as radius. The lower
     apron keeps its grass and its trees - that is the reference image, where
     the wood climbs a long way up before the ground gives out - and only the
     cone above the treeline goes to stone. */
  var vdx = x - VOLC.x, vdz = z - VOLC.z;
  var vdist = Math.sqrt(vdx * vdx + vdz * vdz);
  var volc = 0;
  if (vdist < VOLC.r) {
    /* Driven by RADIUS, not height. A height threshold draws a dead level
       contour line straight around the cone - it was clearly visible in the
       first render, a horizontal seam where grass met stone. volcanoBare()
       in core.js is the shared definition; the scatterers and the grass ask
       the same question so nothing grows on the cinder. */
    volc = volcanoBare(x, z);
    if (volc > 0.001) {
      var ash = fbm(x * 0.017 + 71.3, z * 0.017 - 22.9, 3);
      /* Dark andesite. These numbers are LOW on purpose - around a tenth -
         because everything downstream conspires to lift them: the toon ramp
         floors shadow at 0.59 of albedo, the aerial-perspective term below
         pushes anything tall toward pale blue, and the composite grade lifts
         the shadows again. A basalt that starts at a comfortable-looking
         0.2 arrives on screen as light grey stone. */
      var br = lerp(0.062, 0.148, ash);
      var bg = lerp(0.052, 0.126, ash);
      var bb = lerp(0.058, 0.128, ash);
      /* Ash and pumice catch on the flatter ledges. Pushed from 0.5 to 0.72,
         because at half strength the cone read as one flat black silhouette
         with lava drawn on it - there was nothing in the rock itself to show
         which way a surface was facing. The ash is the only thing giving the
         flanks their form, so it has to be allowed to register. */
      var ledge = smoothstep(0.55, 0.18, slope) * smoothstep(0.42, 0.72, ash);
      br = lerp(br, 0.255, ledge * 0.72); bg = lerp(bg, 0.242, ledge * 0.72); bb = lerp(bb, 0.238, ledge * 0.72);
      /* scorched red-brown near the vent */
      var scorch = smoothstep(0.55, 1.0, smoothstep(VOLC.r * 0.58, VOLC.r * 0.10, vdist));
      /* Pulled back from 0.62 to 0.40 and taken redder. At full strength,
         with the glow chain lifting it again afterwards, the whole upper cone
         arrived as terracotta - a pot, not a mountain. Scorch should tint the
         rock, not replace it. */
      br = lerp(br, 0.232, scorch * 0.40); bg = lerp(bg, 0.094, scorch * 0.40); bb = lerp(bb, 0.058, scorch * 0.40);

      /* THE FRINGE, and it is the fix for the ugliest band on the mountain.
         `volc` crossfades meadow green straight into basalt, and halfway
         across that fade the colour is the average of a bright yellow-green
         and a near-black - which is olive mud. It ran as a wide smeared
         ring right where the eye looks for the treeline, and it read as dirt
         smudged over grass rather than as a boundary.

         Nothing in nature fades grass to rock. It goes through dead grass,
         scrub and ash first, so that is what goes here: a dry ochre weighted
         to the MIDDLE of the transition (4*v*(1-v) peaks at v = 0.5 and is
         zero at both ends), applied to the meadow colour before the basalt
         mix. Grass to straw to cinder, which is three readable steps instead
         of one muddy one, and it suits a palette already built on banded
         light. Well under the 0.72 albedo ceiling in DESIGN-AGENT.md. */
      var fringe = volc * (1 - volc) * 4;
      r = lerp(r, 0.405, fringe * 0.58);
      g = lerp(g, 0.306, fringe * 0.58);
      b = lerp(b, 0.165, fringe * 0.58);

      r = lerp(r, br, volc); g = lerp(g, bg, volc); b = lerp(b, bb, volc);
    }
  }

  var ledgeBias = lerp(-15, 55, smoothstep(0.12, 0.78, slope));
  var snowLine = Math.max(115, 150 + ledgeBias + (n4 - 0.5) * 110 + (n1 - 0.5) * 34);
  var snowMask = smoothstep(snowLine, snowLine + 78, h) * smoothstep(0.90, 0.40, slope);
  /* Nothing settles on a mountain that is currently erupting. Without this
     the volcano gets the same snowcap as the northern range - which, on a
     cone with lava running down it, is the single most obviously wrong
     thing that could happen to the picture. */
  var snowEdge = smoothstep(0.46, 0.54, snowMask) * (1 - volc);
  var snowShade = fbm(x * 0.03, h * 0.05 + z * 0.01, 2);
  var snowBandM = snowShade > 0.5 ? 1 : 0;
  var snowR = lerp(0.86, 0.965, snowBandM), snowG = lerp(0.88, 0.980, snowBandM), snowB = lerp(0.93, 1.0, snowBandM);
  r = lerp(r, snowR, snowEdge); g = lerp(g, snowG, snowEdge); b = lerp(b, snowB, snowEdge);

  /* aerial perspective: height pushes everything toward the sky's blue,
     which is what gives painted mountains their sense of scale */
  /* Held back over the volcano. Aerial perspective is right for a distant
     snow peak - it is what gives the range its scale - but applied at full
     strength to a black cinder cone it turns the whole thing pale blue and
     the lava ends up glowing out of a grey hill. A lit mountain also throws
     its own light into the air in front of it, which is warm, not blue. */
  var far = smoothstep(90, 300, h) * 0.30 * (1 - volc * 0.72);
  r = lerp(r, 0.62, far); g = lerp(g, 0.74, far); b = lerp(b, 0.90, far);

  /* --- crystalline turquoise shallow water bed (Image 1) -------------- */
  if (h < 2.0) {
    var uw = smoothstep(2.0, -1.0, h);
    r = lerp(r, 0.36, uw * 0.6); g = lerp(g, 0.82, uw * 0.6); b = lerp(b, 0.86, uw * 0.6);
    var dp = smoothstep(-1.0, -16.0, h);
    r = lerp(r, 0.08, dp); g = lerp(g, 0.26, dp); b = lerp(b, 0.46, dp);
  }

  out[o] = clamp(r, 0, 1); out[o + 1] = clamp(g, 0, 1); out[o + 2] = clamp(b, 0, 1);
}

/* ======================================================================== *
 *  LAVA
 *
 *  No texture, no mesh, no particle system - the channels are two lookups
 *  of the noise the ground shader already carries, evaluated only inside
 *  the cone. That is the whole reason to do it this way: a lava texture
 *  detailed enough to hold up at this scale would be a megabyte of PNG and
 *  a megabyte of VRAM, and it would still tile. This costs nothing to
 *  download and nothing to keep.
 *
 *  THE TRICK IS THE COORDINATE. Noise sampled on the world XZ plane gives
 *  blobs; what lava wants is thin lines running straight down the fall
 *  line. So it is sampled on the UNIT DIRECTION from the vent instead -
 *  which varies quickly around the cone and not at all along a radius, so
 *  a single noise lookup becomes a set of streaks that radiate from the
 *  summit and reach the foot. A direction vector also closes the circle
 *  with no seam, which an angle from atan2 would not.
 *
 *  Ridging (1 - |2n-1|) turns the smooth noise into creases, and raising
 *  that to a high power keeps only the crease floors - narrow, branching
 *  channels with dark rock between them, rather than a wash of orange. Two
 *  octaves: wide primary rivers, and a finer set that splits off them.
 * ======================================================================== */
/* The cone's local coordinates and its bare-rock mask, computed BEFORE the
   grass texture is applied so the texture step can use them. It re-derives
   volcanoBare() from core.js in GLSL; the noise is one octave here against
   three there, so the two edges differ by a metre or so - which is fine,
   because one decides a colour and the other decides where grass may grow,
   and neither can see the other's boundary. */
var VOLC_PRELUDE = [
  ' float _bare = 0.0; vec2 _vd = vec2(0.0); float _vr = 1.0;',
  ' if (vVolc > 0.002) {',
  '   _vd = vGWP.xz - vec2(' + VOLC.x.toFixed(1) + ', ' + VOLC.z.toFixed(1) + ');',
  '   _vr = max(length(_vd), 0.001);',
  '   float _bt = _vr / ' + VOLC.r.toFixed(1) + ';',
  '   float _bn = (_gn(vGWP.xz * 0.0075) - 0.5) * 0.22;',
  '   _bare = smoothstep(0.96 + _bn, 0.74 + _bn, _bt) * smoothstep(1.0, 0.90, _bt);',
  ' }',
  ''
].join('\n');

var LAVA_GLSL = [
  ' vec3 _lavaCol = vec3(0.0); float _lava = 0.0, _halo = 0.0;',
  ' if (vVolc > 0.002) {',
  '   vec2 _dir = _vd / _vr;',
  '   float _t = clamp(_vr / ' + VOLC.r.toFixed(1) + ', 0.0, 1.0);',
  /* THE SAMPLE COORDINATE IS THE WHOLE TRICK, and the previous version threw
     it away again two lines later.

     Sampling on _dir alone is what makes radial streaks: _dir is constant
     along any radius, so one noise lookup becomes lines running from the
     summit straight down the fall line. The old code then ADDED _vr * 0.0115
     and _vr * 0.0082 to the two noise axes - and over a 360-unit cone that is
     an offset of 4.1 and 3.0 against a _dir term spanning only -5.6 to 5.6.
     The radial drift was comparable to the signal, so a channel wandered
     sideways as it descended, crossed its neighbours and in places curled
     back on itself. Lava does not flow uphill, and a closed orange loop on
     the flank was the first thing anybody noticed about this mountain.

     A lean is still wanted - a ruler-straight channel looks machined - so it
     is applied as a small TANGENTIAL rotation of the sample direction that
     grows with radius. The streak stays a streak and merely curves. At its
     strongest this is about fifteen degrees across the whole flank. */
  '   float _wob = (_gn(_dir * 2.1 + 7.3) - 0.5) * _t * 0.55;',
  '   vec2 _sd = _dir + vec2(-_dir.y, _dir.x) * _wob;',
  '   float _n1 = _gn(_sd * 5.6 + vec2(0.0, 11.0));',
  '   float _n2 = _gn(_sd * 12.6 + vec2(0.0, 31.0));',
  /* Width, and this was backwards. A higher exponent keeps only the floor of
     the crease, so a HIGH exponent is a NARROW channel. The old mix ran 8.5
     at the vent to 3.6 at the foot - narrow where the lava leaves the crater
     and widest where it has run out of heat, which is the opposite of how a
     flow behaves and is why the channels bloomed into orange blobs across the
     lower slope.

     But the first correction of it went too far the other way: an exponent of
     4 at the vent made the creases so broad that every channel merged into
     its neighbours and the top third of the cone came out as one smooth
     terracotta wash - worse to look at than the wrong-shaped lines it
     replaced, because at least those were lines. The channel has to stay
     NARROW at both ends; what widens near the crater is the vent pool below,
     which is its own term. This only tapers. */
  '   float _wide = mix(8.0, 12.5, _t);',
  '   float _c1 = pow(1.0 - abs(_n1 * 2.0 - 1.0), _wide);',
  '   float _c2 = pow(1.0 - abs(_n2 * 2.0 - 1.0), _wide * 1.8);',
  '   float _chan = max(_c1, _c2 * 0.62);',
  /* The crawl, which used to be done by dragging the whole pattern and was
     therefore the same thing that bent the channels. Now the SHAPE is fixed
     and only the BRIGHTNESS travels: a slow wave running down the radius, so
     surges of hotter rock move from the crater toward the foot along channels
     that do not themselves move. Offsetting its phase by _n1 keeps the
     neighbouring channels from pulsing in unison. */
  '   _chan *= 0.72 + 0.28 * sin(_vr * 0.055 - uTime * 0.85 + _n1 * 7.0);',
  /* Fade the channels out toward the foot, on the same RADIUS the basalt
     uses rather than on height - a height cutoff drew a level line across
     the cone. They are allowed to reach further down than the bare rock
     does, because a lava river running the last stretch into the treeline
     is the thing the reference does that makes it read as a live mountain
     rather than a painted backdrop. */
  '   float _hm = 1.0 - smoothstep(0.58, 0.97, _vr / ' + VOLC.r.toFixed(1) + ');',
  /* the vent itself: a pool, always lit, pulsing slowly */
  '   float _vent = 1.0 - smoothstep(' + (VOLC.crater * 0.55).toFixed(1) + ', ' +
    (VOLC.crater * 1.75).toFixed(1) + ', _vr);',
  '   float _pulse = 0.86 + 0.14 * sin(uTime * 0.7) * sin(uTime * 0.31 + 1.7);',
  '   _lava = clamp(max(_chan * _hm, _vent) * vVolc * _pulse, 0.0, 1.0);',
  /* A wider, dimmer band around every channel - the rock beside a lava
     river is lit BY the river. One extra smoothstep on noise we already
     have, and it is most of what sells the glow as light rather than as
     paint. */
  '   _halo = smoothstep(0.76, 1.0, 1.0 - abs(_n1 * 2.0 - 1.0)) * _hm * vVolc * 0.40;',
  '   _halo = max(_halo, _vent * vVolc * 0.7);',
  /* crust: cooling black skin, splitting to show white-hot rock beneath */
  '   float _core = smoothstep(0.20, 0.92, _lava);',
  '   _lavaCol = mix(vec3(0.62, 0.075, 0.006), vec3(2.05, 1.22, 0.30), _core);',
  /* the ground under the channels goes to near-black so the toon ramp has
     nothing to shade - the emissive add below is the only light here */
  '   diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.020, 0.014, 0.012), _lava * 0.94);',
  ' }',
  ''
].join('\n');

/* hardware-optimized terrain material: replaces heavy 4-octave procedural hash with sine micro-detail */

/* ======================================================================== *
 *  THE DIRT PATH, painted per pixel
 *
 *  The ground's vertex colours sit on a 6.25-unit grid, which is coarser
 *  than the path is wide - so a path painted there comes out as a soft
 *  smear. The walk is the centre of every frame in the forest, so it is
 *  drawn in the fragment shader instead: the exact distance to the two
 *  authored spines, a ragged edge, dark packed earth, scattered pebbles and
 *  leaf litter. Sixteen segment tests, run only on triangles the vertex
 *  shader has already found to be within 14 units of the path.
 * ======================================================================== */
var PATH_SEGS = (WALKPATH.length - 1) + (BEACHPATH.length - 1);
function pathSegments() {
  var out = [];
  [WALKPATH, BEACHPATH].forEach(function (P) {
    for (var i = 0; i < P.length - 1; i++) {
      out.push(new THREE.Vector4(P[i].x, P[i].z, P[i + 1].x, P[i + 1].z));
    }
  });
  return out;
}
var PATH_GLSL = [
  'float pathDist(vec2 p){',
  '  float best = 1e9;',
  '  for (int i = 0; i < ' + PATH_SEGS + '; i++) {',
  '    vec4 s = uPathSeg[i];',
  '    vec2 a = s.xy, ab = s.zw - s.xy;',
  '    float t = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0);',
  '    best = min(best, length(p - (a + ab * t)));',
  '  }',
  '  return best;',
  '}',
  /* cheap cellular noise for pebbles: distance to a jittered point per cell */
  'vec2 _ph2(vec2 p){ p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));',
  '  return fract(sin(p) * 43758.5453); }',
  'float pebbles(vec2 p, out float id){',
  '  vec2 i = floor(p), f = fract(p); float d = 8.0; id = 0.0;',
  '  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {',
  '    vec2 g = vec2(float(x), float(y)); vec2 o = _ph2(i + g);',
  '    float dd = length(g + o - f);',
  '    if (dd < d) { d = dd; id = o.x; }',
  '  }',
  '  return d;',
  '}',
  ''
].join('\n');
var PATH_PAINT = [
  ' if (vPathNear > 0.5) {',
  '   float _pd = pathDist(vGWP.xz);',
  '   float _wob = (_gn(vGWP.xz * 0.35) - 0.5) * 1.3 + (_gn(vGWP.xz * 1.7 + 3.0) - 0.5) * 0.45;',
  '   float _pm = smoothstep(2.75, 2.05, _pd + _wob);',
  '   if (_pm > 0.0) {',
  /* packed earth, darker and damper in the middle where it is walked */
  '     float _soil = _gn(vGWP.xz * 0.9 + 7.0);',
  '     vec3 _dirt = mix(vec3(0.20, 0.14, 0.09), vec3(0.34, 0.25, 0.16), _soil);',
  '     _dirt *= mix(0.86, 1.0, smoothstep(0.0, 1.6, _pd));',
  /* pebbles: small, pale, rounded, thicker toward the edges */
  '     float _pid; float _pc = pebbles(vGWP.xz * 6.5, _pid);',
  '     float _pr = mix(0.14, 0.36, fract(_pid * 7.3));',
  '     float _peb = smoothstep(_pr, _pr - 0.08, _pc) * step(0.30, fract(_pid * 13.1));',
  '     _peb *= 0.55 + 0.45 * smoothstep(0.3, 2.2, _pd);',
  '     vec3 _stone = mix(vec3(0.30, 0.25, 0.20), vec3(0.50, 0.45, 0.38), fract(_pid * 3.7));',
  '     _stone *= 0.80 + 0.35 * smoothstep(_pr, 0.0, _pc);',
  '     _dirt = mix(_dirt, _stone, _peb);',
  /* dry needles and leaf litter, a darker speckle */
  '     float _lit = _gn(vGWP.xz * 5.5 + 1.7);',
  '     _dirt = mix(_dirt, vec3(0.13, 0.09, 0.06), smoothstep(0.62, 0.78, _lit) * (1.0 - _peb) * 0.7);',
  '     diffuseColor.rgb = mix(diffuseColor.rgb, _dirt, _pm);',
  '   }',
  ' }',
  ''
].join('\n');

function groundMaterial() {
  var m = withRim(new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonRamp() }), 0.20);
  /* withRim() already installed an onBeforeCompile. Assigning a new one here
     would silently throw the rim light away - CHAIN it instead. */
  var prevOBC = m.onBeforeCompile;
  m.onBeforeCompile = function (sh) {
    if (prevOBC) { prevOBC.call(this, sh); }
    /* The ground mesh carries no UVs - genTerrain() writes only position,
       normal and colour - so the painted texture is projected from world
       X/Z instead. Two different scales, blended, so the tiling never
       resolves into a visible repeat. */
    sh.uniforms.uGrassTex = { value: grassTexture() };
    sh.uniforms.uTime = timeU;
    sh.uniforms.uPathSeg = { value: pathSegments() };
    /* The cone's footprint, resolved in the VERTEX shader into a single
       float. Every fragment outside it then skips the whole lava block on a
       branch the hardware takes coherently - the volcano covers one corner
       of the world, so a given triangle is either in it or nowhere near it,
       and warps do not diverge. That is what keeps a full-screen ground
       shader from paying for a mountain that is usually off camera. */
    sh.vertexShader = 'varying vec3 vGWP;\nvarying float vVolc;\nvarying float vPathNear;\n' +
      'uniform vec4 uPathSeg[' + PATH_SEGS + '];\n' + PATH_GLSL + sh.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n vGWP = (modelMatrix * vec4(position,1.0)).xyz;\n' +
      /* coarse, per vertex: is this triangle anywhere near the path? The
         fragment shader only runs the exact sweep when it is. */
      ' vPathNear = 1.0 - step(14.0, pathDist(vGWP.xz));\n' +
      ' vVolc = 1.0 - smoothstep(' + (VOLC.r * 0.80).toFixed(1) + ', ' + VOLC.r.toFixed(1) +
      ', length(vGWP.xz - vec2(' + VOLC.x.toFixed(1) + ', ' + VOLC.z.toFixed(1) + ')));'
    );
    sh.fragmentShader = 'varying vec3 vGWP;\nvarying float vVolc;\nvarying float vPathNear;\nuniform sampler2D uGrassTex;\nuniform float uTime;\n' +
      'uniform vec4 uPathSeg[' + PATH_SEGS + '];\n' + PATH_GLSL +
      /* hash value-noise, NOT sin(x)*cos(y) - that expression IS a
         checkerboard (see DESIGN-AGENT.md and the water shaders below) and
         the previous dapple term used it, at low amplitude but still a grid.
         Two octaves at different scales give brushy, non-repeating patches. */
      'float _gh(vec2 p){ p=fract(p*vec2(127.1,311.7)); p+=dot(p,p+45.32); return fract(p.x*p.y); }\n' +
      'float _gn(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);\n' +
      '  float a=_gh(i), b=_gh(i+vec2(1.0,0.0)), c=_gh(i+vec2(0.0,1.0)), d=_gh(i+vec2(1.0,1.0));\n' +
      '  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y); }\n' +
      sh.fragmentShader.replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n' +
        VOLC_PRELUDE +
        ' vec3 _t1 = texture2D(uGrassTex, vGWP.xz * 0.075).rgb;\n' +
        ' vec3 _t2 = texture2D(uGrassTex, vGWP.xz * 0.021 + 0.37).rgb;\n' +
        ' vec3 _tex = mix(_t1, _t2, 0.5);\n' +
        /* The grass photograph is why the first attempt came out olive: the
           ground shader multiplies EVERY surface in the world by it, which is
           right for a meadow and quietly wrong for a cinder cone - it tinted
           a correctly-black basalt back to green. Desaturating it to plain
           luminance over the volcano keeps the brush-grain that stops the
           rock reading as flat paint, and loses the colour. */
        ' _tex = mix(_tex, vec3(dot(_tex, vec3(0.299, 0.587, 0.114))) * 0.92, _bare);\n' +
        ' float _brush = _gn(vGWP.xz * 0.028) * 0.6 + _gn(vGWP.xz * 0.11 + 5.2) * 0.4;\n' +
        ' float _dtl = (_brush - 0.5) * 0.10;\n' +
        ' diffuseColor.rgb = clamp(diffuseColor.rgb * (_tex * 1.55 + 0.30) * (1.0 + _dtl), 0.0, 1.0);\n' +
        PATH_PAINT +
        LAVA_GLSL
      ).replace(
        '#include <dithering_fragment>',
        /* Emissive, so it is added AFTER the toon ramp has had its say.
           Lava is not a lit surface - it is the light source - and running
           it through the three-step ramp like everything else is what makes
           painted fire look like orange plastic. Values go well above 1.0
           on purpose: the bright-pass in post.js thresholds at 0.63, so the
           channels blow out into the bloom chain by themselves and the glow
           around the mountain costs nothing extra. */
        ' gl_FragColor.rgb += _lavaCol * _lava + vec3(0.42, 0.13, 0.03) * _halo;\n' +
        '#include <dithering_fragment>'
      );
  };
  m.customProgramCacheKey = function () { return 'ground-painted-volcano-path'; };
  return m;
}

function* genTerrain() {
  var N = WSEG + 1, step = WORLD / WSEG, half = HALF;
  var ix, iy, k;
  var H = new Float32Array(N * N);
  for (iy = 0; iy < N; iy++) {
    var z = -half + iy * step;
    for (ix = 0; ix < N; ix++) { H[iy * N + ix] = terrainHeight(-half + ix * step, z); }
    if ((iy & 15) === 0) { yield ['Raising the mountains', 0.03 + 0.42 * (iy / N)]; }
  }
  terrainHeights = H;

  /* normals straight off the height grid, so chunk seams stay invisible */
  yield ['Smoothing the hills', 0.46];
  var NX = new Float32Array(N * N), NY = new Float32Array(N * N), NZ = new Float32Array(N * N);
  for (iy = 0; iy < N; iy++) {
    for (ix = 0; ix < N; ix++) {
      k = iy * N + ix;
      var xm = ix > 0 ? H[k - 1] : H[k], xp = ix < N - 1 ? H[k + 1] : H[k];
      var zm = iy > 0 ? H[k - N] : H[k], zp = iy < N - 1 ? H[k + N] : H[k];
      var dx = (xp - xm) / ((ix > 0 && ix < N - 1 ? 2 : 1) * step);
      var dz = (zp - zm) / ((iy > 0 && iy < N - 1 ? 2 : 1) * step);
      /* Slope exaggeration: a standard stylized-terrain trick (used any time a
         toon/cel shader has to sell "jagged" off geometry that stayed cheap
         and smooth). terrainHeight() (core.js) already ridges the mountains,
         but at meadow viewing distance the light band on them still reads
         soft, because the ACTUAL slope is gentle relative to how steep a
         painted peak looks. Steepening dx/dz on high terrain only makes the
         toon ramp snap its light/shadow edge harder there - same vertices,
         sharper-reading rock - without moving a single one. Ramps in from
         h=85 (where rock starts) to h=260 (deep peak) so the meadow's rolling
         hills keep their soft normals. */
      var steepAmp = 1 + 1.4 * smoothstep(85, 260, H[k]);
      dx *= steepAmp; dz *= steepAmp;
      var il = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
      NX[k] = -dx * il; NY[k] = il; NZ[k] = -dz * il;
    }
    if ((iy & 63) === 0) { yield ['Smoothing the hills', 0.46 + 0.05 * (iy / N)]; }
  }

  yield ['Painting the meadow', 0.52];
  var C = new Float32Array(N * N * 3);
  for (iy = 0; iy < N; iy++) {
    var z2 = -half + iy * step;
    for (ix = 0; ix < N; ix++) {
      k = iy * N + ix;
      terrainColorAt(-half + ix * step, z2, H[k], NY[k], C, k * 3);
    }
    if ((iy & 15) === 0) { yield ['Painting the meadow', 0.52 + 0.17 * (iy / N)]; }
  }

  /* the ground goes down as a grid of tiles so the half behind you is free */
  yield ['Laying the ground', 0.70];
  var CH = 8, seg = WSEG / CH, sp1 = seg + 1;
  var mat = groundMaterial();
  for (var cy = 0; cy < CH; cy++) {
    for (var cx = 0; cx < CH; cx++) {
      var vs = sp1 * sp1;
      var pos = new Float32Array(vs * 3), nor = new Float32Array(vs * 3), col = new Float32Array(vs * 3);
      var idx = new Uint32Array(seg * seg * 6), q = 0;
      for (var j = 0; j < sp1; j++) {
        for (var i = 0; i < sp1; i++) {
          var gi = cx * seg + i, gj = cy * seg + j;
          var g = gj * N + gi, v = j * sp1 + i;
          pos[v * 3] = -half + gi * step; pos[v * 3 + 1] = H[g]; pos[v * 3 + 2] = -half + gj * step;
          nor[v * 3] = NX[g]; nor[v * 3 + 1] = NY[g]; nor[v * 3 + 2] = NZ[g];
          col[v * 3] = C[g * 3]; col[v * 3 + 1] = C[g * 3 + 1]; col[v * 3 + 2] = C[g * 3 + 2];
        }
      }
      for (j = 0; j < seg; j++) {
        for (i = 0; i < seg; i++) {
          var A = j * sp1 + i, B = A + 1, Cc = A + sp1, D = Cc + 1;
          idx[q++] = A; idx[q++] = Cc; idx[q++] = B;
          idx[q++] = B; idx[q++] = Cc; idx[q++] = D;
        }
      }
      var gg = new THREE.BufferGeometry();
      gg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      gg.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      gg.setAttribute('color', new THREE.BufferAttribute(col, 3));
      gg.setIndex(new THREE.BufferAttribute(idx, 1));
      gg.computeBoundingSphere();
      var m = new THREE.Mesh(gg, mat);
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      scene.add(m);
    }
    yield ['Laying the ground', 0.70 + 0.04 * (cy / CH)];
  }

  /* the sea needs to know how deep it is - reuse the heights we just made */
  var data = new Uint8Array(N * N * 4);
  for (k = 0; k < N * N; k++) {
    var t = clamp((H[k] + 20) / 26, 0, 1) * 255;
    var o = k * 4;
    data[o] = t; data[o + 1] = t; data[o + 2] = t; data[o + 3] = 255;
  }
  depthTex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  depthTex.minFilter = THREE.LinearFilter;
  depthTex.magFilter = THREE.LinearFilter;
  depthTex.wrapS = depthTex.wrapT = THREE.ClampToEdgeWrapping;
  depthTex.needsUpdate = true;
  yield ['Filling the sea', 0.75];
}

/* ======================================================================== *
 *  THE CLIFF WALL  (a real rock face so the waterfall has something to fall
 *  down; the terrain behind it only has to be roughly the right shape)
 * ======================================================================== */

function buildCliffWall() {
  var X0 = -486, X1 = 6, COLS = 84, ROWS = 22;
  var pos = [], col = [], idx = [];
  var cx = (X0 + X1) * 0.5, hw = (X1 - X0) * 0.5;

  for (var i = 0; i <= COLS; i++) {
    var u = i / COLS;
    var x = lerp(X0, X1, u);
    var uu = (x - cx) / hw;                       /* -1 .. 1 */
    var recede = -30 * Math.pow(Math.abs(uu), 4); /* tuck the ends into the hill */
    var cw = cliffWave(x);
    var topY = wallTop(x);
    var botY = terrainHeight(x, CLIFF_S + 4 + cw) - 10;
    /* Buttresses: the single biggest reason a cliff mesh reads as a "striped
       curtain" is that it is one continuous flat-ish plane - real rock faces
       are made of columns that jut out and gullies that recede, so light
       catches some strips and shadows fall in others. Low frequency in x
       only (same value for every row in this column) so each buttress runs
       the full height of the wall as one visible rib, not a per-row wobble.
       Damped to ~0 right at the waterfall (x=-240) so the fall keeps a clean
       planar lip to drop past. */
    var wDamp = smoothstep(50, 170, Math.abs(x + 240));
    var buttress = ((fbm(x * 0.021 + 44.1, 71.3, 3) - 0.5) * 20.0 +
                     (fbm(x * 0.055 + 12.6, 33.9, 2) - 0.5) * 10.0) * wDamp;
    for (var j = 0; j <= ROWS; j++) {
      var v = j / ROWS;
      var y = lerp(topY, botY, v);
      var jitter = (fbm(x * 0.021 + 3.3, v * 3.4 + 7.7, 3) - 0.5) * 6.0
        + (fbm(x * 0.075, v * 9.0, 2) - 0.5) * 1.8;
      var z = cliffZ(v) + cw + recede + buttress * (0.35 + 0.65 * smoothstep(0.0, 0.25, v))
        + jitter * (0.25 + 0.75 * smoothstep(0.0, 0.22, v));
      var xj = x + (fbm(x * 0.05 + 1.1, v * 2.2, 2) - 0.5) * 1.1;
      pos.push(xj, y, z);

      /* colour: banded rock, moss on the crown, wet stone behind the fall */
      var st = fbm(x * 0.024 + 2.2, y * 0.10, 3);
      var n2 = fbm(x * 0.09, y * 0.22, 2);
      /* cool blue-grey to match the peaks, and a much narrower spread:
         the wide light/dark range was banding into vertical stripes */
      var r = lerp(0.40, 0.52, st), g = lerp(0.44, 0.56, st), b = lerp(0.52, 0.64, st);
      r = lerp(r, 0.46, n2 * 0.18); g = lerp(g, 0.50, n2 * 0.18); b = lerp(b, 0.58, n2 * 0.18);
      /* a warm sunstruck crest and a cooler, darker base - split tone
         (sunlit gold / shadow blue) banded across the wall's height. Uses
         `vv`, not the raw `v`: real strata dip and rise along the rock face
         instead of sitting dead level, and a perfectly level line at a fixed
         v was exactly what made the wall look like a printed-on stripe
         rather than a rock formation. The low-frequency x offset makes the
         band wander a few percent up and down the face as x changes. */
      var vv = clamp(v + (fbm(x * 0.006 + 9.4, 1.7, 3) - 0.5) * 0.22, 0, 1);
      var crestLight = smoothstep(0.16, 0.0, vv) * 0.40;
      r = lerp(r, 0.60, crestLight); g = lerp(g, 0.56, crestLight); b = lerp(b, 0.46, crestLight);
      var baseShadow = smoothstep(0.78, 1.0, vv) * 0.35;
      r = lerp(r, 0.28, baseShadow); g = lerp(g, 0.32, baseShadow); b = lerp(b, 0.42, baseShadow);
      var moss = smoothstep(0.16, 0.0, vv) * smoothstep(0.35, 0.75, n2);
      r = lerp(r, 0.24, moss); g = lerp(g, 0.44, moss); b = lerp(b, 0.18, moss);
      var wet = smoothstep(58, 16, Math.abs(x + 240)) * 0.55;
      r *= (1 - wet * 0.42); g *= (1 - wet * 0.36); b *= (1 - wet * 0.24);
      /* buttress ribs also get their own light/shadow read, independent of
         height banding, so the columns this pass adds are actually visible
         as columns and not just a geometry wobble under flat colour */
      var ribShade = clamp(buttress / 20.0, -0.5, 0.5) * 0.30;
      r *= (1 + ribShade); g *= (1 + ribShade); b *= (1 + ribShade);
      var ao = lerp(0.85, 1.06, smoothstep(0.0, 0.35, vv)) * lerp(1.0, 0.84, smoothstep(0.74, 1.0, vv));
      col.push(clamp(r * ao, 0, 1), clamp(g * ao, 0, 1), clamp(b * ao, 0, 1));
    }
  }
  var stride = ROWS + 1;
  for (i = 0; i < COLS; i++) {
    for (var jj = 0; jj < ROWS; jj++) {
      var a = i * stride + jj, bq = (i + 1) * stride + jj;
      idx.push(a, a + 1, bq, bq, a + 1, bq + 1);
    }
  }
  var g2 = new THREE.BufferGeometry();
  g2.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g2.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g2.setIndex(idx);
  g2.computeVertexNormals();
  var m = new THREE.Mesh(g2, new THREE.MeshToonMaterial({ vertexColors: true, side: THREE.DoubleSide, gradientMap: toonRamp() }));
  m.receiveShadow = true;
  scene.add(m);
}

/* ======================================================================== *
 *  WATER  -  the sea, the river, the plunge pool and the fall itself
 * ======================================================================== */

export { buildCliffWall, depthTex, genTerrain, groundMaterial, terrainColorAt, terrainHeights };
