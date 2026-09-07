/* Whispering Meadow - turns KayKit's 3.6 MB Rogue.glb into the small asset
   the game actually ships. Run with:  KEEP="Idle,Walking_C,..." node build-character.mjs in.glb out.glb */
import { NodeIO } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, resample, sparse } from '@gltf-transform/functions';

const KEEP_ANIM = new Set(process.env.KEEP.split(','));
/* a meadow, not a dungeon */
const DROP_NODE = /Knife|Crossbow|Throwable|Spellbook|Wand|Staff|Sword|Axe|Shield|Bow|Quiver|Arrow|Mug|Smokebomb|Dagger/i;

const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);
const doc = await io.read(process.argv[2]);
const root = doc.getRoot();
const before = root.listAnimations().length;

/* Animation.dispose() is shallow - it leaves its channels and samplers alive,
   they keep referencing their keyframe accessors, and prune() then sees every
   one of them as still in use. Which is why simply disposing the 70 clips we
   do not want leaves the file exactly the same size. Tear each one down. */
for (const a of root.listAnimations()) {
  if (KEEP_ANIM.has(a.getName())) { continue; }
  for (const c of a.listChannels()) { c.dispose(); }
  for (const s of a.listSamplers()) { s.dispose(); }
  a.dispose();
}

for (const n of root.listNodes()) { if (DROP_NODE.test(n.getName())) { n.dispose(); } }

/* Which joints actually move vertices? KayKit's rig carries 19 IK/control
   bones (kneeIK, IK-foot, control-heel-roll, handslot...) that the animations
   were authored against but that the exported clips have already baked out:
   nothing is skinned to them and no deforming bone is parented under them.
   Their keyframes are dead weight in the file AND dead work in the mixer
   every frame, for every player on screen. Drop those channels. */
const skin = root.listSkins()[0];
const joints = skin.listJoints();
const weighted = new Set();
for (const m of root.listMeshes()) {
  for (const p of m.listPrimitives()) {
    const J = p.getAttribute('JOINTS_0'), W = p.getAttribute('WEIGHTS_0');
    if (!J || !W) { continue; }
    for (let i = 0; i < J.getCount(); i++) {
      const j = J.getElement(i, []), w = W.getElement(i, []);
      for (let k = 0; k < 4; k++) { if (w[k] > 0.0001) { weighted.add(joints[j[k]]); } }
    }
  }
}
/* a bone matters if it is weighted or is an ancestor of one */
const matters = new Set();
for (const j of weighted) { for (let n = j; n; n = n.listParents().find((p) => p.propertyType === 'Node')) { matters.add(n); } }
/* ...and so does anything a non-skinned mesh (the cape) hangs off */
for (const n of root.listNodes()) {
  if (!n.getMesh() || n.getSkin()) { continue; }
  for (let p = n; p; p = p.listParents().find((q) => q.propertyType === 'Node')) { matters.add(p); }
}

let dropped = 0;
for (const a of root.listAnimations()) {
  for (const c of a.listChannels()) {
    const t = c.getTargetNode();
    if (t && !matters.has(t)) { const s = c.getSampler(); c.dispose(); if (s && !s.listParents().some((p) => p.propertyType === 'AnimationChannel')) { s.dispose(); } dropped++; }
  }
}

await doc.transform(
  resample({ tolerance: 1e-4 }),
  dedup(),
  prune({ keepAttributes: false, keepLeaves: false }),
  sparse()
);

console.log('clips ' + before + ' -> ' + root.listAnimations().length + ': ' + root.listAnimations().map((a) => a.getName()).join(', '));
console.log('dead channels dropped:', dropped, '| channels left:', root.listAnimations().reduce((n, a) => n + a.listChannels().length, 0));
console.log('meshes:', root.listNodes().filter((n) => n.getMesh()).map((n) => n.getName()).join(', '));
await io.write(process.argv[3], doc);
