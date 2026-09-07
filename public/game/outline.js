/* Whispering Meadow - outline.js
   The missing ingredient for the cel look: a dark line around every object.
   Toon-ramp lighting plus a rim light (see core.js) gets you flat, banded
   shading, but shading alone still reads as a lit 3D model. What makes an
   object read as DRAWN is a hard, consistent-width dark line tracing its
   silhouette - the ink line under the paint, in every cel-shaded game from
   Genshin Impact to Breath of the Wild.

   TECHNIQUE CHOICE - inverted hull, not a post-process edge pass
   ----------------------------------------------------------------------
   Two ways to get that line:
     1. Full-screen depth/normal edge detection (a post-processing pass
        that samples a depth+normal buffer and darkens pixels where they
        disagree with their neighbours).
     2. Inverted hull: render a second copy of the mesh, backface-only,
        pushed out along its normals, in a flat dark colour, behind the
        real mesh. Where it pokes out past the real mesh's silhouette, you
        see a rim of dark colour; everywhere else the real mesh's front
        faces draw over it.

   This machine is a laptop iGPU with no discrete graphics card, and per
   post.js the bottleneck here is FILL RATE, not triangles - the engine
   already renders bloom at half resolution for exactly that reason
   (see makeTargets() in post.js). A depth/normal edge pass needs extra
   full-resolution render targets (a normal buffer, most likely a second
   depth pass since MeshToonMaterial doesn't write one usefully) plus a
   multi-tap neighbour sample on EVERY screen pixel, every frame. That is
   pure fill-rate cost stacked on top of an already fill-rate-bound scene.

   The inverted hull costs triangles (cheap on any GPU, let alone one
   rendering full trees out of individually-authored branch cylinders
   already) and only shades the thin sliver of pixels that end up outside
   the original silhouette - a few percent of the object's footprint, not
   the whole screen. It is also literally what Breath of the Wild uses,
   on hardware weaker than this laptop's iGPU. Cheap technique, right
   choice, picking it.

   INSTANCING
   ----------------------------------------------------------------------
   Nearly every prop in this world (trees, rocks, flowers, sunflowers) is
   a THREE.InstancedMesh built by emitInstances() in props.js. The outline
   mesh for one of those is a second InstancedMesh that shares the SAME
   geometry and the SAME instanceMatrix attribute object as the original
   (not a copy - the literal same THREE.InstancedBufferAttribute). Sharing
   the attribute means: no duplicated instance data in RAM (this machine
   has 8GB total), and no separate bookkeeping to keep the two meshes in
   sync if instance data ever changes, because they are reading the same
   buffer.

   The extrusion itself happens in OBJECT space, before instanceMatrix is
   applied (see the `#include <begin_vertex>` hook below) - the built-in
   three.js instancing chunk then carries that extruded position through
   instanceMatrix exactly like it carries the un-extruded position, so
   each instance's outline is automatically scaled and rotated with that
   instance, for free, with no per-instance JS work. */

/* small local helper - kept self-contained rather than importing core.js,
   so this module has no dependency on the rest of the engine's state. */
function clampNum(v, a, b) { return v < a ? a : (v > b ? b : v); }

/* ------------------------------------------------------------------------
   outlineMaterial(opts) - the ink-line material.

   opts.color      - THREE.Color-constructible, default a warm near-black
                      (pure black looks like a hole punched in the world
                      under the warm sunlight grade in post.js; a warm
                      near-black sits in the scene instead of fighting it)
   opts.thickness  - extrusion distance in WORLD units at opts.distRef
                      metres from the camera. If omitted, addOutline()
                      below derives a sane one from the mesh's own size.
   opts.minScale   - floor on the distance scale factor (default 0.5)
   opts.maxScale   - ceiling on the distance scale factor (default 2.4)
   opts.distRef    - distance (world units) at which the scale factor is
                      exactly 1.0 (default 55)
   opts.fog        - blend into scene fog like everything else (default true)

   Distance scaling, and why it is CLAMPED rather than linear:
   A fixed world-space thickness looks perfect close up but thins to
   nothing (in screen pixels) far away, because perspective shrinks it
   like everything else - so distant trees lose their line first, which
   is backwards from how a painting reads (distant shapes still get a
   line, just a cheap thin one is fine). Scaling thickness up with
   distance keeps it visible, but scaling it *without a cap* is the "fat
   ugly line" failure mode the brief warns about: a whole forest at the
   horizon is small on screen, and if its outline thickness keeps growing
   with distance to compensate, that thin, tiny silhouette gets eaten
   alive by its own outline and the far tree line turns into a smear of
   dark blobs. Clamping the scale factor lets it grow enough to stay
   readable at mid range, then stop, so far-away geometry keeps a thin,
   quiet line instead of a fat one. */
