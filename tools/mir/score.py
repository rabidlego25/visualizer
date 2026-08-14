#!/usr/bin/env python3
"""Score analysis.js against a reference, on real music.

WHY THIS EXISTS
tools/test_analysis.mjs proves the DSP does what was intended -- against a song that
was SYNTHESISED with its tempo, bar lines, key and section boundaries known by
construction. That is a correctness test, not a validity test. It says nothing about
whether the analysis is right on a real mix, and eva.html's director now hangs the
entire scene off those outputs. This closes that gap.

Zero dependencies beyond numpy, on purpose: the standard tool (mir_eval) is not
installed here, so a wrapper around it could not have been tested before being handed
over. Every metric below is implemented directly and checked by tools/mir/test_score.py
against cases whose answers are known by construction. If mir_eval IS available on the
target box, cross-check with it -- agreement on a few tracks is cheap reassurance.

INPUT: two directories of per-track JSON in the common schema (see schema.md), or a
directory of reference ANNOTATION files from a public dataset.

    python3 tools/mir/score.py --ours out/ours --ref out/reference
    python3 tools/mir/score.py --ours out/ours --ref annotations/ --ref-format beats

Metric definitions follow the MIREX/mir_eval conventions so the numbers are comparable
to published results; each is documented at its implementation.
"""
import argparse, glob, json, os, sys
import numpy as np

NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
ENHARM = {'Db': 'C#', 'Eb': 'D#', 'Gb': 'F#', 'Ab': 'G#', 'Bb': 'A#',
          'Cb': 'B', 'Fb': 'E', 'E#': 'F', 'B#': 'C'}


# --------------------------------------------------------------------- matching ----
def match_events(ref, est, window):
    """Greedy one-to-one matching of two sorted time lists within +/- window.

    One-to-one is the part that matters and the part a naive implementation gets
    wrong: if an estimate may match several references (or vice versa), an estimator
    that emits beats at 4x the true rate scores a perfect recall, which is exactly the
    failure mode -- octave errors -- this harness exists to catch. Each reference is
    consumed at most once.
    """
    ref = np.asarray(ref, float); est = np.asarray(est, float)
    i = j = 0
    hits = 0
    while i < len(ref) and j < len(est):
        d = est[j] - ref[i]
        if abs(d) <= window:
            hits += 1; i += 1; j += 1
        elif d < 0:
            j += 1          # estimate is early: advance it
        else:
            i += 1          # estimate is late: this reference goes unmatched
    return hits


def prf(ref, est, window):
    """precision / recall / F-measure for event lists."""
    if len(ref) == 0 and len(est) == 0:
        return 1.0, 1.0, 1.0
    if len(ref) == 0 or len(est) == 0:
        return 0.0, 0.0, 0.0
    h = match_events(ref, est, window)
    p = h/len(est); r = h/len(ref)
    f = 0.0 if p + r == 0 else 2*p*r/(p + r)
    return p, r, f


def trim(times, t0=5.0):
    """mir_eval trims the first 5s of beat annotations before scoring.

    Trackers need a few seconds to lock on, and every published beat F-measure is
    computed this way -- not trimming makes our numbers look worse than the literature
    for no real reason.
    """
    return [t for t in times if t >= t0]


# ----------------------------------------------------------------------- tempo ----
# acc2 uses the MIREX set {1, 2, 1/2, 3, 1/3} and ONLY that set, so the number is
# comparable to published results. 3/2 and 2/3 are deliberately NOT in it: including
# them silently makes acc2 more lenient than the literature, which would flatter our
# numbers in exactly the comparison this harness exists to make honest.
ACC2_RATIOS = [1.0, 2.0, 0.5, 3.0, 1/3.0]
# The reported ratio uses a wider set, because a triplet-feel lock at 3/2 is a real
# failure worth naming even though it does not count toward acc2.
DIAG_RATIOS = ACC2_RATIOS + [1.5, 2/3.0]


