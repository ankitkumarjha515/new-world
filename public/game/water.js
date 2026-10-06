/* Whispering Meadow - water.js
   Extracted from the original single file. Logic unchanged. */

import { BROOK, GLSL_COMMON, HALF, PI, POOL, RIVER, TAU, WORLD, clamp, cliffZ, commonUniforms, fbm, lerp, scene, shaderMats, smoothstep, wallTop } from './core.js';
import { depthTex } from './terrain.js';
var oceanMesh, oceanMat, riverMat, poolMat, fallMat;

var GLSL_WAVES = [
  /* Four pure sine waves crossing at fixed angles make a perfectly periodic
     interference pattern - that is the square grid on the water. Fix: warp
     the sample position with noise first so it never repeats, and use
     wavelengths that are not simple multiples of one another. */
  /* GLSL_WAVES runs in the VERTEX shader, where GLSL_COMMON is not
     included, so the noise it needs is defined locally under w-prefixed
     names that cannot collide with the fragment-side copies. */
  'float wh21(vec2 p){ p = fract(p*vec2(123.34,345.45)); p += dot(p,p+34.345); return fract(p.x*p.y); }',
  'float wvn(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);',
  '  float a=wh21(i), b=wh21(i+vec2(1.0,0.0)), c=wh21(i+vec2(0.0,1.0)), d=wh21(i+vec2(1.0,1.0));',
  '  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y); }',
  'float wfbm(vec2 p){ float s=0.0,a=0.5; for(int i=0;i<3;i++){ s+=a*wvn(p); p=p*2.11+5.3; a*=0.5;} return s; }',
  'vec2 warp(vec2 p, float t){',
  '  float w1 = wvn(p*0.018 + vec2(t*0.05, -t*0.04));',
  '  float w2 = wvn(p*0.041 + vec2(-t*0.03, t*0.06) + 31.7);',
  '  return p + vec2(w1 - 0.5, w2 - 0.5) * 26.0;',
  '}',
  'void waveAt(vec2 pIn, float t, float amp, out float hgt, out vec2 der){',
  '  hgt = 0.0; der = vec2(0.0);',
  '  vec2 p = warp(pIn, t);',
  '  vec2 d1 = normalize(vec2(0.90, 0.44));',
  '  vec2 d2 = normalize(vec2(-0.31, 0.95));',
  '  vec2 d3 = normalize(vec2(0.67, -0.74));',
  '  vec2 d4 = normalize(vec2(0.19, 0.98));',
  '  float k1 = 6.2831/41.0, k2 = 6.2831/23.3, k3 = 6.2831/11.7, k4 = 6.2831/6.1;',
  '  float a1 = 0.70*amp, a2 = 0.36*amp, a3 = 0.15*amp, a4 = 0.055*amp;',
  '  float f1 = dot(p,d1)*k1 + t*1.05;  hgt += a1*sin(f1); der += a1*k1*cos(f1)*d1;',
  '  float f2 = dot(p,d2)*k2 + t*1.55;  hgt += a2*sin(f2); der += a2*k2*cos(f2)*d2;',
  '  float f3 = dot(p,d3)*k3 + t*2.30;  hgt += a3*sin(f3); der += a3*k3*cos(f3)*d3;',
  '  float f4 = dot(p,d4)*k4 + t*3.10;  hgt += a4*sin(f4); der += a4*k4*cos(f4)*d4;',
  '  float n = wfbm(p*0.09 + vec2(t*0.11, -t*0.08));',
  '  hgt += (n - 0.5) * amp * 0.42;',
  '}'
].join('\n');

