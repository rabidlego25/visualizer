#!/usr/bin/env python3
"""Ground-truth self-test for score.py.

Same principle as tools/test_analysis.mjs and scratchpad/sim_*.py: construct cases
whose answers are known, then assert. This session already produced a NumPy port whose
boundary handling was wrong in a way that produced a *plausible physical result* -- a
scorer that is wrong in a plausible direction is worse than no scorer, because it would
be used to decide whether analysis.js is trustworthy.

The cases below are chosen to break the specific things that are easy to get wrong:
one-to-one matching (an estimator at 2x the beat rate must NOT score perfect recall),
the trim, the octave-error ratio, and the key-error weighting.

Usage: python3 tools/mir/test_score.py
"""
import os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from score import prf, match_events, tempo_scores, key_score, trim, score_pair

checks = []
def ok(name, cond, detail=''):
    checks.append((name, bool(cond), detail))


# ---- matching -------------------------------------------------------------------
ref = [1.0, 2.0, 3.0, 4.0, 5.0]
p, r, f = prf(ref, ref, 0.070)
ok('identical beats score F=1', abs(f - 1.0) < 1e-9, f'F={f:.4f}')

est = [t + 0.05 for t in ref]           # inside the 70ms window
_, _, f = prf(ref, est, 0.070)
ok('50ms offset still matches', abs(f - 1.0) < 1e-9, f'F={f:.4f}')

est = [t + 0.12 for t in ref]           # outside it
_, _, f = prf(ref, est, 0.070)
ok('120ms offset matches nothing', f == 0.0, f'F={f:.4f}')

# THE important one: an estimate at double the beat rate must be penalised. If matching
# is not one-to-one, recall comes out 1.0 and F ~0.67-1.0, and the harness would call a
# double-time tracker excellent -- the exact failure it is built to catch.
est = sorted(ref + [t + 0.5 for t in ref])
p, r, f = prf(ref, est, 0.070)
ok('double-rate estimate is penalised', r == 1.0 and abs(p - 0.5) < 1e-9 and abs(f - 2/3) < 1e-6,
   f'P={p:.3f} R={r:.3f} F={f:.3f}')

# ...and half-rate: perfect precision, half recall.
est = ref[::2]
p, r, f = prf(ref, est, 0.070)
ok('half-rate estimate is penalised', abs(p - 1.0) < 1e-9 and abs(r - 0.6) < 1e-9,
   f'P={p:.3f} R={r:.3f}')

# a reference must never be consumed twice
ok('one-to-one: 3 estimates near 1 ref -> 1 hit',
   match_events([1.0], [0.98, 1.0, 1.02], 0.070) == 1,
   f'hits={match_events([1.0], [0.98, 1.0, 1.02], 0.070)}')

ok('empty vs empty is F=1', prf([], [], 0.07)[2] == 1.0)
ok('empty est is F=0', prf([1, 2], [], 0.07)[2] == 0.0)

# ---- trim -----------------------------------------------------------------------
ok('trim drops pre-5s events', trim([1, 4.9, 5.0, 9.0]) == [5.0, 9.0],
   str(trim([1, 4.9, 5.0, 9.0])))

# ---- tempo ----------------------------------------------------------------------
t = tempo_scores(120.0, 120.0)
ok('exact tempo: acc1 and acc2', t['acc1'] == 1 and t['acc2'] == 1 and t['ratio'] == 1.0)

t = tempo_scores(120.0, 122.0)          # 1.7% out, inside 4%
ok('tempo within 4% passes acc1', t['acc1'] == 1, f"err={t['err_pct']:.2f}%")

t = tempo_scores(120.0, 131.0)          # 9.2% out
ok('tempo 9% out fails acc1', t['acc1'] == 0, f"err={t['err_pct']:.2f}%")

t = tempo_scores(120.0, 60.0)
ok('half-time: acc1 fails, acc2 passes, ratio=0.5',
   t['acc1'] == 0 and t['acc2'] == 1 and t['ratio'] == 0.5, f"ratio={t['ratio']}")

t = tempo_scores(120.0, 240.0)
ok('double-time: ratio=2.0', t['acc2'] == 1 and t['ratio'] == 2.0, f"ratio={t['ratio']}")

