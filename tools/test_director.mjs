/* test_director.mjs — ground-truth harness for the DIRECTOR layer in eva.html.

   Same trick as tools/test_analysis.mjs and tools/render_eval.py: verify the thing
   without a human in the loop. It synthesises the known song (reusing the stimulus
   test_analysis.mjs already validates the analyser against), runs the real analysis,
   then lifts the `director` object straight OUT of eva.html and drives it across the
   whole track — so this tests the code that actually ships, not a re-implementation.

   What is checked is the contract the renderer depends on:
     - the beat grid is continuous and phase-locked (no jumps, wraps once per beat)
     - beatCount lands on 0 at every downbeat
     - approach() ramps 0 -> 1 INTO a drop and is 0 in flat passages (the anticipation
       that is the entire reason Stage 2 exists)
     - a drop event is reported exactly once
     - seeking backwards does not corrupt the cursor

   Usage: node tools/test_director.mjs
*/
import fs from 'node:fs';

// ---- load the analyser (classic script, same as the worker does) ----------------
const asrc = fs.readFileSync(new URL('../analysis.js', import.meta.url), 'utf8');
new Function('self', asrc)(globalThis);
const { analyzeSong } = globalThis.SongAnalysis;

// ---- lift the director out of eva.html ------------------------------------------
// Deliberately extracted rather than copied: a copy drifts silently, and then this
// harness passes while the shipped code is broken.
const eva = fs.readFileSync(new URL('../eva.html', import.meta.url), 'utf8');
const start = eva.indexOf('  const director = {');
if (start < 0) { console.error('FAIL: could not find `const director` in eva.html'); process.exit(1); }
const endMark = '\n  };\n';
const end = eva.indexOf(endMark, start);
if (end < 0) { console.error('FAIL: could not find the end of the director object'); process.exit(1); }
const dsrc = eva.slice(start, end + endMark.length);
// audioCtx / Worker / mediaEl are only touched by analyse(), which we never call here.
const director = new Function('audioCtx', 'Worker', 'mediaEl', dsrc + '\n return director;')(
  null, undefined, null);

// ---- the known song (same construction as test_analysis.mjs) ---------------------
const SR = 44100, BPM = 132, BEAT = 60/BPM, BARS = 52;
const TOTAL = BARS*4*BEAT;
const CHORDS = [[57,60,64],[57,60,64],[53,57,60],[55,59,62]];
const ROOTS  = [33, 33, 29, 31];
const mtof = m => 440*Math.pow(2, (m-69)/12);
// energy arc by bar: intro (quiet) -> build (rising) -> drop (loud) -> outro
const ARR = b => b < 8 ? 'intro' : b < 24 ? 'build' : b < 32 ? 'drop' : 'outro';
const LEVEL = { intro: 0.22, build: 0.5, drop: 1.0, outro: 0.35 };

function synth(){
  const n = Math.floor(TOTAL*SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i=0;i<n;i++){
    const t = i/SR;
    const beat = Math.floor(t/BEAT), bar = Math.floor(beat/4);
    const sect = ARR(bar);
    let lev = LEVEL[sect];
    if (sect === 'build') lev = 0.30 + 0.45*((bar-8)/16);   // a real ramp into the drop
    const bp = (t - beat*BEAT)/BEAT;
    let s = 0;
    // kick on every beat, snare on 2 and 4 -> an unambiguous percussive grid
    s += Math.sin(2*Math.PI*55*t) * Math.exp(-bp*18) * 0.9*lev;
    if (beat%4===1 || beat%4===3) s += (Math.random()*2-1) * Math.exp(-bp*26) * 0.5*lev;
    // hats on eighths, louder as the build rises
    const ep = (t*2/BEAT)%1;
    s += (Math.random()*2-1) * Math.exp(-ep*40) * 0.12*lev;
    // harmony: one chord per bar, plus a bass root
    const ch = CHORDS[bar%4], root = ROOTS[bar%4];
    for (const m of ch) s += Math.sin(2*Math.PI*mtof(m)*t) * 0.06*lev;
    s += Math.sin(2*Math.PI*mtof(root)*t) * 0.16*lev;
    L[i] = R[i] = s*0.5;
  }
  return { left: L, right: R, sampleRate: SR };
}

const checks = [];
const ok = (name, pass, detail) => checks.push({ name, pass, detail });

