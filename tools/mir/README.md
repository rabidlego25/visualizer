# MIR validation harness

Does `analysis.js` actually work on real music?

`tools/test_analysis.mjs` scores 10/10 — against a song **synthesised** with its tempo,
bar lines, key and section boundaries known by construction. That proves the DSP does
what was intended. It says nothing about whether it is right on a real mix, and
`eva.html`'s director now hangs the entire scene off those outputs. This harness closes
that gap.

## The parts

| file | runs where | what it does |
|---|---|---|
| `extract_ours.mjs` | anywhere (node + ffmpeg) | runs the **shipped** `analysis.js` over audio → JSON |
| `run_reference.py` | the GPU box | runs beat_this / madmom / allin1 / essentia → JSON |
| `score.py` | anywhere (numpy) | compares the two, or ours vs dataset annotations |
| `downbeat_probe.mjs` | anywhere | 6 arrangements, one variable each — where does the bar line go wrong? |
| `key_probe.mjs` | anywhere | classifier-vs-chroma split, and key detection with drums |

The two probes are regression tests for bugs this harness found. Run them after any
change to `analysis.js`.

`score.py` and its metrics are covered by `test_score.py` (30/30). `extract_ours.mjs`
was verified end-to-end on synthesised audio. **`run_reference.py` is the one file that
could not be tested when written** — none of those packages are installed on the dev
machine. Treat its first run as a smoke test, not a result; it probes and prints which
backends are importable before doing any work, precisely so a missing dependency does
not masquerade as a catastrophic `analysis.js` failure.

## Running it

```bash
# 1. ours (fast, ~47x realtime, CPU)
node tools/mir/extract_ours.mjs --in ~/tracks --out out/ours

# 2. reference (GPU)
python3 tools/mir/run_reference.py --in ~/tracks --out out/reference

# 3. compare
python3 tools/mir/score.py --ours out/ours --ref out/reference --per-track
```

Against a public dataset's annotation files instead of a model:

```bash
python3 tools/mir/score.py --ours out/ours --ref annotations/ --ref-format beats
```

Track names must match between the two directories — the file stem is the key.

## What to look at first

**The tempo metrical-level table, not the mean.** Half/double-time is the most common
failure of any tempo estimator and our only defence is a log-normal prior around
120 BPM. A run with high `tempo_acc2` and low `tempo_acc1` is not a near miss: the grid
is locked at the wrong level, and every bar-locked feature (loop recording, HUD bar
pips, the director's approach ramp) is wrong while staying self-consistent.

**The downbeat phase block.** A downbeat F of 0.000 cannot distinguish "the bar lines
are noise" from "the bar lines are perfect but land on beat 2". Those need completely
different fixes, so the scorer reports whole-beat shifts separately.

**`key_score` vs `key_exact`.** The weighted score gives 0.5 to a fifth error and 0.3 to
a relative major/minor. `analysis.js` has already shipped a bug that put the key a fifth
out (bass bins below ~200 Hz voting for an essentially arbitrary pitch class), so the
weighted score moving while exact accuracy does not points straight at that class of bug.

## Bugs this harness has already found

Both were live, both were invisible to `test_analysis.mjs`, and both hit the common case.

**1. The bar line was one beat late on every four-on-the-floor track.** `findDownbeats`
weighted low-end energy (the kick) and harmonic change with *fixed* weights. With a kick
on every beat the low-end means are flat to ~2% across phases, and the snare on 2 and 4
leaks into the sub-200 Hz band — so that 2% decided it. Beat F stayed 0.990 throughout;
only the bar phase was wrong, which propagates intact into `beatCount`, the HUD bar pips
and bar-locked loop recording. Cues are now weighted by how much they actually
discriminate. `downbeat_probe.mjs` covers it: 6/6, four of them four-on-the-floor.

**2. The key detector was reading drums.** Chroma was built from the mixed spectrogram,
so broadband hits deposited energy in all twelve pitch classes; a C major track read as
F minor. Chroma now comes from the harmonic component with the local spectral floor
subtracted. `key_exact` went 0.667 → 1.000 on the smoke test.

Both fixes are in `analysis.js`; the diagnosis notes are in CLAUDE.md.

## Known result from the smoke test

On three synthesised tracks with known answers (`extract_ours.mjs` → `score.py`).
When first run it reported `downbeat_f 0.000`, `boundary_f@0.5 0.533` and
`key_exact 0.667`; both underlying bugs were confirmed real and fixed (see above), and
it now reads:

```
beat_f          0.990        tempo_acc1     1.000     tempo err 0.06%
downbeat_f      1.000        boundary_f@0.5 1.000     boundary_f@3.0 1.000
key_score       1.000        key_exact      1.000
```

Note how the first version of this smoke test was itself wrong: it put C at MIDI 57,
which is A, so every "key error" was the test's fault. **Check the stimulus before
believing the finding** — twice more in the same session a "bug" turned out to be a
degenerate stimulus (a tempo probe where 187 BPM is legitimately 3/2 of 120, and a key
probe using pure sines that all sat below 360 Hz).

## Schema

Both extractors emit the same per-track JSON:

```json
{
  "track": "name",
  "duration": 212.4,
  "tempo_bpm": 128.0,
  "beats": [0.51, 0.98, ...],
  "downbeats": [0.51, 2.42, ...],
  "boundaries": [16.2, 48.9, ...],
  "key": {"tonic": "A", "mode": "minor", "confidence": 0.72},
  "section_labels": [{"start": 0.0, "label": "INTRO"}]
}
```

`boundaries` excludes t=0: every segmenter trivially agrees a track starts at its
beginning, and including it inflates boundary F for both sides equally.

## Notes for the 72h run

- **Your own catalog first.** You post your own singles; agreement on your material is
  what decides whether the director helps or fights you. Public sets are the
  generalization check afterward.
- **A V100 saturates this.** Beat/structure inference is small-model and short-sequence;
  the real cost is audio decode and STFT on CPU. Save the A100 for training/distillation
  if validation shows the heuristics are the weak link.
- **The binding constraint is audio, not GPU hours.** Harmonix Set ships annotations and
  features but not audio; RWC is licensed; SALAMI's audio is partly Internet Archive.
  Assembling a legitimate corpus will take longer than computing on it.
- If `mir_eval` is installed on the box, cross-check a handful of tracks against it.
  Agreement is cheap reassurance that these zero-dependency metrics match the standard.
