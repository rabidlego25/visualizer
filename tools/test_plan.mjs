/* test_plan.mjs — ground-truth harness for plan.js.

   The planner is pure logic over a timeline, so it can be tested against a timeline
   CONSTRUCTED with known structure: a quiet intro, a build, a loud drop, a breakdown, an
   outro, at a known tempo with known bar lines. No audio, no rendering, no analysis --
   the assertions are about planning decisions, and mixing in DSP would only make a
   failure ambiguous about which half broke.

   The rule that matters most here is the loop-seam rule (last shot must differ from the
   first). It is asserted across many seeds, because a rule that holds for seed 1 by
   luck is not a rule.

   Usage: node tools/test_plan.mjs
*/
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../plan.js', import.meta.url), 'utf8');
new Function('self', src)(globalThis);
const { pickLoop, planShots, planLoop } = globalThis.SongPlan;

const checks = [];
const ok = (name, pass, detail = '') => checks.push([name, !!pass, detail]);

// ---- a timeline with known structure --------------------------------------------
const BPM = 120, BEAT = 60 / BPM, BAR = BEAT * 4, BARS = 48;
const ARC = [];
for (let b = 0; b < BARS; b++) {
  if (b < 8) ARC.push(0.20);                       // INTRO
  else if (b < 16) ARC.push(0.30 + (b - 8) / 8 * 0.35);  // BUILD, rising
  else if (b < 32) ARC.push(1.00);                 // DROP, flat and loud
  else if (b < 40) ARC.push(0.38);                 // BREAKDOWN
  else ARC.push(0.28);                             // OUTRO
}
const SECTIONS = [
  { startBar: 0,  endBar: 8,  label: 'INTRO',     energy: 0.20 },
  { startBar: 8,  endBar: 16, label: 'BUILD',     energy: 0.48 },
  { startBar: 16, endBar: 32, label: 'DROP',      energy: 1.00 },
  { startBar: 32, endBar: 40, label: 'BREAKDOWN', energy: 0.38 },
  { startBar: 40, endBar: 48, label: 'OUTRO',     energy: 0.28 },
].map(s => ({ ...s, bars: s.endBar - s.startBar, start: s.startBar * BAR, end: s.endBar * BAR }));

const TL = {
  ok: true, duration: BARS * BAR,
  tempo: { bpm: BPM, confidence: 0.95, meter: 4, beatPeriod: BEAT },
  key: { tonic: 'A', mode: 'minor', confidence: 0.8 },
  // Real analysis.js emits ONE downbeat per bar (downbeats.length === arc.length), not
  // bars+1 -- there is no trailing downbeat closing the final bar. Mirroring that here
  // matters: with bars+1 the harness silently tests a window range the real data cannot
  // produce.
  downbeats: Array.from({ length: BARS }, (_, b) => +(b * BAR).toFixed(3)),
  arc: ARC, sections: SECTIONS, events: [],
};

// ---- pickLoop --------------------------------------------------------------------
const c8 = pickLoop(TL, { bars: 8 });
ok('pickLoop returns candidates', c8.length > 0, `${c8.length}`);
ok('best 8-bar loop is inside the DROP',
   c8[0].startBar >= 16 && c8[0].startBar + 8 <= 32,
   `startBar ${c8[0].startBar} (${c8[0].label}), score ${c8[0].score}`);
ok('candidates are downbeat aligned',
   c8.every(c => Math.abs(c.start - TL.downbeats[c.startBar]) < 1e-6));
ok('window duration is exactly N bars',
   c8.every(c => Math.abs(c.duration - 8 * BAR) < 1e-6), `${c8[0].duration}s`);
ok('candidates are spread, not neighbours',
   c8.every((a, i) => c8.every((b, j) => i === j || Math.abs(a.startBar - b.startBar) >= 4)),
   c8.map(c => c.startBar).join(','));
ok('intro/outro are not chosen over the drop',
   c8[0].label !== 'INTRO' && c8[0].label !== 'OUTRO', c8[0].label);

// A song with NO loud section should still return something rather than nothing.
const flatTL = { ...TL, arc: ARC.map(() => 0.5),
  sections: [{ startBar: 0, endBar: 48, bars: 48, start: 0, end: 48 * BAR, label: 'VERSE', energy: 0.5 }] };
ok('flat song still yields a loop', pickLoop(flatTL, { bars: 8 }).length > 0);

// Too-short songs must not throw or return nonsense.
const shortTL = { ...TL, downbeats: TL.downbeats.slice(0, 5), arc: ARC.slice(0, 4) };
ok('song shorter than the loop returns []', pickLoop(shortTL, { bars: 8 }).length === 0);

// ---- planShots -------------------------------------------------------------------
const loop8 = c8[0];
const p8 = planShots(TL, loop8, { seed: 7 });
ok('8 bars -> 2 shots (one cut, the phrase grid allows no more)',
   p8.shots.length === 2, `${p8.shots.length} shots`);
ok('cuts land on 4-bar phrase boundaries',
   p8.shots.every(s => s.bar % 4 === 0), p8.shots.map(s => s.bar).join(','));
ok('shots tile the loop with no gap or overlap', (() => {
  for (let i = 0; i < p8.shots.length; i++) {
    const s = p8.shots[i];
    const nextStart = i + 1 < p8.shots.length ? p8.shots[i + 1].start : loop8.end;
    if (Math.abs(s.end - nextStart) > 1e-6) return false;
  }
  return Math.abs(p8.shots[0].start - loop8.start) < 1e-6;
})());
ok('density stays in range', p8.shots.every(s => s.density >= 0.2 && s.density <= 1));
ok('engines are real', p8.shots.every(s => ['web','nebula','water','fluid'].includes(s.engine)));

