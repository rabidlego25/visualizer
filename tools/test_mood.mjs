/* test_mood.mjs — the arousal scalar in analysis.js.
 *
 * The point of a SCALAR rather than a classifier is that it can be validated without
 * labelled ground truth: "is this song correctly labelled melancholic" needs an annotated
 * corpus, "does this track score lower than that one" needs two tracks and an ordering
 * you already agree with. So this harness asserts ORDER and MONOTONICITY, never absolute
 * values — the thresholds inside moodOf() are honest guesses awaiting calibration on real
 * music, and a test that pinned them would just freeze the guesses in place.
 *
 * Three stimuli varying the things arousal is supposed to hear, on one axis at a time
 * where possible, so a failure names its own cause rather than reporting "the number
 * moved". Same discipline as downbeat_probe.mjs.
 *
 *   node tools/test_mood.mjs
 */
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../analysis.js', import.meta.url), 'utf8');
(0, eval)(src);
const { analyzeSong, moodOf } = globalThis.SongAnalysis;

const SR = 44100, DUR = 24;
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

/* One generator, three settings. Everything that separates the stimuli is a named
 * argument, so "which cue did this move" is answerable by reading the call site.
 *   bpm      -> the tempo cue
 *   hitsPerBeat -> onset density
 *   drums    -> percussive ratio + punch (HPSS hears these as percussive)
 *   octave   -> brightness (where the harmonic content sits)
 *   sustain  -> decay rate; long = pad-like and harmonic, short = stabby
 */
function synth({ bpm, hitsPerBeat, drums, octave, sustain }){
  const n = Math.round(DUR * SR);
  const L = new Float32Array(n), R = new Float32Array(n);
  let seed = 987654321;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };

  const tone = (t0, dur, f, amp, decay) => {
    const s0 = Math.round(t0 * SR), s1 = Math.min(n, s0 + Math.round(dur * SR));
    for (let s = Math.max(0, s0); s < s1; s++){
      const u = (s - s0) / SR;
      const v = amp * Math.exp(-u * decay) * Math.sin(2 * Math.PI * f * u);
      L[s] += v; R[s] += v;
    }
  };
  const noise = (t0, dur, amp, decay, hp) => {
    const s0 = Math.round(t0 * SR), s1 = Math.min(n, s0 + Math.round(dur * SR));
    let prev = 0;
    for (let s = Math.max(0, s0); s < s1; s++){
      const u = (s - s0) / SR;
      let x = rnd();
      if (hp){ const y = x - prev; prev = x; x = y; }      // white -> hat-ish
      const v = amp * Math.exp(-u * decay) * x;
      L[s] += v; R[s] += v;
    }
  };
  const kick = (t0) => {                                   // pitch sweep, sub-heavy
    const s0 = Math.round(t0 * SR), s1 = Math.min(n, s0 + Math.round(0.18 * SR));
    for (let s = Math.max(0, s0); s < s1; s++){
      const u = (s - s0) / SR;
      const f = 110 * Math.exp(-u * 34) + 44;
      const v = 0.85 * Math.exp(-u * 17) * Math.sin(2 * Math.PI * f * u);
      L[s] += v; R[s] += v;
    }
  };

  const beat = 60 / bpm;
  const CHORD = [57, 60, 64], BASS = 33;                   // A minor throughout, so the
  const nBeats = Math.floor(DUR / beat);                   // key is not a variable here
  for (let b = 0; b < nBeats; b++){
    const t = b * beat;
    // harmonic bed: chord tones, transposed by `octave`, decaying at `sustain`
    if (b % 4 === 0){
      for (const m of CHORD) tone(t, beat * 4, mtof(m + 12 * octave), 0.16, sustain);
      tone(t, beat * 4, mtof(BASS + 12 * octave), 0.20, sustain * 0.6);
    }
    // rhythmic layer: `hitsPerBeat` subdivisions
    for (let h = 0; h < hitsPerBeat; h++){
      const th = t + h * beat / hitsPerBeat;
      if (drums){
        if (h === 0) kick(th);
        noise(th, 0.05, 0.20, 60, true);                   // hat
        if (b % 2 === 1 && h === 0) noise(th, 0.12, 0.45, 26, false);   // snare
      } else {
        // no drums: the subdivision is a plucked harmonic note, so onset density can be
        // varied WITHOUT changing the percussive ratio
        tone(th, beat / hitsPerBeat, mtof(CHORD[h % 3] + 12 * (octave + 1)), 0.10, 9);
      }
    }
  }
  return { left: L, right: R, sampleRate: SR };
}

const STIM = {
  //                        bpm  hits  drums  oct  sustain
  calm:      synth({ bpm:  72, hitsPerBeat: 1, drums: false, octave: -1, sustain: 0.9 }),
  mid:       synth({ bpm: 104, hitsPerBeat: 2, drums: true,  octave:  0, sustain: 3.0 }),
  energetic: synth({ bpm: 148, hitsPerBeat: 4, drums: true,  octave:  1, sustain: 8.0 })
};

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond){ pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  — ' + detail : ''}`); }
};

