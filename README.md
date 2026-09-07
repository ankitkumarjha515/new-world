# Whispering Meadow

A hand-painted procedural open world in a single HTML file. Terrain, water,
grass, clouds, creatures and audio are all generated in code — there are no
assets to download.

## Layout

```
public/index.html   the entire game (~110 KB, one file)
wrangler.jsonc      Cloudflare Workers config (static assets)
```

## Develop

```sh
npm run dev      # local server at http://localhost:8787
```

## Deploy

```sh
npx wrangler login   # once, opens the browser
npm run deploy
```

## Why Workers instead of Pages

Static asset requests on Workers are free and unlimited — serving the game
never consumes the 100,000/day Workers request quota. The same project can
later host the multiplayer Durable Object without restructuring.

## Multiplayer notes (not built yet)

The world is fully deterministic: `terrainHeight(x, z)` is a pure function of
integer-hash value noise, and every scatter (trees, flowers, grass, rocks) uses
`mulberry32` with hardcoded seeds. Every client therefore generates a
bit-identical world with zero network cost — only player positions need to be
sent.

`terrainHeight`, `pathInfo`, `cliffWave` and `bridgeY` have no Three.js
dependency, so they can be copied into the Worker as-is for server-side
collision and movement validation.

Free-tier budget (Durable Objects): 100,000 requests/day with a 20:1 discount on
incoming WebSocket messages, and outgoing messages are free. At 8-10 Hz per
player that is roughly 50-60 player-hours/day.
# new-world
