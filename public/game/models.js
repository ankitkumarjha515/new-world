/* Whispering Meadow - models.js
   Optional loader for real (downloaded) low-poly GLTF/GLB props, so the
   hand-painted procedural trees in props.js can be compared against - or
   swapped for - actual modelled assets.

   Nothing else in the game depends on this file. Every function here is
   allowed to fail (missing file, no network, old browser) and MUST fail
   quietly: on any error the promise resolves to null / an empty array
   instead of rejecting, so a caller that forgets to .catch() still can't
   take the world down with it.

   -------------------------------------------------------------- loading
   three r155 is loaded in index.html as a single global <script> (the
   window.THREE this whole game already uses) - it does NOT bundle
   GLTFLoader. As of r155 three no longer publishes a global-attaching
   "examples/js" build of its loaders at all; the only GLTFLoader three
   ships is the ES module at examples/jsm/loaders/GLTFLoader.js, and that
   module itself does `import { ... } from 'three'`.

   A bare specifier like 'three' only resolves in a browser if the page
   has an <script type="importmap"> entry for it. So loading the loader
   here takes two steps:
     1. inject an import map, once, mapping "three" -> the matching
        three.module.js build (same version, same CDN, so every class the
        loader expects lines up with what our global THREE was built from)
     2. dynamic-import() the GLTFLoader module by URL

   This works in every evergreen browser (import maps landed in Chrome 89,
   Firefox 108, Safari 16.4 - all long since the floor for this game) as
   long as nothing has already tried to resolve "three" as a specifier
   before the map is inserted. Nothing else in this codebase does -
   every other file talks to the THREE global - so this is safe to do
   lazily, on first use, instead of needing a static <script type=
   importmap> in index.html.

   If any of that fails for any reason - old browser, blocked CDN, no
   network - getGLTFLoaderClass() resolves to null and every function
   below degrades to a no-op. The world keeps using its procedural trees. */

import { SUN, renderer, scene, timeU, toonRamp, withRim } from './core.js';

/* Both served from this site now - see the note in index.html. The loader
   and the engine it imports from are the same copy the game is running on,
   so there is one Three.js in the page instead of two. */
var THREE_MODULE_URL = '/vendor/three/build/three.module.js';
var GLTFLOADER_URL = '/vendor/three/examples/jsm/loaders/GLTFLoader.js';

function withTimeout(promise, ms, msg) {
  return new Promise(function (resolve, reject) {
    var done = false;
    var t = setTimeout(function () {
      if (done) { return; }
      done = true;
      reject(new Error(msg || ('timed out after ' + ms + 'ms')));
    }, ms);
    promise.then(function (v) {
      if (done) { return; }
      done = true; clearTimeout(t); resolve(v);
    }, function (err) {
      if (done) { return; }
      done = true; clearTimeout(t); reject(err);
    });
  });
}

function ensureThreeImportMap() {
  if (document.querySelector('script[type="importmap"]')) { return; } // trust whatever is already there
  var im = document.createElement('script');
  im.type = 'importmap';
  im.textContent = JSON.stringify({ imports: { three: THREE_MODULE_URL } });
  document.head.appendChild(im);
}

var _loaderPromise = null;

/* Resolves to the GLTFLoader class, or null if it could not be obtained.
   Cached: only ever does the import-map + network dance once. */
function getGLTFLoaderClass() {
  if (_loaderPromise) { return _loaderPromise; }
  _loaderPromise = new Promise(function (resolve) {
    if (window.THREE && THREE.GLTFLoader) { resolve(THREE.GLTFLoader); return; }
    if (!window.THREE) { resolve(null); return; } // engine itself never came up
    try {
      ensureThreeImportMap();
    } catch (err) {
      console.warn('[models] could not set up the import map GLTFLoader needs:', err);
      resolve(null);
      return;
    }
    /* This one fetch gates the ENTIRE modelled prop set - if it gives up,
       every tree, rock and flower in the world falls back to the
       hand-written geometry. It is a 100 KB file from this same origin now
       rather than a CDN round trip that dragged a 1.2 MB engine behind it,
       but the generous ceiling stays: nothing waits on this (the meadow is
       already standing), so the timeout exists only to stop a dead request
       hanging around for ever. */
    withTimeout(import(/* webpackIgnore: true */ GLTFLOADER_URL), 40000, 'GLTFLoader module timed out')
      .then(function (mod) {
        var Cls = mod && mod.GLTFLoader;
        if (!Cls) { throw new Error('module loaded but exported no GLTFLoader'); }
        THREE.GLTFLoader = Cls; // so later callers (and console debugging) find it the normal way
        resolve(Cls);
      })
      .catch(function (err) {
        console.warn('[models] GLTFLoader unavailable, procedural trees only:', err);
        resolve(null);
      });
  });
  return _loaderPromise;
}

/* Loads one GLTF/GLB by URL. Resolves to the root Object3D on success,
   or null on ANY failure (loader unavailable, 404, bad file, timeout).
   Never rejects - callers do not need a .catch(). */
function loadModel(url) {
  return getGLTFLoaderClass().then(function (Loader) {
    if (!Loader) { return null; }
    var loader = new Loader();
    /* 15s was not enough, and giving up costs quality rather than saving
       any: all sixteen models are requested at once and share the link, so
       the three big ones - the two blossom trees and tree_d, half a
       megabyte each - are the ones that lose the race. Measured against the
       deployed site over a slow connection, those three timed out and the
       meadow fell back to procedural trees for them. Waiting longer is free
       here: the world is already standing and playable by the time any of
       this resolves, and the models drop into their pre-computed positions
       whenever they arrive. The timeout is a backstop against a request
       that will never finish, not a latency budget. */
    return withTimeout(new Promise(function (resolve, reject) {
      loader.load(url, function (gltf) {
        var root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
        if (!root) { reject(new Error('glTF had no scene')); return; }
        /* GLTFLoader hands the clips back on the gltf object, not on the
           scene, and this function only ever returns the scene. Every
           nature prop has none so nothing noticed; the actors in actors.js
           are animated, so carry them across here rather than widening
           what this returns for sixteen callers that do not care. */
        if (gltf.animations && gltf.animations.length) { root.animations = gltf.animations; }
        resolve(root);
      }, undefined, reject);
    }), 45000, 'model fetch timed out: ' + url);
  }).catch(function (err) {
    console.warn('[models] failed to load ' + url + ', falling back to procedural props:', err);
    return null;
  });
}

