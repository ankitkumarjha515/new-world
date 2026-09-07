# traveller.glb

The player character. Not hand-built: it is KayKit's Rogue, by Kay Lousberg.

- **Pack**    KayKit : Adventurers Character Pack 1.0
- **Author**  Kay Lousberg — https://www.kaylousberg.com
- **Licence** CC0 1.0 (public domain) — see LICENSE.txt, shipped verbatim
- **Source**  https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0
- **File**    `addons/kaykit_character_pack_adventures/Characters/gltf/Rogue.glb`

## What was changed, and why

The original `Rogue.glb` is **3.6 MB**. Almost none of that is the character:
the mesh is 6 377 triangles and the texture is a 16 KB palette atlas. The
weight is 76 baked animation clips — crossbow reloads, spellcasting, death
poses, sitting in chairs — none of which a walking sim will ever play.

`build-character.mjs` (kept here so this is reproducible) cuts it to **372 KB**:

1. **Keeps 6 clips** of the 76: `Idle`, `Walking_A`, `Walking_B`, `Walking_C`,
   `Running_A`, `Jump_Idle`. Note that glTF `Animation.dispose()` is shallow —
   it orphans the channels and samplers but leaves them holding their keyframe
   accessors, so `prune()` still considers every one of them live and the file
   does not shrink at all. Each clip has to be torn down by hand.
2. **Drops the weapons.** The knife, both crossbows and the throwable are
   separate nodes parented to the hand slots. This is a meadow.
3. **Drops dead animation channels.** KayKit's rig has 39 bones but only 20 of
   them move vertices; the other 19 are IK targets and control bones
   (`kneeIK.l`, `IK-foot.r`, `control-heel-roll.l`, `handslot.*`) that the
   clips were authored against and that the export has already baked out.
   Nothing is skinned to them and no deforming bone is parented under them, so
   their keyframes are dead weight in the file *and* dead work in the
   AnimationMixer every frame, for every player on screen. 324 of 697 channels
   removed.
4. `resample` + `dedup` + `prune` + `sparse`.

## Rebuilding

```
npm i @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions
curl -LO https://raw.githubusercontent.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0/main/addons/kaykit_character_pack_adventures/Characters/gltf/Rogue.glb
KEEP="Idle,Walking_A,Walking_B,Walking_C,Running_A,Jump_Idle" node build-character.mjs Rogue.glb traveller.glb
```

## Measured facts the game code depends on

Bind pose is 2.187 units tall (T-pose), feet at y=0, and every clip is
**in place** — the hips never translate in x or z, so the body never drifts
away from the position the network gives it.

Foot travel per clip, measured off the baked bone transforms, in model units:

| clip       | duration | step  | ground speed at timeScale 1 |
|------------|----------|-------|-----------------------------|
| Walking_A  | 1.07 s   | 0.513 | 0.96 u/s                    |
| Walking_B  | 1.07 s   | 0.513 | 0.96 u/s                    |
| Walking_C  | 1.60 s   | 0.489 | 0.61 u/s                    |
| Running_A  | 0.80 s   | 0.920 | 2.30 u/s                    |

`character.js` scales those by the character's height to get the speed each
clip should be played back at, which is what keeps the feet planted instead of
skating. There is no lateral hip sway in any clip — the old hand-built walk's
side-to-side wobble is gone by construction.
