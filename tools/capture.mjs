/* capture.mjs — render eva.html states on the REAL GPU and collect the frames.

   WHY THIS EXISTS
   tools/render_eval.py drives headless Chrome on SwiftShader, a CPU rasteriser. That is
   the right call for a fully unattended harness, but it costs ~4 MINUTES per frame for
   the heavy modes (a fluid state at warm=400 runs ~72,000 full-grid fragment passes
   before a single pixel is drawn). Any tuning question therefore costs an hour, which is
   how a single fluid steady-state question ate an afternoon.

   The app is already rendering those exact states on the machine's real GPU at 60fps.
   This drives a REAL browser window, has the page capture its own canvas via
   `&shots=N&post=`, and POSTs the pixels back here. Same states, same determinism,
   seconds instead of minutes.

   It also does something render_eval.py structurally cannot: FILMSTRIPS. `&anim=N&shots=M`
   spreads M captures across N frames of motion, which is the only way to judge temporal
   questions -- "does the disc sweep coherently", "is the beat jerky", "does the cut
   read". A single frame cannot answer any of those.

   TWO THINGS THIS DELIBERATELY AVOIDS, both learned the hard way in this repo:
     * No --virtual-time-budget. Chrome's virtual clock fast-forwards timers without
       waiting for real-clock work, so it races past decodeAudioData, Workers, and
       (as found while trying to measure it) the media clock itself.
     * No polling for files. The page signals completion by fetching `?done=1`, which
       this server resolves on. That is an event, not a hopeful sleep.

   Usage:
     node tools/capture.mjs "test=1&mode=nebula&bass=0.55&beat=0.5&warm=600&t=4"
     node tools/capture.mjs "test=1&mode=water&bass=0.6&anim=120" --shots 8 --out strip
     node tools/capture.mjs --states fluid          # a named preset group

   Frames land in scratchpad/cap/<out>/ and are tiled into contact_sheet.png.
*/
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8242;

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);
const SHOTS = parseInt(flag('--shots', '1'), 10);
const OUT = flag('--out', 'shot');
const HEADFUL = !has('--headless');   // real window by default -> real GPU
const queries = argv.filter(a => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--shots'
                            && argv[argv.indexOf(a) - 1] !== '--out' && argv[argv.indexOf(a) - 1] !== '--states');

// Named groups, so the common sweeps are one word instead of a wall of query strings.
const PRESETS = {
  water: [
    ['wtr quiet',  'test=1&res=1080&mode=water&bass=0.15&mid=0.12&treb=0.10&theme=0&t=2&anim=90'],
    ['wtr groove', 'test=1&res=1080&mode=water&bass=0.55&mid=0.45&treb=0.30&beat=0.5&theme=2&t=2&anim=90'],
    ['wtr loud',   'test=1&res=1080&mode=water&bass=0.85&mid=0.6&treb=0.5&beat=1&theme=4&t=2&anim=90'],
  ],
  nebula: [
    ['neb groove', 'test=1&res=1080&mode=nebula&bass=0.55&mid=0.45&treb=0.30&beat=0.5&theme=2&t=4&warm=600&anim=90'],
    ['neb loud',   'test=1&res=1080&mode=nebula&bass=0.85&mid=0.6&treb=0.5&beat=1&theme=4&t=4&warm=600&anim=90'],
  ],
  fluid: [
    ['fld groove', 'test=1&res=1080&mode=fluid&bass=0.55&mid=0.45&treb=0.30&beat=0.5&theme=2&t=4&warm=900&anim=90'],
    ['fld coiled', 'test=1&res=1080&mode=fluid&bass=0.6&mid=0.5&treb=0.6&coil=0.9&theme=1&t=4&warm=900&anim=90'],
  ],
  web: [
    ['web quiet',  'test=1&res=1080&bass=0.12&mid=0.10&treb=0.08&theme=0&t=2&anim=90'],
    ['web loud',   'test=1&res=1080&bass=0.7&mid=0.6&treb=0.4&beat=1&theme=4&t=2&anim=90'],
  ],
};