function oceanGeometry(rings, segs, maxR) {
  var pos = [], idx = [], i, j;
  for (i = 0; i <= rings; i++) {
    var f = i / rings;
    var r = 0.8 + f * f * maxR;
    for (j = 0; j < segs; j++) {
      var a = j / segs * TAU;
      pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
    }
  }
  for (i = 0; i < rings; i++) {
    for (j = 0; j < segs; j++) {
      var j2 = (j + 1) % segs;
      var a0 = i * segs + j, b0 = i * segs + j2;
      var a1 = (i + 1) * segs + j, b1 = (i + 1) * segs + j2;
      idx.push(a0, a1, b0, b0, a1, b1);
    }
  }
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildOcean() {
  oceanMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
    uniforms: commonUniforms({
      uDepthMap: { value: depthTex },
      /* golden hour: the water reflects a warm, hazy sky, not midday blue */
      uDeep: { value: new THREE.Color(0x163c48) },
      uShallow: { value: new THREE.Color(0x3f8a84) },
      uSand: { value: new THREE.Color(0xa6936c) },
      uSkyLo: { value: new THREE.Color(0xe6c79a) },
      uSkyHi: { value: new THREE.Color(0x6f8f96) }
    }),
    vertexShader: [
      'uniform float uTime; uniform sampler2D uDepthMap;',
      'varying vec3 vWP; varying vec3 vN; varying float vDepth; varying float vCrest;',
      GLSL_WAVES,
      'void main(){',
      '  vec3 wp = (modelMatrix * vec4(position,1.0)).xyz;',
      '  vec2 duv = (wp.xz + ' + HALF.toFixed(1) + ') / ' + WORLD.toFixed(1) + ';',
      '  float inside = step(0.0,duv.x)*step(duv.x,1.0)*step(0.0,duv.y)*step(duv.y,1.0);',
      '  float land = texture2D(uDepthMap, clamp(duv, 0.001, 0.999)).r * 26.0 - 20.0;',
      '  land = mix(-20.0, land, inside);',
      '  float dep = max(0.0, -land);',
      '  float sh = clamp(dep/7.0, 0.0, 1.0);',
      '  float amp = 0.16 + 0.84*sh;',
      '  float hgt; vec2 der;',
      '  waveAt(wp.xz, uTime, amp, hgt, der);',
      '  wp.y += hgt;',
      '  vWP = wp; vDepth = dep; vCrest = hgt/max(amp,0.001);',
      '  vN = normalize(vec3(-der.x, 1.0, -der.y));',
      '  gl_Position = projectionMatrix * viewMatrix * vec4(wp,1.0);',
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uSand;',
      'uniform vec3 uSkyLo; uniform vec3 uSkyHi; uniform vec3 uSun; uniform vec3 uSunCol;',
      'uniform float uTime;',
      'varying vec3 vWP; varying vec3 vN; varying float vDepth; varying float vCrest;',
      GLSL_COMMON,
      'void main(){',
      '  vec3 V = normalize(cameraPosition - vWP);',
      '  vec3 N = normalize(vN);',
      '  vec3 S = normalize(uSun);',
      /* ripples on top of the big swells */
      '  float dist = length(cameraPosition - vWP);',
      /* The ripple field has a wavelength of under two world units. Past a
         couple of hundred units one screen pixel covers dozens of ripples, so
         a power-260 specular sampled through it stops being sunlight on water
         and becomes uncorrelated white dots - the flat band of TV static the
         sea had turned into. Fading the perturbation AND the tight highlight
         with distance is what a mip chain would do for a normal map, which is
         what this procedural normal has instead of one. Up close nothing
         changes: detail is 1.0 out to 90 units. */
      '  float detail = 1.0 - smoothstep(90.0, 430.0, dist);',
      /* ...and now it is SKIPPED, not merely faded. `detail` reaches zero at
         430 units, but the two noise fields it multiplies were still being
         evaluated all the way to the horizon - twenty-four noise lookups per
         pixel, over what can be half the screen when you face the sea,
         producing a contribution of exactly nothing. The branch is coherent
         (whole stretches of water are either near or far) and it is the
         single biggest saving available in this shader. */
      '  float rm = 0.5, r2d = 0.5;',
      '  if (detail > 0.002) {',
      '    vec2 rp = vWP.xz*0.55;',
      '    float r1 = fbm3(rp + vec2(uTime*0.55, uTime*0.28));',
      '    float r2 = fbm3(rp*2.3 - vec2(uTime*0.9, uTime*0.4));',
      '    rm = mix(0.5, r1*0.55 + r2*0.45, detail);',
      '    r2d = mix(0.5, r2, detail);',
      '    N = normalize(N + vec3((r1-0.5)*0.55, 0.0, (r2-0.5)*0.55) * detail);',
      '  }',
      '  float fres = pow(1.0 - max(dot(N,V), 0.0), 4.0);',
      '  fres = 0.045 + 0.90*fres;',
      '  vec3 R = reflect(-V, N);',
      '  vec3 skyc = mix(uSkyLo, uSkyHi, smoothstep(0.0, 0.55, R.y));',
      '  vec3 body = mix(uShallow, uDeep, smoothstep(0.6, 11.0, vDepth));',
      '  body = mix(uSand*0.85, body, smoothstep(0.0, 3.2, vDepth));',
      '  vec3 col = mix(body, skyc, fres);',
      /* sun glitter */
      '  float spec = pow(max(dot(R, S), 0.0), 260.0);',
      '  float glint = pow(max(dot(R, S), 0.0), 22.0) * (0.35 + 0.65*r2d);',
      /* the broad glint survives to the horizon - that is the sheet of light
         under the sun, and it belongs there. Only the pinpoint term goes. */
      '  col += uSunCol * (spec*2.4*detail + glint*0.28);',
      /* foam: along the shore, and on the wave crests */
      /* Shore foam only exists in the shallows. `bandn` shifts the band by
         at most 0.35, so past a depth of about 1.9 the smoothstep below is
         zero however the noise falls - and the open ocean, which is most of
         the water on screen, is far deeper than that. Another twelve noise
         lookups per pixel that were being spent to compute zero. */
      '  float shore = 0.0;',
      '  if (vDepth < 2.2) {',
      '    float bandn = fbm3(vec2(vWP.x*0.09, vWP.z*0.09) + vec2(uTime*0.12, -uTime*0.09));',
      '    shore = smoothstep(1.55, 0.02, vDepth - (bandn-0.5)*0.7);',
      '    shore *= 0.55 + 0.45*sin(vDepth*7.0 - uTime*2.2 + bandn*8.0);',
      '  }',
      '  float crest = smoothstep(0.62, 0.95, vCrest) * smoothstep(1.2, 5.0, vDepth) * (0.35+0.65*rm);',
      '  float foam = clamp(max(shore, crest*0.8), 0.0, 1.0);',
      '  foam *= 0.50 + 0.50*rm;',
      '  col = mix(col, vec3(0.97,0.99,1.0), foam*0.92);',
      '  col = applyFog(col, dist);',
      '  float alpha = clamp(0.40 + 0.60*smoothstep(0.0, 2.4, vDepth) + foam, 0.0, 1.0);',
      '  alpha = mix(alpha, 1.0, smoothstep(160.0, 700.0, dist));',
      '  gl_FragColor = vec4(col, alpha);',
      '}'
    ].join('\n')
  });
  oceanMesh = new THREE.Mesh(oceanGeometry(104, 92, 3000), oceanMat);
  oceanMesh.frustumCulled = false;
  oceanMesh.renderOrder = 6;
  scene.add(oceanMesh);
  shaderMats.push(oceanMat);
}

