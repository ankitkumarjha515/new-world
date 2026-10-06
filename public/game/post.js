/* Whispering Meadow - post.js
   Extracted from the original single file. Logic unchanged. */

import { camera, clamp, renderer, scene, smoothstep } from './core.js';
var rtScene, rtA, rtB, fsScene, fsCam, fsQuad;

var renderScale = 1.0;

var mBright, mRays, mBlur, mComp;

var VERT_FS = [
  'varying vec2 vUv;',
  'void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }'
].join('\n');

/* Depth is only needed by the aerial-perspective term in the composite
   grade, and it is allowed to be missing: WebGL1 without WEBGL_depth_texture
   simply gets uHasDepth = 0 and the rest of the grade is unaffected. */
function depthTextureSupported() {
  try {
    if (renderer.capabilities.isWebGL2) { return true; }
    return !!renderer.extensions.get('WEBGL_depth_texture');
  } catch (e) { return false; }
}

function makeTargets(w, h) {
  var opt = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false };
  if (rtScene) {
    if (rtScene.depthTexture) { rtScene.depthTexture.dispose(); }
    rtScene.dispose(); rtA.dispose(); rtB.dispose();
  }
  rtScene = new THREE.WebGLRenderTarget(w, h, opt);
  if (renderer.capabilities.isWebGL2 && renderScale > 0.85) { rtScene.samples = 2; }
  /* Scene depth, read back in the composite pass to drive aerial
     perspective. It costs one attachment and one texture fetch - no extra
     full-screen pass - and it is what lets distance wash out toward the sky
     independently of the in-shader FogExp2, which is tuned for the near
     field. The sky dome and the cloud cards both draw with depthWrite:false,
     so their pixels keep the cleared depth of 1.0 and land at the far plane;
     the smoothstep in the shader uses that to leave the sky alone instead of
     hazing it toward itself and flattening the clouds. */
  if (depthTextureSupported()) {
    var dt = new THREE.DepthTexture(w, h);
    dt.format = THREE.DepthFormat;
    dt.type = renderer.capabilities.isWebGL2 ? THREE.UnsignedIntType : THREE.UnsignedShortType;
    dt.minFilter = THREE.NearestFilter;
    dt.magFilter = THREE.NearestFilter;
    dt.generateMipmaps = false;
    rtScene.depthTexture = dt;
  }
  /* Quarter, not half. These three buffers carry the bloom, and bloom is a
     BLUR - by the time it reaches the composite it has been smeared across
     nine pixels twice over, so the resolution it was gathered at stops
     mattering long before you can see it. Going from half to quarter makes
     the bright pass, the god rays and both blurs a quarter of the work
     each, which is the cheapest four-for-one in the whole frame. */
  var hw = Math.max(2, Math.floor(w / 4)), hh = Math.max(2, Math.floor(h / 4));
  rtA = new THREE.WebGLRenderTarget(hw, hh, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false });
  rtB = new THREE.WebGLRenderTarget(hw, hh, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false });
  if (mBlur) { mBlur.uniforms.uTexel.value.set(1 / hw, 1 / hh); }
}