const c16 = pickLoop(TL, { bars: 16 });
const p16 = planShots(TL, c16[0], { seed: 3 });
ok('16 bars -> up to 4 shots', p16.shots.length >= 2 && p16.shots.length <= 4,
   `${p16.shots.length} shots at bars ${p16.shots.map(s => s.bar).join(',')}`);
ok('16-bar cuts are all on the phrase grid', p16.shots.every(s => s.bar % 4 === 0));

// ---- THE loop-seam rule ----------------------------------------------------------
// Asserted over many seeds: a rule that holds for one seed is not a rule.
let seamBad = 0, adjBad = 0, single = 0;
for (let seed = 0; seed < 300; seed++) {
  const p = planShots(TL, loop8, { seed });
  if (p.shots.length < 2) { single++; continue; }
  if (p.shots[0].engine === p.shots[p.shots.length - 1].engine) seamBad++;
  for (let i = 1; i < p.shots.length; i++)
    if (p.shots[i].engine === p.shots[i - 1].engine) adjBad++;
}
ok('loop seam: first and last shot never share an engine (300 seeds)', seamBad === 0, `${seamBad} bad`);
ok('adjacent shots never share an engine (300 seeds)', adjBad === 0, `${adjBad} bad`);
ok('a loop plan is never a single shot (300 seeds)', single === 0, `${single} single-shot plans`);

// ...and it must be exercised, not merely satisfied by accident.
// NOTE the configuration: on an 8-bar loop there are exactly 2 shots, and the
// adjacent-contrast rule already forces shot2 != shot1 -- shot2 IS the last shot, so the
// seam rule is structurally unreachable there and measuring it on loop8 reports 0/300
// while proving nothing. The rule only has work to do from 3 shots up, where the last
// shot can circle back to the first engine.
let fired = 0, seamBad16 = 0, multi = 0;
for (let seed = 0; seed < 300; seed++) {
  const p = planShots(TL, c16[0], { seed });
  if (p.shots.length < 3) continue;
  multi++;
  if (p.seamFixed) fired++;
  if (p.shots[0].engine === p.shots[p.shots.length - 1].engine) seamBad16++;
}
ok('3+ shot plans exist to test the rule on', multi > 50, `${multi}/300 had 3+ shots`);
ok('loop seam holds on 3+ shot plans', seamBad16 === 0, `${seamBad16} bad of ${multi}`);
ok('the seam rule actually fires sometimes', fired > 0, `fired on ${fired}/${multi} multi-shot plans`);

// ---- determinism -----------------------------------------------------------------
const a1 = JSON.stringify(planShots(TL, loop8, { seed: 42 }));
const a2 = JSON.stringify(planShots(TL, loop8, { seed: 42 }));
ok('same seed -> identical plan', a1 === a2);
let distinct = new Set();
for (let s = 0; s < 40; s++) distinct.add(JSON.stringify(planShots(TL, loop8, { seed: s }).shots));
ok('different seeds -> genuinely different plans', distinct.size > 8, `${distinct.size}/40 distinct`);

// ---- styles ----------------------------------------------------------------------
const calm = planShots(TL, c16[0], { seed: 5, style: 'calm' });
const norm = planShots(TL, c16[0], { seed: 5 });
ok('calm style cuts no more than default', calm.shots.length <= norm.shots.length,
   `calm ${calm.shots.length} vs default ${norm.shots.length}`);
ok('calm style prefers no trails', calm.shots.filter(s => s.trails).length <= norm.shots.filter(s => s.trails).length);

// engine restriction (fluid is removed from the select when unsupported)
const noFluid = planShots(TL, loop8, { seed: 11, engines: ['web', 'nebula', 'water'] });
ok('respects the available-engine list', noFluid.shots.every(s => s.engine !== 'fluid'));
const twoOnly = planShots(TL, loop8, { seed: 11, engines: ['web', 'nebula'] });
ok('works with only two engines', twoOnly.shots.length === 2
   && twoOnly.shots[0].engine !== twoOnly.shots[1].engine);

// ---- end to end ------------------------------------------------------------------
const full = planLoop(TL, { bars: 8, seed: 1 });
ok('planLoop returns a plan with alternatives', full && full.shots.length >= 2 && full.alternatives.length >= 1,
   full ? `${full.shots.length} shots, ${full.alternatives.length} alts` : 'null');

// ---- report ----------------------------------------------------------------------
console.log(`\ntimeline: ${BARS} bars @ ${BPM} BPM  (INTRO 0-7, BUILD 8-15, DROP 16-31, BREAKDOWN 32-39, OUTRO 40-47)`);
console.log(`best 8-bar loops: ${c8.map(c => `bar ${c.startBar} (${c.label}, ${c.score})`).join('  |  ')}`);
console.log(`plan @seed7: ${p8.shots.map(s => `${s.bar}:${s.engine}/t${s.theme}/d${s.density}${s.trails ? '/tr' : ''}`).join('  ->  ')}`);
console.log(`plan @seed3 (16 bars): ${p16.shots.map(s => `${s.bar}:${s.engine}`).join(' -> ')}\n`);

let pass = 0;
for (const [name, good, detail] of checks) {
  console.log(`${good ? ' ok ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
  pass += good;
}
console.log(`\n${pass}/${checks.length} passed`);
process.exit(pass === checks.length ? 0 : 1);
