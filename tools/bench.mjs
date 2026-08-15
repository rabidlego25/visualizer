/* bench.mjs — the TRUE per-frame render cost of each engine, in milliseconds.

   WHY THIS EXISTS AND perf.mjs DOES NOT REPLACE IT
   Frame RATE is not frame COST. Chrome throttles occluded windows to ~30fps, and a window
   spawned from a terminal never has focus, so every rAF-based measurement from a harness
   reads 33.3ms regardless of what the page draws -- a page rendering NOTHING measures the
   same. That is a property of the window, not of the renderer.

   This drives eva.html's `?bench=N`, which renders N frames back to back with no rAF and
   a 1-pixel readPixels per frame. readPixels blocks until the GPU has actually retired
   the work (gl.finish() does NOT under ANGLE/Metal -- it returned the same ~0.3ms at 540p
   and 2160p, a 16x pixel change), so the number is immune to vsync and throttling. Runs headless, so it
   never opens a window or takes focus.

   Usage: node tools/bench.mjs [--frames 90] [--res 1080] [--engines web,nebula,fluid]
*/
import { spawn } from 'node:child_process';
import http from 'node:http'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8246;
const argv = process.argv.slice(2);
const flag = (k,d) => { const i = argv.indexOf(k); return i>=0 ? argv[i+1] : d; };
const FRAMES = flag('--frames','90'), RES = flag('--res','1080');
const ENGINES = flag('--engines','web,nebula,fluid').split(',');
const EXTRA = { web:'&relax=150', nebula:'&warm=600', fluid:'&warm=600', water:'&warm=112' };

const TYPES={'.html':'text/html','.js':'text/javascript','.json':'application/json','.wav':'audio/wav','.png':'image/png'};
let onBench=()=>{}, onDone=()=>{};
const srv = http.createServer((req,res)=>{
  const u=new URL(req.url,'http://x');
  if(u.pathname==='/__b'){
    if(u.searchParams.has('done')){res.writeHead(204).end();onDone();return;}
    const c=[];req.on('data',d=>c.push(d));
    req.on('end',()=>{try{onBench(JSON.parse(Buffer.concat(c).toString()));}catch{} res.writeHead(204).end();});
    return;
  }
  const f=path.join(ROOT,decodeURIComponent(u.pathname));
  if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404).end();return;}
  res.writeHead(200,{'Content-Type':TYPES[path.extname(f)]||'application/octet-stream'});
  fs.createReadStream(f).pipe(res);
});
await new Promise(r=>srv.listen(PORT,r));

const prof = fs.mkdtempSync(path.join(os.tmpdir(),'evabench-'));
const args = ['--no-first-run',`--user-data-dir=${prof}`,'--headless=new','--use-angle=metal',
              '--disable-background-networking','--no-default-browser-check','--window-size=1100,1200'];
const kids=new Set();
const reap=()=>{for(const c of kids){try{c.kill('SIGKILL');}catch{}}kids.clear();};
process.on('exit',reap); process.on('SIGINT',()=>{reap();process.exit(130);});

console.log(`true render cost, ${FRAMES} frames each, GPU-synced via readPixels, headless\n`);
console.log('engine    canvas        p50 ms   p95 ms    min    max    implies');
for (const eng of ENGINES){
  let got=null; onBench=(d)=>{got=d;};
  const q=`test=1&res=${RES}&mode=${eng}&bass=0.6&mid=0.5&treb=0.35&beat=0.4&theme=2&t=4${EXTRA[eng]||''}`
        + `&bench=${FRAMES}&post=/__b`;
  const done=new Promise(r=>{onDone=r;});
  const ch=spawn(CHROME,[...args,`http://localhost:${PORT}/eva.html?${q}`],{stdio:'ignore'});
  kids.add(ch);
  await Promise.race([done, new Promise(r=>{const t=setTimeout(r,120000);t.unref();})]);
  ch.kill(); kids.delete(ch);
  if(!got){ console.log(`${eng.padEnd(9)} NO DATA`); continue; }
  const fps = 1000/got.p50;
  const implies = fps>=115?'120fps ok': fps>=58?'60fps ok': fps>=29?'30fps only':'below 30fps';
  console.log(`${eng.padEnd(9)} ${(got.w+'x'+got.h).padEnd(12)} ${got.p50.toFixed(2).padStart(7)} ${got.p95.toFixed(2).padStart(8)} ${got.min.toFixed(1).padStart(6)} ${got.max.toFixed(1).padStart(6)}    ${implies} (${fps.toFixed(0)}fps)`);
}
srv.close(); process.exit(0);