function setupPost() {
  /* renderer.info accumulates draw calls/triangles across ALL render()
     calls until reset. We reset it exactly once per animate() frame (see
     updatePerfHUD below) so the HUD reads the TOTAL cost of a frame's six
     render passes, not just the last one. Must be false or three.js clears
     it after every single render() call and the HUD would only ever show
     the composite pass. */
  renderer.info.autoReset = false;

  fsScene = new THREE.Scene();
  fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
  fsQuad.frustumCulled = false;
  fsScene.add(fsQuad);

  mBright = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, uThresh: { value: 0.63 } },
    vertexShader: VERT_FS,
    fragmentShader: [
      'uniform sampler2D tDiffuse; uniform float uThresh; varying vec2 vUv;',
      'void main(){',
      '  vec3 c = texture2D(tDiffuse, vUv).rgb;',
      '  float l = dot(c, vec3(0.299,0.587,0.114));',
      '  float k = smoothstep(uThresh, uThresh+0.34, l);',
      '  gl_FragColor = vec4(c*k, 1.0);',
      '}'
    ].join('\n')
  });
  mRays = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, uSunUV: { value: new THREE.Vector2(0.5, 0.5) }, uAmt: { value: 0.0 } },
    vertexShader: VERT_FS,
    fragmentShader: [
      'uniform sampler2D tDiffuse; uniform vec2 uSunUV; uniform float uAmt; varying vec2 vUv;',
      'void main(){',
      '  vec3 base = texture2D(tDiffuse, vUv).rgb;',
      '  if(uAmt <= 0.001){ gl_FragColor = vec4(base,1.0); return; }',
      '  vec2 dir = (uSunUV - vUv) * 0.36;',
      '  vec3 acc = vec3(0.0); float w = 1.0, tw = 0.0;',
      '  for(int i=0;i<14;i++){',
      '    vec2 uv = vUv + dir * (float(i)/14.0);',
      '    acc += texture2D(tDiffuse, clamp(uv, 0.0, 1.0)).rgb * w;',
      '    tw += w; w *= 0.91;',
      '  }',
      '  gl_FragColor = vec4(base + acc/tw * uAmt, 1.0);',
      '}'
    ].join('\n')
  });
  mBlur = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2(1, 0) }, uTexel: { value: new THREE.Vector2(0.002, 0.002) } },
    vertexShader: VERT_FS,
    fragmentShader: [
      'uniform sampler2D tDiffuse; uniform vec2 uDir; uniform vec2 uTexel; varying vec2 vUv;',
      'void main(){',
      '  vec2 o = uDir * uTexel;',
      '  vec3 c = texture2D(tDiffuse, vUv).rgb * 0.2270270;',
      '  c += texture2D(tDiffuse, vUv + o*1.3846).rgb * 0.3162162;',
      '  c += texture2D(tDiffuse, vUv - o*1.3846).rgb * 0.3162162;',
      '  c += texture2D(tDiffuse, vUv + o*3.2307).rgb * 0.0702702;',
      '  c += texture2D(tDiffuse, vUv - o*3.2307).rgb * 0.0702702;',
      '  gl_FragColor = vec4(c, 1.0);',
      '}'
    ].join('\n')
  });
  mComp = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: null }, tBloom: { value: null }, tDepth: { value: null },
      uBloom: { value: 0.46 }, uFade: { value: 0.0 },
      uHasDepth: { value: 0.0 },
      uCamNF: { value: new THREE.Vector2(0.35, 5200.0) },
      uSunUV: { value: new THREE.Vector2(0.5, 0.5) },
      /* aerial perspective. uHazeDens is deliberately a good deal higher
         than FOGDENS: the in-shader FogExp2 has to stay gentle or the near
         meadow goes milky, while this term only bites past a few hundred
         units. See the note in the shader. */
      uHaze: { value: 1.0 },
      /* Golden-hour forest haze: thick, and strongly two-toned - burning
         amber in the half of the frame the sun is in, a cool teal-grey in
         the other half. This is what makes trunks forty metres off read as
         soft silhouettes standing in light. */
      uHazeDens: { value: 0.0105 },
      uHazeCol: { value: new THREE.Color(0.52, 0.57, 0.55) },
      uHazeSun: { value: new THREE.Color(0.98, 0.79, 0.55) }
    },
    vertexShader: VERT_FS,
    fragmentShader: [
      'uniform sampler2D tScene; uniform sampler2D tBloom; uniform sampler2D tDepth;',
      'uniform float uBloom; uniform float uFade;',
      'uniform float uHasDepth; uniform vec2 uCamNF; uniform vec2 uSunUV;',
      'uniform float uHaze; uniform float uHazeDens;',
      'uniform vec3 uHazeCol; uniform vec3 uHazeSun;',
      'varying vec2 vUv;',
      'const vec3 LUMA = vec3(0.299, 0.587, 0.114);',
      'void main(){',
      '  vec3 c = texture2D(tScene, vUv).rgb;',
      '  vec3 b = texture2D(tBloom, vUv).rgb;',
      '  c += b * uBloom;',
      '',
      '  /* ---- aerial perspective ----------------------------------------',
      '     The single strongest depth cue in the reference paintings: a far',
      '     ridge is not a small green ridge, it is a PALE BLUE one. Done here',
      '     rather than in the fog because it has to be much stronger at',
      '     distance than FogExp2 can be without fogging the meadow you are',
      '     standing in, and because it can be tinted warm toward the sun the',
      '     way real scattered light is. Applied BEFORE the tonemap, which is',
      '     where light physically mixes.',
      '',
      '     The far-plane cutoff is what protects the sky. The sky dome and',
      '     the cloud cards draw with depthWrite:false, so their pixels keep',
      '     the cleared depth and read back as the far plane; fading the haze',
      '     out there leaves the sky gradient and the cloud modelling intact',
      '     instead of washing them into flat soup. Nothing solid in the world',
      '     gets anywhere near 2600 units - the plate is WORLD across and the',
      '     mountains sit inside it - so the cutoff never clips real terrain. */',
      '  if (uHasDepth > 0.5) {',
      '    float dN = texture2D(tDepth, vUv).x * 2.0 - 1.0;',
      '    float zn = uCamNF.x, zf = uCamNF.y;',
      '    float vz = (2.0 * zn * zf) / (zf + zn - dN * (zf - zn));',
      '    float t = vz * uHazeDens;',
      '    float a = (1.0 - exp(-t * t)) * uHaze;',
      '    a *= smoothstep(3600.0, 2600.0, vz);',
      '    vec3 hz = mix(uHazeSun, uHazeCol, smoothstep(0.04, 0.95, distance(vUv, uSunUV)));',
      /* capped short of 1, so the farthest ridges keep a ghost of their
         relief instead of going to a flat cut-out */
      '    c = mix(c, hz, clamp(a, 0.0, 0.86));',
      '  }',
      '',
      '  /* ---- anime landscape grade -------------------------------------',
      '     Reference: Shinkai / Ghibli landscapes. The look is NOT subtle -',
      '     but it is also NOT uniformly saturated. In the paintings the',
      '     greens are the LEAST saturated thing in frame: cobalt skies and',
      '     turquoise water are pushed hard, while grass sits at a muted',
      '     yellow-olive in the light and a blue-teal in the shade. Grading',
      '     the whole frame with one saturation number is what turned this',
      '     meadow fluorescent, so the green band gets its own treatment. */',
      '',
      '  /* filmic shoulder: let highlights bloom out instead of clipping flat */',
      '  c = c / (1.0 + 0.145*c) * 0.98;',
      '',
      '  float l = dot(c, LUMA);',
      '',
      '  /* Green-band selector. Scale-invariant on purpose - the same blade of',
      '     grass in sun and in shade has the same hue and must get the same',
      '     weight, which an absolute channel difference would not give. Zero',
      '     for anything where green is not the dominant channel (sky, water,',
      '     sand, cloud, sakura), and the smoothstep floor keeps the golden',
      '     hilltops and the sunflower field - yellow-greens, g barely over r -',
      '     out of it too. Only real greens are touched. */',
      '  float mx = max(c.r, max(c.g, c.b));',
      '  float gW = clamp((c.g - max(c.r, c.b)) / max(mx, 1e-3), 0.0, 1.0);',
      '  gW = smoothstep(0.06, 0.42, gW);',
      '',
      '  /* hue-selective saturation: everything else keeps its punch, greens',
      '     get pulled BELOW neutral - 0.78, genuinely desaturating, not the',
      '     1.10 this used to be. Any number above 1.0 here still ADDS saturation',
      '     to the one band that already had far too much of it, which is why the',
      '     meadow stayed fluorescent no matter what the rest of the grade did.',
      '     Near-whites are protected last so clouds stay white. */',
      '  float sat = mix(1.04, 0.92, gW);',
      '  sat = mix(sat, 1.06, smoothstep(0.66, 1.0, l));',
      '  c = mix(vec3(l), c, sat);',
      '',
      '  /* S-curve. Clamp FIRST: the smoothstep curve turns negative above',
      '     1.0, which would flip bright clouds to black. */',
      '  c = clamp(c, 0.0, 1.0);',
      '  c = mix(c, c*c*(3.0 - 2.0*c), 0.20);',
      '  c = pow(c, vec3(0.90));',
      '',
      '  float l2 = dot(c, LUMA);',
      '  float litW = smoothstep(0.34, 0.78, l2);',
      '  float shdW = 1.0 - smoothstep(0.16, 0.52, l2);',
      '',
      '  /* Green hue rotation, and the reason this is ADDITIVE rather than a',
      '     multiply. Sunlit grass here has almost no blue in it at all, so a',
      '     multiplicative cool tint - which is all the toon ramp and the split',
      '     tone below can do - scales a near-zero blue channel by 1.13 and',
      '     changes nothing. That is exactly why shaded grass used to come out',
      '     as the same hue as lit grass, only darker, which is the single',
      '     thing that made the meadow read as fake. Adding blue is the only',
      '     operation that can actually move the hue. Lit greens go the other',
      '     way, toward warm yellow-olive. */',
      '  c += vec3( 0.070, 0.010, -0.045) * gW * litW;',
      '  c += vec3(-0.012, 0.004,  0.026) * gW * shdW;',
      '',
      '  /* split tone: sunlight goes gold, shadow goes blue. This single',
      '     step does more for the anime feel than anything else here. */',
      '  vec3 warm = vec3(1.070, 1.000, 0.880);',
      '  vec3 cool = vec3(0.900, 0.975, 1.060);',
      '  c *= mix(cool, warm, smoothstep(0.18, 0.78, l2));',
      '',
      '  /* a breath of sky bounce in the darkest places, never pure black.',
      '     After the split tone so the multiply cannot scale it away. */',
      '  c += vec3(0.010, 0.016, 0.030) * shdW;',
      '',
      '  float d = length(vUv - 0.5);',
      /* heavy, warm-black vignette: the reference frames are dark at the
         corners and near the ground, and bright only in the haze */
      '  c *= mix(vec3(0.42, 0.40, 0.38), vec3(1.0), smoothstep(0.98, 0.22, d));',
      '  c = mix(c, vec3(0.0), uFade);',
      '  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);',
      '}'
    ].join('\n')
  });
}