function calmWaterMaterial(flowSpeed, tint, edgeMode) {
  var m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
    uniforms: commonUniforms({
      uFlow: { value: flowSpeed },
      uTint: { value: new THREE.Color(tint) },
      uDeep: { value: new THREE.Color(0x1b4650) },
      uSkyLo: { value: new THREE.Color(0xe2c497) },
      uSkyHi: { value: new THREE.Color(0x6a8c94) },
      uEdge: { value: edgeMode }
    }),
    vertexShader: [
      'varying vec3 vWP; varying vec2 vUv;',
      'void main(){ vUv = uv; vWP = (modelMatrix*vec4(position,1.0)).xyz;',
      '  gl_Position = projectionMatrix * viewMatrix * vec4(vWP,1.0); }'
    ].join('\n'),
    fragmentShader: [
      'uniform float uTime; uniform float uFlow; uniform float uEdge;',
      'uniform vec3 uTint; uniform vec3 uDeep; uniform vec3 uSkyLo; uniform vec3 uSkyHi;',
      'uniform vec3 uSun; uniform vec3 uSunCol;',
      'varying vec3 vWP; varying vec2 vUv;',
      GLSL_COMMON,
      'void main(){',
      '  vec3 V = normalize(cameraPosition - vWP);',
      /* The river's flow pattern is a two-unit ripple. Beyond a couple of
         hundred metres one pixel spans dozens of them and the average is
         simply the noise's midpoint, so past that the six-octave pair is
         replaced by the constant it would have averaged to. Same picture,
         and the whole upper river stops being shaded twice over. */
      '  float rd = length(cameraPosition - vWP);',
      '  float rdet = 1.0 - smoothstep(120.0, 300.0, rd);',
      '  vec2 fp = vec2(vWP.x*0.30, vWP.z*0.30);',
      '  float t = uTime*uFlow;',
      /* sin/cos here produced the same square grid as the ocean did.
         fbm noise is organic and has no repeat. */
      '  float n1 = 0.5, n2 = 0.5;',
      '  if (rdet > 0.002) {',
      '    n1 = mix(0.5, fbm3(fp + vec2(0.0, -t*0.9)), rdet);',
      '    n2 = mix(0.5, fbm3(fp*2.1 + vec2(t*0.35, -t*1.7)), rdet);',
      '  }',
      '  vec3 N = normalize(vec3((n1-0.5)*1.5, 1.0, (n2-0.5)*1.5));',
      '  float fres = 0.05 + 0.85*pow(1.0 - max(dot(N,V),0.0), 4.0);',
      '  vec3 R = reflect(-V, N);',
      '  vec3 skyc = mix(uSkyLo, uSkyHi, smoothstep(0.0,0.55,R.y));',
      '  float edge;',
      '  if(uEdge > 0.5){ edge = 1.0 - smoothstep(0.62, 1.0, abs(vUv.x*2.0-1.0)); }',
      '  else { edge = 1.0 - smoothstep(0.76, 1.0, length(vUv-0.5)*2.0); }',
      /* two flat colour bands - lighter turquoise where it runs shallow near
         the banks, deep teal at mid-channel - a cel-shaded step instead of
         the old single smooth tint-to-deep gradient */
      '  float depthBand = step(0.45, edge);',
      '  vec3 shallowC = uTint * 1.18;',
      '  vec3 bodyFlat = mix(shallowC, uDeep, depthBand);',
      '  vec3 body = mix(bodyFlat, uDeep, 0.20*n1);',
      '  vec3 col = mix(body, skyc, fres);',
      '  col += uSunCol * pow(max(dot(R, normalize(uSun)),0.0), 190.0) * 1.7;',
      /* white water where the current breaks - snapped toward a hard step so
         it reads as banded foam rather than a soft smear */
      '  float brRaw = smoothstep(0.62, 0.92, n2) * smoothstep(0.35, 0.75, n1);',
      '  float br = step(0.5, brRaw) * 0.7 + brRaw * 0.3;',
      '  col = mix(col, vec3(0.95,0.99,1.0), br*0.35*uFlow);',
      /* thin cross-current riffle band, reusing n2 at a different threshold
         so no extra noise sample is needed */
      '  float riffle = smoothstep(0.70, 0.78, n2) * smoothstep(0.30, 0.60, n1);',
      '  col = mix(col, vec3(0.94,0.99,1.0), riffle*0.28*uFlow);',
      /* lace of foam along the banks */
      '  float lace = smoothstep(0.55, 0.98, 1.0-edge) * (0.4+0.6*n2);',
      '  col = mix(col, vec3(0.96,0.99,1.0), lace*0.55);',
      '  col = applyFog(col, rd);',
      '  gl_FragColor = vec4(col, clamp(edge,0.0,1.0)*0.93);',
      '}'
    ].join('\n')
  });
  shaderMats.push(m);
  return m;
}

