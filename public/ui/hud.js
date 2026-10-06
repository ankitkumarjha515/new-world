/* ==========================================================================
   WHISPERING MEADOW - HUD

   There is deliberately NO heads-up display over the world.

   An earlier version of this file put a sliding compass strip at the top of
   the screen and announced the name of each region as you walked into it
   ("The Riverbank", "Sunflower East"). Both were removed on sight: this is a
   game about walking somewhere quiet and looking at it, and a navigation
   arrow plus a text prompt every time you near the water turns that into an
   objective marker. If you want to know where the river is, you look at it.

   They were not free either. The compass was a masked, composited layer with
   its transform rewritten every single frame, and the region label walked the
   river polyline four times a second - a steady cost on exactly the weak
   hardware the rest of this work is trying to help.

   What is left is the performance readout, which is off unless you ask for it
   (F3, or the switch in the settings panel). It is the one thing that has to
   draw over the world, because measuring the frame is the whole point of it.

   If a HUD element is ever wanted again, the rule this file was rebuilt under
   is: nothing permanent over the picture, and nothing that costs a frame.
   ========================================================================== */

var dom = null;

function buildHUD(root) {
  var diag = document.createElement('div');
  diag.id = 'diag';
  root.appendChild(diag);
  dom = { diag: diag };
  return dom;
}

function setDiag(text) {
  if (!dom) { return; }
  dom.diag.textContent = text;
}

function showDiag(on) {
  if (!dom) { return; }
  dom.diag.classList.toggle('on', !!on);
}

function diagVisible() {
  return !!(dom && dom.diag.classList.contains('on'));
}

/* Kept as no-ops so ui.js and main.js have one shape to call into whether or
   not anything is being displayed - and so that bringing a HUD element back
   is a change in one file rather than three. */
function show() {}
function tick() {}
function measure() {}
function setHeading() {}
function setRegion() {}
function setPlayers() {}

export { buildHUD, setDiag, showDiag, diagVisible, show, tick, measure, setHeading, setRegion, setPlayers };