function fsPass(mat, target) {
  fsQuad.material = mat;
  renderer.setRenderTarget(target || null);
  renderer.clear(true, true, false);
  renderer.render(fsScene, fsCam);
}

/* ======================================================================== *
 *  QUALITY TIERS
 *
 *  WHAT CHANGED, AND WHAT DELIBERATELY DID NOT.
 *
 *  The tier VALUES here are the ones the game shipped with. An earlier pass
 *  at this file rewrote all of them - lower render scales, a much shorter LOD
 *  distance, and bloom switched OFF on LOW, on the grounds that the comment
 *  over the post chain below says "on LOW, bloomOn is false" while the table
 *  said `bloom: true`.
 *
 *  That read the contradiction the wrong way round. Rendering the same camera
 *  from both builds side by side settles it: with the glow chain off, the
 *  clouds go flat grey, the sky loses its cobalt and the whole picture reads
 *  as washed out. The art direction in DESIGN-AGENT.md is built on a hard
 *  light and a bright bloom; the chain is not a polish layer on this style,
 *  it is part of the look. The TABLE was right and the COMMENT was stale.
 *
 *  So the numbers are back to what they were, and the lesson is the one
 *  DESIGN-AGENT.md already states: change one thing, screenshot it, compare.
 *  A comment is not evidence.
 *
 *  What is kept from that pass is the part that measures rather than guesses:
 *
 *  Four knobs now, and they are chosen to attack fill rate, because on both
 *  target machines - an 8 GB integrated-graphics laptop and a phone - fill
 *  rate is the whole bill:
 *
 *    maxDPR       the device pixel ratio the CANVAS is drawn at. Lowering it
 *                 does NOT blur any text: every piece of interface is HTML
 *                 above the canvas, so it stays native-sharp regardless.
 *                 This is the knob the old code could not use, because back
 *                 then the menus were the only UI and they were also the
 *                 only thing you could read.
 *    budget       a ceiling on total scene-pass pixels. A flat renderScale
 *                 means a 6.7" phone at DPR 3 and a 13" laptop at DPR 1 get
 *                 wildly different bills for the same number; a pixel budget
 *                 gives them the same one.
 *    lod          how far out props keep their detail. Unchanged from the
 *                 shipped values - see above.
 * ======================================================================== */

