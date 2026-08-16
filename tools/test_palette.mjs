/* test_palette.mjs — harness for palette.js (cover-art theme extraction).

   Same role render_eval.py plays for the visuals and test_analysis.mjs plays for the DSP:
   images whose right answer is known BY CONSTRUCTION, so the extractor can be judged
   without anyone looking at anything. palette.js is a pure function of RGBA bytes
   precisely so this can exist.

   Two classes of check, and the second one is the one that matters:
     1. does it find the right HUE (the easy half -- a solid orange sleeve is orange)
     2. does the output land where the SHADERS expect (the half that breaks things).
        Brightness is the recurring failure mode in this repo; a pale sleeve handed
        through raw would white the frame out. So every result, from every stimulus, is
        asserted against the bands measured off the built-in THEMES -- and those bands
        are LIFTED out of eva.html rather than copied, so adding a built-in theme that
        breaks the assumption fails here instead of silently widening it.

   Usage: node tools/test_palette.mjs
*/
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../palette.js', import.meta.url), 'utf8');
const scope = {};
new Function('self', src)(scope);
const P = scope.CoverPalette;

// ---- the built-in themes, lifted, so the target bands cannot drift silently ----------
const eva = fs.readFileSync(new URL('../eva.html', import.meta.url), 'utf8');
const a = eva.indexOf('  const THEMES = [');
const b = eva.indexOf('];', a);
if (a < 0 || b < 0){ console.error('FAIL: could not find THEMES in eva.html'); process.exit(1); }
const THEMES = new Function(eva.slice(a, b+2) + '; return THEMES;')();

let pass = 0, fail = 0;
const ok = (c, m, x='') => { c ? (pass++, console.log(` ok  ${m}${x?'  ('+x+')':''}`))
                               : (fail++, console.log(`FAIL ${m}${x?'  ('+x+')':''}`)); };

const luma = P.luma;
const sat  = c => { const mx = Math.max(...c); return mx === 0 ? 0 : (mx - Math.min(...c))/mx; };

// ---- stimuli ------------------------------------------------------------------------
// Solid fills, patches and gradients built from HSV, so the hue going in is known exactly.
function img(w, h, fn){
  const d = new Uint8ClampedArray(w*h*4);
  for (let y=0;y<h;y++) for (let x=0;x<w;x++){
    const c = fn(x, y, w, h), i = (y*w+x)*4;
    d[i] = c[0]*255; d[i+1] = c[1]*255; d[i+2] = c[2]*255; d[i+3] = (c[3] ?? 1)*255;
  }
  return { d, w, h };
}
const solid  = (hue, s=0.9, v=0.9) => img(64, 64, () => P.hsv2rgb(hue, s, v));
const halves = (h1, h2) => img(64, 64, (x,y,w) => P.hsv2rgb(x < w/2 ? h1 : h2, 0.9, 0.9));
const run = (im, o) => P.extract(im.d, im.w, im.h, o);

console.log('\n--- the bands this is shaped to are still the real ones ---------------');
{
  const l1 = THEMES.map(t => luma(t.c1)), l2 = THEMES.map(t => luma(t.c2));
  const s1 = THEMES.map(t => sat(t.c1)),  s2 = THEMES.map(t => sat(t.c2));
  const B = P.BANDS;
  ok(Math.min(...l1) >= B.c1.lo - 1e-3 && Math.max(...l1) <= B.c1.hi + 1e-3,
     'every built-in c1 sits inside the c1 luma band', `${Math.min(...l1).toFixed(3)}..${Math.max(...l1).toFixed(3)}`);
  ok(Math.min(...l2) >= B.c2.lo - 1e-3 && Math.max(...l2) <= B.c2.hi + 1e-3,
     'every built-in c2 sits inside the c2 luma band', `${Math.min(...l2).toFixed(3)}..${Math.max(...l2).toFixed(3)}`);
  ok(Math.min(...s1) >= B.c1.minSat - 1e-3, 'and the c1 saturation floor holds',
     `min sat ${Math.min(...s1).toFixed(2)}`);
  ok(Math.min(...s2) >= B.c2.minSat - 1e-3, 'and the c2 saturation floor holds',
     `min sat ${Math.min(...s2).toFixed(2)}`);
}

console.log('\n--- finding the hue --------------------------------------------------');
{
  const circ = (a2, b2) => { const d = Math.abs(a2-b2) % 360; return d > 180 ? 360-d : d; };
  for (const [hue, name] of [[30,'orange'],[210,'sky'],[120,'green'],[300,'magenta']]){
    const r = run(solid(hue));
    ok(r && circ(r.info.hue1, hue) < 5,
       `a solid ${name} sleeve reads as ${name}`, r ? `hue1=${r.info.hue1}` : 'null');
  }
}
{
  // straddles a bin edge on purpose: un-smoothed, the winner is decided by which side of
  // 10 degrees the colour happened to fall on
  const r = run(solid(5));
  ok(r && (r.info.hue1 <= 12 || r.info.hue1 >= 358), 'a hue on a bin boundary is not snapped to a bin centre',
     `hue1=${r.info.hue1}`);
}
{
  const r = run(halves(30, 200));
  ok(r && r.info.sep > 120, 'a two-colour sleeve yields two genuinely contrasting hues',
     `${r.info.hue1} / ${r.info.hue2}, sep ${r.info.sep}`);
  ok(r && !r.info.synthesised, 'and it uses the real second colour rather than inventing one');
}
{
  // THE selection rule: 2% of the frame is vivid red, 98% is dead near-black. Weighted by
  // coverage this returns nothing; weighted by chroma it returns red.
  const im = img(64, 64, (x,y) => (x < 9 && y < 9) ? P.hsv2rgb(0, 0.95, 0.95) : [0.04,0.04,0.05]);
  const r = run(im);
  ok(r && (r.info.hue1 < 15 || r.info.hue1 > 345),
     'a small vivid mark on a dark sleeve beats the dark majority', r ? `hue1=${r.info.hue1}, ${(r.info.coloured*100).toFixed(1)}% coloured` : 'null');
}