const stateArg = flag('--states', null);
const STATES = stateArg
  ? (PRESETS[stateArg] || (() => { console.error(`unknown preset "${stateArg}" (have: ${Object.keys(PRESETS).join(', ')})`); process.exit(2); })())
  : queries.map((q, i) => [`state${i}`, q]);
if (!STATES.length) { console.error('give a query string or --states <preset>'); process.exit(2); }

const outDir = path.join(ROOT, 'scratchpad', 'cap', OUT);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
                '.png': 'image/png', '.wav': 'audio/wav', '.css': 'text/css' };
let onFrame = () => {}, onDone = () => {};
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__frame') {
    if (u.searchParams.has('done')) { res.writeHead(204).end(); onDone(); return; }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { onFrame(u.searchParams.get('i') || '000', Buffer.concat(chunks)); res.writeHead(204).end(); });
    return;
  }
  const f = path.join(ROOT, decodeURIComponent(u.pathname));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => srv.listen(PORT, r));

const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'evacap-'));
const args = [
  '--no-first-run', `--user-data-dir=${prof}`, '--disable-background-networking',
  '--disable-default-apps', '--no-default-browser-check', '--disable-component-update',
  '--window-size=1100,1200',
];
if (!HEADFUL) args.push('--headless=new', '--use-angle=metal');

console.log(`${STATES.length} state(s) x ${SHOTS} shot(s) -> scratchpad/cap/${OUT}/`);
console.log(HEADFUL ? 'real browser window (real GPU)' : 'headless (--headless)');

const written = [];
for (const [label, q] of STATES) {
  const slug = label.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  const url = `http://localhost:${PORT}/eva.html?${q}&shots=${SHOTS}&post=/__frame`;
  const t0 = Date.now();
  const got = [];
  onFrame = (i, buf) => {
    const name = SHOTS > 1 ? `${slug}_f${i}.png` : `${slug}.png`;
    fs.writeFileSync(path.join(outDir, name), buf);
    got.push(name);
  };
  const done = new Promise(r => { onDone = r; });
  const ch = spawn(CHROME, [...args, url], { stdio: 'ignore' });
  // unref the guard timer, or node keeps the event loop alive for the full 90s AFTER the
  // frame has already arrived -- a 2s capture was taking 90s of doing nothing.
  const guard = new Promise(r => { const t = setTimeout(r, 90000); t.unref(); });
  await Promise.race([done, guard]);
  ch.kill();
  written.push(...got);
  console.log(`  ${label.padEnd(12)} ${got.length} frame(s)  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
srv.close();

if (!written.length) { console.error('\nno frames captured'); process.exit(1); }

// tile them — Pillow is already a dependency of the other tools
try {
  execFileSync('python3', ['-c', `
import glob, os, sys
from PIL import Image, ImageDraw
d = sys.argv[1]
fs_ = sorted(glob.glob(os.path.join(d, '*.png')))
fs_ = [f for f in fs_ if 'contact_sheet' not in f]
if not fs_: sys.exit(0)
TW, TH = 260, 300
cols = min(6, len(fs_)); rows = (len(fs_) + cols - 1)//cols
sheet = Image.new('RGB', (cols*(TW+8)+8, rows*(TH+28)+8), (14,14,16))
dr = ImageDraw.Draw(sheet)
for i, f in enumerate(fs_):
    im = Image.open(f).convert('RGB')
    im.thumbnail((TW, TH))
    x = 8 + (i%cols)*(TW+8); y = 8 + (i//cols)*(TH+28)
    dr.text((x, y), os.path.basename(f)[:-4][:34], fill=(255,180,60))
    sheet.paste(im, (x, y+18))
sheet.save(os.path.join(d, 'contact_sheet.png'))
print('sheet ->', os.path.join(d, 'contact_sheet.png'))
`, outDir], { stdio: 'inherit' });
} catch (e) { console.error('tiling failed:', e.message); }

console.log(`${written.length} frame(s) in scratchpad/cap/${OUT}/`);