/* ======================================================================== *
 *  THE NATURE SET                       public/assets/nature/*
 *
 *  Everything below drives the CC0 Quaternius props that ship in
 *  public/assets/nature - see SOURCES.md there for where they came from
 *  and tools/nature-build/build.mjs - which lives outside public/, so it
 *  is not shipped - for what was done to them. Three facts about those
 *  files shape this whole section:
 *
 *  1. THEY CARRY NO TEXTURES. The build pulled every image out, because
 *     the same eight 1024^2 PNGs were embedded in all 25 source models
 *     (~2.2 MB of duplicate PNG per tree). What is left tying a primitive
 *     to its base colour is the MATERIAL NAME, so NATURE_TEX below has to
 *     mirror the TEXTURES table in that build script exactly. One THREE.Texture
 *     per image for the entire world, which is the whole point on an
 *     integrated GPU with no VRAM to spare.
 *
 *  2. EACH GLB HOLDS TWO LEVELS OF DETAIL as two sibling nodes named
 *     LOD0 and LOD1 (a few of the small props only have LOD0 - nothing
 *     to thin). LOD1 is the same tree with whole leaf cards discarded and
 *     the survivors grown to cover the gap.
 *
 *  3. UVs ARE glTF UVs, so every texture here needs flipY = false. A
 *     TextureLoader defaults to true and GLTFLoader would have set false
 *     for us; loading the images ourselves means saying so ourselves.
 *
 *  ---------------------------------------------------------------- LOD
 *  Three bands, and the far one is a flat card:
 *
 *      0 ....... 118 ....... 158 ....... 330 ....... 410 ....... inf
 *      |   LOD0   |  x-fade  |   LOD1    |  x-fade   |  impostor
 *
 *  The cross-fade is a SCREEN-DOOR (ordered-dither) fade, not alpha
 *  blending: each level discards fragments whose 4x4 Bayer threshold
 *  falls outside its share of the transition, and consecutive levels use
 *  complementary halves of the same pattern, so together they always
 *  cover exactly 100% of the silhouette - no popping, no holes, and no
 *  transparency. That last part matters: staying in the opaque queue
 *  keeps depth writes and early-Z, which is exactly what a fill-rate-
 *  bound iGPU wants. Real alpha blending on a thousand trees would cost
 *  far more than the pop it removes.
 *
 *  The impostor band is a single billboarded quad per prop sampling a
 *  1024^2 atlas that is RENDERED AT BOOT from the real LOD0 meshes under
 *  the real scene lights (see buildNatureImpostors). So a distant tree is
 *  a photograph of the near tree rather than a different-looking object.
 * ======================================================================== */

var NATURE_DIR = 'assets/nature/';

/* material name in the GLB -> shared PNG + how to shade it.
   MIRRORS the TEXTURES table in tools/nature-build/build.mjs. If that table changes,
   this one has to change with it - the material name is the only link
   left between a primitive and its texture. */
var NATURE_TEX = {
  Bark_NormalTree:    { file: 'bark.png',           role: 'bark' },
  Bark_TwistedTree:   { file: 'bark_twisted.png',   role: 'bark' },
  Leaves_NormalTree:  { file: 'leaves_broad.png',   role: 'leaves' },
  Leaves_Pine:        { file: 'leaves_pine.png',    role: 'leaves' },
  Leaves_TwistedTree: { file: 'leaves_twisted.png', role: 'leaves' },
  /* Not a material in any GLB - a synthetic name props.js can swap in to
     get the twisted tree's silhouette with summer leaves on it. The
     shipped twisted texture averages rgb(167,23,23), which is autumn red,
     and a meadow planted entirely with it goes pink. */
  Leaves_TwistedGreen: { file: 'leaves_broad.png',   role: 'leaves' },
  Leaves:             { file: 'leaves_blade.png',   role: 'leaves' },
  Flowers:            { file: 'flowers.png',        role: 'leaves' },
  Rocks:              { file: 'rock.png',           role: 'rock' },

  /* ---- landmarks. One atlas serves both KayKit props; the dead tree's
     bark is its own, at 256px like every other bark here. */
  HalloweenBits:      { file: 'halloween.png',      role: 'rock' },
  Bark_DeadTree:      { file: 'bark_dead.png',      role: 'bark' },
  /* The fox statue carries no UVs at all, so there is nothing to map a
     texture onto. It reads its colour from the vertex colours the build
     paints on (see TINT in tools/nature-build/build.mjs) - listed here
     with a null file so that "why is this material not in the table?"
     never has to be asked about it. */
  Stone:              { file: null,                 role: 'rock' }
};

/* every prop in manifest.json, in manifest order - also the order of the
   impostor atlas cells, so it must stay stable */
var NATURE_PROPS = [
  'tree_a', 'tree_b', 'tree_c', 'tree_d',
  'pine_a', 'pine_b', 'pine_c',
  'blossom_a', 'blossom_b',
  'bush_a', 'fern_a',
  'rock_a', 'rock_b', 'rock_c',
  'flower_a', 'flower_b',
  /* Landmarks, APPENDED - never inserted. This array is also the order of
     the impostor atlas cells, so putting a new name anywhere but the end
     would silently re-point every existing prop at someone else's
     photograph. */
  'statue_fox', 'pillar', 'crypt', 'dead_tree'
];

/* The three distance bands. `in` fades the level IN over [x,y] metres,
   `out` fades it OUT over [x,y]. Band N's `out` is band N+1's `in`, which
   is what makes the dither halves complementary. */
