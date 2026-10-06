/* ==========================================================================
   WHISPERING MEADOW - screens

   Boot, title, pause and settings. Each one is built once, as a DOM subtree
   under #ui, and shown by toggling a class - nothing is created or destroyed
   while the game is running, so opening the pause menu never allocates.

   The settings panel is the half of settings.js that was missing: that file
   has always stored lookSens, touchSens, invertY and name, and player.js has
   always read them, but nothing in the game could write them. Everything
   here goes through MeadowSettings.set(), which validates, persists and
   notifies - the screens hold no state of their own.
   ========================================================================== */

import { icon } from './icons.js';
import { isTouchDevice } from './controls.js';

/* ==========================================================================
   Small builders
   ========================================================================== */
function el(tag, cls, html) {
  var n = document.createElement(tag);
  if (cls) { n.className = cls; }
  if (html !== undefined) { n.innerHTML = html; }
  return n;
}

function iconBtn(id, name, label) {
  var b = el('button', 'btn btn-icon', icon(name));
  b.type = 'button';
  b.id = id;
  b.setAttribute('aria-label', label);
  b.title = label;
  return b;
}

/* One settings row: a label, an optional explanation, and a control. */
function row(labelText, subText, ctl, opts) {
  var r = el('div', 'row' + (opts && opts.stack ? ' stack' : ''));
  var lab = el('div', 'row-label');
  lab.appendChild(el('span', null, labelText));
  if (subText) { lab.appendChild(el('small', null, subText)); }
  r.appendChild(lab);
  var box = el('div', 'row-ctl');
  if (opts && opts.value) { box.appendChild(opts.value); }
  box.appendChild(ctl);
  r.appendChild(box);
  return r;
}

function group(title) {
  var g = el('div', 'group');
  g.appendChild(el('h3', null, title));
  return g;
}

/* ---- slider -------------------------------------------------------------
   `format` turns the raw value into what the player reads, so the same
   widget serves a percentage, a degree count and a bare multiplier. */
function slider(min, max, step, value, format, onInput) {
  var out = el('span', 'row-val');
  var input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);

  function paint() { out.textContent = format(parseFloat(input.value)); }
  paint();
  /* 'input' fires continuously while dragging, which is what makes the FOV
     and resolution sliders feel live. MeadowSettings.set() ignores a write
     that does not change the value, so the storm of identical events a
     slider produces costs one comparison each. */
  input.addEventListener('input', function () {
    paint();
    onInput(parseFloat(input.value));
  });
  return { input: input, out: out, sync: function (v) { input.value = String(v); paint(); } };
}

/* ---- switch ------------------------------------------------------------- */
function toggle(value, onChange) {
  var b = el('button', 'switch');
  b.type = 'button';
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-checked', value ? 'true' : 'false');
  b.addEventListener('click', function () {
    var next = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', next ? 'true' : 'false');
    onChange(next);
  });
  return { input: b, sync: function (v) { b.setAttribute('aria-checked', v ? 'true' : 'false'); } };
}

/* ---- segmented choice --------------------------------------------------- */
function segmented(options, value, onChange) {
  var wrap = el('div', 'seg');
  var btns = [];
  options.forEach(function (o) {
    var b = el('button', null, o.label);
    b.type = 'button';
    b.setAttribute('aria-pressed', o.value === value ? 'true' : 'false');
    b.addEventListener('click', function () {
      btns.forEach(function (x) {
        x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
      });
      onChange(o.value);
    });
    btns.push(b);
    wrap.appendChild(b);
  });
  return {
    input: wrap,
    sync: function (v) {
      btns.forEach(function (b, i) {
        b.setAttribute('aria-pressed', options[i].value === v ? 'true' : 'false');
      });
    }
  };
}

/* ==========================================================================
   Boot
   ========================================================================== */