function outlineMaterial(opts) {
  opts = opts || {};
  var color = new THREE.Color(opts.color === undefined ? 0x231a12 : opts.color);
  var thickness = opts.thickness === undefined ? 0.03 : opts.thickness;
  var minScale = opts.minScale === undefined ? 0.5 : opts.minScale;
  var maxScale = opts.maxScale === undefined ? 2.4 : opts.maxScale;
  var distRef = opts.distRef === undefined ? 55 : opts.distRef;

  /* MeshBasicMaterial: no lighting math at all in the fragment shader,
     which is exactly what a flat ink line wants, and the cheapest
     fragment shader available on a fill-rate-bound iGPU. Backface-only
     is the whole trick - see the file header. */
  var m = new THREE.MeshBasicMaterial({
    color: color,
    vertexColors: false,
    side: THREE.BackSide,
    fog: opts.fog !== false,
    depthTest: true,
    depthWrite: true,
    toneMapped: false
  });

  m.onBeforeCompile = function (sh) {
    sh.uniforms.uOutThick = { value: thickness };
    sh.uniforms.uOutMin = { value: minScale };
    sh.uniforms.uOutMax = { value: maxScale };
    sh.uniforms.uOutRef = { value: distRef };
    sh.vertexShader = 'uniform float uOutThick, uOutMin, uOutMax, uOutRef;\n' +
      sh.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n' +
        /* cameraPosition is a uniform three.js always declares and fills
           in for us (renderer sets it from the active camera every
           frame) - no need to pass it in ourselves. */
        '#ifdef USE_INSTANCING\n' +
        '  vec3 _outOrigin = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;\n' +
        '#else\n' +
        '  vec3 _outOrigin = modelMatrix[3].xyz;\n' +
        '#endif\n' +
        /* per-object distance, not per-vertex - a single subtraction, not
           a full transform, and plenty accurate for choosing a line
           weight. normal is always present (attribute vec3 normal; is
           declared unconditionally by three.js's vertex prefix), and
           GB.build() in geom.js always writes a normal attribute too. */
        '  float _outDist = length(cameraPosition - _outOrigin);\n' +
        '  float _outScale = clamp(_outDist / uOutRef, uOutMin, uOutMax);\n' +
        '  transformed += normalize(normal) * (uOutThick * _outScale);\n'
      );
  };
  /* distinct shader per distinct thickness/scale combo, same idea as
     withRim()'s customProgramCacheKey in core.js */
  m.customProgramCacheKey = function () {
    return 'outline_' + thickness + '_' + minScale + '_' + maxScale + '_' + distRef;
  };
  return m;
}

/* ------------------------------------------------------------------------
   addOutline(mesh, opts) - build and attach the inverted hull for one
   THREE.Mesh or THREE.InstancedMesh, and hand back the outline mesh.

   Works for both:
     - THREE.InstancedMesh: a sibling InstancedMesh is created, sharing
       geometry and instanceMatrix, added next to `mesh` in the same
       parent (mesh.parent.add(...) - normally the scene, since
       emitInstances() in props.js does scene.add(mesh) before this runs).
     - plain THREE.Mesh: the outline is added as a CHILD of `mesh`
       (mesh.add(...)) with an identity local transform, so it inherits
       mesh's world transform automatically, including any future
       animation - no per-frame bookkeeping needed here.

   opts is passed straight through to outlineMaterial(), plus:
     opts.thickness - if omitted, derived from the mesh geometry's own
                       bounding sphere so a tree and a flower each get a
                       proportionally sensible line without per-call tuning. */
function addOutline(mesh, opts) {
  opts = opts || {};
  var geo = mesh.geometry;
  if (geo && !geo.boundingSphere) { geo.computeBoundingSphere(); }
  var autoThick = (geo && geo.boundingSphere) ? clampNum(geo.boundingSphere.radius * 0.045, 0.006, 0.16) : 0.03;
  var matOpts = {
    color: opts.color,
    thickness: opts.thickness === undefined ? autoThick : opts.thickness,
    minScale: opts.minScale,
    maxScale: opts.maxScale,
    distRef: opts.distRef,
    fog: opts.fog
  };
  var mat = outlineMaterial(matOpts);
  var out;

  if (mesh.isInstancedMesh) {
    out = new THREE.InstancedMesh(geo, mat, mesh.count);
    out.instanceMatrix = mesh.instanceMatrix;   // literally the same buffer
    out.count = mesh.count;
    out.frustumCulled = mesh.frustumCulled;
    out.matrixAutoUpdate = false;
    out.castShadow = false;
    out.receiveShadow = false;
    if (out.computeBoundingSphere) { out.computeBoundingSphere(); }
    var parent = mesh.parent;
    if (parent) { parent.add(out); }
  } else {
    out = new THREE.Mesh(geo, mat);
    out.matrixAutoUpdate = false;
    out.castShadow = false;
    out.receiveShadow = false;
    mesh.add(out);
  }
  return out;
}

export { addOutline, outlineMaterial };