var NATURE_BANDS = {
  near: { key: 'n', level: 0, in: [-2, -1],   out: [118, 158] },
  mid:  { key: 'm', level: 1, in: [118, 158], out: [330, 410] },
  far:  { key: 'f', level: 2, in: [330, 410], out: [99000, 99001] }
};

/* ------------------------------------------------------- how far things go
   THE ONE TABLE. Every draw distance in the world is here, so "is this
   consistent across the map?" is a question you answer by reading eleven
   lines rather than by walking around looking for the place it was forgotten.

   It was forgotten. The billboards that take over from the mesh had NO far
   limit and NO frustum test at all - every prop in the world, four and a
   half thousand of them, was submitted every frame including the ones
   directly behind the camera, out to the edge of the plate. That is why the
   far field never emptied no matter where you stood.

   The rule is the obvious one: the bigger the object, the further out it is
   worth drawing. A blossom tree is seventeen metres tall and reads at eight
   hundred; a rock is two metres and stops being a pixel long before that.
   Three size classes rather than a per-prop distance, because each distinct
   distance is a separate compiled shader and sixteen of them would cost more
   than they saved.

   `in` is inherited from NATURE_BANDS.far so the card always fades IN exactly
   where the mesh fades OUT - a gap between the two would make props wink out
   of existence for a stretch and back again. */
/* The three size classes were hand-assigned, and hand-assignment is what
   went wrong with them. Two faults, both invisible from the table itself:

   THEY MEASURED THE WRONG OBJECT. The class came from `prop.height` as the
   MODELLER built it, but nothing in this world is drawn at the size the
   modeller built it. NATURE_FIT in props.js cuts blossom_a to 0.46 and the
   scatter's own `scale` callback varies every instance on top of that. A
   blossom is 16.7 metres in the manifest and 10.7 on the meadow, so it was
   classed `large` and its card drawn to 930m on the strength of six metres
   that are not there. The ordering came apart too: blossom_b (8.0m as
   drawn) held its card to 800m while pine_c, a BIGGER object at 8.7m,
   stopped at 640m.

   THEY MEASURED ONLY THE HEIGHT. What decides whether a thing is still
   worth drawing is how much SCREEN it covers, and fern_a is 2.7m tall and
   11.5m wide. Classed `small` on its height, it left the world at the same
   distance as a pebble.

   So the table is now a rule, and the rule is the one the old comment
   already stated: the bigger the object, the further out it is worth
   drawing. An object of extent E metres at distance D subtends a constant
   share of the screen when D/E is constant, so the draw distance is simply

       distance = LOD_K * extent

   LOD_K was not invented. It was FITTED to the tuning already in this file
   - the mean of out[0]/extent across the trees and pines, the props that
   were actually looked at while they were tuned - and it comes out at 56.

   THE EXTENT IT IS FITTED ON IS THE EXTENT AS DRAWN, which is the part
   that is easy to get wrong and was got wrong once here already. A first
   pass fitted the constant on manifest extents and then applied it to
   extents that included the scatter's per-instance scale; those differ by
   about 40%, so every prop came out a rung too far. Both sides of the fit
   have to be the size the player actually sees.

   The check that 56 is a real constant and not a curve-fit is that three
   numbers tuned by hand somewhere else, for different props, on different
   days, all fall out of it: SMALL_SCATTER.flower's 150m implies a 2.7m
   object, SMALL_SCATTER.sunflower's 270m implies 4.8m, and PROC_FAR_OUT's
   980m implies 17.5m. A wildflower, a sunflower, and a procedural tree,
   each at the size its own scatter draws it.

   RUNGS, not a continuous distance. Every distinct band is a separate
   compiled shader - see the note on natureMaterial's cache key - so the
   computed distance snaps to the nearest of a fixed ladder. The point of
   a fixed ladder is that ADDING A PROP CAN NEVER ADD
   A SHADER: a new model measures itself, lands on a rung that already has
   a program compiled, and is done. Nothing to assign by hand, and nothing
   to forget to assign.

   BELOW THE HAND-OVER THERE IS NO CARD. A rung under NATURE_BANDS.far.in
   would have the billboard fading IN at 330m and OUT at 240m - it would
   never be drawn, and the prop would simply vanish when its mesh ended. So
   the short rungs carry no impostor at all and the mesh itself ends on
   them. That is not a special case bolted on; it is what SMALL_SCATTER has
   always done for the hand-written flowers, now applied to everything that
   is that small. It also deletes the rock and fern card layers outright,
   which is a straight saving of both draw calls and atlas pressure. */
var LOD_K = 56;

/* Where the rungs sit: on the clusters this world's props actually form,
   not spaced evenly over the range. Even spacing costs 25% worst-case snap
   error for nothing; placing them by hand gets it to 17% AND lands seven
   of the eight tree and pine scatters on the single 630m rung, so most of
   the far field ends up sharing one compiled program.

   Rungs 0-2 sit below the 410m hand-over and so carry no billboard; rungs
   3-4 sit above it and do. */
var LOD_RUNGS = [165, 250, 380, 630, 850];

/* The fade window is ~19% of the distance, which is what the three bands
   this replaces used (480->580, 640->760, 800->930). */
function lodFade(d) { return [d, Math.round(d * 1.19)]; }

/* Each rung, pre-built as the band objects the shaders are keyed on.

   `mesh`, `midOnly` and `imp` SHARE ONE `out` ARRAY per rung, and that is
   load-bearing for the same reason the old table's sharing was:
   setNatureLODScale mutates these arrays in place so that a material which
   has already compiled cannot be left behind on a stale distance. One
   array per rung means one place to mutate. */
