/* ==========================================================================
   WHISPERING MEADOW - production build

   Development does not use this. `npm run dev` serves public/ exactly as it
   sits on disk: edit a file, hit refresh, no build, no watcher, no cache to
   clear. That property is worth keeping and this script does not take it
   away - it only exists for `npm run deploy`.

   What it is for: a phone on mobile data. Served raw, the game is 20 separate
   ES modules plus three classic scripts plus two stylesheets, and every one
   of them is a round trip before the first tree can be drawn. On a desktop
   that is invisible. On a 4G connection with 80 ms of latency it is most of a
   second of nothing happening.

   Output: dist/, which is public/ with the JavaScript bundled and minified,
   the two stylesheets concatenated into one, and the HTML pointed at the
   results. Everything else - models, textures, the vendored Three.js - is
   copied through untouched.

   Run: node tools/build.mjs
   ========================================================================== */

import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, stat, writeFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'public');
const OUT = join(ROOT, 'dist');

/* The two entry points, and the only two. Everything else is reached by an
   import from one of them, which is what makes bundling safe here: there is
   no file that only the HTML knows about.

   ui/ui.js is deliberately SEPARATE from game/main.js rather than bundled in
   with it. The interface has to be on screen and interactive before the 3D
   engine has finished downloading - that is the whole reason the boot card is
   static markup in the HTML - so folding it into the same file as the game
   would undo the thing it exists to do. */
const ENTRIES = [
  { in: 'ui/ui.js', out: 'ui/ui.js' },
  { in: 'game/main.js', out: 'game/main.js' }
];

/* Classic scripts. Not modules, not bundled - minified in place, because
   net.js and voice.js reach each other and settings.js through globals and
   turning them into modules would change their semantics. */
const PLAIN = ['settings.js', 'net.js', 'voice.js'];

const CSS_IN = ['ui/tokens.css', 'ui/ui.css'];
const CSS_OUT = 'ui/ui.css';

function kb(n) { return (n / 1024).toFixed(1) + ' KB'; }

async function sizeOf(p) {
  try { return (await stat(p)).size; } catch { return 0; }
}

/* Total bytes of the code+markup in a tree, ignoring vendor/ and assets/ -
   those are copied through untouched and counting them would bury the number
   this build is actually trying to move. */
async function codeBytes(dir) {
  let total = 0;
  const walk = async (d, rel) => {
    for (const ent of await readdir(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (r === 'vendor' || r === 'assets') { continue; }
      if (ent.isDirectory()) { await walk(join(d, ent.name), r); continue; }
      if (/\.(js|css|html)$/.test(ent.name)) { total += await sizeOf(join(d, ent.name)); }
    }
  };
  await walk(dir, '');
  return total;
}

/* Every .js under these directories is a bundle input, so shipping it
   separately would send the same code twice. The entry outputs are written
   after this runs, so they survive. */
async function pruneBundledSources(dir, keep) {
  const full = join(OUT, dir);
  if (!existsSync(full)) { return 0; }
  let removed = 0;
  for (const name of await readdir(full)) {
    if (!name.endsWith('.js')) { continue; }
    if (keep.includes(`${dir}/${name}`)) { continue; }
    await unlink(join(full, name));
    removed++;
  }
  return removed;
}

async function main() {
  const t0 = Date.now();
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  /* Copy everything first, then overwrite what gets built. Assets - the .glb
     models, the .png textures and the vendored Three.js - are already as
     small as they are going to get and are left exactly alone. */
  await cp(SRC, OUT, { recursive: true });

  const before = await codeBytes(SRC);

  /* ---- modules ---------------------------------------------------------- */
  for (const e of ENTRIES) {
    const result = await build({
      entryPoints: [join(SRC, e.in)],
      outfile: join(OUT, e.out),
      bundle: true,
      minify: true,
      format: 'esm',
      target: ['es2019'],
      legalComments: 'none',
      /* GLTFLoader is fetched at runtime by URL through the import map in
         index.html, so that this build never has to understand three's own
         module graph. models.js builds that URL from a variable, which esbuild
         cannot resolve statically and therefore leaves alone - but it is
         marked external as well, so the day somebody writes the path as a
         literal it still does the right thing. */
      external: ['three', '/vendor/*'],
      write: true
    });
    if (result.warnings.length) {
      for (const w of result.warnings) { console.warn('  warn:', w.text); }
    }
  }

  const pruned =
    (await pruneBundledSources('game', ENTRIES.map((e) => e.out))) +
    (await pruneBundledSources('ui', ENTRIES.map((e) => e.out)));

  /* ---- classic scripts -------------------------------------------------- */
  for (const f of PLAIN) {
    const src = join(SRC, f);
    if (!existsSync(src)) { continue; }
    await build({
      entryPoints: [src],
      outfile: join(OUT, f),
      bundle: false,
      minify: true,
      target: ['es2019'],
      legalComments: 'none',
      allowOverwrite: true
    });
  }

  /* ---- stylesheets: two files become one -------------------------------- */
  let css = '';
  for (const f of CSS_IN) {
    css += await readFile(join(SRC, f), 'utf8') + '\n';
  }
  const cssMin = await build({
    stdin: { contents: css, loader: 'css', resolveDir: join(SRC, 'ui') },
    minify: true,
    write: false
  });
  await writeFile(join(OUT, CSS_OUT), cssMin.outputFiles[0].text);
  await rm(join(OUT, 'ui/tokens.css'), { force: true });

  /* ---- html ------------------------------------------------------------- */
  let html = await readFile(join(SRC, 'index.html'), 'utf8');

  /* One stylesheet now, so one link. The tokens link is dropped rather than
     left pointing at a file that no longer exists. */
  html = html.replace(/\s*<link rel="stylesheet" href="\/ui\/tokens\.css">/, '');

  /* Comments in the source files are the documentation and they stay there.
     In the shipped HTML they are dead weight, and there are several long ones.
     The importmap and every <script> body are left completely untouched - only
     HTML comment nodes go. */
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  html = html.replace(/\n{3,}/g, '\n\n');

  await writeFile(join(OUT, 'index.html'), html);

  /* ---- report ----------------------------------------------------------- */
  const after = await codeBytes(OUT);

  console.log(`
  dist/ built in ${Date.now() - t0} ms`);
  console.log(`  ${pruned} bundled source modules pruned`);
  console.log(`  code + markup:  ${kb(before)} -> ${kb(after)}`);
  console.log(`  (assets, models and vendored three.js copied unchanged)
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
