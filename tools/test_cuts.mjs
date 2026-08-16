/* test_cuts.mjs — harness for THE GATE (the cut layer in eva.html).

   The `?test=` render harness cannot reach this code at all: it never calls listen(),
   so beatCount/beatPeriod never advance and a cut can never fire. That is not a gap
   worth closing in the renderer -- the cut logic is pure timing over the beat grid, so
   it belongs in a Node harness where a bar line costs microseconds instead of a frame.

   Same trick as test_director.mjs: the code is LIFTED out of eva.html rather than
   copied, because a copy drifts silently and then this passes while the app is broken.

   What is checked is the contract the gate depends on -- that the takes a human is
   about to sit and watch are actually the takes they think they are:
     - a cut lands on a BAR line, exactly once, never once per frame
     - no cuts at all when disarmed, and none without a tempo lock
     - a camera cut always yields a DIFFERENT angle (a cut to the same shot is a
       dropped frame, not an edit)
     - an engine cut always yields a DIFFERENT engine
     - shot 0 is the identity shot, so every A/B has a baseline that means something

   Usage: node tools/test_cuts.mjs
*/
import fs from 'node:fs';

const eva = fs.readFileSync(new URL('../eva.html', import.meta.url), 'utf8');

function lift(startMark, endMark, what){
  const a = eva.indexOf(startMark);
  if (a < 0){ console.error(`FAIL: could not find ${what} in eva.html`); process.exit(1); }
  const b = eva.indexOf(endMark, a);
  if (b < 0){ console.error(`FAIL: could not find the end of ${what}`); process.exit(1); }
  return eva.slice(a, b);
}

// the real shot table and the real cut logic, verbatim
const shotSrc = lift('  const NEB_SHOTS = [', '  let nebShot', 'NEB_SHOTS');
const cutSrc  = lift('  const cuts = {', '\n  // Called every frame while armed', 'the cut logic');

// Everything the lifted code closes over in eva.html, stubbed at the boundary only.
// modeSel is the one DOM object involved; its change event carries clearTrails() and the
// slider relabel in the app, neither of which this harness has an opinion about.
const ENGINES = ['web', 'nebula', 'fluid'];
const harness = new Function(`
  ${shotSrc}
  let nebShot = 0, modeId = 'nebula';
  let beatCount = 0, beatPeriod = 0.5;
  const modeSel = {
    options: ${JSON.stringify(ENGINES)}.map(v => ({ value: v })),
    value: 'nebula',
    dispatchEvent(){ modeId = modeSel.value; }
  };
  ${cutSrc}
  return {
    cuts, cutTick, fireCut, NEB_SHOTS,
    get nebShot(){ return nebShot; },  set nebShot(v){ nebShot = v; },
    get modeId(){ return modeId; },    set modeId(v){ modeId = v; modeSel.value = v; },
    set beatCount(v){ beatCount = v; },
    set beatPeriod(v){ beatPeriod = v; }
  };
`);

let pass = 0, fail = 0;
const ok  = (c, m, x='') => { c ? (pass++, console.log(` ok  ${m}${x?'  ('+x+')':''}`))
                                : (fail++, console.log(`FAIL ${m}${x?'  ('+x+')':''}`)); };

// Drive the beat grid the way listen() does: beatCount cycles 0..3, and the renderer
// calls cutTick() every frame -- many times per beat. Firing once per BAR rather than
// once per frame is the whole job, so the harness must oversample to catch a failure.
function run(H, { mode, bar, beats, framesPerBeat = 8, onCut }){
  H.cuts.mode = mode; H.cuts.bar = bar; H.cuts.bars = 0; H.cuts.prevBeat = -1;
  const fires = [];
  const realFire = H.fireCut;
  for (let i = 0; i <= beats; i++){
    H.beatCount = i % 4;
    for (let f = 0; f < framesPerBeat; f++){
      const before = H.cuts.bars;
      H.cutTick();
      if (H.cuts.bars !== before && H.cuts.bars % bar === 0) fires.push(H.cuts.bars);
    }
  }
  return fires;
}