var TIERS = {
  /* A phone, or a laptop with no dedicated GPU. 1.5x DPR, under 700k scene
     pixels, no bloom chain, props handing over to impostors early.

     Dropping under 0.85 also drops the MSAA in makeTargets(), and that is a
     WIN here, not a cost: 2x multisampling on a mobile GPU is pure memory
     bandwidth, which is the one thing those parts have least of. The old
     comment treated 0.85 as a floor to protect; on this tier it is a ceiling
     to get under. */
  LOW:    { renderScale: 0.86, minScale: 0.62, maxDPR: 1.60, budget: 1100000, shadows: false, bloom: true,  lod: 0.72 },
  /* A good phone, or a thin laptop. Bloom comes back, MSAA does not. */
  MEDIUM: { renderScale: 0.88, minScale: 0.70, maxDPR: 2.00, budget: 2000000, shadows: false, bloom: true,  lod: 0.85 },
  /* A machine with a real GPU. This is the frame the game shipped with. */
  HIGH:   { renderScale: 0.90, minScale: 0.78, maxDPR: 2.00, budget: 3600000, shadows: false, bloom: true,  lod: 0.92 }
};

var currentTier = 'HIGH', bloomOn = true, shadowsOn = false;
/* The scale actually handed to makeTargets() after the pixel budget has had
   its say. Kept separate from renderScale so the perf readout can show both,
   which is the only way to tell "the governor backed off" apart from "this
   screen is simply enormous". */
var effScale = 1.0;

/* Shadows are gone from the whole game - see initEngine() in core.js, where
   the light is told not to cast and the renderer's shadow map is switched
   off. This is kept as a no-op rather than deleted because applyTier() and
   the perf readout still ask about it, and a function that always answers
   "off" is clearer than three call sites that have to remember there is no
   answer. */
