/* test_analysis.mjs — ground-truth harness for analysis.js.
 *
 * Same idea as render_eval.py for the visuals: I can't listen to a track, so the
 * analyser is checked against a song I SYNTHESISE, whose tempo, bar lines, key,
 * section boundaries and instrument placement are known exactly by construction.
 * Everything here is deterministic — a regression shows up as a number, not a vibe.
 *
 *   node tools/test_analysis.mjs
 */
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../analysis.js', import.meta.url), 'utf8');
(0, eval)(src);
const { analyzeSong, unpackEnv } = globalThis.SongAnalysis;

// ---- ground truth ----------------------------------------------------------
const SR = 44100, BPM = 132, BEAT = 60/BPM, BARS = 52;
const TOTAL = BARS*4*BEAT;
// bar -> arrangement. Boundaries at bars 8, 24, 32 are what the structure pass must find.
const ARR = b => b < 8  ? 'intro'
              : b < 24 ? 'full'
              : b < 32 ? 'breakdown'
              :          'full_lead';
const TRUE_BOUNDS = [8, 24, 32].map(b => b*4*BEAT);
// Am - Am - F - G. Deliberately NOT the obvious Am-F-C-G: with one bar each, that
// progression is the plain C major diatonic set and even a perfect chroma scores C major
// above A minor (0.94 vs 0.83) — an ambiguous stimulus can't test a key detector.
// Doubling the tonic bar puts A minor clear at 0.96 vs 0.70.
const CHORDS = [[57,60,64],[57,60,64],[53,57,60],[55,59,62]];   // MIDI
const ROOTS  = [33, 33, 29, 31];                                 // bass, MIDI
const mtof = m => 440*Math.pow(2, (m-69)/12);

function synth(){
  const n = Math.round(TOTAL*SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  let seed = 12345;
  const rnd = () => { seed = (seed*1103515245 + 12345) & 0x7fffffff; return seed/0x3fffffff - 1; };

  const add = (t0, dur, f, amp, pl, pr, decay, vib) => {
    const s0 = Math.round(t0*SR), s1 = Math.min(n, s0 + Math.round(dur*SR));
    for (let s=Math.max(0,s0); s<s1; s++){
      const u = (s-s0)/SR;
      const a = amp*Math.exp(-u*decay);
      const ff = vib ? f*(1 + 0.012*Math.sin(2*Math.PI*5.5*u)) : f;
      const v = a*Math.sin(2*Math.PI*ff*u);
      L[s] += v*pl; R[s] += v*pr;
    }
  };
  const noise = (t0, dur, amp, pl, pr, decay, hp) => {
    const s0 = Math.round(t0*SR), s1 = Math.min(n, s0 + Math.round(dur*SR));
    let prev = 0;
    for (let s=Math.max(0,s0); s<s1; s++){
      const u = (s-s0)/SR;
      let x = rnd();
      if (hp){ const y = x - prev; prev = x; x = y; }     // one-pole HP: turns white into hat-ish
      const v = amp*Math.exp(-u*decay)*x;
      L[s] += v*pl; R[s] += v*pr;
    }
  };
  const sweep = (t0, dur, f0, f1, amp, decay) => {       // kick
    const s0 = Math.round(t0*SR), s1 = Math.min(n, s0 + Math.round(dur*SR));
    let ph = 0;
    for (let s=Math.max(0,s0); s<s1; s++){
      const u = (s-s0)/SR, k = u/Math.max(1e-6,dur);
      const f = f0 + (f1-f0)*Math.min(1,k*3);
      ph += 2*Math.PI*f/SR;
      const v = amp*Math.exp(-u*decay)*Math.sin(ph);
      L[s] += v; R[s] += v;
    }
  };

  for (let bar=0; bar<BARS; bar++){
    const kind = ARR(bar), t = bar*4*BEAT;
    const ch = CHORDS[bar % 4], root = ROOTS[bar % 4];
    const drums = kind === 'full' || kind === 'full_lead';

    // pad: harmonic, sustained, and deliberately NOT centre-panned, so the centre
    // extraction has something to reject.
    const pans = [[0.95,0.30],[0.30,0.95],[0.72,0.45]];
    ch.forEach((m, i) => {
      const f = mtof(m);
      add(t, 4*BEAT, f,   0.16, pans[i][0], pans[i][1], 0.35, false);
      add(t, 4*BEAT, f*2, 0.05, pans[i][1], pans[i][0], 0.5,  false);
    });

    if (drums){
      add(t, 4*BEAT, mtof(root), 0.34, 1, 1, 0.15, false);      // bass, below the vocal band
      for (let b=0;b<4;b++){
        const tb = t + b*BEAT;
        if (b === 0 || b === 2) sweep(tb, 0.30, 130, 45, 0.95, 22);
        if (b === 1 || b === 3){ noise(tb, 0.16, 0.42, 1, 1, 26, false); add(tb, 0.12, 190, 0.25, 1, 1, 30, false); }
        noise(tb,          0.05, 0.10, 0.72, 0.38, 60, true);   // hats, off-centre
        noise(tb+BEAT*0.5, 0.05, 0.10, 0.38, 0.72, 60, true);
      }
    }
    if (kind === 'full_lead'){
      // "vocal": dead centre, harmonic, in the 200-4000Hz band the proxy looks at.
      const m = ch[2] + 12;
      add(t,          2*BEAT, mtof(m),   0.30, 1, 1, 0.6, true);
      add(t+2*BEAT,   2*BEAT, mtof(m-3), 0.30, 1, 1, 0.6, true);
    }
  }
  let pk = 0;
  for (let i=0;i<n;i++){ pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i])); }
  const g = 0.89/pk;
  for (let i=0;i<n;i++){ L[i] *= g; R[i] *= g; }
  return { left: L, right: R, sampleRate: SR };
}

