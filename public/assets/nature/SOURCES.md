# Nature assets

Most models and textures under this directory derive from the **Stylized Nature
MegaKit** by **Quaternius**, released into the public domain under **CC0 1.0**.
Four landmark props come from two other CC0 authors — see the table below.

- **Author**  Quaternius — https://quaternius.com
- **Licence** CC0 1.0 Universal (public domain dedication) — see LICENSE.txt
- **Mirror**  https://poly.pizza  (per-asset pages listed in `tools/nature-build/build.mjs`)

## The landmarks

Added later, and not part of the MegaKit. They go through the same build for the
same reasons, and they are placed by `buildLandmarks()` in `props.js` into the gaps
the scatters leave rather than by a density field of their own.

| Prop | What | Author | Licence | Source |
|---|---|---|---|---|
| `statue_fox` | Stone fox statue, 2,150 tris | Quaternius | CC0 1.0 | [poly.pizza/m/abxyXID5EA](https://poly.pizza/m/abxyXID5EA) |
| `pillar` | Ruined pillar, 94 tris | Kay Lousberg (KayKit) | CC0 1.0 | [poly.pizza/m/1nt8n3rVKU](https://poly.pizza/m/1nt8n3rVKU) |
| `crypt` | Stone crypt, 952 tris | Kay Lousberg (KayKit) | CC0 1.0 | [poly.pizza/m/iV5x01FYAl](https://poly.pizza/m/iV5x01FYAl) |
| `dead_tree` | Gnarled dead tree, 5,702 tris | Quaternius | CC0 1.0 | [poly.pizza/m/n8FhMgMldD](https://poly.pizza/m/n8FhMgMldD) |

`pillar` and `crypt` share one texture atlas (`halloween.png`), which is the
arrangement the build below exists to produce — they simply arrived that way.
`statue_fox` has no UVs at all, so it carries no texture and takes its colour from
vertex colours the build paints on (`TINT` in the build script).

The dead tree is the case that justifies this pipeline twice over. Its source GLB
is 2.5 MB, of which 2.3 MB is two PNGs — and 1.33 MB of *that* is a normal map,
which this game cannot display at all. Through the build it comes out at 276 KB of
geometry plus a 69 KB shared bark texture.

CC0 imposes no attribution requirement. This file exists anyway, because
knowing where a file came from is worth more than the licence obliges.

## These are not the originals

`tools/nature-build/build.mjs` rewrites the source GLBs before they ship. Run it with:

    node tools/nature-build/build.mjs

It re-downloads the originals into `tools/.cache/` (~28 MB, deliberately not
committed and deleted after a build - it is a download cache, not a source) and
regenerates everything in `models/` and `textures/`.

What it changes and why:

1. **Textures are pulled out of the models.** Each source GLB embeds a
   1024x1024 base colour *and* a 1024x1024 normal map per material, and the
   same eight images repeat across all 25 models - roughly 2.2 MB of PNG inside
   every single tree. Extracting them once means the whole nature set downloads
   for about the size of one original tree, and the GPU holds one texture per
   image for the entire world instead of one per model. That second part is
   what matters on an integrated GPU with no VRAM to spare.
2. **Normal maps are dropped entirely.** Everything here renders as
   `MeshToonMaterial` through a 4-step gradient ramp, which cannot show a
   normal map's detail at all. Shipping them would cost bandwidth for nothing.
3. **Two levels of detail per prop**, as two nodes inside one GLB: LOD0 full,
   LOD1 with a thinned canopy. The canopies in this pack are piles of
   disconnected leaf cards, so LOD1 discards whole cards and grows the
   survivors to cover the gaps. A normal edge-collapse simplifier is the wrong
   tool for that - with no shared edges it welds neighbouring cards into
   spaghetti.

`manifest.json` records each prop's height, base offset and radius, so the
scatter code can seat a model on the ground and space it without loading it.

## Files

| Path | What |
|---|---|
| `models/*.glb` | 20 props: 4 broadleaf, 3 pine, 2 twisted/blossom, bush, fern, 3 rocks, 2 flowers, and 4 landmarks |
| `textures/*.png` | 9 shared base-colour maps, re-attached by material name in `models.js` |
| `manifest.json` | per-prop height / base / radius |
| `tools/` | build-time only, never loaded by the game |
