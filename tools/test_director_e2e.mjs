/* test_director_e2e.mjs — does a real file load actually reach a ready director?

   tools/test_director.mjs covers the director's LOGIC by lifting the object out of
   eva.html and feeding it a timeline directly. That leaves one seam untested, and it is
   exactly the seam Stage 2 added:
       file -> arrayBuffer -> decodeAudioData -> analysis -> adopt()
   Integration bugs live in glue, so the glue gets driven for real: a real HTTP server,
   a real browser, a real audio file through the real loadFile() path.

   Two things this harness must NOT do, both learned the hard way:

   * No --virtual-time-budget. Chrome's virtual clock fast-forwards timers but does not
     wait for work on the real clock, so it races straight past both a Worker AND
     decodeAudioData. The first attempt at this test reported a flat timeout with
     status still 'ANALYSING' for exactly that reason. (analyze.html documents the same
     trap for Workers with &worker=0.) So: real time, and the page reports when done.

   * No polling for a file. The page signals completion by fetching /__result?..., and
     the server below — ours, not python's — resolves the moment that request arrives.
     That turns "wait long enough and hope" into an actual event.

   Usage: node tools/test_director_e2e.mjs
*/
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8199;
const TIMEOUT_MS = 120000;

// ---- a small WAV: a beat grid and one clear energy step --------------------------
// This is a PLUMBING probe, not a tempo stimulus. It is deliberately short so the test
// stays fast, and short+simple is exactly the case where the ACF's log-normal prior
// picks half-time — it reports ~60 BPM for this 120 BPM file. That is expected here
// and is NOT evidence of an analyser bug: tempo accuracy is asserted by
// tools/test_analysis.mjs against a properly unambiguous stimulus (0.05 BPM error).
// Do not "fix" the analyser from this number, and do not assert on it below.
function makeWav(){
  const SR = 44100, BPM = 120, BEAT = 60/BPM, SECS = 26;
  const n = SR*SECS, data = Buffer.alloc(n*2);
  for (let i=0;i<n;i++){
    const t = i/SR, beat = Math.floor(t/BEAT), bp = (t - beat*BEAT)/BEAT;
    const bar = Math.floor(beat/4);
    const lev = bar < 6 ? 0.3 : 1.0;
    let s = Math.sin(2*Math.PI*55*t)*Math.exp(-bp*16)*0.9*lev;
    if (beat%2===1) s += (Math.random()*2-1)*Math.exp(-bp*24)*0.4*lev;
    s += Math.sin(2*Math.PI*220*t)*0.10*lev;
    data.writeInt16LE(Math.max(-32767, Math.min(32767, s*12000)), i*2);
  }
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF',0); hdr.writeUInt32LE(36+data.length,4); hdr.write('WAVE',8);
  hdr.write('fmt ',12); hdr.writeUInt32LE(16,16); hdr.writeUInt16LE(1,20);
  hdr.writeUInt16LE(1,22); hdr.writeUInt32LE(SR,24); hdr.writeUInt32LE(SR*2,28);
  hdr.writeUInt16LE(2,32); hdr.writeUInt16LE(16,34);
  hdr.write('data',36); hdr.writeUInt32LE(data.length,40);
  return Buffer.concat([hdr, data]);
}

const REPORTER = `<!doctype html><meta charset=utf-8><body>
<iframe id=f src="/eva.html?e2e=/scratchpad/e2e_probe.wav&worker=0"
        style="width:900px;height:1000px;border:0"></iframe>
<script>
const t0 = Date.now(), done = m => fetch('/__result?' + encodeURIComponent(m));
const tick = () => {
  let w = null;
  try { w = document.getElementById('f').contentWindow; } catch (e) {}
  const s = w && w.__dirState;
  if (s) {
    const v = s();
    if (v.ready)  return done('ready:'+v.bpm+':'+v.beats+':'+v.sections);
    if (v.failed) return done('failed:'+(w.__e2eErr||'-'));
  }
  if (Date.now()-t0 > 90000)
    return done('timeout:' + (s ? JSON.stringify(s()) : 'no-hook'));
  setTimeout(tick, 200);
};
tick();
<\/script></body>`;

fs.mkdirSync(path.join(ROOT, 'scratchpad'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'scratchpad', 'e2e_reporter.html'), REPORTER);
fs.writeFileSync(path.join(ROOT, 'scratchpad', 'e2e_probe.wav'), makeWav());

const TYPES = { '.html':'text/html', '.js':'text/javascript', '.wav':'audio/wav',
                '.json':'application/json', '.png':'image/png' };
let resolveResult;
const result = new Promise(r => { resolveResult = r; });

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__result'){
    res.writeHead(204).end();
    resolveResult(decodeURIComponent(u.search.slice(1)));
    return;
  }
  const f = path.join(ROOT, decodeURIComponent(u.pathname));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()){
    res.writeHead(404).end(); return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => srv.listen(PORT, r));

const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'evae2e-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-first-run', `--user-data-dir=${prof}`,
  '--autoplay-policy=no-user-gesture-required', '--disable-background-networking',
  '--disable-default-apps', '--no-default-browser-check', '--disable-component-update',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  `http://localhost:${PORT}/scratchpad/e2e_reporter.html`,
], { stdio: 'ignore' });

const res = await Promise.race([
  result,
  new Promise(r => setTimeout(() => r('harness-timeout'), TIMEOUT_MS)),
]);
chrome.kill(); srv.close();

console.log('e2e result:', res);
if (res.startsWith('ready')){
  const [, bpm, beats, sections] = res.split(':');
  console.log(` ok  a real file load reached a ready director`);
  console.log(`     (${beats} beats, ${sections} sections; bpm=${bpm} — half-time on this`);
  console.log(`      short probe by design, see the note above makeWav)`);
  process.exit(0);
}
console.log('FAIL director did not reach ready');
process.exit(1);
