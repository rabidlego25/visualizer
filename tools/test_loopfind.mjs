/* test_loopfind.mjs — harness for the LOOP FINDER wiring in eva.html.

   tools/test_plan.mjs already proves pickLoop's SCORING against timelines with known
   structure. This covers the part that lives in eva.html and that test_plan cannot see:
   the glue between the director's timeline, the clip select, the media element and the
   arming path. Integration bugs live in glue, and this glue has one genuinely subtle
   piece in it -- the one-bar lead-in.

   THE LEAD-IN IS THE WHOLE REASON THIS FILE EXISTS. Bar-locked recording ARMS and then
   cues in on the NEXT downbeat (recTick). So cueing the playhead exactly to a window's
   start makes Rec catch the downbeat AFTER it, and the take is one bar off the plan --
   silently, with every individual component behaving correctly. That is the same shape
   as the four-on-the-floor downbeat bug: everything measures fine and the result is
   subtly wrong. A regression here would be invisible in any screenshot.

   Code is LIFTED out of eva.html rather than copied, so it cannot pass while the app is
   broken. Same trick as test_cuts.mjs / test_loopenv.mjs.

   Usage: node tools/test_loopfind.mjs
*/
import fs from 'node:fs';

const eva  = fs.readFileSync(new URL('../eva.html', import.meta.url), 'utf8');
const plan = fs.readFileSync(new URL('../plan.js', import.meta.url), 'utf8');

function lift(startMark, endMark, what){
  const a = eva.indexOf(startMark);
  if (a < 0){ console.error(`FAIL: could not find ${what} in eva.html`); process.exit(1); }
  const b = eva.indexOf(endMark, a);
  if (b < 0){ console.error(`FAIL: could not find the end of ${what}`); process.exit(1); }
  return eva.slice(a, b);
}
const findSrc = lift('  let loopCands = null,', '  // ---------------- THE GATE', 'the loop finder');
const fmtSrc  = lift('  function fmt(s){', '\n', 'fmt');

// ---- a timeline with known structure, mirroring tools/test_plan.mjs ----------------
const BPM = 120, BEAT = 60/BPM, BAR = BEAT*4, BARS = 48;
const ARC = [];
for (let b = 0; b < BARS; b++){
  if (b < 8) ARC.push(0.20);
  else if (b < 16) ARC.push(0.30 + (b-8)/8*0.35);
  else if (b < 32) ARC.push(1.00);
  else if (b < 40) ARC.push(0.38);
  else ARC.push(0.28);
}
const SECTIONS = [
  { startBar:0,  endBar:8,  label:'INTRO',     energy:0.20 },
  { startBar:8,  endBar:16, label:'BUILD',     energy:0.48 },
  { startBar:16, endBar:32, label:'DROP',      energy:1.00 },
  { startBar:32, endBar:40, label:'BREAKDOWN', energy:0.38 },
  { startBar:40, endBar:48, label:'OUTRO',     energy:0.28 },
].map(s => ({ ...s, bars: s.endBar-s.startBar, start: s.startBar*BAR, end: s.endBar*BAR }));
const TL = {
  ok: true, duration: BARS*BAR,
  tempo: { bpm: BPM, confidence: 0.95, meter: 4, beatPeriod: BEAT },
  key: { tonic:'A', mode:'minor', confidence:0.8 },
  downbeats: Array.from({length: BARS}, (_, b) => +(b*BAR).toFixed(3)),
  arc: ARC, sections: SECTIONS, events: [],
  beats: Array.from({length: BARS*4}, (_, i) => +(i*BEAT).toFixed(3)),
};

// plan.js resolves its own root (`typeof self !== 'undefined' ? self : this`), so a local
// `self` inside the harness scope is invisible to it -- it would assign to globalThis and
// the lifted withPlan() would then fall through to document.createElement and throw.
// Give it the global it expects, once.
globalThis.self = globalThis;
new Function(plan)();
if (!globalThis.self.SongPlan){ console.error('FAIL: plan.js did not export SongPlan'); process.exit(1); }

// Everything else the lifted code closes over, stubbed at the boundary only. plan.js is
// the REAL module -- the point is to exercise the wiring against the real scorer.
function harness({ bars = 8, ready = true, tl = TL, status = '' } = {}){
  return new Function(`
    let _bars = ${bars};
    function clipBars(){ return _bars; }
    const flashes = [];
    function hintFlash(m){ flashes.push(m); }
    const director = { ready: ${ready}, tl: ${tl ? 'TL_JSON' : 'null'}, status: ${JSON.stringify(status)} };
    const mediaEl = { currentTime: 0, paused: true };
    function play(){ mediaEl.paused = false; }
    let beatPeriod = ${BEAT};
    ${fmtSrc}
    ${findSrc}
    return {
      findLoops, loopCueTime, flashes, mediaEl, director,
      get idx(){ return loopIdx; }, get cands(){ return loopCands; },
      set bars(v){ _bars = v; }
    };
  `.replace('TL_JSON', JSON.stringify(tl)))();
}

