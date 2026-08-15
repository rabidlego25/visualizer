/* plan.js — turn a song timeline into a LOOP PLAN: which bars to post, and what the
   visuals do across them.

   WHY THIS SHAPE
   The target is an 8-16 bar loop (15-30s at typical tempo) for Instagram, because that
   is what eva.html's clip selector already defaults to and what CLAUDE.md's own strategy
   argues for ("a seamless loop earns replays"). That length is the WORST case for a
   conventional auto-editor -- 8 bars is two 4-bar phrases, so there is room for exactly
   one cut, and any narrative arc grammar is irrelevant.

   What it is good for is the defect CLAUDE.md already documents about loop recording:

       "this makes the AUDIO loop. The visuals don't return to a previous state
        (the force-directed web and the fluid never do), so the seam is continuity."

   A planned shot sequence fixes that, and not by making the visuals return -- they
   can't, the sims are irreversible. Instead the LOOP POINT IS A CUT. When the last shot
   ends exactly at the loop boundary and the first shot begins there, the wrap-around
   reads as a deliberate hard cut on a downbeat rather than as a glitch. That inverts the
   problem: the discontinuity becomes the edit.

   From which the one hard rule of this module follows: THE LAST SHOT MUST DIFFER FROM
   THE FIRST. Same engine across the seam exposes the state jump; a different engine
   hides it. See planShots().

   Pure logic over the timeline -- no Web Audio, no DOM, no rendering -- so it runs in a
   Worker, in the page, and in Node against constructed timelines with known structure.
   That is the whole reason it is a separate file: tools/test_plan.mjs can check the
   planner in milliseconds instead of minutes of software WebGL.

   Classic script (assigns self.SongPlan), matching analysis.js, so importScripts and
   Node eval both work with no build step.
*/
(function (root) {
  'use strict';

  // Deterministic PRNG. The plan must be reproducible from (timeline, seed) or "reroll"
  // is not a feature, it is a coin flip you cannot get back. Note this makes the PLAN
  // reproducible, NOT the rendered video -- eva.html still has ~22 unseeded Math.random
  // calls and an adaptive resolution scaler, so identical plans render differently.
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  const ENGINES = ['web', 'nebula', 'water', 'fluid'];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }

  // ---- 1. which bars to post ----------------------------------------------------
  /* Score every downbeat-aligned window of `bars` length and return the best few.

     The criteria that matter for a LOOP are not the criteria for an excerpt. A trailer
     wants a build; a loop wants to be able to run twice in a row without the join
     announcing itself. So energy MATCH between the first and last bar is weighted
     heavily, and a window that straddles a big section change near its end is penalised
     even if it is individually exciting.
  */
  function pickLoop(tl, opts) {
    opts = opts || {};
    const bars = opts.bars || 8;
    const top = opts.top || 3;
    if (!tl || !tl.ok || !tl.downbeats || !tl.arc) return [];
    const db = tl.downbeats, arc = tl.arc;
    const nBars = Math.min(db.length - 1, arc.length);
    if (nBars <= bars) return [];

    const sectionStartBars = new Set((tl.sections || []).map(s => s.startBar));
    const labelAt = (bar) => {
      const s = (tl.sections || []).find(x => bar >= x.startBar && bar < x.endBar);
      return s ? s.label : '';
    };

    const out = [];
    for (let b = 0; b + bars <= nBars; b++) {
      const win = arc.slice(b, b + bars);
      const e = mean(win);
      const why = [];
      let score = e * 100;                                   // loud is the base currency
      why.push(`energy ${e.toFixed(2)}`);

      // Loop join: the last bar should feel like the bar before the first. This is the
      // criterion that distinguishes a loop from an excerpt, so it is weighted to matter.
      const join = 1 - Math.abs(win[0] - win[win.length - 1]);
      score += join * 40;
      if (join > 0.9) why.push('clean loop join');

      // Starting on a section boundary is a musically clean entry -- the listener drops
      // into the top of a phrase rather than halfway through one.
      if (sectionStartBars.has(b)) { score += 25; why.push('starts on a section'); }

      // The hook. DROP and CHORUS are what a promo clip is for -- but the label bonus is
      // SCALED BY MEASURED ENERGY, deliberately. Labels are the least reliable thing in
      // the timeline (a heuristic over the energy arc, as analysis.js says outright),
      // while `arc` is measured. With a flat bonus a mislabelled quiet section beats a
      // genuinely loud one: on a real timeline a 0.53-energy bar labelled DROP scored 162
      // against 155 for a 0.74-energy window. Scaling subordinates the guess to the
      // measurement while keeping the intent.
      const lab = labelAt(b);
      if (lab === 'DROP') { score += 45 * e; why.push(`DROP x${e.toFixed(2)}`); }
      else if (lab === 'CHORUS') { score += 35 * e; why.push(`CHORUS x${e.toFixed(2)}`); }
      else if (lab === 'BUILD') { score -= 10; why.push('build (resolves outside the loop)'); }
      else if (lab === 'INTRO' || lab === 'OUTRO') { score -= 30; why.push(lab.toLowerCase()); }

      // A section change inside the window is fine early (it is a lift) but bad late --
      // the loop would end somewhere musically different from where it starts.
      for (const s of (tl.sections || [])) {
        if (s.startBar > b && s.startBar < b + bars) {
          const frac = (s.startBar - b) / bars;
          if (frac > 0.6) { score -= 30; why.push('section change near the end'); }
        }
      }

      // Flat windows loop cleanly but are boring; a little internal movement is good.
      const spread = Math.max.apply(null, win) - Math.min.apply(null, win);
      score += clamp(spread, 0, 0.35) * 30;

      out.push({
        startBar: b, bars,
        start: +db[b].toFixed(3),
        end: +db[b + bars].toFixed(3),
        duration: +(db[b + bars] - db[b]).toFixed(3),
        energy: +e.toFixed(3),
        join: +join.toFixed(3),
        label: lab,
        score: +score.toFixed(1),
        why
      });
    }
    out.sort((x, y) => y.score - x.score);

    // Spread the results out: three overlapping windows one bar apart are one answer,
    // not three, and offering them as alternatives is a worse experience than offering
    // genuinely different moments in the song.
    const picked = [];
    for (const c of out) {
      if (picked.every(p => Math.abs(p.startBar - c.startBar) >= bars / 2)) picked.push(c);
      if (picked.length >= top) break;
    }
    return picked;
  }

  // ---- 2. what the visuals do across it -------------------------------------------
  /* Compose 2-4 shots over the loop and return an EDL.

     Cuts land only on 4-bar phrase boundaries. A cut on bar 3 of 8 reads as a glitch; a
     cut on bar 4 reads as an edit. At 8 bars that permits exactly one cut, which is the
     honest ceiling at this length -- the value here is not cut COUNT.
  */
  function planShots(tl, loop, opts) {
    opts = opts || {};
    const rnd = mulberry32((opts.seed == null ? 1 : opts.seed) | 0);
    const style = opts.style || 'default';
    const available = opts.engines && opts.engines.length ? opts.engines.slice() : ENGINES.slice();
    const themes = opts.themes || 5;
    const bars = loop.bars;
    const barDur = loop.duration / bars;

    // Cut density: more energy earns more cuts, but the phrase grid is the hard limit.
    // PHRASE=4 bars. 8 bars -> at most 1 cut. 16 bars -> at most 3.
    const PHRASE = 4;
    const maxCuts = Math.max(0, Math.floor(bars / PHRASE) - 1);
    let nCuts = maxCuts;
    if (style === 'minimal') nCuts = Math.min(1, maxCuts);
    else if (style === 'calm') nCuts = Math.min(1, maxCuts);
    else if (loop.energy < 0.45) nCuts = Math.min(1, maxCuts);
    // A single shot cannot hide the loop seam -- see the module comment -- so a loop
    // plan always has at least two shots when the grid allows one cut at all.
    if (maxCuts >= 1) nCuts = Math.max(1, nCuts);

    const cutBars = [];
    for (let i = 1; i <= nCuts; i++) cutBars.push(Math.round(i * bars / (nCuts + 1) / PHRASE) * PHRASE);
    const bounds = [0].concat(cutBars.filter((v, i, a) => v > 0 && v < bars && a.indexOf(v) === i));

    // pick a first look, then make every subsequent shot CONTRAST with its predecessor
    const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];
    const baseTheme = Math.floor(rnd() * themes);
    const shots = [];
    for (let i = 0; i < bounds.length; i++) {
      const b0 = bounds[i];
      const b1 = i + 1 < bounds.length ? bounds[i + 1] : bars;
      let engine;
      if (i === 0) {
        engine = pick(available);
      } else {
        const others = available.filter(e => e !== shots[i - 1].engine);
        engine = others.length ? pick(others) : shots[i - 1].engine;
      }
      const eHere = mean((tl.arc || []).slice(loop.startBar + b0, loop.startBar + b1)) || loop.energy;
      shots.push({
        bar: b0,
        start: +(loop.start + b0 * barDur).toFixed(3),
        end: +(loop.start + b1 * barDur).toFixed(3),
        engine,
        theme: (baseTheme + (i === 0 ? 0 : 1 + Math.floor(rnd() * (themes - 1)))) % themes,
        density: +clamp(0.35 + eHere * 0.75, 0.2, 1).toFixed(2),
        trails: rnd() < (style === 'calm' ? 0.2 : 0.55),
        transition: i === 0 ? 'cut' : 'cut'
      });
    }

    // THE LOOP RULE. At the wrap-around the last shot runs straight into the first. If
    // they share an engine the viewer sees the sim jump state -- the exact seam this is
    // meant to hide. If they differ, the wrap reads as one more hard cut on a downbeat.
    let seamFixed = false;
    if (shots.length > 1 && shots[shots.length - 1].engine === shots[0].engine) {
      const others = available.filter(e => e !== shots[0].engine
        && (shots.length < 3 || e !== shots[shots.length - 2].engine));
      if (others.length) { shots[shots.length - 1].engine = pick(others); seamFixed = true; }
    }

    return {
      version: 1,
      seed: (opts.seed == null ? 1 : opts.seed) | 0,
      style,
      bpm: tl.tempo ? tl.tempo.bpm : null,
      loop: { startBar: loop.startBar, bars, start: loop.start, end: loop.end,
              duration: loop.duration, label: loop.label },
      shots,
      // true when the seam rule had to intervene; surfaced so a test can assert the rule
      // actually fired rather than passing by luck
      seamFixed,
      seamEngines: [shots[0].engine, shots[shots.length - 1].engine]
    };
  }

  // convenience: timeline in, finished plan out
  function planLoop(tl, opts) {
    opts = opts || {};
    const cands = pickLoop(tl, opts);
    if (!cands.length) return null;
    const plan = planShots(tl, cands[0], opts);
    plan.alternatives = cands.slice(1);
    return plan;
  }

  root.SongPlan = { pickLoop, planShots, planLoop, ENGINES, mulberry32 };
})(typeof self !== 'undefined' ? self : globalThis);