function buildRibbon(path, segs, halfWidth, widthGain, yLift) {
  var pos = [], uvs = [], idx = [];
  var total = 0, i;
  var lens = [0];
  for (i = 0; i < path.length - 1; i++) {
    var dx = path[i + 1].x - path[i].x, dz = path[i + 1].z - path[i].z;
    total += Math.sqrt(dx * dx + dz * dz);
    lens.push(total);
  }
  function at(s) {
    for (var k = 0; k < path.length - 1; k++) {
      if (s <= lens[k + 1] || k === path.length - 2) {
        var t = (s - lens[k]) / Math.max(0.001, lens[k + 1] - lens[k]);
        t = clamp(t, 0, 1);
        var a = path[k], b = path[k + 1];
        return {
          x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t), y: lerp(a.y, b.y, t),
          tx: b.x - a.x, tz: b.z - a.z
        };
      }
    }
    return null;
  }
  for (i = 0; i <= segs; i++) {
    var s = total * i / segs;
    var p = at(s);
    var tl = Math.sqrt(p.tx * p.tx + p.tz * p.tz);
    var nx = -p.tz / tl, nz = p.tx / tl;
    var f = i / segs;
    var w = halfWidth * (1 + widthGain * f) * (0.85 + 0.30 * fbm(f * 6.0, 3.3, 3));
    pos.push(p.x - nx * w, p.y + yLift, p.z - nz * w);
    pos.push(p.x + nx * w, p.y + yLift, p.z + nz * w);
    uvs.push(0, s / 34, 1, s / 34);
  }
  for (i = 0; i < segs; i++) {
    var a2 = i * 2;
    idx.push(a2, a2 + 1, a2 + 2, a2 + 2, a2 + 1, a2 + 3);
  }
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildInlandWater() {
  riverMat = calmWaterMaterial(1.15, 0x24aebc, 1.0);
  var rg = buildRibbon(RIVER, 220, 24, 0.55, 0.05);
  var river = new THREE.Mesh(rg, riverMat);
  river.renderOrder = 5;
  scene.add(river);

  var bg = buildRibbon(BROOK, 90, 9, 0.1, 0.04);
  var brook = new THREE.Mesh(bg, riverMat);
  brook.renderOrder = 5;
  scene.add(brook);

  poolMat = calmWaterMaterial(0.42, 0x22b2bf, 0.0);
  var pg = new THREE.CircleGeometry(POOL.r + 6, 72);
  pg.rotateX(-PI / 2);
  var pool = new THREE.Mesh(pg, poolMat);
  pool.position.set(POOL.x, 14.05, POOL.z);
  pool.renderOrder = 5;
  scene.add(pool);
}