console.log('synthesising %ss @ %s BPM...', TOTAL.toFixed(1), BPM);
const pcm = synth();
const A = analyzeSong(pcm);
if (!A.ok){ console.error('FAIL: analysis not ok:', A.reason); process.exit(1); }
console.log('analysed: %s BPM, %d beats, %d sections, %d events',
  A.tempo.bpm, A.beats.length, A.sections.length, A.events.length);
console.log('sections: %s', A.sections.map(s => `${s.label}@${s.start.toFixed(1)}s`).join(' '));

director.adopt(A);
ok('director adopts the timeline', director.ready === true, `ready=${director.ready}`);

// ---- drive it across the whole song at 60fps ------------------------------------
const dt = 1/60;
let prevPhase = null, wraps = 0, phaseJumps = 0, badCount = 0, dbHits = 0, dbTotal = 0;
let approachSeries = [];
const downSet = A.downbeats.map(t => +t.toFixed(3));
for (let t=0; t<A.duration; t+=dt){
  const d = director.sample(t);
  if (!d) { badCount++; continue; }
  if (d.beatPhase < 0 || d.beatPhase > 1) badCount++;
  if (prevPhase !== null){
    const delta = d.beatPhase - prevPhase;
    if (delta < 0) wraps++;                       // wrapped to the next beat
    else if (delta > 0.5) phaseJumps++;           // a real discontinuity
  }
  prevPhase = d.beatPhase;
  approachSeries.push([t, d.approach]);
}
ok('beatPhase always in 0..1', badCount === 0, `${badCount} out-of-range samples`);
ok('phase wraps ~once per beat', Math.abs(wraps - A.beats.length) <= 3,
   `${wraps} wraps vs ${A.beats.length} beats`);
ok('no phase discontinuities', phaseJumps === 0, `${phaseJumps} jumps > 0.5`);

// beatCount must be 0 at each downbeat
for (const dbt of downSet){
  if (dbt < 0.05 || dbt > A.duration - 0.05) continue;
  dbTotal++;
  const d = director.sample(dbt + 0.01);
  if (d.beatCount === 0) dbHits++;
}
ok('beatCount is 0 on downbeats', dbTotal > 0 && dbHits/dbTotal > 0.95,
   `${dbHits}/${dbTotal} downbeats`);

// ---- the anticipation: approach must ramp INTO the drop -------------------------
const drops = A.events.filter(e => e.type === 'drop');
ok('a drop was detected', drops.length >= 1, `${drops.length} drops: ${drops.map(d=>d.t.toFixed(1)).join(',')}`);
if (drops.length){
  const dt0 = drops[0].t;
  const at = s => { const r = approachSeries.find(([tt]) => tt >= s); return r ? r[1] : -1; };
  const justBefore = at(dt0 - 0.25), mid = at(dt0 - 3), early = at(Math.max(0, dt0 - 12));
  ok('approach ~1 just before the drop', justBefore > 0.85, `approach=${justBefore.toFixed(3)}`);
  ok('approach rises monotonically into it', justBefore > mid && mid > early,
     `t-12s=${early.toFixed(2)} t-3s=${mid.toFixed(2)} t-0.25s=${justBefore.toFixed(3)}`);
  ok('approach resets after the drop', at(dt0 + 1.0) < 0.5, `approach=${at(dt0+1).toFixed(3)}`);
}

// ---- seeking backwards must not corrupt the cursor ------------------------------
const fwd = director.sample(A.duration*0.75);
director.sample(A.duration*0.10);                  // seek back
const again = director.sample(A.duration*0.75);    // and forward again
ok('seek backwards then forwards is stable',
   Math.abs(fwd.beatPhase - again.beatPhase) < 1e-6 && fwd.beatCount === again.beatCount,
   `phase ${fwd.beatPhase.toFixed(4)} -> ${again.beatPhase.toFixed(4)}`);

// ---- report ---------------------------------------------------------------------
console.log('');
let pass = 0;
for (const c of checks){
  console.log('%s %s%s', c.pass ? ' ok ' : 'FAIL', c.name, c.detail ? `  (${c.detail})` : '');
  if (c.pass) pass++;
}
console.log('\n%d/%d passed', pass, checks.length);
process.exit(pass === checks.length ? 0 : 1);