console.log('\n--- the shot table ---------------------------------------------------');
{
  const H = harness();
  const s0 = H.NEB_SHOTS[0];
  ok(s0.yaw === 0 && s0.pit === 0 && s0.cam === 1 && s0.foc === 1,
     'shot 0 is the identity shot (every A/B has a real baseline)',
     `yaw=${s0.yaw} pit=${s0.pit} cam=${s0.cam} foc=${s0.foc}`);
  ok(H.NEB_SHOTS.length >= 2, 'there is more than one angle to cut between', `${H.NEB_SHOTS.length} shots`);
  const seen = new Set(H.NEB_SHOTS.map(s => `${s.yaw},${s.pit},${s.cam},${s.foc}`));
  ok(seen.size === H.NEB_SHOTS.length, 'every shot is distinct', `${seen.size}/${H.NEB_SHOTS.length} unique`);
}

console.log('\n--- when a cut may fire ----------------------------------------------');
{
  const H = harness();
  ok(run(H, { mode: 'off', bar: 4, beats: 64 }).length === 0, 'disarmed: no cuts, ever');
}
{
  const H = harness();
  H.beatPeriod = 0;   // no tempo lock -- the grid is guesswork, same bar recTick() refuses on
  ok(run(H, { mode: 'camera', bar: 4, beats: 64 }).length === 0,
     'no tempo lock: no cuts (the bar line would be a guess)');
}
{
  const H = harness();
  const fires = run(H, { mode: 'camera', bar: 4, beats: 32 });   // 8 bars
  ok(fires.length === 2, 'an 8-bar take with cutbar=4 cuts twice', `at bars [${fires}]`);
  ok(fires[0] === 4 && fires[1] === 8, 'the cuts land on bars 4 and 8', `[${fires}]`);
}
{
  const H = harness();
  const fires = run(H, { mode: 'camera', bar: 4, beats: 32, framesPerBeat: 40 });
  ok(fires.length === 2, 'still twice at 40 frames/beat, so it fires per BAR not per frame',
     `${fires.length} cuts`);
}
{
  const H = harness();
  const fires = run(H, { mode: 'camera', bar: 8, beats: 32 });
  ok(fires.length === 1 && fires[0] === 8, 'cutbar=8 cuts once, at bar 8', `[${fires}]`);
}

console.log('\n--- camera cuts ------------------------------------------------------');
{
  const H = harness();
  H.cuts.mode = 'camera';           // fireCut branches on this; without it the block is vacuous
  H.modeId = 'nebula';
  const seq = [H.nebShot];
  for (let i = 0; i < 12; i++){ H.fireCut(); seq.push(H.nebShot); }
  let repeats = 0;
  for (let i = 1; i < seq.length; i++) if (seq[i] === seq[i-1]) repeats++;
  ok(repeats === 0, 'a camera cut always changes the angle (never a cut to the same shot)',
     `${seq.length} cuts, ${repeats} repeats`);
  ok(new Set(seq).size === H.NEB_SHOTS.length, 'it visits every angle in the table',
     `${new Set(seq).size}/${H.NEB_SHOTS.length}`);
  const expect = Array.from({length: seq.length}, (_, i) => i % H.NEB_SHOTS.length);
  ok(seq.join() === expect.join(), 'the order is deterministic, so takes are comparable',
     `[${seq.slice(0,6)}...]`);
}
{
  const H = harness();
  H.cuts.mode = 'camera';
  H.modeId = 'web';                 // no camera to cut between
  const before = H.nebShot;
  H.fireCut();
  ok(H.nebShot === before, 'a camera cut is a no-op outside the nebula', `shot ${before} -> ${H.nebShot}`);
}

console.log('\n--- engine cuts ------------------------------------------------------');
{
  const H = harness();
  H.cuts.mode = 'engine';
  H.modeId = 'web';
  const seq = [H.modeId];
  for (let i = 0; i < 6; i++){ H.fireCut(); seq.push(H.modeId); }
  let repeats = 0;
  for (let i = 1; i < seq.length; i++) if (seq[i] === seq[i-1]) repeats++;
  ok(repeats === 0, 'an engine cut always changes the engine', `[${seq.join(' -> ')}]`);
  ok(new Set(seq).size === ENGINES.length, 'it cycles the whole available list',
     `${new Set(seq).size}/${ENGINES.length}`);
}

console.log(`\n${pass}/${pass+fail} passed\n`);
process.exit(fail ? 1 : 0);
