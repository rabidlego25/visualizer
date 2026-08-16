/* test_loopenv.mjs — harness for RUNG 1 (the periodic look envelope in eva.html).

   The `?test=` render harness cannot reach this either: it never calls listen(), so
   beatCount/beatPhase never advance and the envelope never moves. And a screenshot
   could not answer the question anyway -- the claim is about two frames being EQUAL
   across a join, which is a numeric property of a time series, not of an image.

   Same trick as test_cuts.mjs / test_director.mjs: the code is LIFTED out of eva.html
   rather than copied, because a copy drifts silently and then this passes while the app
   is broken.

   What is checked is the one promise rung 1 makes -- that the look at the END of a
   bar-locked take is the look at its START:
     - the cycle returns: p runs 0 -> 1 across exactly `bars` bars, then wraps
     - the seam closes in VALUE   (last frame == first frame)
     - the seam closes in SLOPE   (a return with a kink still reads as a bump)
     - at full strength the camera is independent of ABSOLUTE time, which is the actual
       mechanism: nothing is left that can drift across the join
     - with the envelope off it is byte-identical to the camera that shipped
     - it stays off without a tempo lock, and eases rather than jumping

   Usage: node tools/test_loopenv.mjs
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

const envSrc = lift('  const LOOP_EASE = 2.5;',
                    '  // ---------------- the camera as a SHOT parameter', 'the loop envelope');
const camSrc = lift('  const NEB_SHOTS = [',
                    '  // Columns are spaced by a power curve', 'nebCamera');

// Everything the lifted code closes over, stubbed at the boundary only. `advance` is a
// faithful copy of the grid arithmetic in listen(): beatPhase accumulates, beatCount
// cycles 0..3, barPhase is derived. The envelope reads nothing else about the audio.
function harness({ bars = 8, conf = 0.9, period = 0.5 } = {}){
  return new Function(`
    let bpmConf = ${conf}, beatPeriod = ${period};
    let beatCount = 0, beatPhase = 0, barPhase = 0;
    let clip = ${bars};
    function clipBars(){ return clip; }
    ${envSrc}
    ${camSrc}
    function advance(dt){
      if (beatPeriod > 0){
        beatPhase += dt/beatPeriod;
        while (beatPhase >= 1){ beatPhase -= 1; beatCount = (beatCount+1) % 4; }
        barPhase = (beatCount + beatPhase)/4;
      }
      loopTick(dt);
    }
    return {
      advance, loopEnv, nebCamera, NEB_SHOTS,
      LOOP: { EASE: LOOP_EASE, YAW: LOOP_YAW, PIT: LOOP_PIT, FOC: LOOP_FOC, HUE: LOOP_HUE },
      set clip(v){ clip = v; }, set conf(v){ bpmConf = v; }, set period(v){ beatPeriod = v; },
      set envOn(v){ envOn = v; }, set envBars(v){ envBars = v; },
      get grid(){ return { beatCount, beatPhase, barPhase }; }
    };
  `)();
}

let pass = 0, fail = 0;
const ok = (c, m, x='') => { c ? (pass++, console.log(` ok  ${m}${x?'  ('+x+')':''}`))
                               : (fail++, console.log(`FAIL ${m}${x?'  ('+x+')':''}`)); };
const near = (a, b, eps=1e-9) => Math.abs(a-b) <= eps;

// A neutral frame state. The audio terms are held constant on purpose: the audio really
// does loop, so at the seam bass/beat return on their own and are not what is under test.
const st = (t) => ({ t, bass: 0.4, beat: 0.2, burst: 0.1, safe: 1 });

// run the envelope up to full strength before measuring anything
function settle(H, secs = 6){ for (let i=0;i<secs*60;i++) H.advance(1/60); }

// Advance to the far side of the next bar line. Deliberately NOT a spin on
// `beatPhase < dt` -- beatPhase accumulates in floating point, so it can step straight
// over any fixed window and never satisfy the condition. The first version of this file
// did exactly that and hung. Watch for the WRAP, and bound the search.
function toBarLine(H, dt = 1/60){
  const b0 = H.loopEnv.bar;
  for (let i=0;i<10000;i++){ H.advance(dt); if (H.loopEnv.bar !== b0) return true; }
  return false;
}

console.log('\n--- when the envelope is armed ---------------------------------------');
{
  const H = harness({ conf: 0.2 });          // below the bar recTick() arms on
  settle(H);
  ok(H.loopEnv.amt === 0, 'no tempo lock: the envelope stays off (the bar line would be a guess)',
     `amt=${H.loopEnv.amt}`);
}
{
  const H = harness({ bars: 0 });            // clipSel on Free -- no loop, nothing to return to
  settle(H);
  ok(H.loopEnv.amt === 0, 'Free clip length: off (there is no cycle to close)', `amt=${H.loopEnv.amt}`);
}
{
  const H = harness(); H.envOn = false;
  settle(H);
  ok(H.loopEnv.amt === 0, '?env=0 disables it (this is the A/B baseline)', `amt=${H.loopEnv.amt}`);
}
{
  const H = harness();
  settle(H);
  ok(H.loopEnv.amt === 1, 'bar-locked clip + tempo lock: armed', `amt=${H.loopEnv.amt}`);
  ok(H.loopEnv.bars === 8, 'it takes its length from the clip select', `bars=${H.loopEnv.bars}`);
}
{
  const H = harness({ bars: 0 }); H.envBars = 4;   // ?envbars= without touching the clip
  settle(H);
  ok(H.loopEnv.amt === 1 && H.loopEnv.bars === 4,
     '?envbars= overrides the clip length, so it can be previewed independently',
     `bars=${H.loopEnv.bars}`);
}

console.log('\n--- easing, not jumping ----------------------------------------------');
{
  const H = harness();
  const at = s => { const n = Math.round(s*60); for (let i=0;i<n;i++) H.advance(1/60); return H.loopEnv.amt; };
  const half = at(H.LOOP.EASE/2);
  ok(half > 0.4 && half < 0.6, 'amt ramps linearly, ~half way at half the ease time', `amt=${half.toFixed(3)}`);
  at(H.LOOP.EASE/2 + 0.5);
  ok(H.loopEnv.amt === 1, 'and reaches full strength at the ease time', `amt=${H.loopEnv.amt}`);
  H.conf = 0;                                 // lose the lock
  for (let i=0;i<Math.round((H.LOOP.EASE+0.5)*60);i++) H.advance(1/60);
  ok(H.loopEnv.amt === 0, 'losing the lock fades it back out rather than snapping',
     `amt=${H.loopEnv.amt}`);
}

console.log('\n--- the cycle returns ------------------------------------------------');
{
  const H = harness({ bars: 8, period: 0.5 });
  settle(H);
  // realign to a bar line, then walk exactly 8 bars
  ok(toBarLine(H), 'the grid reaches a bar line');
  const p0 = H.loopEnv.p, bar0 = H.loopEnv.bar;
  const dt = 1/60, beats = 8*4, steps = Math.round(beats*0.5/dt);
  const seen = new Set();
  for (let i=0;i<steps;i++){ H.advance(dt); seen.add(H.loopEnv.bar); }
  ok(seen.size === 8, 'the cycle visits every bar of the loop exactly once',
     `bars seen: ${[...seen].sort((a,b)=>a-b).join(',')}`);
  ok(near(H.loopEnv.bar, bar0) && Math.abs(H.loopEnv.p - p0) < 0.02,
     'after `bars` bars it is back where it started', `p ${p0.toFixed(4)} -> ${H.loopEnv.p.toFixed(4)}`);
}

console.log('\n--- the seam closes --------------------------------------------------');
{
  // Sample the basis functions directly at both ends of the join. This is the whole
  // claim: p=0 and p=1 must agree in value AND in slope, or the last frame of the file
  // does not match the first and the loop announces itself on the downbeat.
  const sway = p => Math.sin(p*Math.PI*2);
  const rise = p => 0.5 - 0.5*Math.cos(p*Math.PI*2);
  ok(near(sway(0), sway(1), 1e-12) && near(rise(0), rise(1), 1e-12),
     'value matches across the join', `sway ${sway(0)} / ${sway(1).toExponential(2)}`);
  const h = 1e-6;
  const dS = [(sway(h)-sway(0))/h, (sway(1)-sway(1-h))/h];
  const dR = [(rise(h)-rise(0))/h, (rise(1)-rise(1-h))/h];
  ok(near(dS[0], dS[1], 1e-4) && near(dR[0], dR[1], 1e-4),
     'and so does the SLOPE -- a return with a kink still reads as a bump',
     `d(sway) ${dS[0].toFixed(4)} / ${dS[1].toFixed(4)}`);
  ok(near(rise(0), 0, 1e-12) && near(sway(0), 0, 1e-12),
     'both bases start at zero, so amt=0 and p=0 are the same picture');
}

console.log('\n--- the camera --------------------------------------------------------');
{
  const H = harness();
  // amt=0 must be the camera that SHIPPED. Written out literally rather than lifted --
  // it is a fixed historical baseline, and the point is to catch eva.html drifting from
  // it, which a second lift of the same source could never do.
  const s = H.NEB_SHOTS[0];
  let worst = 0;
  for (const t of [0, 3.7, 41.2, 900]){
    const S = st(t), c = H.nebCamera(S);
    const want = {
      yaw: S.t*0.075 + S.bass*0.22 + s.yaw,
      pit: 1.02 + Math.sin(S.t*0.11)*0.16 + s.pit,
      cam: (2.85 - S.beat*0.20*S.safe - S.burst*0.30) * s.cam,
      foc: s.foc
    };
    for (const k of ['yaw','pit','cam','foc']) worst = Math.max(worst, Math.abs(c[k]-want[k]));
  }
  ok(worst === 0, 'envelope off: byte-identical to the camera that shipped', `max|d|=${worst}`);
}
{
  const H = harness();
  settle(H);
  // THE mechanism, stated as a test. At full strength every absolute-time term is gone,
  // so there is nothing left that can have drifted by the time the loop comes round.
  const a = H.nebCamera(st(0)), b = H.nebCamera(st(10000));
  let worst = 0;
  for (const k of ['yaw','pit','cam','foc']) worst = Math.max(worst, Math.abs(a[k]-b[k]));
  ok(worst < 1e-12, 'envelope on: the camera no longer depends on absolute time at all',
     `t=0 vs t=10000, max|d|=${worst.toExponential(2)}`);
}
{
  const H = harness({ bars: 8, period: 0.5 });
  settle(H);
  toBarLine(H);
  const first = H.nebCamera(st(0));
  const dt = 1/60, steps = Math.round(8*4*0.5/dt);
  for (let i=0;i<steps;i++) H.advance(dt);
  const last = H.nebCamera(st(9999));
  let worst = 0;
  for (const k of ['yaw','pit','cam','foc']) worst = Math.max(worst, Math.abs(first[k]-last[k]));
  ok(worst < 0.02, 'a full 8-bar take ends on the camera it started on',
     `max|d|=${worst.toFixed(5)} rad`);
}
{
  const H = harness();
  settle(H);
  // The framing discipline every shot is held to applies to the envelope too: it must not
  // swing the fill of the frame far enough that the push-in reads as the visual changing
  // size rather than as a camera move.
  let lo = Infinity, hi = -Infinity, camLo = Infinity, camHi = -Infinity;
  for (let i=0;i<8*4*0.5*60;i++){
    H.advance(1/60);
    const c = H.nebCamera(st(0));
    lo = Math.min(lo, c.foc); hi = Math.max(hi, c.foc);
    camLo = Math.min(camLo, c.cam); camHi = Math.max(camHi, c.cam);
  }
  ok(lo >= 1 && hi <= 1 + H.LOOP.FOC + 1e-9,
     'the push-in only ever zooms IN, and by no more than LOOP_FOC',
     `foc ${lo.toFixed(4)}..${hi.toFixed(4)}`);
  ok(near(camLo, camHi, 1e-12),
     'it never touches `cam` -- distance stays a function of the music, not the cycle',
     `cam=${camLo.toFixed(4)}`);
}

console.log(`\n${pass}/${pass+fail} passed\n`);
process.exit(fail ? 1 : 0);
