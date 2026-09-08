# Actor assets

The two models in this world that move under their own power. Both are **CC0 1.0**
(public domain). CC0 imposes no attribution requirement; this file exists anyway,
for the same reason `../nature/SOURCES.md` does - knowing where a file came from is
worth more than the licence obliges.

| File | What | Author | Licence | Source |
|---|---|---|---|---|
| `models/wolf.glb` | Animated wolf, 1,962 tris, 12 skeletal clips | Quaternius | CC0 1.0 | [poly.pizza/m/P1gU3Qkr9r](https://poly.pizza/m/P1gU3Qkr9r) |
| `models/tractor.glb` | Tractor, 2,044 tris, body + 4 separate wheel nodes | Kenney | CC0 1.0 | [kenney.nl/assets/car-kit](https://kenney.nl/assets/car-kit) |
| `models/Textures/colormap.png` | The tractor's palette atlas, 12 KB | Kenney | CC0 1.0 | same pack |

## Unlike the nature set, these ship as they were downloaded

`tools/nature-build/build.mjs` rewrites everything under `../nature/` to strip its
textures out and share them. These two deliberately do not go through it, and the
reason is structural rather than an oversight:

- **The wolf is a skinned mesh.** `flatten()` in that build bakes node transforms
  into vertex positions, which is exactly the right thing for a static tree and
  exactly wrong for an armature - it would weld the wolf into its bind pose and
  throw the skin weights away.
- **The tractor's five nodes are the point of it.** `body` plus `wheel-front-left`,
  `wheel-front-right`, `wheel-back-left`, `wheel-back-right`, each a separate named
  node. `actors.js` finds the wheels by name and spins them. Flattening merges all
  five into one mesh and the tractor becomes a sled.

Neither costs much to leave alone. The tractor carries one 12 KB atlas shared by
all five of its meshes, which is already the arrangement the nature build exists to
produce. The wolf carries no textures at all - it is coloured by four flat
materials.

## Known cost

`wolf.glb` is 964 KB, and most of that is animation data: the file ships all twelve
clips **twice**, once bare (`Walk`) and once armature-prefixed
(`AnimalArmature|Walk`). `actors.js` resolves either spelling and uses two of them,
`Walk` and `Idle`. Stripping the ten unused clips and the duplicate set would cut
the file by roughly half, but doing it properly means repacking the accessors and
buffer views, not just deleting animation entries - orphaned bin data saves nothing.
Worth doing if the download budget ever gets tight; not worth the risk today.

## What the game does with them

Both are plain `THREE.Group`s rather than instanced meshes, because there is exactly
one of each. `actors.js` explains why that is the right call and how they earn it
back - they are not drawn, and not simulated, past their rung on the distance ladder
in `../../game/models.js`.

Their materials are swapped to `MeshToonMaterial` through the same 4-step gradient
ramp everything else in the meadow uses. A PBR surface next to a toon-ramped one
reads as a sticker.