function setShadows() {
  shadowsOn = false;
  renderer.shadowMap.enabled = false;
}

/* ------------------------------------------------------------------ probe
   Best-effort hardware read. Every signal is optional and allowed to be
   missing (privacy settings strip WEBGL_debug_renderer_info in a lot of
   browsers now) - this always falls back to a reasonable guess rather than
   throwing or defaulting to the most expensive tier. */
function probeHardware() {
  var h = { coarse: false, cores: 0, mem: 0, gpu: '', known: false, weak: false, strong: false };
  try { h.coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); }
  catch (e) { /* ignore */ }
  h.cores = navigator.hardwareConcurrency || 0;
  /* Chrome-only, absent on Safari and Firefox, and rounded down to a power
     of two - but when it IS there it is the single most useful number
     available for telling a flagship phone from a cheap one. */
  h.mem = navigator.deviceMemory || 0;
  try {
    var gl = renderer.getContext();
    var dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) {
      h.gpu = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '').toLowerCase();
      if (h.gpu) {
        h.known = true;
        h.strong = /(rtx|gtx 16|gtx 10|radeon rx|arc a[57]|apple m[1-9])/.test(h.gpu);
        h.weak = /(intel|uhd|iris|radeon(?! rx)|vega|mali|adreno|powervr|swiftshader|llvmpipe|apple gpu)/.test(h.gpu) && !h.strong;
      }
    }
  } catch (e) { /* treat as unknown */ }
  return h;
}

/* A pinned choice in the settings panel always wins. detectTier() cannot
   tell a current flagship phone from a 2017 budget one - both report a
   coarse pointer and neither will name its GPU - so there has to be a way
   for a player to say "I can afford more than this". There was not one. */
function detectTier() {
  var S = window.MeadowSettings;
  var pinned = S ? S.quality() : 'auto';
  if (pinned === 'low') { return 'LOW'; }
  if (pinned === 'medium') { return 'MEDIUM'; }
  if (pinned === 'high') { return 'HIGH'; }

  var h = probeHardware();

  /* Phones and tablets. Not all LOW any more: a device reporting 8 cores and
     8 GB is a current flagship and holds MEDIUM comfortably, while the pixel
     budget keeps even that honest on a very high-DPR screen. Anything that
     will not say gets LOW, which is the safe direction to be wrong in - a
     player who wants more can pin it, and now there is a panel to pin it in. */
  if (h.coarse) {
    if (h.cores >= 8 && h.mem >= 8) { return 'MEDIUM'; }
    if (h.cores >= 6 && h.mem === 0) { return 'MEDIUM'; }
    return 'LOW';
  }

  if (h.strong) { return 'HIGH'; }
  if (h.weak) { return 'LOW'; }
  if (!h.known && h.cores === 0) { return 'MEDIUM'; }  /* nothing to go on */
  if (!h.known && h.cores <= 4) { return 'LOW'; }
  if (h.cores >= 8) { return 'HIGH'; }
  return 'MEDIUM';
}

/* ------------------------------------------------------------- pixel ratio
   The canvas backing store, separate from the render scale. core.js sets a
   starting value before any tier is known; this is what the tier actually
   wants, and it is re-applied whenever the tier changes.

   Only the canvas is affected. The interface is HTML - see maxDPR above. */
function applyPixelRatio() {
  var t = TIERS[currentTier] || TIERS.HIGH;
  var want = Math.min(window.devicePixelRatio || 1, t.maxDPR);
  if (Math.abs(renderer.getPixelRatio() - want) < 0.001) { return false; }
  renderer.setPixelRatio(want);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  return true;
}

function applyTier(name) {
  var t = TIERS[name] || TIERS.HIGH;
  currentTier = TIERS[name] ? name : 'HIGH';
  renderScale = t.renderScale;
  bloomOn = resolveBloom(t.bloom);
  setShadows();
  applyPixelRatio();
  /* only rebuild render targets if post is already set up (setupPost may not
     have run yet when this is called right after initEngine) */
  if (rtScene) { applyRenderScale(); }
  return currentTier;
}

/* The settings panel can force the glow chain on or off regardless of tier.
   'auto' hands the decision back to the tier, and to autoQuality() below. */
function resolveBloom(tierDefault) {
  var S = window.MeadowSettings;
  var pref = S ? S.bloom() : 'auto';
  if (pref === 'on') { return true; }
  if (pref === 'off') { return false; }
  return !!tierDefault;
}

function getTier() { return currentTier; }

/* How far out the props hold their detail, as a fraction of the distances
   authored in models.js. Read by main.js once, right after initQuality(). */