def tempo_scores(ref_bpm, est_bpm, tol=0.04):
    """acc1 / acc2 plus the RATIO that matched.

    acc1: within 4% of the reference. acc2: within 4% of the reference times any of
    {1, 2, 1/2, 3, 1/3, 3/2, 2/3}.

    The ratio is reported rather than swallowed because half/double time is "the single
    most common failure of any tempo estimator" and our only defence is a log-normal
    prior around 120 BPM. A run where acc2 is high and acc1 is low is not a near miss;
    it means the grid is locked at the wrong metrical level and every bar-locked
    feature downstream (loop recording, bar pips, the director's approach ramp) is
    wrong in a way that still looks self-consistent.
    """
    if not ref_bpm or not est_bpm:
        return dict(acc1=0.0, acc2=0.0, ratio=None, err_pct=None)
    acc1 = abs(est_bpm - ref_bpm)/ref_bpm <= tol
    def best(ratios):
        br, be = None, 1e9
        for r in ratios:
            err = abs(est_bpm - ref_bpm*r)/(ref_bpm*r)
            if err < be:
                be, br = err, r
        return br, be
    _, acc2_err = best(ACC2_RATIOS)
    diag_ratio, diag_err = best(DIAG_RATIOS)
    return dict(acc1=float(acc1), acc2=float(acc2_err <= tol),
                ratio=diag_ratio if diag_err <= tol else None,
                err_pct=100*abs(est_bpm - ref_bpm)/ref_bpm)


# ------------------------------------------------------------------------- key ----
def norm_note(n):
    if not n:
        return None
    n = n.strip()
    n = n[0].upper() + n[1:]
    return ENHARM.get(n, n)


def key_score(ref, est):
    """MIREX weighted key score.

    same 1.0 | perfect fifth 0.5 | relative major/minor 0.3 | parallel 0.2 | else 0.
    A plain accuracy hides the structure of the errors, and the structure is the
    diagnostic: analysis.js has already shipped a bug that put the key a FIFTH out
    (bass bins below ~200 Hz voting for an arbitrary pitch class), and a fifth error
    scores 0.5 here while a random error scores 0 -- so the weighted score moving
    without accuracy moving points straight at that class of bug.
    """
    if not ref or not est:
        return None
    rt, rm = norm_note(ref.get('tonic')), (ref.get('mode') or '').lower()
    et, em = norm_note(est.get('tonic')), (est.get('mode') or '').lower()
    if rt not in NOTES or et not in NOTES:
        return None
    ri, ei = NOTES.index(rt), NOTES.index(et)
    if ri == ei and rm == em:
        return 1.0
    if rm == em and (ei - ri) % 12 in (7, 5):
        return 0.5
    # relative: minor is 3 semitones below its relative major
    if rm == 'major' and em == 'minor' and (ei - ri) % 12 == 9:
        return 0.3
    if rm == 'minor' and em == 'major' and (ei - ri) % 12 == 3:
        return 0.3
    if ri == ei and rm != em:
        return 0.2
    return 0.0


# -------------------------------------------------------------------- loading ----
def load_json_dir(d):
    out = {}
    for f in sorted(glob.glob(os.path.join(d, '*.json'))):
        with open(f) as fh:
            j = json.load(fh)
        out[j.get('track') or os.path.splitext(os.path.basename(f))[0]] = j
    return out