function buildBoot(root) {
  /* index.html ships this card as static markup so it paints before any
     module has run - see the comment on it there. Adopted IN PLACE rather
     than moved into #ui: reparenting a node restarts its CSS transitions in
     some browsers, and this one is already at its end state. Built from
     scratch only if the markup is missing, which keeps ui/ working if it is
     ever mounted into a page that does not have it. */
  var s = document.getElementById('screen-boot');
  if (!s) {
    s = el('div', 'screen opaque on');
    s.id = 'screen-boot';
    s.innerHTML =
      '<div class="card">' +
        '<h1 class="wordmark wordmark-xl"><b>whispering</b>meadow<span>.world</span></h1>' +
        '<div class="kicker">A place that does not exist</div>' +
        '<div id="boot-bar"><i></i></div>' +
        '<div id="boot-msg">Growing the world&hellip;</div>' +
      '</div>';
    root.appendChild(s);
  }
  return {
    screen: s,
    bar: s.querySelector('#boot-bar > i'),
    msg: s.querySelector('#boot-msg')
  };
}

/* ==========================================================================
   Title

   Over the live world rather than over a gradient. The world was already
   being rendered behind this screen and then hidden under an opaque veil -
   the player never saw the meadow they were about to walk into.
   ========================================================================== */
function buildTitle(root) {
  var touch = isTouchDevice();
  var s = el('div', 'screen veiled');
  s.id = 'screen-title';

  var legend = touch
    ? '<div class="keys">' +
        '<span><b>left</b> walk</span>' +
        '<span><b>drag</b> look</span>' +
        '<span><b>double-tap</b> run</span>' +
        '<span><b>jump</b> hop</span>' +
      '</div>'
    : '<div class="keys">' +
        '<span><b>wasd</b> walk</span>' +
        '<span><b>mouse</b> look</span>' +
        '<span><b>shift</b> run</span>' +
        '<span><b>space</b> jump</span>' +
        '<span><b>esc</b> pause</span>' +
      '</div>';

  var hint = touch
    ? 'Headphones if you have them &middot; either orientation works'
    : 'Best with headphones &middot; click to capture the mouse';

  /* A printed ticket rather than a glass panel: a stub with a perforation,
     a serif line you could read aloud, and one obvious way in. */
  s.innerHTML =
    '<div class="card ticket">' +
      '<div class="ticket-head"><span>Walk &#8470; 01</span><span>~&infin; min &middot; outside only</span></div>' +
      '<div class="ticket-perf" aria-hidden="true"></div>' +
      '<h1 class="ticket-title">Walk somewhere quiet.<br>Stay as long as you like.</h1>' +
      '<p class="ticket-whisper">' + icon('cloud') +
        '<span>the meadow asked: &ldquo;When did you last look up?&rdquo;</span></p>' +
      '<p class="ticket-note">Sunflowers east &middot; a waterfall north &middot; a warm sea downriver</p>' +
      legend +
      '<div class="btn-row">' +
        '<button type="button" class="btn btn-primary" id="btn-enter">Step outside ' + icon('arrow') + '</button>' +
        '<button type="button" class="btn btn-ghost" id="btn-title-settings">' + icon('gear') + ' settings</button>' +
      '</div>' +
      '<div class="hint">' + hint + '</div>' +
    '</div>';
  root.appendChild(s);
  return {
    screen: s,
    enter: s.querySelector('#btn-enter'),
    settings: s.querySelector('#btn-title-settings')
  };
}

/* ==========================================================================
   Pause

   This screen could not be reached at all on a phone. player.js drove it off
   pointerlockchange, and pointer lock does not exist on touch, so there was
   no pause, no settings and no way back to the title - and a stray tap
   resumed play because main.js had a document-wide click handler.
   ========================================================================== */
function buildPause(root) {
  var s = el('div', 'screen veiled');
  s.id = 'screen-pause';
  s.innerHTML =
    '<div class="card ticket ticket-sm">' +
      '<div class="ticket-head"><span>Paused</span><span>the wind is holding its breath</span></div>' +
      '<div class="ticket-perf" aria-hidden="true"></div>' +
      '<h1 class="ticket-title">Still here.<br>Whenever you are ready.</h1>' +
      '<div class="btn-row">' +
        '<button type="button" class="btn btn-primary" id="btn-resume">Back to the meadow ' + icon('arrow') + '</button>' +
        '<button type="button" class="btn btn-ghost" id="btn-pause-settings">' + icon('gear') + ' settings</button>' +
      '</div>' +
    '</div>';
  root.appendChild(s);
  return {
    screen: s,
    resume: s.querySelector('#btn-resume'),
    settings: s.querySelector('#btn-pause-settings')
  };
}

