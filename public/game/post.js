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
      uHazeDens: { value: 0.00060 },
      uHazeCol: { value: new THREE.Color(0.800, 0.892, 0.972) },
      uHazeSun: { value: new THREE.Color(0.985, 0.938, 0.842) }
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
      '    vec3 hz = mix(uHazeSun, uHazeCol, smoothstep(0.06, 0.60, distance(vUv, uSunUV)));',
      '    c = mix(c, hz, clamp(a, 0.0, 1.0));',
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
      '  float sat = mix(1.06, 0.78, gW);',
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
      '  c += vec3(-0.032, 0.006,  0.078) * gW * shdW;',
      '',
      '  /* split tone: sunlight goes gold, shadow goes blue. This single',
      '     step does more for the anime feel than anything else here. */',
      '  vec3 warm = vec3(1.045, 1.005, 0.930);',
      '  vec3 cool = vec3(0.930, 0.972, 1.075);',
      '  c *= mix(cool, warm, smoothstep(0.18, 0.78, l2));',
      '',
      '  /* a breath of sky bounce in the darkest places, never pure black.',
      '     After the split tone so the multiply cannot scale it away. */',
      '  c += vec3(0.010, 0.016, 0.030) * shdW;',
      '',
      '  float d = length(vUv - 0.5);',
      '  c *= mix(0.82, 1.0, smoothstep(1.02, 0.30, d));',
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
 *  LOW / MEDIUM / HIGH together control render scale, shadows, the bloom /
 *  god-ray chain, and (via grass.js reading getTier()) grass density and
 *  draw distance. HIGH reproduces the exact numbers this file shipped with
 *  before tiers existed - nothing changes for a machine that can afford it.
 * ======================================================================== */

var TIERS = {
  /* The 3D is drawn slightly under native and the FINAL image is not: the
     composite pass writes to the real framebuffer at 100%, and every piece
     of interface - the title, the chat, the touch controls, the settings
     panel - is HTML sitting above the canvas and never goes through this at
     all. So the text stays pin-sharp while the world behind it is drawn
     with about a fifth fewer pixels.
     Starting at 1.00 meant the phone opened at the desktop's exact cost and
     only backed off after it had already stuttered - which is the part you
     actually feel. minScale is still the floor autoQuality() may fall to
     once it has watched real frame times.
     Every value stays above 0.85, which is the threshold makeTargets() uses
     to decide whether the scene buffer gets multisampling: dropping under it
     would silently trade smooth edges for speed, and that was not asked for. */
  LOW: { renderScale: 0.86, minScale: 0.62, shadows: false, bloom: true, lod: 0.72 },
  MEDIUM: { renderScale: 0.88, minScale: 0.70, shadows: false, bloom: true, lod: 0.85 },
  HIGH: { renderScale: 0.90, minScale: 0.78, shadows: false, bloom: true, lod: 0.92 }
};

var currentTier = 'HIGH', bloomOn = true, shadowsOn = false;

/* Shadows are gone from the whole game - see initEngine() in core.js, where
   the light is told not to cast and the renderer's shadow map is switched
   off. This is kept as a no-op rather than deleted because applyTier() and
   the perf HUD still ask about it, and a function that always answers "off"
   is clearer than three call sites that have to remember there is no answer. */
function setShadows() {
  shadowsOn = false;
  renderer.shadowMap.enabled = false;
}

/* Best-effort hardware read. Every signal here is optional and allowed to
   be missing (privacy settings strip WEBGL_debug_renderer_info in a lot of
   browsers now) - the function always falls back to a reasonable guess
   rather than throwing or defaulting to the most expensive tier. */
function detectTier() {
  var coarsePointer = false;
  try { coarsePointer = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (e) { /* ignore */ }

  var cores = navigator.hardwareConcurrency || 0;

  var gpuKnown = false, weakGPU = false, strongGPU = false;
  try {
    var gl = renderer.getContext();
    var dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) {
      var str = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '').toLowerCase();
      if (str) {
        gpuKnown = true;
        strongGPU = /(rtx|gtx 16|gtx 10|radeon rx|arc a[57]|apple m[1-9])/.test(str);
        weakGPU = /(intel|uhd|iris|radeon(?! rx)|vega|mali|adreno|powervr|swiftshader|llvmpipe|apple gpu)/.test(str) && !strongGPU;
      }
    }
  } catch (e) { /* ignore - treat as unknown */ }

  /* phones/tablets: mobile GPUs are fill-rate limited even more than the
     integrated-graphics laptop this game targets, and touch play is always
     landscape at a smaller framebuffer than desktop - start conservative */
  if (coarsePointer) { return 'LOW'; }
  if (weakGPU) { return 'LOW'; }
  if (!gpuKnown && cores > 0 && cores <= 4) { return 'LOW'; }
  if (!gpuKnown && cores === 0) { return 'MEDIUM'; } /* nothing to go on: safe middle default */
  if (strongGPU || cores >= 8) { return 'HIGH'; }
  return 'MEDIUM';
}

function applyTier(name) {
  var t = TIERS[name] || TIERS.HIGH;
  currentTier = TIERS[name] ? name : 'HIGH';
  renderScale = t.renderScale;
  bloomOn = t.bloom;
  setShadows();
  /* only rebuild render targets if post is already set up (setupPost may
     not have run yet when this is called right after initEngine) */
  if (rtScene) { applyRenderScale(); }
  return currentTier;
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
  return applyTier(detectTier());
}