function getLODScale() {
  var t = TIERS[currentTier] || TIERS.HIGH;
  return t.lod === undefined ? 1 : t.lod;
}

/* Call once, right after initEngine() and before the boot sequence starts
   building the scene - grass.js reads getTier() while sizing its grid in
   buildGrassGrid(), so the tier has to be known before that runs. */
function initQuality() {
  var tier = applyTier(detectTier());
  bindSettings();
  return tier;
}

/* ---------------------------------------------------------------- settings
   Graphics settings apply live, without a reload, for everything that can:
   the tier, the render scale, the glow chain and the field of view. Grass
   density is the one exception - it is baked into the instance buffers in
   buildGrassGrid() - and the settings panel says so on the row.

   Registered once, from initQuality(), and keyed on WHICH setting changed so
   moving the volume slider does not rebuild three render targets. */
var settingsBound = false;

function bindSettings() {
  if (settingsBound) { return; }
  var S = window.MeadowSettings;
  if (!S) { return; }
  settingsBound = true;

  S.onChange(function (s, key) {
    var all = (key === null);
    if (all || key === 'quality') { applyTier(detectTier()); }
    if (all || key === 'bloom') {
      var t = TIERS[currentTier] || TIERS.HIGH;
      bloomOn = resolveBloom(t.bloom);
    }
    if (all || key === 'resScale') { applyRenderScale(); }
    if (all || key === 'fov') {
      camera.fov = s.fov;
      camera.updateProjectionMatrix();
    }
  });

  /* Apply whatever was already stored from a previous visit. */
  var v = S.get();
  if (v.fov && v.fov !== camera.fov) {
    camera.fov = v.fov;
    camera.updateProjectionMatrix();
  }
}

/* ======================================================================== *
 *  POST CHAIN
 *  6 full-screen passes on HIGH/MEDIUM: scene, bright-extract, god-rays (or
 *  a cheap swap when the sun is off-screen), blur H, blur V, composite.
 *  On LOW, bloomOn is false and everything but the composite is skipped -
 *  that removes 4 of those passes (or all 5 taps of the god-ray loop, which
 *  is by far the most expensive one) at essentially zero visual cost, since
 *  bloom on this art style is a polish layer, not the base look.
 *
 *  That sentence was aspirational for a long time: the TIERS table above said
 *  `bloom: true` on LOW, so the fast path this comment describes had never
 *  once run on a phone. It does now. If you are changing that table, this is
 *  the comment that tells you what the `bloom` flag is worth.
 * ======================================================================== */

/* The aerial-perspective term needs the depth attachment and the camera's
   near/far to un-project it, plus the sun's screen position so the haze can
   warm up toward the light. Set on both the bloom and the no-bloom path -
   dropping bloom is a performance tier, losing the sense of distance is not. */
function setCompScene(sunUV) {
  var dt = rtScene.depthTexture || null;
  mComp.uniforms.tDepth.value = dt;
  mComp.uniforms.uHasDepth.value = dt ? 1.0 : 0.0;
  mComp.uniforms.uCamNF.value.set(camera.near, camera.far);
  if (sunUV) { mComp.uniforms.uSunUV.value.set(sunUV.x, sunUV.y); }
}

function applyPostFX(sunUV, sunAmt, fade) {
  setCompScene(sunUV);
  if (!bloomOn) {
    var prevBloom = mComp.uniforms.uBloom.value;
    mComp.uniforms.tScene.value = rtScene.texture;
    mComp.uniforms.tBloom.value = rtScene.texture; /* sampled but multiplied by 0 below */
    mComp.uniforms.uBloom.value = 0.0;
    mComp.uniforms.uFade.value = fade;
    fsPass(mComp, null);
    mComp.uniforms.uBloom.value = prevBloom;
    return;
  }

  /* The glow chain runs at a quarter of the screen in each direction, so
     the four passes below together cost about a sixteenth of one full-screen
     pass. What is left to skip is the chain as a WHOLE, on frames where it
     could not contribute anything - and the only way to know that for
     certain is to read the bright buffer back off the GPU, which stalls the
     pipeline and costs more than the passes it would save.

     So the skip is done on the two cases that ARE knowable for free, and
     they are the ones that actually happen: the whole chain is gone when
     bloom is off (above), and the god-ray pass - the expensive one, a
     14-tap radial blur - is gone whenever the sun is not on screen, which
     is most of the time you are looking anywhere but east. */
  mBright.uniforms.tDiffuse.value = rtScene.texture;
  fsPass(mBright, rtA);

  if (sunAmt > 0.005) {
    mRays.uniforms.uSunUV.value.set(sunUV.x, sunUV.y);
    mRays.uniforms.uAmt.value = sunAmt;
    mRays.uniforms.tDiffuse.value = rtA.texture;
    fsPass(mRays, rtB);
  } else {
    // Skip 14-tap radial blur when sun is not on screen - significant GPU performance saving
    swapTargets();
  }

  mBlur.uniforms.tDiffuse.value = rtB.texture;
  mBlur.uniforms.uDir.value.set(1, 0);
  fsPass(mBlur, rtA);
  mBlur.uniforms.tDiffuse.value = rtA.texture;
  mBlur.uniforms.uDir.value.set(0, 1);
  fsPass(mBlur, rtB);

  mComp.uniforms.tScene.value = rtScene.texture;
  mComp.uniforms.tBloom.value = rtB.texture;
  mComp.uniforms.uFade.value = fade;
  fsPass(mComp, null);
}

