/* downbeat_probe.mjs — WHEN does analysis.js put the bar line in the wrong place?

   The MIR smoke test found downbeats shifted +1 beat on all three of its tracks, while
   tools/test_analysis.mjs reports downbeat F=1.00 on its own stimulus. Both cannot be
   a general statement about the analyser, so this isolates which ARRANGEMENT features
   the downbeat detector actually depends on.

   That question is not academic for this project. The smoke-test stimulus was
   four-on-the-floor -- a kick on every beat -- which is the dominant pattern in the
   electronic music eva.html is built for. If the detector needs a kick pattern that
   distinguishes beat 1 from beat 3, it will mis-phase exactly the tracks that matter,
   and every bar-locked feature (loop recording, HUD bar pips, the director's approach
   ramp) inherits the error while staying self-consistent.

   Each variant changes ONE thing, so a failure names its own cause.

   Usage: node tools/mir/downbeat_probe.mjs
*/
import fs from 'node:fs';

const asrc = fs.readFileSync(new URL('../../analysis.js', import.meta.url), 'utf8');
new Function('self', asrc)(globalThis);
const { analyzeSong } = globalThis.SongAnalysis;

const SR = 44100, BPM = 120, BEAT = 60/BPM, BARS = 48;
const mtof = m => 440*Math.pow(2, (m-69)/12);

// Am - Am - F - G : the progression test_analysis.mjs validated as unambiguous.
const CHORDS = [[57,60,64],[57,60,64],[53,57,60],[55,59,62]];
const ROOTS  = [33, 33, 29, 31];

function synth({ kickPattern, snare = true, chordEveryBar = true, accent = false,
                 hats = true }) {
  const n = Math.round(BARS*4*BEAT*SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  let seed = 987654321;
  const rnd = () => { seed = (seed*1103515245 + 12345) & 0x7fffffff; return seed/0x3fffffff - 1; };
  const add = (t0, dur, f, amp, decay) => {
    const s0 = Math.round(t0*SR), s1 = Math.min(n, s0 + Math.round(dur*SR));
    for (let s = Math.max(0, s0); s < s1; s++) {
      const u = (s-s0)/SR, v = amp*Math.exp(-u*decay)*Math.sin(2*Math.PI*f*u);
      L[s] += v; R[s] += v;
    }
  };
  const noise = (t0, dur, amp, decay, hp) => {
    const s0 = Math.round(t0*SR), s1 = Math.min(n, s0 + Math.round(dur*SR));
    let prev = 0;
    for (let s = Math.max(0, s0); s < s1; s++) {
      const u = (s-s0)/SR; let x = rnd();
      if (hp) { const y = x - prev; prev = x; x = y; }
      const v = amp*Math.exp(-u*decay)*x;
      L[s] += v; R[s] += v;
    }
  };
  const kick = (t0, amp = 0.95) => {
    const s0 = Math.round(t0*SR), s1 = Math.min(n, s0 + Math.round(0.30*SR));
    let ph = 0;
    for (let s = Math.max(0, s0); s < s1; s++) {
      const u = (s-s0)/SR, f = 130 + (45-130)*Math.min(1, (u/0.30)*3);
      ph += 2*Math.PI*f/SR;
      const v = amp*Math.exp(-u*22)*Math.sin(ph);
      L[s] += v; R[s] += v;
    }
  };

  for (let bar = 0; bar < BARS; bar++) {
    const t = bar*4*BEAT;
    // chordEveryBar=false holds one chord for two bars, halving the harmonic evidence
    // for a bar line without changing anything percussive.
    const ci = chordEveryBar ? (bar % 4) : (Math.floor(bar/2) % 4);
    const ch = CHORDS[ci], root = ROOTS[ci];
    ch.forEach(m => add(t, 4*BEAT, mtof(m), 0.16, 0.35));
    add(t, 4*BEAT, mtof(root), 0.34, 0.15);
    for (let b = 0; b < 4; b++) {
      const tb = t + b*BEAT;
      if (kickPattern === 'four')      kick(tb);
      else if (kickPattern === 'k13' && (b === 0 || b === 2)) kick(tb);
      if (snare && (b === 1 || b === 3)) {
        noise(tb, 0.16, 0.42, 26, false); add(tb, 0.12, 190, 0.25, 30);
      }
      if (accent && b === 0) noise(tb, 0.5, 0.45, 6, true);   // crash on the downbeat
      if (hats) { noise(tb, 0.05, 0.10, 60, true); noise(tb + BEAT*0.5, 0.05, 0.10, 60, true); }
    }
  }
  let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(L[i]));
  const g = 0.89/pk; for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
  return { left: L, right: R, sampleRate: SR };
}