console.log('\n--- monochrome and greyscale -----------------------------------------');
{
  const r = run(solid(210));
  ok(r && r.info.synthesised, 'a one-hue sleeve synthesises its second colour');
  ok(r && r.info.sep >= 120, 'near the complement, so the engines still have a c1/c2 split',
     `sep ${r.info.sep}`);
}
{
  const r = run(img(64, 64, (x,y,w) => { const v = 0.1 + 0.8*x/w; return [v,v,v]; }));
  ok(r === null, 'a greyscale sleeve returns null rather than inventing a palette');
}
{
  const r = run(img(64, 64, () => [0.9, 0.3, 0.1, 0]));
  ok(r === null, 'a fully transparent image returns null');
}
{
  ok(P.extract(null, 0, 0) === null, 'garbage in returns null, not a throw');
}

console.log('\n--- the output lands where the shaders expect -------------------------');
{
  // Every stimulus, including the ones designed to be hostile: a near-white sleeve, a
  // washed-out pastel, a very dark one. None may come back outside the bands.
  const cases = [
    ['solid orange',   solid(30)],
    ['solid blue',     solid(240)],          // darkest hue there is: luma 0.072 raw
    ['solid yellow',   solid(60)],           // brightest: luma 0.928 raw
    ['pale pastel',    solid(200, 0.18, 0.97)],
    ['near-white wash',solid(40, 0.08, 0.99)],
    ['very dark',      solid(280, 0.9, 0.12)],
    ['two-colour',     halves(30, 200)],
    ['vivid mark',     img(64,64,(x,y)=> (x<9&&y<9) ? P.hsv2rgb(0,0.95,0.95) : [0.04,0.04,0.05])],
  ];
  const B = P.BANDS;
  let bad = [];
  for (const [name, im] of cases){
    const r = run(im);
    if (!r){ bad.push(`${name}: null`); continue; }
    const L1 = luma(r.c1), L2 = luma(r.c2), S1 = sat(r.c1), S2 = sat(r.c2);
    if (L1 < B.c1.lo - 0.01 || L1 > B.c1.hi + 0.01) bad.push(`${name}: c1 luma ${L1.toFixed(3)}`);
    if (L2 < B.c2.lo - 0.01 || L2 > B.c2.hi + 0.01) bad.push(`${name}: c2 luma ${L2.toFixed(3)}`);
    if (S1 < B.c1.minSat - 0.01) bad.push(`${name}: c1 sat ${S1.toFixed(2)}`);
    if (S2 < B.c2.minSat - 0.01) bad.push(`${name}: c2 sat ${S2.toFixed(2)}`);
    if (Math.max(...r.c1) > 1 || Math.min(...r.c1) < 0) bad.push(`${name}: c1 out of range`);
  }
  ok(bad.length === 0, 'every stimulus lands inside the measured bands', bad.join('; ') || `${cases.length} cases`);

  // and specifically the failure this exists to prevent
  const pale = run(solid(40, 0.08, 0.99));
  ok(pale && sat(pale.c1) >= B.c1.minSat,
     'a near-white sleeve does NOT come back as a near-white theme',
     pale ? `c1 sat ${sat(pale.c1).toFixed(2)}, luma ${luma(pale.c1).toFixed(3)}` : 'null');
  const dark = run(solid(280, 0.9, 0.12));
  ok(dark && luma(dark.c1) >= B.c1.lo - 0.01,
     'and a very dark sleeve does not come back as an invisible one',
     dark ? `c1 luma ${luma(dark.c1).toFixed(3)}` : 'null');
}
{
  const r = run(solid(30));
  ok(/^#[0-9a-f]{6}$/.test(r.hud), 'hud is a hex string the HUD can use directly', r.hud);
}

console.log('\n--- determinism ------------------------------------------------------');
{
  const im = halves(30, 200);
  const x = JSON.stringify(run(im)), y = JSON.stringify(run(im));
  ok(x === y, 'the same bytes give the same theme');
  // downsampling must not change the answer materially -- a 3000px sleeve is subsampled
  const big = img(600, 600, (x2,y2,w) => P.hsv2rgb(x2 < w/2 ? 30 : 200, 0.9, 0.9));
  const rb = run(big), rs = run(im);
  ok(Math.abs(rb.info.hue1 - rs.info.hue1) < 6,
     'subsampling a large sleeve gives the same hue as the small one',
     `${rs.info.hue1} vs ${rb.info.hue1}`);
}

console.log(`\n${pass}/${pass+fail} passed\n`);
process.exit(fail ? 1 : 0);