/* ==========================================================================
   Settings
   ========================================================================== */
function buildSettings(root) {
  var S = window.MeadowSettings;
  var touch = isTouchDevice();
  var s = el('div', 'screen');
  s.id = 'settings';

  var sheet = el('div', 'sheet');
  var head = el('div', 'sheet-head');
  head.appendChild(el('h2', null, 'Settings'));
  var closeBtn = iconBtn('btn-settings-close', 'close', 'Close settings');
  head.appendChild(closeBtn);
  sheet.appendChild(head);

  var body = el('div', 'sheet-body');
  var widgets = {};

  function cur(k) { return S ? S.get()[k] : null; }
  function put(k, v) { if (S) { S.set(k, v); } }

  /* ---- display --------------------------------------------------------- */
  var gD = group('Display');

  widgets.quality = segmented([
    { value: 'auto', label: 'Auto' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Med' },
    { value: 'high', label: 'High' }
  ], cur('quality'), function (v) { put('quality', v); });
  gD.appendChild(row('Quality',
    'Auto reads the hardware. Pin it if Auto guesses wrong - it cannot tell a ' +
    'new phone from an old one. Grass density changes on your next visit.',
    widgets.quality.input, { stack: true }));

  /* 0.45 on the track is the Auto notch: below the real 0.50 floor, so it
     cannot be confused with a pinned value, and leftmost so "less than the
     lowest setting" reads as "let the game decide". */
  widgets.resScale = slider(0.45, 1.0, 0.05, cur('resScale') || 0.45,
    function (v) { return v < 0.5 ? 'Auto' : Math.round(v * 100) + '%'; },
    function (v) { put('resScale', v < 0.5 ? 0 : v); });
  gD.appendChild(row('Resolution',
    'How many pixels the world is drawn with. Menus and text are always sharp.',
    widgets.resScale.input, { value: widgets.resScale.out }));

  widgets.bloom = segmented([
    { value: 'auto', label: 'Auto' },
    { value: 'on', label: 'On' },
    { value: 'off', label: 'Off' }
  ], cur('bloom'), function (v) { put('bloom', v); });
  gD.appendChild(row('Glow and sun shafts',
    'The prettiest thing to switch off if the frame rate is struggling.',
    widgets.bloom.input));

  widgets.fov = slider(55, 88, 1, cur('fov'),
    function (v) { return Math.round(v) + '°'; },
    function (v) { put('fov', v); });
  gD.appendChild(row('Field of view', null,
    widgets.fov.input, { value: widgets.fov.out }));

  body.appendChild(gD);

  /* ---- controls -------------------------------------------------------- */
  var gC = group('Controls');

  if (touch) {
    widgets.touchSens = slider(0.25, 2.5, 0.05, cur('touchSens'),
      function (v) { return v.toFixed(2) + '×'; },
      function (v) { put('touchSens', v); });
    gC.appendChild(row('Look sensitivity', 'How far the view turns per thumb drag.',
      widgets.touchSens.input, { value: widgets.touchSens.out }));
  } else {
    widgets.lookSens = slider(0.2, 3.0, 0.05, cur('lookSens'),
      function (v) { return v.toFixed(2) + '×'; },
      function (v) { put('lookSens', v); });
    gC.appendChild(row('Mouse sensitivity', null,
      widgets.lookSens.input, { value: widgets.lookSens.out }));
  }

  widgets.invertY = toggle(cur('invertY'), function (v) { put('invertY', v); });
  gC.appendChild(row('Invert vertical look', null, widgets.invertY.input));

  /* navigator.vibrate has never existed in Safari, so on an iPhone this row
     would be a switch that does nothing. Hidden rather than disabled. */
  if (touch && navigator.vibrate) {
    widgets.haptics = toggle(cur('haptics'), function (v) { put('haptics', v); });
    gC.appendChild(row('Vibration', 'A short buzz on jumping and on starting a run.',
      widgets.haptics.input));
  }

  body.appendChild(gC);

  /* ---- sound ----------------------------------------------------------- */
  var gS = group('Sound');
  widgets.volume = slider(0, 1, 0.05, cur('volume'),
    function (v) { return v <= 0 ? 'Muted' : Math.round(v * 100) + '%'; },
    function (v) { put('volume', v); });
  gS.appendChild(row('Volume', 'Wind, water and footsteps.',
    widgets.volume.input, { value: widgets.volume.out }));
  body.appendChild(gS);

  /* ---- you ------------------------------------------------------------- */
  var gY = group('You');
  var nameIn = document.createElement('input');
  nameIn.type = 'text';
  nameIn.maxLength = 16;
  nameIn.placeholder = 'Walker';
  nameIn.autocomplete = 'off';
  nameIn.spellcheck = false;
  nameIn.value = cur('name') || '';
  nameIn.addEventListener('change', function () { put('name', nameIn.value); });
  /* Written on blur as well as on change: on a phone the keyboard's "done"
     key does not always fire change before the panel is dismissed. */
  nameIn.addEventListener('blur', function () { put('name', nameIn.value); });
  widgets.name = { input: nameIn, sync: function (v) { nameIn.value = v || ''; } };
  gY.appendChild(row('Name', 'Shown to other people walking here. Blank is fine.',
    nameIn, { stack: true }));
  body.appendChild(gY);

  /* ---- diagnostics ----------------------------------------------------- */
  var gX = group('Diagnostics');
  widgets.showPerf = toggle(cur('showPerf'), function (v) { put('showPerf', v); });
  gX.appendChild(row('Performance readout',
    'Frame rate, draw calls and the quality tier actually in use. F3 also toggles it.',
    widgets.showPerf.input));
  body.appendChild(gX);

  sheet.appendChild(body);

  /* ---- foot ------------------------------------------------------------ */
  var foot = el('div', 'sheet-foot');
  var resetBtn = el('button', 'btn btn-ghost', 'Reset');
  resetBtn.type = 'button';
  resetBtn.id = 'btn-settings-reset';
  foot.appendChild(resetBtn);
  foot.appendChild(el('div', 'spacer'));
  var doneBtn = el('button', 'btn btn-primary', 'Done');
  doneBtn.type = 'button';
  doneBtn.id = 'btn-settings-done';
  doneBtn.style.marginTop = '0';
  foot.appendChild(doneBtn);
  sheet.appendChild(foot);

  s.appendChild(sheet);
  root.appendChild(s);

  /* Pull every control back in line with stored state. Called after Reset,
     and after any outside write (the F3 key also flips showPerf). */
  function sync() {
    if (!S) { return; }
    var v = S.get();
    if (widgets.quality) { widgets.quality.sync(v.quality); }
    if (widgets.resScale) { widgets.resScale.sync(v.resScale || 0.45); }
    if (widgets.bloom) { widgets.bloom.sync(v.bloom); }
    if (widgets.fov) { widgets.fov.sync(v.fov); }
    if (widgets.touchSens) { widgets.touchSens.sync(v.touchSens); }
    if (widgets.lookSens) { widgets.lookSens.sync(v.lookSens); }
    if (widgets.invertY) { widgets.invertY.sync(v.invertY); }
    if (widgets.haptics) { widgets.haptics.sync(v.haptics); }
    if (widgets.volume) { widgets.volume.sync(v.volume); }
    if (widgets.name) { widgets.name.sync(v.name); }
    if (widgets.showPerf) { widgets.showPerf.sync(v.showPerf); }
  }

  resetBtn.addEventListener('click', function () {
    if (S) { S.reset(); }
    sync();
  });

  return {
    screen: s,
    close: closeBtn,
    done: doneBtn,
    reset: resetBtn,
    sync: sync
  };
}

export { buildBoot, buildTitle, buildPause, buildSettings, iconBtn };
