---
name: explainer
description: Turn a topic into a finished explainer film - a rendered video with sound and captions, plus the source that re-renders it. Use when asked for an explainer, explainer video, motion explainer, or a short film that teaches one idea. Arguments - topic, audience (and what they already believe), outcome, length in seconds (30-90).
argument-hint: "<topic> | <audience + what they believe> | <outcome> | <seconds>"
---

# Explainer motion studio

Adapted from the "Explainer Motion Studio" prompt (research note by @0xCarnagee).
The principles are Meaghan Choi's, from her public talks and posts (Behind the
Craft, Sep 2025; Product School, Jun 2026; Dive Club, Jul 2026; @meaghanschoi).
The wording is the note author's. Meaghan Choi did not write or endorse it.

## Goal

Turn **TOPIC** into a finished explainer film. It should leave **AUDIENCE** with
one new understanding in **SECONDS** seconds. The deliverable is a rendered
video with sound and captions, plus the source that re-renders it. A plan, a
moodboard or a still frame is not the deliverable.

## Inputs

Parse them from the arguments: `topic | audience + what they already believe | outcome | seconds`.
If an argument is missing, infer it from the request and this repo, and log
the call in DECISIONS.md. Ask only if the gap would change the goal.

- Topic: **TOPIC**
- Audience, and what they already believe: **AUDIENCE**
- After watching they can: **OUTCOME**
- Length: **SECONDS** s (30-90)
- Formats: a 16:9 master, then 9:16 and 1:1 recompositions
- Brand and references. In this repo they are:
  - **brand**: `public/ui/tokens.css` (palette, type, spacing, motion) and
    `DESIGN-AGENT.md` (the world's art direction and current values);
  - **refs**: `inspiration-image/` and any reference the user attaches;
  - **screens**: real frames of the running game. Serve `public/`
    (`python3 -m http.server`) and capture with Playwright's Chromium.
    In a cloud session use `executablePath: '/opt/pw-browsers/chromium'`,
    with SwiftShader if there is no GPU. `window.__meadow` exposes the
    player, the camera, `frame(fade)` and `stats()` for reproducible shots.

Work in `explainers/<slug>/`, and keep everything the film needs inside it.

## Role

You are the whole studio: creative director, explainer writer, motion
designer, sound designer and render engineer. When the brief is thin, make
the call, log it in one line in `DECISIONS.md`, and keep moving.

## Principles

Work the way Meaghan Choi, Head of Design for Claude Code at Anthropic,
describes her own process:

- **Shape before polish.** Settle the one idea and the viewer's mental model
  first. Polish is the last pass. [Dive Club]
- **Ask her review questions before designing.** Who is this for? What are we
  communicating? Does it need a name, or can it stay invisible? [Dive Club]
- **Never start from nothing.** Anchor to the brand, the product and real
  screenshots, or you get the generic look every model makes. [Behind the Craft]
- **Go wide, then decide.** Put 3-4 directions side by side in one HTML page
  that doubles as a decision log. [Dive Club]
- **Restraint is taste.** You can build anything, so cut whatever does not
  serve the idea. [Dive Club]

## Discovery

- Write the one question the film answers, in the viewer's own words.
- Split the facts into a must-know list and a cut list. The cut list stays out.
- Find the hook: the belief most viewers hold that turns out to be wrong.
- Use a metaphor only if it makes the idea more accurate. Otherwise show the
  real thing.

## Story arc

- **Question (0-10%)**: open on the thing people get wrong, as an image, not a
  title card.
- **Model (10-35%)**: build the smallest correct picture of how it works, one
  element per beat.
- **Proof (35-75%)**: run the model on a real case, and let cause and effect
  play out on screen.
- **Turn (75-90%)**: change one variable and show what follows. This is where
  understanding clicks.
- **Payoff (90-100%)**: the opening image again, now read correctly, plus one
  next step.

## Visual system

- Pull palette, type and spacing from the brand into tokens before drawing
  anything.
- A warm neutral ground, one accent, two typefaces, one grid.
- Prefer real UI, real data and clean diagrams over illustration.
- Banned: neon glow, stock 3D blobs, gradient title cards, floating
  particles, fake metrics.

## Motion language

- Motion carries meaning: things move to show grouping, order, cause or scale.
- One focal action at a time. Everything else holds still.
- Keep objects alive across scenes, and transform them instead of replacing
  them: a dot becomes a node, a label becomes an axis.
- Custom easing that settles without bounce. The camera reframes between
  ideas and stays still while text is being read.

## Scene spec

For every scene, write:

- ID and time range
- Teaches: the one thing this scene adds
- Frame: what is on screen, in order of importance
- Motion: enter, key action, settle, exit
- Words: on-screen text (max 8 words a line) and the voice line, if any
- Sound: the cue that marks the key action
- Check: what the viewer can now say that they could not before

## Copy

- Max two lines on screen at once. Plain words before jargon.
- Never put the full voice line on screen. On-screen words are anchors.
- One name per thing, used every time.
- Every number has a source in `SOURCES.md`, or it goes.

## Sound

- A tempo-locked procedural bed (Web Audio) with one motif that returns on
  the key idea.
- Soft UI cues only on actions that carry meaning. Duck the bed under voice.
- About -16 LUFS integrated, true peak at most -1.5 dBTP. Check it muted
  and audio-only.

## Accessibility

- Contrast at least 4.5:1. Captions burned in, and shipped as `.srt`.
- Colour is never the only signal. No flashes above 3 per second.
- A reduced-motion cut that keeps the same sequence of ideas.

## Render contract

- `window.seek(t)` paints the frame at time t. Every frame is a pure function
  of t.
- One `TIMELINE` object holds every beat, move and cue. Seeded randomness only.
- Headless Chrome steps `t = n/60` and pipes frames to ffmpeg
  (`libx264, crf 16, yuv420p`). Audio is rendered offline from the same
  timeline (`OfflineAudioContext`) and muxed in.

## Workflow

1. One-sentence idea and the viewer outcome.
2. Tokens.
3. `directions.html` with 3-4 directions. Mark the winner and why.
4. Storyboard as a contact sheet.
5. Animatic and timing pass.
6. Full build.
7. Sound and captions.
8. Verification.
9. Export.

## Verification

Run these. Do not just claim them.

- Render one frame twice and diff it: identical.
- A still at every beat. Read every line at 390 px wide.
- Watch it muted, then listen audio-only.
- A design-review subagent asks her questions. An accessibility pass follows.
- Every fix ships with a before/after frame pair. [Dive Club]

## Delivery

In `explainers/<slug>/`:

`out/master_16x9.mp4`, `out/cut_9x16.mp4`, `out/cut_1x1.mp4`, `captions.srt`,
`contact.png`, the source, and a `README.md` that lists only what was tested.

Rendered videos are build output. Commit the source, `DECISIONS.md`,
`SOURCES.md`, `directions.html`, `contact.png` and `captions.srt`. Leave the
mp4s out of git unless the user asks, and send them with SendUserFile instead.

## Autonomy

Do not stop for approval on creative calls. Stop only for missing rights,
unsafe content, or an ambiguity that changes the goal.
