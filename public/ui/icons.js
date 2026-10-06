/* ==========================================================================
   WHISPERING MEADOW - icons

   Inline SVG strings, so the interface costs zero image requests and every
   glyph inherits currentColor. The old UI drew its icons from text glyphs
   ("⛶", "✕", "↻"), which render differently on every platform and were
   missing outright in some Android font stacks - a fullscreen button that
   shows a tofu box is worse than no button.

   All paths are drawn on a 24x24 grid with a 2px round stroke so they sit
   together at any size.
   ========================================================================== */

var BOX = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
          'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
          'aria-hidden="true" focusable="false"';

function svg(body) { return '<svg ' + BOX + '>' + body + '</svg>'; }

var ICONS = {
  gear: svg(
    '<circle cx="12" cy="12" r="3.1"/>' +
    '<path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z"/>'
  ),
  pause: svg('<path d="M9 4.5v15M15 4.5v15"/>'),
  play:  svg('<path d="M7 4.2 19.2 12 7 19.8Z"/>'),
  close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  /* Four corners pushing out. */
  expand: svg(
    '<path d="M9 3H5a2 2 0 0 0-2 2v4M15 3h4a2 2 0 0 1 2 2v4"/>' +
    '<path d="M21 15v4a2 2 0 0 1-2 2h-4M3 15v4a2 2 0 0 0 2 2h4"/>'
  ),
  /* The same four corners pulling in. */
  collapse: svg(
    '<path d="M3 9h4a2 2 0 0 0 2-2V3M21 9h-4a2 2 0 0 1-2-2V3"/>' +
    '<path d="M15 21v-4a2 2 0 0 1 2-2h4M9 21v-4a2 2 0 0 0-2-2H3"/>'
  ),
  /* Used on the pause screen, where "back to the world" reads better as a
     doorway than as a play triangle. */
  door: svg(
    '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h8"/>' +
    '<path d="M18 8l4 4-4 4M22 12h-8"/>'
  ),
  sound: svg(
    '<path d="M4 9.5h3L11 6v12l-4-3.5H4Z"/>' +
    '<path d="M15.5 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/>'
  )
};

/* Phones that report a coarse pointer get a slightly heavier stroke: at
   44px the 2px stroke on a 3x screen reads as hairline-thin, which looks
   unfinished rather than delicate. */
function icon(name) {
  var s = ICONS[name];
  return s === undefined ? '' : s;
}

export { icon, ICONS };