var LOD_BANDS = (function () {
  var out = [];
  for (var i = 0; i < LOD_RUNGS.length; i++) {
    var d = LOD_RUNGS[i];
    /* A rung is long enough to be worth a billboard only if the mesh has
       already handed over by the time it arrives. */
    var card = d >= NATURE_BANDS.far.in[1];
    var fade = lodFade(d);
    out.push({
      dist: d,
      /* the prop's own geometry, drawn from zero and ending HERE */
      mesh: { key: 'r' + i, level: 0, in: [-2, -1], out: fade },
      /* the mid LOD carrying the tail alone, when no atlas could be baked */
      midOnly: { key: 'R' + i, level: 1, in: NATURE_BANDS.mid.in, out: fade },
      /* the billboard: fades in exactly where the mesh fades out, so the
         two are never both gone at once */
      imp: card ? { key: 'F' + i, level: 2, in: NATURE_BANDS.far.in, out: fade } : null
    });
  }
  return out;
})();

/* How much screen a prop covers is set by its LARGEST dimension, not its
   height - see fern_a. `radius` in the manifest is a horizontal radius, so
   the width it implies is twice it. `scale` is what the world actually
   draws the thing at: NATURE_FIT times the scatter's own per-instance
   scale, which the caller measures off the placed matrices. */
function propExtent(prop, scale) {
  if (!prop) { return 6; }
  var h = prop.height || 0, r = prop.radius || 0;
  return Math.max(h, 2 * r) * (scale === undefined ? 1 : scale);
}

/* Nearest rung in LOG space - a ladder that is geometric has to be matched
   geometrically or every prop drifts toward the widely-spaced top end. */
function rungFor(extent) {
  var ideal = LOD_K * Math.max(0.2, extent);
  var best = LOD_BANDS[0], bestErr = Infinity;
  for (var i = 0; i < LOD_BANDS.length; i++) {
    var err = Math.abs(Math.log(LOD_BANDS[i].dist / ideal));
    if (err < bestErr) { bestErr = err; best = LOD_BANDS[i]; }
  }
  return best;
}

/* Convenience for a caller that has a prop and a scale and wants the rung. */
function rungForProp(prop, scale) { return rungFor(propExtent(prop, scale)); }

/* Same rule for geometry that was never a manifest entry - the hand-written
   trees, reeds and flowers. Their extent is whatever their bounding box
   says it is, so they join the system by existing. */
function rungForGeometry(geo, scale) {
  if (!geo) { return LOD_BANDS[LOD_BANDS.length - 1]; }
  if (!geo.boundingBox) { geo.computeBoundingBox(); }
  var b = geo.boundingBox;
  if (!b) { return LOD_BANDS[LOD_BANDS.length - 1]; }
  var ex = Math.max(b.max.y - b.min.y, b.max.x - b.min.x, b.max.z - b.min.z);
  return rungFor(ex * (scale === undefined ? 1 : scale));
}

/* Pull every hand-over distance in by the same factor, so a phone drops to
   the cheap level sooner than a desktop does. The numbers above are the
   desktop reference and this only ever shrinks them.

   It MUTATES the arrays in place rather than replacing them, and that is
   load-bearing: props.js builds its own bands out of these same array
   objects at module-evaluation time (SOLO_TO_IMP borrows far.in, and every
   rung's imp band borrows it too), so anything that swapped the arrays
   would update the originals and silently leave those copies on the old
   distances. Mutating in place means every reference sees the new value.

   Must be called BEFORE anything is scattered - the distances are baked
   into each shader as literals when its material is first built, and a
   material that has already compiled will not pick up a change. main.js
   calls it right after initQuality() and long before buildTrees(). */
function setNatureLODScale(k) {
  var b = NATURE_BANDS;
  var pairs = [b.near.out, b.mid.in, b.mid.out, b.far.in];
  var i;
  /* One `out` array per rung, shared by that rung's mesh/midOnly/imp bands,
     so it is pushed exactly once. Note that imp.in IS b.far.in - the same
     array object, already in the list above - and scaling it a second time
     here would square the factor. */
  for (i = 0; i < LOD_BANDS.length; i++) { pairs.push(LOD_BANDS[i].mesh.out); }

  for (i = 0; i < pairs.length; i++) {
    pairs[i][0] = Math.round(pairs[i][0] * k);
    pairs[i][1] = Math.round(pairs[i][1] * k);
  }

  /* The rung LADDER and the constant that chooses between its rungs have to
     move together. Shrinking the rungs alone would leave `LOD_K * extent`
     where it was, so every prop would snap UP a rung and quietly hand back
     most of the reduction a phone just asked for. Scaling both leaves the
     extent -> rung mapping exactly where it was and only the distances
     themselves come in, which is the whole intent. */
  LOD_K *= k;
  for (i = 0; i < LOD_BANDS.length; i++) {
    LOD_BANDS[i].dist = Math.round(LOD_BANDS[i].dist * k);
  }
  /* far.out is the 99000 sentinel meaning "never fades out" - scaling it
     would be meaningless and, at a small enough k, wrong. */
}

/* ------------------------------------------------------------- textures */
var _natTex = {};
function natureTexture(file) {
  if (_natTex[file]) { return _natTex[file]; }
  var t = new THREE.TextureLoader().load(NATURE_DIR + 'textures/' + file);
  t.flipY = false;                     /* glTF UV convention - see (3) above */
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;                    /* three clamps this to the GPU max */
  _natTex[file] = t;
  return t;
}

/* ------------------------------------------------------- shader plumbing
   GLSL float literal: `1` is an int in GLSL ES and `float x = 1;` is a
   compile error, so every number baked into the source needs a point. */
function glslF(n) {
  var s = (Math.round(n * 1000) / 1000).toString();
  return (s.indexOf('.') < 0 && s.indexOf('e') < 0) ? (s + '.0') : s;
}

/* 4x4 ordered dither without an array lookup (dynamic indexing into a
   const array is not allowed in GLSL ES 1.0, and this has to compile on
   whatever a mid-range phone gives us). The two-line form is the standard
   recursive Bayer identity: B4 = B2(p/2)/4 + B2(p). */
