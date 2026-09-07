# Nature assets

Every model and texture under this directory derives from the **Stylized Nature
MegaKit** by **Quaternius**, released into the public domain under **CC0 1.0**.

- **Author**  Quaternius — https://quaternius.com
- **Licence** CC0 1.0 Universal (public domain dedication) — see LICENSE.txt
- **Mirror**  https://poly.pizza  (per-asset pages listed in `tools/build.mjs`)

CC0 imposes no attribution requirement. This file exists anyway, because
knowing where a file came from is worth more than the licence obliges.

## These are not the originals

`tools/build.mjs` rewrites the source GLBs before they ship. Run it with:

    node public/assets/nature/tools/build.mjs

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
| `models/*.glb` | 16 props: 4 broadleaf, 3 pine, 2 twisted/blossom, bush, fern, 3 rocks, 2 flowers |
| `textures/*.png` | 7 shared base-colour maps, re-attached by material name in `models.js` |
| `manifest.json` | per-prop height / base / radius |
| `tools/` | build-time only, never loaded by the game |