function buildWaterfall() {
  var FX = -240, ROWS = 46, COLS = 16;
  var topY = wallTop(FX) + 1.4, botY = 13.6;
  var pos = [], uvs = [], idx = [];
  for (var j = 0; j <= ROWS; j++) {
    var v = j / ROWS;
    var y = lerp(topY, botY, v);
    var z = cliffZ(v) + 1.9 + v * 2.6;
    var hw = 10.5 + 6.5 * v * v;
    for (var i = 0; i <= COLS; i++) {
      var u = i / COLS;
      var x = FX + (u - 0.5) * 2 * hw;
      var curl = (1 - Math.cos(u * TAU)) * 0.5 * 1.6 * (0.3 + v);
      pos.push(x, y, z + curl);
      uvs.push(u, v);
    }
  }
  for (j = 0; j < ROWS; j++) {
    for (var i2 = 0; i2 < COLS; i2++) {
      var a = j * (COLS + 1) + i2, b = (j + 1) * (COLS + 1) + i2;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();

  fallMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
    uniforms: commonUniforms({
      uTop: { value: new THREE.Color(0xbfeef5) },
      uWhite: { value: new THREE.Color(0xffffff) }
    }),
    vertexShader: [
      'varying vec2 vUv; varying vec3 vWP;',
      'void main(){ vUv = uv; vWP = (modelMatrix*vec4(position,1.0)).xyz;',
      ' gl_Position = projectionMatrix * viewMatrix * vec4(vWP,1.0); }'
    ].join('\n'),
    fragmentShader: [
      'uniform float uTime; uniform vec3 uTop; uniform vec3 uWhite;',
      'varying vec2 vUv; varying vec3 vWP;',
      GLSL_COMMON,
      'void main(){',
      '  float t = uTime;',
      '  vec2 p = vec2(vUv.x*7.0, vUv.y*3.4);',
      '  float s1 = fbm3(p*vec2(2.6,1.0) - vec2(0.0, t*1.55));',
      '  float s2 = fbm3(p*vec2(6.0,2.4) - vec2(0.0, t*2.65));',
      '  float s3 = fbm3(p*vec2(13.0,5.0) - vec2(0.0, t*3.9));',
      '  float streak = s1*0.5 + s2*0.34 + s3*0.16;',
      '  vec3 col = mix(uTop, uWhite, smoothstep(0.30, 0.78, streak));',
      '  col = mix(col*0.86, col, smoothstep(0.0, 0.25, vUv.y));',
      '  float a = 0.55 + 0.45*smoothstep(0.22, 0.75, streak);',
      '  a *= smoothstep(0.0, 0.09, vUv.y);',
      '  a *= 1.0 - smoothstep(0.60, 1.0, abs(vUv.x*2.0-1.0))*0.85;',
      /* it churns to white where it lands */
      '  float boil = smoothstep(0.80, 1.0, vUv.y);',
      '  col = mix(col, vec3(1.0), boil*0.7);',
      '  a = mix(a, a*0.55 + 0.45*(0.4+0.6*s3), boil);',
      '  col = applyFog(col, length(cameraPosition - vWP));',
      '  gl_FragColor = vec4(col, clamp(a,0.0,1.0)*0.95);',
      '}'
    ].join('\n')
  });
  var m = new THREE.Mesh(g, fallMat);
  m.renderOrder = 7;
  scene.add(m);
  shaderMats.push(fallMat);
  return { topY: topY, botY: botY, x: FX };
}

export { GLSL_WAVES, buildInlandWater, buildOcean, buildRibbon, buildWaterfall, calmWaterMaterial, fallMat, oceanGeometry, oceanMat, oceanMesh, poolMat, riverMat };