# 187 would have been a BAD stimulus: 120*1.5 = 180 and 187 is within 4% of it, so
# it is a legitimate 3/2 match, not an unrelated tempo. 145 is unrelated to every
# ratio in both sets. (Same trap test_analysis.mjs documents: check the stimulus is
# unambiguous before asserting on it.)
t = tempo_scores(120.0, 145.0)
ok('unrelated tempo fails both', t['acc1'] == 0 and t['acc2'] == 0 and t['ratio'] is None,
   f"ratio={t['ratio']} err={t['err_pct']:.1f}%")

t = tempo_scores(120.0, 180.0)
ok('3/2 is reported but does NOT count for acc2',
   t['acc2'] == 0 and t['ratio'] == 1.5, f"acc2={t['acc2']} ratio={t['ratio']}")

# ---- key ------------------------------------------------------------------------
K = lambda t, m: {'tonic': t, 'mode': m}
ok('same key = 1.0',      key_score(K('A', 'minor'), K('A', 'minor')) == 1.0)
ok('fifth = 0.5',         key_score(K('C', 'major'), K('G', 'major')) == 0.5)
ok('fourth = 0.5',        key_score(K('C', 'major'), K('F', 'major')) == 0.5)
# the bug analysis.js actually shipped: A minor read as F major (a fifth out)
ok('relative (Cmaj->Amin) = 0.3', key_score(K('C', 'major'), K('A', 'minor')) == 0.3)
ok('relative (Amin->Cmaj) = 0.3', key_score(K('A', 'minor'), K('C', 'major')) == 0.3)
ok('parallel = 0.2',      key_score(K('C', 'major'), K('C', 'minor')) == 0.2)
ok('unrelated = 0.0',     key_score(K('C', 'major'), K('D#', 'major')) == 0.0)
ok('enharmonic Bb == A#', key_score(K('Bb', 'major'), K('A#', 'major')) == 1.0)

# ---- end to end -----------------------------------------------------------------
# A synthetic 120 BPM track: our "estimate" is locked at half time, which is the
# realistic failure. Beat F should be poor, acc2 should catch it, ratio should say 0.5.
beats = [i*0.5 for i in range(80)]                    # 120 BPM
downs = beats[::4]
ref_rec = {'beats': beats, 'downbeats': downs, 'tempo_bpm': 120.0,
           'boundaries': [0.0, 16.0, 32.0], 'key': K('A', 'minor')}
# boundary offsets are chosen OUTSIDE the 0.5s window and inside the 3.0s one, so the
# two windows actually differ -- at 0.4s both scored 1.0 and the assertion was vacuous.
est_rec = {'beats': beats[::2], 'downbeats': downs, 'tempo_bpm': 60.0,
           'boundaries': [0.0, 17.2, 30.9], 'key': K('A', 'minor')}
s = score_pair(ref_rec, est_rec)
ok('e2e: half-time hurts beat_f', s['beat_f'] < 0.75, f"beat_f={s['beat_f']:.3f}")
ok('e2e: half-time flagged by ratio', s['tempo_ratio'] == 0.5 and s['tempo_acc1'] == 0,
   f"ratio={s['tempo_ratio']}")
ok('e2e: downbeats still perfect', abs(s['downbeat_f'] - 1.0) < 1e-9,
   f"downbeat_f={s['downbeat_f']:.3f}")
ok('e2e: boundaries loose window passes', s['boundary_f@3.0'] == 1.0)
ok('e2e: boundaries tight window is stricter',
   s['boundary_f@0.5'] < s['boundary_f@3.0'],
   f"0.5s={s['boundary_f@0.5']:.2f} 3.0s={s['boundary_f@3.0']:.2f}")
ok('e2e: key exact', s['key_score'] == 1.0)

# ---- report ---------------------------------------------------------------------
print()
npass = 0
for name, good, detail in checks:
    print(f"{' ok ' if good else 'FAIL'} {name}{'  (' + detail + ')' if detail else ''}")
    npass += good
print(f'\n{npass}/{len(checks)} passed')
sys.exit(0 if npass == len(checks) else 1)