let pass = 0, fail = 0;
const ok = (c, m, x='') => { c ? (pass++, console.log(` ok  ${m}${x?'  ('+x+')':''}`))
                               : (fail++, console.log(`FAIL ${m}${x?'  ('+x+')':''}`)); };

console.log('\n--- the lead-in (the reason this file exists) -------------------------');
{
  const H = harness();
  ok(Math.abs(H.loopCueTime(20, BEAT) - (20 - BAR)) < 1e-9,
     'the cue lands exactly one bar before the window start',
     `20s -> ${H.loopCueTime(20, BEAT)}s (bar = ${BAR}s)`);
  ok(H.loopCueTime(0.5, BEAT) === 0, 'clamped at zero for a window near the top of the track',
     `${H.loopCueTime(0.5, BEAT)}`);
  // the lead must be a whole BAR, not a beat -- a beat of lead-in would leave the arming
  // path catching the same downbeat only if the user reacted within 0.5s
  ok(Math.abs((20 - H.loopCueTime(20, BEAT)) / BEAT - 4) < 1e-9,
     'the lead is four beats, so arming catches the PLANNED downbeat, not the next one');
}
{
  const H = harness();
  H.findLoops();
  const c = H.cands[0];
  ok(Math.abs(H.mediaEl.currentTime - (c.start - BAR)) < 1e-9,
     'findLoops cues the media element one bar early',
     `start ${c.start}s -> cue ${H.mediaEl.currentTime}s`);
  ok(!H.mediaEl.paused, 'and starts playback so the window can be auditioned');
}

console.log('\n--- the shortlist ----------------------------------------------------');
{
  const H = harness();
  H.findLoops();
  ok(H.cands && H.cands.length > 1, 'it is a shortlist, not one answer', `${H.cands.length} candidates`);
  ok(H.cands.length <= 3, 'capped at three', `${H.cands.length}`);
  ok(H.idx === 0, 'the first press selects the top candidate');
  const seen = [H.cands[H.idx].startBar];
  for (let i=0;i<2;i++){ H.findLoops(); seen.push(H.cands[H.idx].startBar); }
  ok(new Set(seen).size === H.cands.length, 'pressing again cycles to a different window',
     `bars ${seen.join(' -> ')}`);
  H.findLoops();
  ok(H.idx === 0, 'and wraps back round to the first', `idx ${H.idx}`);
}
{
  const H = harness();
  H.findLoops();
  ok(H.cands[0].startBar >= 16 && H.cands[0].startBar + 8 <= 32,
     'the top candidate is inside the DROP (the real scorer is wired, not a stub)',
     `startBar ${H.cands[0].startBar} ${H.cands[0].label}`);
  const msg = H.flashes[H.flashes.length-1];
  ok(/LOOP 1\/\d/.test(msg) && /JOIN/.test(msg) && /HIT REC/.test(msg),
     'the readout says which candidate, how clean the join is, and what to do next', msg);
}

console.log('\n--- recompute when the question changes ------------------------------');
{
  const H = harness({ bars: 8 });
  H.findLoops();
  const n8 = H.cands[0].bars;
  H.bars = 16;
  H.findLoops();
  ok(H.cands[0].bars === 16, 'changing the clip length recomputes the shortlist',
     `${n8}-bar -> ${H.cands[0].bars}-bar windows`);
  ok(H.idx === 0, 'and restarts the cycle rather than leaving a stale index');
  ok(H.cands.every(c => c.bars === 16 && Math.abs(c.duration - 16*BAR) < 1e-6),
     'and EVERY candidate is the new length, not just the first',
     `[${H.cands.map(c => c.startBar)}] @ ${H.cands[0].duration}s`);
}

console.log('\n--- it refuses rather than guessing ----------------------------------');
{
  const H = harness({ bars: 0 });                 // clipSel on Free
  H.findLoops();
  ok(!H.cands && /BAR-LOCKED/.test(H.flashes[0] || ''),
     'Free clip length: refuses, because there is no window length to score', H.flashes[0]);
}
{
  const H = harness({ ready: false, status: 'ANALYSING' });
  H.findLoops();
  ok(!H.cands && /ANALYSING/.test(H.flashes[0] || ''),
     'mid-analysis: says so rather than failing silently', H.flashes[0]);
}
{
  const H = harness({ ready: false, tl: null, status: '' });
  H.findLoops();
  ok(!H.cands && /NO ANALYSIS/.test(H.flashes[0] || ''),
     'no timeline at all (mic input, failed analysis): says so', H.flashes[0]);
}
{
  // a track shorter than the window -- pickLoop returns [] and the UI must not crash
  const shortTL = { ...TL, downbeats: TL.downbeats.slice(0, 5), arc: ARC.slice(0, 4) };
  const H = harness({ tl: shortTL });
  H.findLoops();
  ok(/TOO SHORT/.test(H.flashes[0] || ''), 'a track too short for the window says so',
     H.flashes[0]);
  ok(H.mediaEl.currentTime === 0, 'and does not move the playhead');
}

console.log(`\n${pass}/${pass+fail} passed\n`);
process.exit(fail ? 1 : 0);
