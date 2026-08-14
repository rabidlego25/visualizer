/* extract_ours.mjs — run the SHIPPED analysis.js over real audio files.

   Emits one JSON per track in the common schema (schema.md) so tools/mir/score.py can
   compare it against a reference or against dataset annotations.

   It loads ../../analysis.js the same way analysis-worker.js does (classic script, via
   Function('self', src)) rather than re-implementing anything — the whole point is to
   measure the code that actually ships. If this file ever starts massaging the output
   beyond renaming fields, it is measuring the wrong thing.

   Decoding is delegated to ffmpeg, which handles mp3/m4a/wav/flac/ogg alike and is the
   one dependency here. Audio is converted to raw f32le so it can be read straight into
   the Float32Arrays analyzeSong wants, with no decoder in JS.

   Usage:
     node tools/mir/extract_ours.mjs --in ~/tracks --out out/ours
     node tools/mir/extract_ours.mjs --in ~/tracks --out out/ours --sr 22050 --mono
*/
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argv = (k, d = null) => {
  const i = args.indexOf(k);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : (args.includes(k) ? true : d);
};
const IN = argv('--in');
const OUT = argv('--out', 'out/ours');
const SR = parseInt(argv('--sr', '44100'), 10);
const MONO = !!argv('--mono', false);
const LIMIT = parseInt(argv('--limit', '0'), 10);
if (!IN) { console.error('usage: --in <audio dir> --out <json dir> [--sr N] [--mono] [--limit N]'); process.exit(2); }

// ---- load the shipped analyser exactly as the Worker does ------------------------
const asrc = fs.readFileSync(new URL('../../analysis.js', import.meta.url), 'utf8');
new Function('self', asrc)(globalThis);
const { analyzeSong } = globalThis.SongAnalysis;

const AUDIO = /\.(mp3|wav|flac|m4a|aac|ogg|opus|aiff?|wma)$/i;

function decode(file) {
  // -v quiet keeps ffmpeg's banner out of the PCM stream. f32le matches Float32Array
  // exactly, so the buffer can be viewed with no conversion pass.
  const ch = MONO ? 1 : 2;
  const r = spawnSync('ffmpeg', [
    '-v', 'quiet', '-i', file,
    '-f', 'f32le', '-acodec', 'pcm_f32le', '-ac', String(ch), '-ar', String(SR), '-',
  ], { maxBuffer: 1 << 30, encoding: 'buffer' });
  if (r.status !== 0 || !r.stdout || r.stdout.length === 0) return null;
  // Buffer may not be 4-byte aligned for a Float32Array view, so copy when it isn't.
  const buf = (r.stdout.byteOffset % 4 === 0)
    ? new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length >> 2)
    : new Float32Array(new Uint8Array(r.stdout).buffer);
  if (ch === 1) return { left: buf, right: null, sampleRate: SR };
  const n = buf.length >> 1;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = buf[i*2]; R[i] = buf[i*2+1]; }
  return { left: L, right: R, sampleRate: SR };
}

// ---- map our timeline onto the common schema ------------------------------------
function toSchema(name, A) {
  // Section STARTS are the boundaries. The leading 0.0 is dropped: every segmenter
  // trivially agrees that a track starts at its beginning, and leaving it in inflates
  // boundary F-measure for both sides equally, which flatters the comparison.
  const bounds = (A.sections || []).map(s => s.start).filter(t => t > 0.01);
  return {
    track: name,
    source: 'analysis.js',
    duration: A.duration,
    tempo_bpm: A.tempo ? A.tempo.bpm : null,
    tempo_confidence: A.tempo ? A.tempo.confidence : null,
    beats: A.beats || [],
    downbeats: A.downbeats || [],
    boundaries: bounds,
    key: A.key ? { tonic: A.key.tonic, mode: A.key.mode, confidence: A.key.confidence } : null,
    // carried through for error analysis, not scored
    section_labels: (A.sections || []).map(s => ({ start: s.start, label: s.label })),
    analysis_ms: A.analysisMs,
  };
}

fs.mkdirSync(OUT, { recursive: true });
let files = fs.readdirSync(IN).filter(f => AUDIO.test(f)).sort();
if (LIMIT) files = files.slice(0, LIMIT);
if (!files.length) { console.error(`no audio files in ${IN}`); process.exit(2); }

try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); }
catch { console.error('ffmpeg not found on PATH — required for decoding'); process.exit(2); }

console.log(`${files.length} files -> ${OUT}  (sr=${SR}${MONO ? ' mono' : ' stereo'})`);
let done = 0, failed = 0, totalAudio = 0, totalWall = 0;
for (const f of files) {
  const name = path.parse(f).name;
  const t0 = Date.now();
  let pcm;
  try { pcm = decode(path.join(IN, f)); }
  catch (e) { pcm = null; }
  if (!pcm || pcm.left.length < SR) {
    console.log(`  SKIP  ${name}  (decode failed or too short)`); failed++; continue;
  }
  let A;
  try { A = analyzeSong(pcm); }
  catch (e) { console.log(`  FAIL  ${name}  ${e.message}`); failed++; continue; }
  if (!A.ok) { console.log(`  SKIP  ${name}  (${A.reason})`); failed++; continue; }
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(toSchema(name, A)));
  const wall = (Date.now() - t0) / 1000;
  totalAudio += A.duration; totalWall += wall; done++;
  console.log(`  ok    ${name.slice(0, 40).padEnd(40)} ${A.tempo.bpm.toFixed(1)} BPM  `
    + `${A.key ? (A.key.tonic + ' ' + A.key.mode).padEnd(9) : '--'.padEnd(9)}`
    + `${(A.beats || []).length} beats  ${(A.sections || []).length} sections  ${wall.toFixed(1)}s`);
}
console.log(`\n${done} ok, ${failed} failed`);
if (totalWall > 0) console.log(`${(totalAudio/totalWall).toFixed(1)}x realtime`);