var NATURE_BAYER_GLSL = [
  'varying float vNatD;',
  'float natBayer2(vec2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }',
  'float natBayer4(vec2 a) { return natBayer2(a * 0.5) * 0.25 + natBayer2(a); }',
  ''
].join('\n');

function natureBandGLSL(band) {
  return [
    '  float natIn  = smoothstep(' + glslF(band.in[0]) + ', ' + glslF(band.in[1]) + ', vNatD);',
    '  float natOut = smoothstep(' + glslF(band.out[0]) + ', ' + glslF(band.out[1]) + ', vNatD);',
    '  float natB = natBayer4(gl_FragCoord.xy);',
    /* natBayer4 never reaches 1.0, so natIn == 1.0 means "fully in" and
       natOut == 0.0 means "not leaving yet" - the degenerate bands used by
       the first and last level cost nothing. */
    '  if (natB >= natIn || natB < natOut) { discard; }',
    ''
  ].join('\n');
}

/* Distances and sway amplitudes are baked in as LITERALS rather than
   uniforms on purpose. Uniform objects handed out inside onBeforeCompile
   belong to the compiled program, not the material, so two materials that
   shared a program would share their band constants too - the classic way
   to get a "why is my far LOD using the near LOD's distances" bug. A
   literal cannot be aliased, and customProgramCacheKey (set by the caller)
   keeps each variant on its own program. */
function patchNatureShader(sh, band, height, sway) {
  if (!band && !(sway > 0)) { return; }
  var head = [];
  var body = ['#include <begin_vertex>'];
  body.push('#ifdef USE_INSTANCING');
  body.push('  vec3 natOrg = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;');
  body.push('#else');
  body.push('  vec3 natOrg = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;');
  body.push('#endif');
  if (band) {
    head.push('varying float vNatD;');
    /* ONE distance per instance, taken at the instance origin - not
       per-fragment. A tree has to fade as a whole object; a per-pixel
       distance would dissolve its near side before its far side. */
    body.push('  vNatD = distance(cameraPosition, natOrg);');
  }
  if (sway > 0) {
    sh.uniforms.uTime = timeU;         /* the one clock the whole world shares */
    head.push('uniform float uTime;');
    /* Two sines at very different scales: a fast local rustle, and a slow
       broad gust that walks across the meadow so a whole hillside leans
       together instead of every tree wobbling on its own. Amplitude is
       y^2 in normalised model height, so trunks stay planted and only the
       crown moves. Both primitives of a prop get the same formula and the
       same height, so trunk and canopy bend as one piece. */
    body.push('  float natY = clamp(transformed.y / ' + glslF(Math.max(0.5, height)) + ', 0.0, 1.0);');
    body.push('  float natG = sin(uTime * 0.37 + natOrg.x * 0.0104 + natOrg.z * 0.0087) * 0.5 + 0.5;');
    body.push('  float natS = sin(uTime * 1.07 + natOrg.x * 0.163 + natOrg.z * 0.131) * 0.5 + 0.5;');
    body.push('  float natA = ' + glslF(sway) + ' * (0.32 + 0.68 * natG) * (0.38 + 0.62 * natS) * natY * natY;');
    body.push('  transformed.x += natA; transformed.z += natA * 0.42;');
  }
  sh.vertexShader = head.join('\n') + '\n' +
    sh.vertexShader.replace('#include <begin_vertex>', body.join('\n'));

  if (band) {
    sh.fragmentShader = NATURE_BAYER_GLSL +
      sh.fragmentShader.replace('#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\n' + natureBandGLSL(band));
  }
}

/* -------------------------------------------------------------- materials
   Cached on every axis that changes the compiled shader, because the cache
   key IS the program key: material name (texture + role), whether this
   primitive has vertex colours, which LOD band, and the prop's height and
   sway (both baked into the vertex shader as literals). */
var _natMat = {};
function natureMaterial(matName, vc, band, height, sway) {
  var spec = NATURE_TEX[matName] || { file: null, role: 'bark' };
  var leaves = spec.role === 'leaves';
  var key = matName + '|' + (vc ? 1 : 0) + '|' + (band ? band.key : 'plain') +
    '|' + glslF(height) + '|' + glslF(sway);
  if (_natMat[key]) { return _natMat[key]; }
  /* alphaTest, NOT transparent: the leaf textures are 80% cut-out, and the
     opaque queue with early-Z is the only affordable way to draw a
     thousand of them. */
  var m = withRim(new THREE.MeshToonMaterial({
    map: spec.file ? natureTexture(spec.file) : null,
    vertexColors: !!vc,
    gradientMap: toonRamp(),
    side: leaves ? THREE.DoubleSide : THREE.FrontSide,
    alphaTest: leaves ? 0.45 : 0.0
  }), leaves ? 0.38 : 0.20);
  var prev = m.onBeforeCompile;
  m.onBeforeCompile = function (sh) {
    if (prev) { prev.call(this, sh); }   /* withRim() got there first - chain, never replace */
    patchNatureShader(sh, band, height, sway);
  };
  m.customProgramCacheKey = function () { return 'nature|' + key; };
  _natMat[key] = m;
  return m;
}

/* --------------------------------------------------------------- loading */
function isIdentity(m) {
  var e = m.elements;
  return e[0] === 1 && e[1] === 0 && e[2] === 0 && e[3] === 0 &&
    e[4] === 0 && e[5] === 1 && e[6] === 0 && e[7] === 0 &&
    e[8] === 0 && e[9] === 0 && e[10] === 1 && e[11] === 0 &&
    e[12] === 0 && e[13] === 0 && e[14] === 0 && e[15] === 1;
}

/* One prop: its two LOD levels as lists of { geo, matName, vc }, plus the
   model-space box the impostor is framed from. Resolves to null on any
   failure, like everything else in this file. */
