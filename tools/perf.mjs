/* perf.mjs — measure eva.html's REAL frame times on this machine, per engine.

   WHY THIS EXISTS
   Every visual harness in this repo either forces renderScale to 1.0 (capture.mjs) or
   runs on a CPU rasteriser where frame time is meaningless (render_eval.py). So the one
   number that decides what the user actually sees -- how fast it runs on their GPU, and
   what adaptResolution() has therefore scaled the render down to -- has never been
   measured. The app had no readout of either.

   Drives a real browser window per engine, lets it settle, and collects frame-time and
   renderScale samples via the page's `?perf=` hook.

   Usage:  node tools/perf.mjs            # all engines, 12s each
           node tools/perf.mjs --secs 20  # longer sample
*/
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8243;
const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SECS = parseFloat(flag('--secs', '12'));
const ENGINES = (flag('--engines', 'web,nebula,fluid')).split(',');
const RES = flag('--res', '');
const AUDIO = flag('--audio', '');
const PAGE  = flag('--page', 'eva.html');

const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json',
                '.png':'image/png', '.css':'text/css' };
let onSample = () => {};
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__perf') {
    const c = []; req.on('data', d => c.push(d));
    req.on('end', () => { try { onSample(JSON.parse(Buffer.concat(c).toString())); } catch {} res.writeHead(204).end(); });
    return;
  }
  const f = path.join(ROOT, decodeURIComponent(u.pathname));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => srv.listen(PORT, r));

const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'evaperf-'));
// Chrome throttles OCCLUDED and BACKGROUNDED windows. A window spawned from a terminal
// never gets focus, so without these flags every measurement reads ~30fps regardless of
// what the page does -- a blank page measured 33.3ms too, which is how this was caught.
const args = ['--no-first-run', `--user-data-dir=${prof}`, '--disable-background-networking',
              '--disable-default-apps', '--no-default-browser-check', '--disable-component-update',
              '--autoplay-policy=no-user-gesture-required', '--window-size=1100,1200',
              '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
              '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion'];

// mirror adaptResolution(): snap the observed floor to a real refresh period, so the
// verdict is judged against what the DISPLAY can deliver rather than a hardcoded 60Hz.
const vsGuess = (ms) => [6.94, 8.33, 11.11, 16.67, 33.34]
  .reduce((b, h) => Math.abs(ms - h) < Math.abs(ms - b) ? h : b, 16.67);
// never leave a browser behind, even on ctrl-c
const kids = new Set();
const reap = () => { for (const c of kids) { try { c.kill('SIGKILL'); } catch {} } kids.clear(); };
process.on('exit', reap); process.on('SIGINT', () => { reap(); process.exit(130); });
process.on('uncaughtException', e => { reap(); console.error(e); process.exit(1); });

const pct = (a, p) => a.length ? a.slice().sort((x,y)=>x-y)[Math.min(a.length-1, Math.floor(a.length*p))] : NaN;

// HONEST LIMIT: Chrome throttles occluded windows to ~30fps, and a window spawned from a
// terminal never gets focus. A blank page measures 33.3ms here for exactly that reason, so
// these fps figures are a FLOOR, not the app's real cost. Raising the window would fix the
// number and steal focus, which is not worth it -- use ?fps=1 in a normal browser instead.
console.log(`measuring ${SECS}s per engine  (occluded window: fps is a floor, see header)\n`);
console.log('engine    canvas       fps  p50 ms  p95 ms   worst   scale  verdict');
const results = [];
for (const eng of ENGINES) {
  const frames = []; let last = null;
  onSample = (d) => { last = d; for (const [ms] of d.samples) frames.push(ms); };
  const url = eng==='blank' ? `http://localhost:${PORT}/scratchpad/perfctl/blank.html`
    : `http://localhost:${PORT}/${PAGE}?mode=${eng}&perf=/__perf&hud=0${RES?`&res=${RES}`:''}${AUDIO?`&e2e=${AUDIO}`:''}`;
  const ch = spawn(CHROME, [...args, url], { stdio: 'ignore' });
  kids.add(ch);
  await new Promise(r => setTimeout(r, SECS * 1000));
  ch.kill(); kids.delete(ch);
  // drop the first ~2s: shader compile, lazy target allocation and the fluid's first
  // frames are startup cost, not steady state, and they drag every percentile.
  const warm = frames.slice(Math.min(frames.length - 1, 120));
  const p50 = pct(warm, 0.50), p95 = pct(warm, 0.95), worst = warm.length ? Math.max(...warm) : NaN;
  const scale = last ? last.scale : NaN;
  const size = last ? `${last.w}x${last.h}` : '?';
  const fps = 1000 / p50;
  const verdict = !warm.length ? 'NO DATA'
    : scale < 0.99 ? `DOWNSCALED to ${Math.round(scale*100)}%`
    : p95 > vsGuess(p50)*1.30 ? 'will downscale'
    : 'holding 1.0';
  console.log(`${eng.padEnd(9)} ${size.padEnd(11)} ${fps.toFixed(0).padStart(4)}  ${p50.toFixed(1).padStart(6)}  ${p95.toFixed(1).padStart(6)}  ${worst.toFixed(0).padStart(6)}   ${String(scale).padEnd(5)}  ${verdict}`);
  results.push({ eng, p50, p95, scale });
}
srv.close();

console.log(`\nadaptResolution() thresholds are relative to the observed refresh period`);
console.log(`(snapped to 144/120/90/60/30Hz): down above 1.30x, up below 1.08x. Pass --audio`);
console.log(`<url> to actually exercise it -- the scaler only runs in the audio loop.`);