// ---- scoring ---------------------------------------------------------------
function fmeasure(detected, truth, tol){
  let hit = 0;
  const used = new Set();
  for (const t of truth){
    let bi = -1, bd = Infinity;
    detected.forEach((d, i) => { const e = Math.abs(d-t); if (e < bd && !used.has(i)){ bd = e; bi = i; } });
    if (bi >= 0 && bd <= tol){ hit++; used.add(bi); }
  }
  const p = detected.length ? hit/detected.length : 0;
  const r = truth.length ? hit/truth.length : 0;
  return { p, r, f: p+r > 0 ? 2*p*r/(p+r) : 0 };
}
function meanOver(env, rate, t0, t1){
  const a = Math.max(0, Math.round(t0*rate)), b = Math.min(env.length, Math.round(t1*rate));
  let s = 0; for (let i=a;i<b;i++) s += env[i];
  return b > a ? s/(b-a) : 0;
}

const checks = [];
const ok = (name, pass, detail) => { checks.push({ name, pass, detail }); };

console.log('synthesising %ss of %s BPM audio...', TOTAL.toFixed(1), BPM);
const pcm = synth();
console.log('analysing...');
const t0 = Date.now();
const A = analyzeSong({ ...pcm, onProgress: (ph, f) => {
  if ((f*100|0) % 25 === 0) process.stdout.write(`\r  ${ph} ${(f*100).toFixed(0)}%   `);
} });
process.stdout.write('\r' + ' '.repeat(40) + '\r');
const wall = Date.now()-t0;

// 1. tempo
const bpmErr = Math.abs(A.tempo.bpm - BPM);
ok('tempo within 1 BPM', bpmErr < 1.0, `${A.tempo.bpm} BPM (truth ${BPM}, err ${bpmErr.toFixed(2)}), conf ${A.tempo.confidence}`);
ok('meter is 4', A.tempo.meter === 4, `meter ${A.tempo.meter}`);

// 2. beat grid
const trueBeats = [];
for (let i=0;i<BARS*4;i++) trueBeats.push(i*BEAT);
const bf = fmeasure(A.beats, trueBeats, 0.07);
ok('beat F-measure > 0.90', bf.f > 0.90, `F=${bf.f.toFixed(3)} (P=${bf.p.toFixed(3)} R=${bf.r.toFixed(3)}) over ${A.beats.length} beats`);