function loadNatureProp(name, meta) {
  return loadModel(NATURE_DIR + 'models/' + name + '.glb').then(function (root) {
    if (!root) { return null; }
    root.updateWorldMatrix(true, true);
    var lods = [[], []];
    var box = new THREE.Box3();
    root.traverse(function (n) {
      if (!n.isMesh || !n.geometry) { return; }
      var lvl = 0, walk = n;
      while (walk) {
        if (walk.name === 'LOD1') { lvl = 1; break; }
        if (walk.name === 'LOD0') { break; }
        walk = walk.parent;
      }
      var geo = n.geometry;
      if (!isIdentity(n.matrixWorld)) { geo = geo.clone(); geo.applyMatrix4(n.matrixWorld); }
      if (!geo.boundingSphere) { geo.computeBoundingSphere(); }
      if (!geo.boundingBox) { geo.computeBoundingBox(); }
      var mat = Array.isArray(n.material) ? n.material[0] : n.material;
      lods[lvl].push({
        geo: geo,
        matName: (mat && mat.name) || '',
        vc: !!geo.attributes.color
      });
      if (lvl === 0) { box.union(geo.boundingBox); }
    });
    if (!lods[0].length) { return null; }
    if (!lods[1].length) { lods[1] = lods[0]; }   /* small props have no LOD1 */
    return {
      name: name,
      height: meta ? meta.height : (box.max.y - box.min.y),
      base: meta ? meta.base : box.min.y,
      radius: meta ? meta.radius : Math.max(box.max.x, -box.min.x),
      box: box,
      lods: lods
    };
  }).catch(function (err) {
    console.warn('[nature] ' + name + ' could not be loaded:', err);
    return null;
  });
}

var _natureLib = null;         /* resolved library, or null if unusable */
var _naturePromise = null;

/* Kicks off the whole set - manifest, 16 GLBs, 8 PNGs - and resolves to a
   library keyed by prop name, or null if nothing usable came back. Never
   rejects. Safe to call any number of times; only the first does work. */
function preloadNature() {
  if (_naturePromise) { return _naturePromise; }
  _naturePromise = withTimeout(fetch(NATURE_DIR + 'manifest.json'), 25000, 'nature manifest timed out')
    .then(function (res) {
      if (!res || !res.ok) { throw new Error('manifest HTTP ' + (res && res.status)); }
      return res.json();
    })
    .catch(function (err) {
      console.warn('[nature] no manifest, falling back to model bounds:', err);
      return [];
    })
    .then(function (manifest) {
      var meta = {};
      for (var i = 0; i < manifest.length; i++) { meta[manifest[i].name] = manifest[i]; }
      return Promise.all(NATURE_PROPS.map(function (n) { return loadNatureProp(n, meta[n]); }));
    })
    .then(function (list) {
      var props = {}, order = [], n = 0;
      for (var i = 0; i < list.length; i++) {
        if (!list[i]) { continue; }
        props[list[i].name] = list[i];
        order.push(list[i].name);
        n++;
      }
      if (!n) {
        console.warn('[nature] no props loaded - keeping the procedural world');
        return null;
      }
      _natureLib = { props: props, order: order };
      console.log('[nature] ' + n + '/' + NATURE_PROPS.length + ' props ready');
      return _natureLib;
    })
    .catch(function (err) {
      console.warn('[nature] set unavailable:', err);
      return null;
    });
  return _naturePromise;
}

/* The library if it is already in hand, else null - for callers that can
   use the models synchronously when they happen to be ready. */
function natureLibrary() { return _natureLib; }

/* ======================================================================== *
 *  IMPOSTORS
 *
 *  The far band is one flat quad per prop, textured from an atlas that is
 *  rendered HERE, at boot, out of the real LOD0 meshes under a copy of the
 *  real scene's lights. That is the whole trick: the far tree is a picture
 *  of the near tree, so the swap changes resolution and nothing else. A
 *  hand-authored billboard would have to be re-authored every time a
 *  material or the toon ramp changed; this one cannot drift.
 *
 *  1024^2 RGBA = 4 MB on the GPU for EVERY distant prop in the world, and
 *  one draw call per prop type for the entire far field.
 * ======================================================================== */

/* Grows opaque colour outwards into the transparent margin. Without it,
   bilinear filtering and mipmapping blend the cleared (black, alpha 0)
   background into every silhouette edge and distant trees get a dark
   fringe - the classic "why do my billboards have a halo" bug. Only RGB
   moves; alpha is untouched, so the cut-out shape is unchanged. */
function dilateEdges(buf, w, h, passes) {
  for (var p = 0; p < passes; p++) {
    var src = buf.slice(0);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var o = (y * w + x) * 4;
        if (src[o + 3] > 8) { continue; }
        var r = 0, g = 0, b = 0, n = 0;
        for (var dy = -1; dy <= 1; dy++) {
          var yy = y + dy;
          if (yy < 0 || yy >= h) { continue; }
          for (var dx = -1; dx <= 1; dx++) {
            var xx = x + dx;
            if (xx < 0 || xx >= w) { continue; }
            var q = (yy * w + xx) * 4;
            if (src[q + 3] > 8) { r += src[q]; g += src[q + 1]; b += src[q + 2]; n++; }
          }
        }
        if (n) { buf[o] = r / n; buf[o + 1] = g / n; buf[o + 2] = b / n; }
      }
    }
  }
}

var NATURE_IMP_CELL = 256;

/* ------------------------------------------------------------ the baker
   bakeImpostorSet(items) renders a list of things into ONE atlas and hands
   back an `imp` record per item: the quad's world size and the atlas rect
   to sample. It knows nothing about the nature library - an item is just a
   model-space box plus a function that produces the meshes to photograph -
   so the procedural trees in props.js can use exactly the same path, and a
   material-swapped variant can have an atlas of its own.

   items: [{ box: THREE.Box3, meshes: function () -> [THREE.Mesh] }]
   returns { tex: THREE.Texture, imps: [ {w,h,cy,uv} ] }, or null. */