def load_annotation_dir(d, fmt):
    """Public-dataset annotations: one time per line, optionally `time<TAB>label`.

    `beats`     -> .beats/.txt where col 2 (if present) is the beat position in the bar;
                   position 1 means a downbeat, which is how Ballroom/GTZAN ship them.
    `segments`  -> .lab/.txt where col 1 is a boundary time.
    """
    out = {}
    for f in sorted(glob.glob(os.path.join(d, '*'))):
        if os.path.isdir(f):
            continue
        name = os.path.splitext(os.path.basename(f))[0]
        times, downs = [], []
        try:
            for line in open(f):
                parts = line.replace(',', ' ').split()
                if not parts:
                    continue
                try:
                    t = float(parts[0])
                except ValueError:
                    continue     # header row
                times.append(t)
                if fmt == 'beats' and len(parts) > 1:
                    try:
                        if int(float(parts[1])) == 1:
                            downs.append(t)
                    except ValueError:
                        pass
        except (OSError, UnicodeDecodeError):
            continue
        if not times:
            continue
        rec = {'track': name}
        if fmt == 'beats':
            rec['beats'] = times
            if downs:
                rec['downbeats'] = downs
        else:
            rec['boundaries'] = times
        out[name] = rec
    return out


# -------------------------------------------------------------------- scoring ----
def downbeat_phase_error(ref_db, est_db, beat_period):
    """How far off is the downbeat phase, measured in BEATS?

    A downbeat F-measure of 0.000 is true but useless: it cannot distinguish "the bar
    lines are noise" from "the bar lines are perfect but land on beat 2", and those
    call for completely different fixes. The second case is common and consequential --
    it silently shifts the director's beatCount, the HUD bar pips, and bar-locked loop
    recording, all of which then stay self-consistently wrong.

    Returns the median offset in beats, rounded to the nearest integer where it is
    close to one, so "off by exactly 1 beat" is stated rather than inferred.
    """
    if not ref_db or not est_db or not beat_period:
        return None
    ref_db = np.asarray(ref_db, float); est_db = np.asarray(est_db, float)
    offs = []
    for e in est_db:
        i = int(np.argmin(np.abs(ref_db - e)))
        offs.append((e - ref_db[i])/beat_period)
    med = float(np.median(offs))
    return dict(beats=med, nearest_int=int(round(med)),
                is_integer_shift=bool(abs(med - round(med)) < 0.15 and round(med) != 0))