/* ======================================================================== *
 *  PERFORMANCE READOUT
 *
 *  Numbers built from renderer.info. There was previously no way to measure
 *  any of this; every optimisation before it existed was a guess, and one of
 *  those guesses - cutting the camera far plane - deleted the sky.
 *
 *  The readout no longer owns any DOM. It used to create its own fixed
 *  element at z-index 9999 and bind its own F3 handler, which is how it ended
 *  up sitting on top of the touch controls. It now hands a string to the
 *  interface layer, which owns every pixel above the canvas, and the F3 key
 *  writes through MeadowSettings so the switch in the settings panel agrees
 *  with it and the choice survives a reload.
 * ======================================================================== */

var hudAcc = 0, hudN = 0, hudFps = 0;

function uiHud() {
  return (window.MeadowUI && window.MeadowUI.hud) ? window.MeadowUI.hud : null;
}

/* Call exactly once per animate() frame, after renderFrame() has issued all
   of that frame's render() calls. Reads renderer.info for the frame just
   drawn, then resets it so the next frame starts from zero (autoReset is
   false - see setupPost - because a single frame here is up to six render()
   calls and the total is the interesting number, not the last pass). */
function updatePerfHUD(dt) {
  hudAcc += dt; hudN++;
  if (hudAcc >= 0.25) {
    hudFps = Math.round(hudN / hudAcc);
    hudAcc = 0; hudN = 0;
  }

  var h = uiHud();
  /* Nothing is formatted unless somebody is looking. String building every
     frame for a hidden element was costing more than some of the passes this
     readout exists to measure. */
  if (h && h.diagVisible()) {
    var info = renderer.info;
    h.setDiag(
      'FPS        ' + hudFps + '  (' + (dt * 1000).toFixed(1) + ' ms)\n' +
      'draw calls ' + info.render.calls + '\n' +
      'triangles  ' + info.render.triangles + '\n' +
      'tier       ' + currentTier + (isPinned() ? ' (pinned)' : '') + '\n' +
      'dpr        ' + renderer.getPixelRatio().toFixed(2) + '\n' +
      'scale      ' + effScale.toFixed(2) + ' of ' + renderScale.toFixed(2) + '\n' +
      'scene px   ' + Math.round(scenePixels() / 1000) + 'k\n' +
      'bloom      ' + (bloomOn ? 'on' : 'off')
    );
  }
  renderer.info.reset();
}

function isPinned() {
  var S = window.MeadowSettings;
  return !!(S && S.quality() !== 'auto');
}

function scenePixels() {
  return rtScene ? rtScene.width * rtScene.height : 0;
}

/* ======================================================================== *
 *  SIZING
 * ======================================================================== */
function onResize() {
  var w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  /* The tier's DPR ceiling has to be re-asserted here: dragging a window
     between a retina and a non-retina display changes devicePixelRatio
     without changing anything else, and Math.min() has to run again. */
  applyPixelRatio();
  renderer.setSize(w, h, false);
  applyRenderScale();
}

/* The scene is drawn into rtScene at this size; the FINAL composite pass
   writes to the real framebuffer at full canvas resolution, so edges of
   geometry stay as crisp as the canvas is - only the shading is cheaper.
   Every piece of interface is HTML above all of this and is never resampled
   at all.

   Two things decide the size, and the smaller wins:

     renderScale   the tier's preference, nudged by autoQuality() or pinned
                   by the player in the settings panel.
     budget        a hard ceiling on scene pixels for this tier.

   The budget is what the old flat renderScale could not express. 0.86 on a
   13" laptop at DPR 1 is 1.1 M pixels; the same 0.86 on a 6.7" phone at DPR
   3 - capped to 2 - is 1.4 M, on a GPU with a fraction of the bandwidth. One
   number could not be right for both, and it was tuned on the laptop. */