/* ======================================================================== *
 *  POST CHAIN
 *  6 full-screen passes on HIGH/MEDIUM: scene, bright-extract, god-rays (or
 *  a cheap swap when the sun is off-screen), blur H, blur V, composite.
 *  On LOW, bloomOn is false and everything but the composite is skipped -
 *  that removes 4 of those passes (or all 5 taps of the god-ray loop, which
 *  is by far the most expensive one) at essentially zero visual cost, since
 *  bloom on this art style is a polish layer, not the base look.
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
 *  PERF HUD - F3 toggles a readout built from renderer.info. There was
 *  previously no way to measure any of this; every optimisation before this
 *  was a guess (one of them, cutting the camera far plane, deleted the sky).
 * ======================================================================== */

var hudEl = null, hudOn = false;
var hudAcc = 0, hudN = 0, hudFps = 0;

function ensureHUD() {
  if (hudEl) { return; }
  hudEl = document.createElement('div');
  hudEl.id = 'perfHud';
  hudEl.style.cssText = [
    'position:fixed', 'top:8px', 'left:8px', 'z-index:9999',
    'background:rgba(0,0,0,0.6)', 'color:#a6f5a6', 'font:12px/1.5 monospace',
    'padding:8px 12px', 'border-radius:4px', 'pointer-events:none',
    'white-space:pre', 'display:none'
  ].join(';');
  document.body.appendChild(hudEl);
  window.addEventListener('keydown', function (e) {
    if (e.key === 'F3' || e.code === 'F3') {
      hudOn = !hudOn;
      hudEl.style.display = hudOn ? 'block' : 'none';
      e.preventDefault();
    }
  });
}

/* Call exactly once per animate() frame, after renderFrame() has issued all
   of that frame's render() calls. Reads renderer.info for the frame just
   drawn, then resets it so the next frame starts from zero (autoReset is
   false - see setupPost - because a single frame here is 6 render() calls
   and we want the HUD to show their total, not just the last pass). */
function updatePerfHUD(dt) {
  ensureHUD();
  hudAcc += dt; hudN++;
  if (hudOn) {
    if (hudAcc >= 0.25) {
      hudFps = Math.round(hudN / hudAcc);
      hudAcc = 0; hudN = 0;
    }
    var info = renderer.info;
    hudEl.textContent =
      'FPS       ' + hudFps + '  (' + (dt * 1000).toFixed(1) + ' ms)\n' +
      'draw calls ' + info.render.calls + '\n' +
      'triangles  ' + info.render.triangles + '\n' +
      'tier       ' + currentTier + '\n' +
      'render scl ' + renderScale.toFixed(2) + '\n' +
      'shadows    ' + (shadowsOn ? 'on' : 'off') + '\n' +
      'bloom      ' + (bloomOn ? 'on' : 'off') + '\n' +
      '[F3 to hide]';
  }
  renderer.info.reset();
}

function onResize() {
  var w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  applyRenderScale();
}

function applyRenderScale() {
  var pr = renderer.getPixelRatio();
  makeTargets(Math.max(64, Math.floor(window.innerWidth * pr * renderScale)),
              Math.max(64, Math.floor(window.innerHeight * pr * renderScale)));
}

var frameAcc = 0, frameN = 0, adjustments = 0;

/* How many frames to watch before acting. The shipped figure was 55 for
   every decision, and 55 frames on a phone that is running at 20 fps is
   nearly three seconds - times three or four steps before the render scale
   reaches a size the device can hold. That is the "it feels very laggy"
   window, and it was spent measuring something the first second had already
   made obvious.

   The first few judgements are made on a much shorter sample and the window
   widens as it settles, which is the usual shape for this kind of governor:
   quick to find the right ballpark, slow and steady afterwards so it cannot
   oscillate. Nothing about the steady state changes - the tiers, the floors
   and the order things are given up in are all untouched. */
function sampleFrames() {
  return adjustments < 1 ? 18 : (adjustments < 3 ? 30 : 55);
}

function autoQuality(dt) {
  frameAcc += dt; frameN++;
  if (frameN < sampleFrames()) { return; }
  var avg = frameAcc / frameN;
  frameAcc = 0; frameN = 0;
  var tierCfg = TIERS[currentTier] || TIERS.HIGH;
  if (avg > 0.0225) {
    adjustments++;
    if (renderScale > tierCfg.minScale) {
      /* Step in proportion to how far over budget the frame actually is,
         instead of always shaving the same 0.13. A device at 45 ms/frame
         needs the whole way down and used to get there in four separate
         waits; one at 24 ms needs a nudge and now gets a nudge. */
      var over = clamp(avg / 0.0225 - 1, 0, 1);
      renderScale = Math.max(tierCfg.minScale, renderScale - (0.10 + 0.22 * over));
      applyRenderScale();
    } else if (bloomOn && avg > 0.030) {
      /* last resort: render scale is already at this tier's floor and
         shadows are already off, and it is STILL not holding the frame
         budget. Drop the whole bloom/god-ray chain - several full-screen
         passes, and the god-ray loop alone is a 14-tap blur - rather than
         degrade resolution further into visibly blurry territory. */
      bloomOn = false;
    }
  } else if (avg < 0.0132 && renderScale < tierCfg.renderScale) {
    renderScale = Math.min(tierCfg.renderScale, renderScale + 0.09);
    applyRenderScale();
  }
}

/* the blur pass ping-pongs between the two half-size targets */
function swapTargets() { var t = rtA; rtA = rtB; rtB = t; }

export { swapTargets, TIERS, getLODScale, VERT_FS, applyPostFX, applyRenderScale, applyTier, autoQuality, bloomOn, detectTier, frameAcc, frameN, fsCam, fsPass, fsQuad, fsScene, getTier, initQuality, mBlur, mBright, mComp, mRays, makeTargets, onResize, renderScale, rtA, rtB, rtScene, setShadows, setupPost, shadowsOn, updatePerfHUD };