console.log('analysing 3 stimuli…');
const M = {};
for (const k of Object.keys(STIM)){
  const tl = analyzeSong(STIM[k]);
  if (!tl.ok){ console.log(`  FAIL ${k} did not analyse: ${tl.reason}`); fail++; continue; }
  M[k] = tl.mood;
  const c = M[k].cues;
  console.log(`  ${k.padEnd(10)} arousal=${M[k].arousal.toFixed(3)}  ` +
    `bpm=${c.bpm.toFixed(1)}${c.tempoUsed ? '' : '(unused)'} onset/s=${c.onsetRate.toFixed(2)} ` +
    `perc=${c.percussive.toFixed(3)} bright=${c.bright.toFixed(4)}`);
  console.log(`             parts ${JSON.stringify(M[k].parts)}`);
}

console.log('\nshape');
ok('moodOf is exported', typeof moodOf === 'function');
for (const k of Object.keys(M)){
  ok(`${k}: arousal in 0..1`, M[k].arousal >= 0 && M[k].arousal <= 1, String(M[k].arousal));
  ok(`${k}: cues + parts present`, !!M[k].cues && !!M[k].parts &&
     Object.keys(M[k].parts).length === 4);
}

console.log('\nordering — the property the scalar exists to have');
ok('calm < mid', M.calm.arousal < M.mid.arousal,
   `${M.calm.arousal} vs ${M.mid.arousal}`);
ok('mid < energetic', M.mid.arousal < M.energetic.arousal,
   `${M.mid.arousal} vs ${M.energetic.arousal}`);
ok('calm and energetic are clearly separated (>0.25)',
   M.energetic.arousal - M.calm.arousal > 0.25,
   `delta ${(M.energetic.arousal - M.calm.arousal).toFixed(3)}`);

console.log('\nper-cue direction — so a failure above names its own cause');
ok('tempo cue rises', M.calm.parts.tempo < M.energetic.parts.tempo);
ok('onset density rises', M.calm.cues.onsetRate < M.energetic.cues.onsetRate,
   `${M.calm.cues.onsetRate} vs ${M.energetic.cues.onsetRate}`);
ok('percussive ratio rises', M.calm.cues.percussive < M.energetic.cues.percussive,
   `${M.calm.cues.percussive} vs ${M.energetic.cues.percussive}`);
ok('brightness rises', M.calm.cues.bright < M.energetic.cues.bright,
   `${M.calm.cues.bright} vs ${M.energetic.cues.bright}`);

console.log('\nEVERY cue must discriminate — the check that catches a dead cue');
// The first version of this file passed 17/17 while two of the five cues were inert:
// `punch` read 1.000 / 1.000 / 0.974 (its input, beatStrength, is onset/3 clamped and had
// saturated) and `percussive` read 0 / 0 / 0.462 (the ramp started above two of the three
// stimuli). Ordering held anyway, because the working cues carried it — so an
// ordering-only suite cannot see this. A cue contributing a constant is pure offset: it
// compresses the usable range of the scalar and pretends to be evidence.
for (const k of ['tempo', 'onset', 'percussive', 'bright']){
  const lo = M.calm.parts[k], hi = M.energetic.parts[k];
  ok(`cue "${k}" spans >0.15 across the stimuli`, hi - lo > 0.15,
     `calm=${lo} mid=${M.mid.parts[k]} energetic=${hi}`);
}

console.log('\nmastering independence — level is deliberately NOT a cue');
// Halving the amplitude of the whole mix is what a quieter master looks like. Every cue
// is a ratio, a rate or a tempo, so the answer must not move. If this ever fails, an
// absolute-level term has crept in and the estimate has become a readout of the limiter.
const quiet = { left: STIM.mid.left.map(v => v * 0.5),
                right: STIM.mid.right.map(v => v * 0.5), sampleRate: SR };
const qm = analyzeSong(quiet).mood;
ok('arousal is invariant to a 6 dB level change',
   Math.abs(qm.arousal - M.mid.arousal) < 0.02,
   `${M.mid.arousal} vs ${qm.arousal}`);

console.log('\nrefusal — a cue that cannot be trusted is dropped, not believed');
// Low tempo confidence must drop the tempo cue rather than feed a guessed BPM into the
// average. Same rule every bar-locked path in this repo already follows at bpmConf 0.30.
const fake = moodOf({ bpm: 200, conf: 0.05 }, new Float32Array(900),
                    new Float32Array(900), new Float32Array(900),
                    new Float32Array(900), new Float32Array(900), new Float32Array(900),
                    900, 86);
ok('tempoUsed false below conf 0.30', fake.cues.tempoUsed === false);
ok('a wrong 200 BPM does not inflate arousal', fake.arousal < 0.30, String(fake.arousal));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