def score_pair(ref, est, beat_win=0.070, seg_wins=(0.5, 3.0), trim_s=5.0):
    r = {}
    if ref.get('beats') and est.get('beats'):
        _, _, f = prf(trim(ref['beats'], trim_s), trim(est['beats'], trim_s), beat_win)
        r['beat_f'] = f
    if ref.get('downbeats') and est.get('downbeats'):
        _, _, f = prf(trim(ref['downbeats'], trim_s), trim(est['downbeats'], trim_s), beat_win)
        r['downbeat_f'] = f
        # When downbeat F is poor, say WHY: a whole-beat phase shift is a different bug
        # from a scattered grid, and only one of them is a one-line fix.
        bp = 60.0/est['tempo_bpm'] if est.get('tempo_bpm') else (
             60.0/ref['tempo_bpm'] if ref.get('tempo_bpm') else None)
        if f < 0.5 and bp:
            pe = downbeat_phase_error(ref['downbeats'], est['downbeats'], bp)
            if pe:
                r['db_phase_beats'] = pe['beats']
                if pe['is_integer_shift']:
                    r['db_shift'] = pe['nearest_int']
    rb = ref.get('tempo_bpm'); eb = est.get('tempo_bpm')
    if rb and eb:
        t = tempo_scores(rb, eb)
        r.update(tempo_acc1=t['acc1'], tempo_acc2=t['acc2'],
                 tempo_err_pct=t['err_pct'], tempo_ratio=t['ratio'])
    if ref.get('boundaries') and est.get('boundaries'):
        for w in seg_wins:
            _, _, f = prf(ref['boundaries'], est['boundaries'], w)
            r[f'boundary_f@{w}'] = f
    ks = key_score(ref.get('key'), est.get('key'))
    if ks is not None:
        r['key_score'] = ks
        r['key_exact'] = 1.0 if ks == 1.0 else 0.0
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ours', required=True, help='dir of our JSON timelines')
    ap.add_argument('--ref', required=True, help='dir of reference JSON or annotations')
    ap.add_argument('--ref-format', choices=['json', 'beats', 'segments'], default='json')
    ap.add_argument('--beat-window', type=float, default=0.070)
    ap.add_argument('--trim', type=float, default=5.0)
    ap.add_argument('--per-track', action='store_true')
    ap.add_argument('--out', help='write the full per-track table as JSON')
    a = ap.parse_args()

    ours = load_json_dir(a.ours)
    ref = (load_json_dir(a.ref) if a.ref_format == 'json'
           else load_annotation_dir(a.ref, a.ref_format))
    common = sorted(set(ours) & set(ref))
    if not common:
        print(f'no overlapping track names.\n  ours: {sorted(ours)[:4]}\n  ref : {sorted(ref)[:4]}',
              file=sys.stderr)
        sys.exit(2)
    print(f'{len(common)} tracks matched '
          f'({len(ours)-len(common)} ours-only, {len(ref)-len(common)} ref-only)\n')

    rows = {}
    for t in common:
        rows[t] = score_pair(ref[t], ours[t], a.beat_window, trim_s=a.trim)

    if a.per_track:
        keys = sorted({k for v in rows.values() for k in v})
        print(f"{'track':34}" + ''.join(f'{k:>15}' for k in keys))
        print('-'*(34 + 15*len(keys)))
        for t in common:
            print(f'{t[:33]:34}' + ''.join(
                (f'{rows[t][k]:15.3f}' if isinstance(rows[t].get(k), float)
                 else f"{str(rows[t].get(k,'-')):>15}") for k in keys))
        print()

    print('SUMMARY (mean over tracks reporting each metric)')
    print('-'*54)
    for k in ['beat_f', 'downbeat_f', 'tempo_acc1', 'tempo_acc2', 'tempo_err_pct',
              'boundary_f@0.5', 'boundary_f@3.0', 'key_score', 'key_exact']:
        vals = [v[k] for v in rows.values() if isinstance(v.get(k), float)]
        if vals:
            print(f'  {k:18} {np.mean(vals):7.3f}   (n={len(vals)})')

    # The octave-error breakdown is the headline diagnostic, so it gets its own block.
    shifts = [v['db_shift'] for v in rows.values() if v.get('db_shift') is not None]
    if shifts:
        print('\nDOWNBEAT PHASE (whole-beat shifts, where downbeat F was poor)')
        print('-'*54)
        for sh in sorted(set(shifts)):
            print(f'  {shifts.count(sh):4d} tracks shifted by {sh:+d} beat(s)')
        print('  A whole-beat shift means the grid is RIGHT and the bar line is wrong.')
        print('  It moves beatCount, the HUD bar pips and bar-locked loop recording')
        print('  together, so the result stays self-consistent while being off.')

    ratios = [v.get('tempo_ratio') for v in rows.values() if v.get('tempo_ratio')]
    if ratios:
        print('\nTEMPO METRICAL LEVEL (ratio of ours to reference)')
        print('-'*54)
        for r in sorted(set(ratios)):
            n = ratios.count(r)
            tag = 'CORRECT' if r == 1.0 else ('half-time' if r == 0.5 else
                                              'double-time' if r == 2.0 else 'other')
            print(f'  x{r:<6.3f} {n:4d} tracks  {tag}')
        wrong = sum(1 for r in ratios if r != 1.0)
        if wrong:
            print(f'\n  {wrong}/{len(ratios)} tracks locked at the WRONG metrical level.')
            print('  Every bar-locked feature (loop recording, bar pips, the director\'s')
            print('  approach ramp) is wrong on those, while still looking self-consistent.')

    if a.out:
        with open(a.out, 'w') as fh:
            json.dump(rows, fh, indent=1)
        print(f'\nper-track table -> {a.out}')


if __name__ == '__main__':
    main()
