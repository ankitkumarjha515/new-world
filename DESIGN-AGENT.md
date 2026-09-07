# Art direction brief — Whispering Meadow

Read this before changing anything visual. It exists because a previous pass
reached for the easy knob (post-processing saturation) and the result did not
move. The look lives in the **lighting model**, not in the grade.

## The target

Anime landscape painting. Reference images are in `inspiration-image/`.
Think Makoto Shinkai and Studio Ghibli backgrounds, not photorealism.

Five things define it. In order of how much they matter:

1. **Banded light.** Light and shade snap into 2–3 flat steps. No smooth fade.
2. **Sculptural clouds** with blue sky between them. Bright tops, blue-grey undersides.
3. **Hard light / soft fill.** Strong sun, weak ambient. A wide gap between lit and shaded.
4. **Split tone.** Sunlit surfaces go gold. Shadows go blue. Never grey.
5. **Deep saturated colour** — cobalt skies, acid greens — with whites protected.

## Hard constraints

**Target machine: 8 GB RAM, integrated graphics, no dedicated GPU.**
Assume every player has this.

- The bottleneck is **fill rate** (screen pixels shaded), not triangle count.
- Transparent and overlapping surfaces are the expensive thing.
- Memory is not a concern — the world is generated from noise, ~20 MB total.
- **Toon shading is cheaper than realistic shading.** The art direction and the
  performance budget want the same thing. Never reach for PBR "realism" here.

Never use `MeshStandardMaterial` or `MeshPhysicalMaterial`. They are PBR
(physically based) materials: expensive, and wrong for this style. Use
`toonMaterial()` from `game/core.js`.

## Where the look actually lives

| File | What to change there |
|---|---|
| `game/core.js` | `toonRamp()` — the light ladder. `initEngine()` — light intensities. |
| `game/post.js`  | The grade: saturation, S-curve, split tone, bloom. |
| `game/sky.js`   | Sky gradient and the cloud banks. |
| `game/terrain.js` | Ground colour bands in `terrainColorAt()`. |
| `game/props.js` | Tree, flower and rock colours. |

Start with `toonRamp()` and the light intensities. That is the style. The grade
in `post.js` is the last 20%, not the first.

## Rules that are easy to get wrong

**Clamp before any S-curve.** `c*c*(3-2c)` goes negative above 1.0. Bloom pushes
values above 1.0, so an unclamped curve turns bright clouds solid black. This
has already happened once.

**Protect near-whites when boosting saturation.** Clouds must stay white. Fade
the saturation boost out above about 0.72 luminance.

**Clouds need gaps.** A puff 800 units wide sitting 1400 units away covers the
whole screen and reads as grey soup. Keep cloud banks beyond ~2200 units and
puffs under ~250 units. Blue sky between shapes is what makes them read as
clouds at all.

**Shadow steps must not crush to navy.** The darkest rung of the toon ramp
should stay around `rgb(124,138,168)`. Darker than that and foliage turns into
black blobs once saturation is applied.

**Fog should go pale cyan with distance, never grey.**

## Workflow

1. Change one thing.
2. Screenshot it. Compare against `inspiration-image/` side by side.
3. If you cannot see the difference in a screenshot, it was not worth doing.

Do not stack five speculative changes and hope. Every change in this file's
history that helped was visible in a single screenshot.

## Do not touch

- `public/net.js`, `public/voice.js`, `src/` — multiplayer, chat and voice.
- `game/player.js` — movement feel is settled.
- Anything under `.backup/`.

## Settled values (do not "improve" these without a screenshot)

Reached by iteration. Each was checked against `inspiration-image/`.

```
sun            DirectionalLight 1.95      above ~2.5 the lit ground clips to white
hemisphere     1.42  sky 0x9fd4ff         this is what makes shadows blue, not black
ambient        0.46
toon ramp      darkest rung 150,168,202   any darker and shade goes black
saturation     1.52 -> 1.10 above 0.66 L
S-curve mix    0.20                       0.42 was too contrasty
bloom          0.70
```

Sun brightness and the grade fight each other. If you raise one, lower the other,
and screenshot. Do not raise both.


## Two rules learned the hard way

**1. Never use `sin(x) * cos(y)` for water or any organic surface.**
That expression IS a checkerboard. A previous pass replaced `fbm3()` noise
with sin/cos "for performance" in BOTH the ocean and the river, and the
result was a visible square grid on the water. Use `fbm3()` / `vn()`. The
performance saving was not worth it and was never measured.

**2. No ground albedo above ~0.72.**
The colour grade (filmic shoulder + S-curve + saturation) pushes anything
brighter to pure white glare. The stone path was authored at 0.85-0.94 with a
dapple multiplier on top that took it past 1.0, and it read as a blinding
white strip through the meadow. Sand had the same problem at 0.98.
Snow above 0.9 is fine - it is far away and behind fog.

## Loading downloaded models

`public/assets/trees/` holds the CC0 Kenney Nature Kit trees. They are OFF by
default. Add `?models=1` to the URL to swap them in for the procedural
broadleaf trees. `useModelTrees()` in `props.js` does the swap and fails
silently, so a missing asset can never break the world.

## Known gaps, if you are looking for work

- **The cliff wall is the worst thing in frame.** It is a tall vertical band
  across the whole background and it reads as a striped curtain. Nothing like it
  exists in the reference images. It only exists so the waterfall has something
  to fall down. Consider moving it far off to one side, or cutting it and giving
  the waterfall a rocky gorge instead.
- **Cast shadows are still too large and too dark.** The shadow camera is only
  +/-88 units, so one tree overhead darkens a huge share of the screen. Consider
  a shorter shadow distance and a lighter shadow.
- Trees now branch properly (`limbs()` / `canopy()` in `props.js`) but the
  canopy silhouette is still lumpy compared with painted foliage.
- The ground has no painterly texture. This is the biggest remaining gap against
  the references, which have visible brushwork everywhere.
- The sky could hold a deeper cobalt at the zenith.