function bakeImpostorSet(items) {
  if (!items || !items.length) { return null; }
  if (!renderer || !window.THREE) { return null; }

  var grid = Math.max(1, Math.ceil(Math.sqrt(items.length)));
  var cell = NATURE_IMP_CELL, size = grid * cell;

  /* the real scene's lighting rig, so an impostor and the LOD1 mesh it
     replaces are lit by the same numbers (see initEngine in core.js) */
  var tmp = new THREE.Scene();
  var dl = new THREE.DirectionalLight(0xfff4d2, 1.95);
  dl.position.set(SUN.x * 300, SUN.y * 300, SUN.z * 300);
  tmp.add(dl); tmp.add(dl.target);
  tmp.add(new THREE.HemisphereLight(0x9fd4ff, 0x6fae44, 1.42));
  var holder = new THREE.Group();
  tmp.add(holder);

  var rt = new THREE.WebGLRenderTarget(size, size, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
    depthBuffer: true, stencilBuffer: false, generateMipmaps: false
  });
  var cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);

  var oldTarget = renderer.getRenderTarget();
  var oldAutoClear = renderer.autoClear;
  var oldClear = new THREE.Color();
  renderer.getClearColor(oldClear);
  var oldAlpha = renderer.getClearAlpha();
  var oldScissor = renderer.getScissorTest();
  var oldSize = new THREE.Vector2();
  renderer.getSize(oldSize);

  var imps = [], tex = null;
  try {
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, size, size);
    renderer.clear(true, true, false);
    renderer.autoClear = false;          /* one clear for the whole sheet */
    renderer.setScissorTest(true);

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var col = i % grid, row = Math.floor(i / grid);

      while (holder.children.length) { holder.remove(holder.children[0]); }
      var ms = it.meshes();
      for (var j = 0; j < ms.length; j++) { holder.add(ms[j]); }

      /* frame the box side-on, with an 8% margin so mipmapping has
         somewhere to bleed that is not the neighbouring atlas cell */
      var box = it.box;
      var hw = Math.max(Math.abs(box.min.x), Math.abs(box.max.x),
        Math.abs(box.min.z), Math.abs(box.max.z)) * 1.08;
      var cy = (box.min.y + box.max.y) * 0.5;
      var hh = (box.max.y - box.min.y) * 0.54;
      if (!(hw > 0.001)) { hw = 0.5; }
      if (!(hh > 0.001)) { hh = 0.5; }
      cam.left = -hw; cam.right = hw; cam.top = cy + hh; cam.bottom = cy - hh;
      cam.position.set(0, cy, Math.max(80, hh * 8));
      cam.rotation.set(0, 0, 0);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);

      renderer.setViewport(col * cell, row * cell, cell, cell);
      renderer.setScissor(col * cell, row * cell, cell, cell);
      renderer.render(tmp, cam);

      imps.push({
        w: hw * 2, h: hh * 2, cy: cy,
        uv: [col / grid, row / grid, (col + 1) / grid, (row + 1) / grid]
      });
    }

    var buf = new Uint8Array(size * size * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf);
    dilateEdges(buf, size, size, 2);

    /* A DataTexture rather than the render target itself: three only
       regenerates render-target mipmaps on some paths, and a distant
       unmipmapped tree crawls with aliasing. Read it back once at boot and
       let the normal texture path build the chain. flipY stays false
       because readRenderTargetPixels hands back rows bottom-up, which is
       already what v = 0 means. The sheet is a power of two, so the mip
       chain is exact. */
    tex = new THREE.DataTexture(buf, size, size, THREE.RGBAFormat);
    tex.flipY = false;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = true;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
  } catch (err) {
    console.warn('[nature] impostor atlas failed:', err);
    tex = null;
  }

  renderer.setScissorTest(oldScissor);
  renderer.autoClear = oldAutoClear;
  renderer.setClearColor(oldClear, oldAlpha);
  renderer.setRenderTarget(oldTarget);
  renderer.setViewport(0, 0, oldSize.x, oldSize.y);
  renderer.setScissor(0, 0, oldSize.x, oldSize.y);
  rt.dispose();
  return tex ? { tex: tex, imps: imps } : null;
}

/* The base atlas: every prop in the library, photographed from its own
   LOD0 meshes with its own materials. Stores an `imp` on each prop and
   returns the shared texture (or null). Idempotent. */
function buildNatureImpostors(lib) {
  if (!lib) { return null; }
  if (lib.impostorTex !== undefined) { return lib.impostorTex; }
  lib.impostorTex = null;

  var names = lib.order;
  var set = bakeImpostorSet(names.map(function (n) {
    var prop = lib.props[n];
    return {
      box: prop.box,
      meshes: function () {
        var out = [];
        for (var j = 0; j < prop.lods[0].length; j++) {
          var pr = prop.lods[0][j];
          /* the plain (bandless, swayless) variant - a capture must not
             dither itself away or lean in the wind */
          out.push(new THREE.Mesh(pr.geo, natureMaterial(pr.matName, pr.vc, null, prop.height, 0)));
        }
        return out;
      }
    };
  }));
  if (!set) {
    console.warn('[nature] no impostor atlas, distant props will use LOD1');
    return null;
  }
  for (var i = 0; i < names.length; i++) { lib.props[names[i]].imp = set.imps[i]; }
  lib.impostorTex = set.tex;
  return set.tex;
}

/* ------------------------------------------------- material-swapped sets
   A scatter that re-points one material name at another entry in
   NATURE_TEX (props.js plants the twisted trees a second time in summer
   green) used to be barred from the far band entirely, because the base
   atlas was photographed with the ORIGINAL materials and the tree would
   have turned autumn red the moment it crossed 330 metres. Rather than
   hold the mid LOD out to the horizon - 4,000 triangles per tree, times
   three hundred trees, for ever - photograph the swapped variant too.
   One extra atlas per distinct swap, baked once, cached by swap key. */
