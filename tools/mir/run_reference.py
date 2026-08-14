#!/usr/bin/env python3
"""Run reference MIR models over the same audio, emitting the common schema.

This is the GPU-side half of the harness. It is the ONE file here that could not be
tested in the session that wrote it -- none of these packages are installed on the dev
machine -- so it is written defensively: each backend is optional, probed at import,
and skipped with a clear message rather than taking the run down. Treat the first run
on the box as a smoke test, not a result.

Backends, in the order they are preferred:
  beats/downbeats : beat_this  ->  madmom (DBN)
  structure       : allin1
  key             : essentia

Install (V100 box, CUDA 11.8+ image; check current install docs, these move):
    pip install beat_this            # or: pip install madmom
    pip install allin1
    pip install essentia-tensorflow

Usage:
    python3 tools/mir/run_reference.py --in ~/tracks --out out/reference
    python3 tools/mir/run_reference.py --in ~/tracks --out out/reference --only beats
"""
import argparse, json, os, sys, glob, traceback

AUDIO_EXT = ('.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.aif', '.aiff')


def probe():
    """Report what is actually importable, before doing any work.

    A run that silently produces empty beat lists scores as a catastrophic failure of
    analysis.js rather than a missing dependency, so this prints the truth up front.
    """
    have = {}
    for mod in ('beat_this', 'madmom', 'allin1', 'essentia.standard', 'torch'):
        try:
            __import__(mod)
            have[mod] = True
        except Exception:
            have[mod] = False
    print('backends available:')
    for k, v in have.items():
        print(f'  {"yes" if v else " no"}  {k}')
    if have.get('torch'):
        try:
            import torch
            print(f'  cuda: {torch.cuda.is_available()} '
                  f'({torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu only"})')
        except Exception:
            pass
    print()
    return have


def beats_beat_this(path):
    from beat_this.inference import File2Beats
    f2b = File2Beats(device='cuda' if _cuda() else 'cpu')
    beats, downbeats = f2b(path)
    return list(map(float, beats)), list(map(float, downbeats)), 'beat_this'


def beats_madmom(path):
    import numpy as np
    from madmom.features.downbeats import (RNNDownBeatProcessor,
                                           DBNDownBeatTrackingProcessor)
    act = RNNDownBeatProcessor()(path)
    proc = DBNDownBeatTrackingProcessor(beats_per_bar=[3, 4], fps=100)
    out = proc(act)                      # (time, beat-position-in-bar)
    beats = [float(t) for t, _ in out]
    downs = [float(t) for t, b in out if int(b) == 1]
    return beats, downs, 'madmom'


def structure_allin1(path):
    import allin1
    r = allin1.analyze(path, device='cuda' if _cuda() else 'cpu')
    bounds = [float(s.start) for s in r.segments if s.start > 0.01]
    labels = [{'start': float(s.start), 'label': str(s.label)} for s in r.segments]
    return bounds, labels, float(r.bpm) if getattr(r, 'bpm', None) else None


def key_essentia(path):
    import essentia.standard as es
    audio = es.MonoLoader(filename=path, sampleRate=44100)()
    k, scale, strength = es.KeyExtractor()(audio)
    return {'tonic': k, 'mode': scale, 'confidence': float(strength)}


def _cuda():
    try:
        import torch
        return torch.cuda.is_available()
    except Exception:
        return False


def tempo_from_beats(beats):
    """Median inter-beat interval -> BPM. Median, not mean: one dropped or doubled beat
    skews a mean enough to cross the 4% acc1 threshold on its own."""
    if len(beats) < 4:
        return None
    import numpy as np
    d = np.diff(np.asarray(beats, float))
    d = d[(d > 0.2) & (d < 2.0)]
    return float(60.0/np.median(d)) if len(d) else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='inp', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--only', choices=['beats', 'structure', 'key'], action='append')
    ap.add_argument('--limit', type=int, default=0)
    a = ap.parse_args()

    have = probe()
    want = set(a.only) if a.only else {'beats', 'structure', 'key'}
    os.makedirs(a.out, exist_ok=True)

    files = sorted(f for f in glob.glob(os.path.join(a.inp, '*'))
                   if f.lower().endswith(AUDIO_EXT))
    if a.limit:
        files = files[:a.limit]
    if not files:
        print(f'no audio in {a.inp}', file=sys.stderr); sys.exit(2)
    print(f'{len(files)} files -> {a.out}\n')

    nok = 0
    for path in files:
        name = os.path.splitext(os.path.basename(path))[0]
        rec = {'track': name, 'source': 'reference'}
        got = []
        if 'beats' in want:
            for fn, need in ((beats_beat_this, 'beat_this'), (beats_madmom, 'madmom')):
                if not have.get(need):
                    continue
                try:
                    b, d, src = fn(path)
                    rec['beats'], rec['downbeats'] = b, d
                    rec['tempo_bpm'] = tempo_from_beats(b)
                    rec['beats_source'] = src
                    got.append(src)
                    break
                except Exception as e:
                    print(f'  {name}: {need} failed: {e}')
        if 'structure' in want and have.get('allin1'):
            try:
                bounds, labels, bpm = structure_allin1(path)
                rec['boundaries'] = bounds
                rec['section_labels'] = labels
                rec.setdefault('tempo_bpm', bpm)
                got.append('allin1')
            except Exception as e:
                print(f'  {name}: allin1 failed: {e}')
        if 'key' in want and have.get('essentia.standard'):
            try:
                rec['key'] = key_essentia(path)
                got.append('essentia')
            except Exception as e:
                print(f'  {name}: essentia failed: {e}')

        if len(got) == 0:
            print(f'  SKIP  {name}  (no backend produced anything)')
            continue
        with open(os.path.join(a.out, f'{name}.json'), 'w') as fh:
            json.dump(rec, fh)
        nok += 1
        print(f'  ok    {name[:44]:44} [{", ".join(got)}]')

    print(f'\n{nok}/{len(files)} written')
    if nok == 0:
        print('\nNo backend produced output. Install at least one (see the module '
              'docstring) -- an empty reference would score analysis.js at 0.0 and '
              'that number would mean nothing.', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        traceback.print_exc(); sys.exit(1)