// truth: bar lines at multiples of 4 beats, beats every BEAT
const trueBeats = Array.from({length: BARS*4}, (_, i) => i*BEAT);
const trueDowns = Array.from({length: BARS}, (_, b) => b*4*BEAT);

function phaseShift(est, ref, beatPeriod) {
  if (!est.length) return null;
  const offs = est.map(e => {
    let best = Infinity;
    for (const r of ref) if (Math.abs(e-r) < Math.abs(best)) best = e-r;
    return best/beatPeriod;
  }).sort((a, b) => a-b);
  return offs[Math.floor(offs.length/2)];
}
function fmeasure(ref, est, w = 0.07) {
  let i = 0, j = 0, h = 0;
  while (i < ref.length && j < est.length) {
    const d = est[j]-ref[i];
    if (Math.abs(d) <= w) { h++; i++; j++; } else if (d < 0) j++; else i++;
  }
  if (!ref.length || !est.length) return 0;
  const p = h/est.length, r = h/ref.length;
  return p+r ? 2*p*r/(p+r) : 0;
}

const VARIANTS = [
  ['kick 1&3, chord/bar  (test_analysis-like)', { kickPattern: 'k13', chordEveryBar: true }],
  ['FOUR-ON-FLOOR, chord/bar',                  { kickPattern: 'four', chordEveryBar: true }],
  ['FOUR-ON-FLOOR, chord every 2 bars',         { kickPattern: 'four', chordEveryBar: false }],
  ['FOUR-ON-FLOOR + crash on beat 1',           { kickPattern: 'four', chordEveryBar: true, accent: true }],
  ['FOUR-ON-FLOOR, no snare',                   { kickPattern: 'four', chordEveryBar: true, snare: false }],
  ['kick 1&3, chord every 2 bars',              { kickPattern: 'k13', chordEveryBar: false }],
];

console.log(`${BPM} BPM, ${BARS} bars, downbeat every 4 beats (${(4*BEAT).toFixed(2)}s)\n`);
console.log(`${'variant'.padEnd(44)}${'beatF'.padStart(7)}${'dbF'.padStart(7)}${'shift'.padStart(8)}   verdict`);
console.log('-'.repeat(80));
for (const [label, opts] of VARIANTS) {
  const A = analyzeSong(synth(opts));
  if (!A.ok) { console.log(`${label.padEnd(44)}  analysis failed: ${A.reason}`); continue; }
  const bf = fmeasure(trueBeats, A.beats);
  const df = fmeasure(trueDowns, A.downbeats);
  const sh = phaseShift(A.downbeats, trueDowns, 60/A.tempo.bpm);
  const near = sh === null ? null : Math.round(sh);
  const verdict = df > 0.9 ? 'ok'
    : (near !== 0 && Math.abs(sh-near) < 0.2 ? `SHIFTED ${near > 0 ? '+' : ''}${near} beat` : 'scattered');
  console.log(`${label.padEnd(44)}${bf.toFixed(3).padStart(7)}${df.toFixed(3).padStart(7)}`
    + `${(sh === null ? '-' : sh.toFixed(2)).padStart(8)}   ${verdict}`);
}