function natureSwapImpostors(lib, swap, names) {
  if (!lib || !swap) { return null; }
  var key = [];
  for (var k in swap) { key.push(k + '>' + swap[k]); }
  key = key.sort().join('|') + '#' + names.slice().sort().join(',');
  if (!lib.swapSets) { lib.swapSets = {}; }
  if (lib.swapSets[key] !== undefined) { return lib.swapSets[key]; }
  lib.swapSets[key] = null;

  var set = bakeImpostorSet(names.map(function (n) {
    var prop = lib.props[n];
    return {
      box: prop.box,
      meshes: function () {
        var out = [];
        for (var j = 0; j < prop.lods[0].length; j++) {
          var pr = prop.lods[0][j];
          var mn = swap[pr.matName] || pr.matName;
          out.push(new THREE.Mesh(pr.geo, natureMaterial(mn, pr.vc, null, prop.height, 0)));
        }
        return out;
      }
    };
  }));
  if (!set) { return null; }
  var byName = {};
  for (var i = 0; i < names.length; i++) { byName[names[i]] = set.imps[i]; }
  lib.swapSets[key] = { tex: set.tex, imps: byName };
  return lib.swapSets[key];
}

/* One quad in the prop's own model space, UV'd to its atlas cell, so the
   very same instance matrix that places the real mesh places this too. */
function impostorGeometry(imp) {
  var g = new THREE.PlaneGeometry(imp.w, imp.h);
  g.translate(0, imp.cy, 0);
  var uv = g.attributes.uv, r = imp.uv;
  /* PlaneGeometry vertex order is top-left, top-right, bottom-left,
     bottom-right; v grows upward in the atlas. */
  uv.setXY(0, r[0], r[3]); uv.setXY(1, r[2], r[3]);
  uv.setXY(2, r[0], r[1]); uv.setXY(3, r[2], r[1]);
  uv.needsUpdate = true;
  g.computeBoundingSphere();
  return g;
}

/* Cached PER TEXTURE. There is more than one atlas now (the base set, one
   per material swap, and one for the hand-written trees), and a single
   shared material would have quietly handed all of them the first atlas
   that happened to be baked. */
var _impMat = [];
/* Unlit on purpose: the lighting is already painted into the atlas. What
   it does still need is the scene fog, which is most of what a tree 400
   metres away actually looks like. */
function natureImpostorMaterial(tex, band) {
  band = band || NATURE_BANDS.far;
  for (var i = 0; i < _impMat.length; i++) {
    if (_impMat[i].tex === tex && _impMat[i].band === band) { return _impMat[i].mat; }
  }
  var m = new THREE.MeshBasicMaterial({
    map: tex, alphaTest: 0.35, side: THREE.DoubleSide, fog: true
  });
  m.onBeforeCompile = function (sh) {
    /* Billboard about the Y axis in the vertex shader. Doing it on the CPU
       would mean rewriting every instance matrix every frame; doing it
       here costs a normalize on four vertices. Position and scale are read
       straight out of the instance matrix, so the card lands exactly where
       the real mesh would have - same matrices, no second placement pass.
       The card's own rotation is deliberately thrown away: a billboard
       that also honoured the instance's random tilt would lean out of the
       screen plane and shrink. */
    sh.vertexShader = 'varying float vNatD;\n' + sh.vertexShader
      .replace('#include <begin_vertex>', [
        '  vec3 transformed = vec3(position);',
        '#ifdef USE_INSTANCING',
        '  mat4 natM = modelMatrix * instanceMatrix;',
        '#else',
        '  mat4 natM = modelMatrix;',
        '#endif',
        '  vec3 natOrg = natM[3].xyz;',
        '  float natSX = length(natM[0].xyz);',
        '  float natSY = length(natM[1].xyz);',
        '  vec3 natToCam = cameraPosition - natOrg;',
        '  natToCam.y = 0.0;',
        '  float natLen = length(natToCam);',
        '  vec3 natRight = natLen > 0.0001 ? normalize(vec3(natToCam.z, 0.0, -natToCam.x)) : vec3(1.0, 0.0, 0.0);',
        '  vec3 natWP = natOrg + natRight * (position.x * natSX) + vec3(0.0, position.y * natSY, 0.0);',
        '  vNatD = distance(cameraPosition, natOrg);'
      ].join('\n'))
      .replace('#include <project_vertex>', [
        '  vec4 mvPosition = viewMatrix * vec4(natWP, 1.0);',
        '  gl_Position = projectionMatrix * mvPosition;'
      ].join('\n'));
    sh.fragmentShader = NATURE_BAYER_GLSL +
      sh.fragmentShader.replace('#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\n' + natureBandGLSL(band));
  };
  m.customProgramCacheKey = function () { return 'nature-impostor|' + band.key; };
  _impMat.push({ tex: tex, band: band, mat: m });
  return m;
}

/* ------------------------------------------------- hand-written geometry
   The procedural trees in props.js are one merged, vertex-coloured
   BufferGeometry with one material, and they had no far LOD at all: six
   hundred of them, two thousand triangles each, drawn at full detail from
   any distance right out to the edge of the plate. bakeGeoImpostors gives
   them the same treatment the modelled props already had - a photograph of
   the real thing, taken with the real material under the real lights.

   items: [{ geo, mat }]  ->  { tex, imps: [...] } or null */
function bakeGeoImpostors(items) {
  return bakeImpostorSet(items.map(function (it) {
    if (!it.geo.boundingBox) { it.geo.computeBoundingBox(); }
    return {
      box: it.geo.boundingBox,
      meshes: function () { return [new THREE.Mesh(it.geo, it.mat)]; }
    };
  }));
}

export { NATURE_BANDS, LOD_BANDS, LOD_K, LOD_RUNGS, propExtent, rungFor, rungForProp,
  rungForGeometry, setNatureLODScale, NATURE_BAYER_GLSL, patchNatureShader, NATURE_DIR, NATURE_PROPS, NATURE_TEX, bakeGeoImpostors, bakeImpostorSet, buildNatureImpostors, getGLTFLoaderClass, impostorGeometry, loadModel, natureBandGLSL, natureImpostorMaterial, natureLibrary, natureMaterial, natureSwapImpostors, natureTexture, preloadNature };