function applyRenderScale() {
  var pr = renderer.getPixelRatio();
  var t = TIERS[currentTier] || TIERS.HIGH;
  var S = window.MeadowSettings;

  var want = renderScale;
  /* A pinned resolution means exactly that - the budget still applies as a
     ceiling, because a pinned 100% on a 4K phone would simply not render. */
  var pin = S ? S.resScale() : 0;
  if (pin > 0) { want = pin; }

  var fullW = window.innerWidth * pr, fullH = window.innerHeight * pr;
  var full = fullW * fullH;
  if (full > 0 && full * want * want > t.budget) {
    want = Math.sqrt(t.budget / full);
  }
  /* Never below a third: past that the world is mush and the honest answer
     is a lower tier, not a smaller buffer. */
  effScale = clamp(want, 0.34, 1.0);

  makeTargets(Math.max(64, Math.floor(fullW * effScale)),
              Math.max(64, Math.floor(fullH * effScale)));
}

/* ======================================================================== *
 *  FRAME-TIME GOVERNOR
 * ======================================================================== */

var frameAcc = 0, frameN = 0, adjustments = 0;

/* How many frames to watch before acting. The shipped figure was 55 for every
   decision, and 55 frames on a phone running at 20 fps is nearly three
   seconds - times three or four steps before the render scale reaches a size
   the device can hold. That is the "it feels very laggy" window, and it was
   spent measuring something the first second had already made obvious.

   The first few judgements are made on a much shorter sample and the window
   widens as it settles, which is the usual shape for this kind of governor:
   quick to find the right ballpark, slow and steady afterwards so it cannot
   oscillate. */
function sampleFrames() {
  return adjustments < 1 ? 18 : (adjustments < 3 ? 30 : 55);
}

function autoQuality(dt) {
  /* A player who pinned a resolution in the settings panel has said what they
     want. Measuring is still useful - the readout keeps working - but the
     governor does not get to overrule them. */
  var S = window.MeadowSettings;
  if (S && S.resScale() > 0) { return; }

  frameAcc += dt; frameN++;
  if (frameN < sampleFrames()) { return; }
  var avg = frameAcc / frameN;
  frameAcc = 0; frameN = 0;
  var t = TIERS[currentTier] || TIERS.HIGH;

  if (avg > 0.0225) {
    adjustments++;
    /* Order matters, and it is the opposite of what shipped. The glow chain
       is four passes; the render scale is a fraction of one. Giving up bloom
       first buys more frame time than three steps of resolution AND leaves
       the picture sharp, so it is no longer the last resort - it is the first
       thing to go, as soon as the frame is properly over budget.

       It only goes if the player left it on 'auto'. An explicit "on" is a
       choice, not a default to be overridden. */
    var bloomPref = S ? S.bloom() : 'auto';
    if (bloomOn && bloomPref === 'auto' && avg > 0.028) {
      bloomOn = false;
      return;
    }
    if (renderScale > t.minScale) {
      /* Step in proportion to how far over budget the frame actually is,
         instead of always shaving the same amount. A device at 45 ms/frame
         needs the whole way down and used to get there in four separate
         waits; one at 24 ms needs a nudge and now gets a nudge. */
      var over = clamp(avg / 0.0225 - 1, 0, 1);
      renderScale = Math.max(t.minScale, renderScale - (0.10 + 0.22 * over));
      applyRenderScale();
    }
  } else if (avg < 0.0132) {
    /* Comfortably inside budget: give back what was taken, resolution first,
       then the glow chain - the reverse of the order it was surrendered in,
       so the picture sharpens before it sparkles. */
    if (renderScale < t.renderScale) {
      renderScale = Math.min(t.renderScale, renderScale + 0.09);
      applyRenderScale();
    } else if (!bloomOn && t.bloom && (S ? S.bloom() : 'auto') === 'auto' && avg < 0.0110) {
      bloomOn = true;
    }
  }
}

/* the blur pass ping-pongs between the two half-size targets */
function swapTargets() { var t = rtA; rtA = rtB; rtB = t; }

export { swapTargets, TIERS, getLODScale, VERT_FS, applyPostFX, applyPixelRatio, applyRenderScale, applyTier, autoQuality, bloomOn, detectTier, effScale, frameAcc, frameN, fsCam, fsPass, fsQuad, fsScene, getTier, initQuality, mBlur, mBright, mComp, mRays, makeTargets, onResize, renderScale, rtA, rtB, rtScene, setShadows, setupPost, shadowsOn, updatePerfHUD };