// 3. downbeats
const trueDown = [];
for (let i=0;i<BARS;i++) trueDown.push(i*4*BEAT);
const df = fmeasure(A.downbeats, trueDown, 0.07);
ok('downbeat F-measure > 0.90', df.f > 0.90, `F=${df.f.toFixed(3)} over ${A.downbeats.length} downbeats`);

// 4. key
ok('key is A minor', A.key.tonic === 'A' && A.key.mode === 'minor',
   `${A.key.tonic} ${A.key.mode} (conf ${A.key.confidence.toFixed(3)})`);

// 5. structure
const bounds = A.sections.slice(1).map(s => s.start);
const sf = TRUE_BOUNDS.map(t => {
  const d = bounds.length ? Math.min(...bounds.map(b => Math.abs(b-t))) : Infinity;
  return { t, d };
});
const worst = Math.max(...sf.map(s => s.d));
ok('all 3 boundaries within 2 bars', worst <= 2*4*BEAT,
   sf.map(s => `${s.t.toFixed(1)}s off by ${s.d === Infinity ? 'n/a' : s.d.toFixed(2)+'s'}`).join(', '));
ok('no boundary spam (<= 8 sections)', A.sections.length <= 8, `${A.sections.length} sections`);

// 6. stems
const perc = unpackEnv(A.env.percussive), rate = A.env.rate;
const percDrums = (meanOver(perc, rate, 8*4*BEAT, 24*4*BEAT) + meanOver(perc, rate, 32*4*BEAT, TOTAL))/2;
const percPad   = (meanOver(perc, rate, 0, 8*4*BEAT) + meanOver(perc, rate, 24*4*BEAT, 32*4*BEAT))/2;
ok('percussive env tracks the drums (>3x)', percDrums > percPad*3,
   `drums ${percDrums.toFixed(1)} vs pad-only ${percPad.toFixed(1)} (${(percDrums/Math.max(1e-9,percPad)).toFixed(1)}x)`);

if (A.env.vocal){
  const voc = unpackEnv(A.env.vocal);
  const vLead = meanOver(voc, rate, 32*4*BEAT, TOTAL);
  const vNone = meanOver(voc, rate, 8*4*BEAT, 24*4*BEAT);
  ok('vocal proxy finds the centred lead (>2x)', vLead > vNone*2,
     `lead ${vLead.toFixed(1)} vs no-lead ${vNone.toFixed(1)} (${(vLead/Math.max(1e-9,vNone)).toFixed(1)}x)`);
} else ok('vocal proxy present for stereo input', false, 'env.vocal missing');

// 7. events — the whole point of the stage: a drop is known before it happens
const drops = A.events.filter(e => e.type === 'drop');
ok('a drop is flagged at bar 8 or 32', drops.some(d => Math.abs(d.t - 8*4*BEAT) < 2*4*BEAT || Math.abs(d.t - 32*4*BEAT) < 2*4*BEAT),
   drops.map(d => `${d.type}@${d.t.toFixed(1)}s(${d.strength})`).join(' ') || 'none');

// ---- report ----------------------------------------------------------------
console.log('');
console.log('sections:');
for (const s of A.sections){
  console.log(`  bar %s-%s  %ss-%ss  %s  e=%s perc=%s  %s %s`,
    String(s.startBar).padStart(3), String(s.endBar).padStart(3),
    s.start.toFixed(1).padStart(6), s.end.toFixed(1).padStart(6),
    s.label.padEnd(10), s.energy.toFixed(2), s.percussive.toFixed(2),
    s.key.tonic, s.key.mode);
}
console.log('');
let pass = 0;
for (const c of checks){
  console.log(`${c.pass ? '  PASS' : '  FAIL'}  ${c.name.padEnd(38)} ${c.detail}`);
  if (c.pass) pass++;
}
const jsonBytes = JSON.stringify(A).length;
console.log('');
console.log(`analysed ${TOTAL.toFixed(1)}s of audio in ${(wall/1000).toFixed(1)}s (${(TOTAL/(wall/1000)).toFixed(1)}x realtime)`);
console.log(`timeline JSON: ${(jsonBytes/1024).toFixed(0)} KB`);
console.log(`${pass}/${checks.length} checks passed`);
process.exit(pass === checks.length ? 0 : 1);
