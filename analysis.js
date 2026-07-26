/* analysis.js — offline whole-song analysis.
 *
 * Stage 1 of "stop reacting, start directing". eva.html's listen() is causal: it can
 * only ever respond to the last couple of seconds, which is why the visuals can chase
 * a drop but never BUILD toward one. Given the whole PCM buffer up front (decodeAudioData
 * hands it over the moment a file loads) we can analyse the entire song before frame one
 * and hand the renderer a timeline: beat grid, downbeats, sections, per-instrument
 * envelopes, and the events (drops, builds, breakdowns) with timestamps in the future.
 *
 * Pure DSP, no dependencies, no Web Audio, no DOM — so it runs in a Worker, and runs in
 * Node against synthetic PCM with known ground truth (tools/test_analysis.mjs).
 *
 * Pipeline:
 *   1. STFT of L and R. mono = (L+R)/2 by linearity, so three spectra cost two FFTs.
 *   2. HPSS (Fitzgerald 2010): median-filter the magnitude spectrogram along time
 *      (-> harmonic) and along frequency (-> percussive), soft-mask. Beat tracking on
 *      the PERCUSSIVE part is far cleaner than on the full mix.
 *   3. Global tempo by prior-weighted autocorrelation, then Ellis (2007) dynamic-
 *      programming beat tracking — a global optimum over the whole song, where the
 *      realtime tracker only ever has a 6-second window.
 *   4. Bar-synchronous chroma + timbre -> self-similarity matrix -> Foote checkerboard
 *      novelty -> section boundaries, snapped to downbeats.
 *   5. Events + labels from the per-bar energy arc.
 */
(function (root) {
  'use strict';

  const FFT_N = 2048;                 // 46ms at 44.1k — enough frequency resolution for chroma
  const HOP   = 512;                  // 11.6ms, ~86 frames/sec: fine enough to place a beat
  const KEEP_HZ = 8600;               // bins above this carry nothing we measure, and the
                                      // spectrogram is the memory budget (frames x bins x 4B)
  const MED_T = 15;                   // HPSS median kernel along time (~0.17s) -> harmonic
  const MED_F = 15;                   // ...and along frequency -> percussive
  const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  // Krumhansl-Schmuckler key profiles.
  const KS_MAJOR = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
  const KS_MINOR = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];

  // ---- FFT ------------------------------------------------------------------
  function FFT(n){
    this.n = n;
    const bits = Math.round(Math.log2(n));
    this.rev = new Uint32Array(n);
    for (let i=0;i<n;i++){
      let r = 0;
      for (let b=0;b<bits;b++) r |= ((i>>b)&1) << (bits-1-b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n>>1);
    this.sin = new Float64Array(n>>1);
    for (let i=0;i<(n>>1);i++){
      this.cos[i] = Math.cos(-2*Math.PI*i/n);
      this.sin[i] = Math.sin(-2*Math.PI*i/n);
    }
  }
  FFT.prototype.forward = function(re, im){
    const n = this.n, rev = this.rev, C = this.cos, S = this.sin;
    for (let i=0;i<n;i++){
      const j = rev[i];
      if (j > i){ let t = re[i]; re[i]=re[j]; re[j]=t; t = im[i]; im[i]=im[j]; im[j]=t; }
    }
    for (let size=2; size<=n; size<<=1){
      const half = size>>1, step = n/size;
      for (let i=0;i<n;i+=size){
        for (let j=i,k=0;j<i+half;j++,k+=step){
          const c = C[k], s = S[k];
          const tr = re[j+half]*c - im[j+half]*s;
          const ti = re[j+half]*s + im[j+half]*c;
          re[j+half] = re[j]-tr; im[j+half] = im[j]-ti;
          re[j] += tr;           im[j] += ti;
        }
      }
    }
  };

  // ---- small helpers --------------------------------------------------------
  function medianOf(win, k){           // insertion sort; k is small (15) so this beats anything clever
    for (let i=1;i<k;i++){
      const v = win[i]; let j = i-1;
      while (j >= 0 && win[j] > v){ win[j+1] = win[j]; j--; }
      win[j+1] = v;
    }
    return win[k>>1];
  }
  function mean(a, n){ let s=0; for (let i=0;i<n;i++) s += a[i]; return n ? s/n : 0; }
  function stddev(a, n, m){ let s=0; for (let i=0;i<n;i++){ const d=a[i]-m; s+=d*d; } return Math.sqrt(n ? s/n : 0); }
  function clamp(v,a,b){ return v<a?a:v>b?b:v; }
  // moving average with a box of half-width h, edge-clamped
  function smoothBox(x, h){
    const n = x.length, out = new Float32Array(n);
    let acc = 0;
    for (let i=0;i<n;i++){
      acc += x[i];
      if (i > 2*h) acc -= x[i-2*h-1];
      out[Math.max(0,i-h)] = acc / Math.min(i+1, 2*h+1);
    }
    for (let i=n-h;i<n;i++) out[i] = out[Math.max(0,n-h-1)];
    return out;
  }

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64encode(bytes){
    let out = '';
    for (let i=0;i<bytes.length;i+=3){
      const a = bytes[i], b = bytes[i+1], c = bytes[i+2];
      const n = (a<<16) | ((b||0)<<8) | (c||0);
      out += B64[(n>>18)&63] + B64[(n>>12)&63]
           + (i+1 < bytes.length ? B64[(n>>6)&63] : '=')
           + (i+2 < bytes.length ? B64[n&63] : '=');
    }
    return out;
  }
  function b64decode(str){
    const clean = str.replace(/=+$/,'');
    const out = new Uint8Array(Math.floor(clean.length*3/4));
    let o = 0, buf = 0, bits = 0;
    for (let i=0;i<clean.length;i++){
      buf = (buf<<6) | B64.indexOf(clean[i]); bits += 6;
      if (bits >= 8){ bits -= 8; out[o++] = (buf >> bits) & 255; }
    }
    return out;
  }
  // Envelopes are ~86 values/sec — a 4-minute song is 20k floats each, and there are
  // eight of them. Quantised to a byte with the peak carried alongside, the whole
  // timeline stays small enough to ship next to the track.
  function packEnv(x){
    let max = 0;
    for (let i=0;i<x.length;i++) if (x[i] > max) max = x[i];
    const bytes = new Uint8Array(x.length), g = max > 1e-9 ? 255/max : 0;
    for (let i=0;i<x.length;i++) bytes[i] = clamp(Math.round(x[i]*g), 0, 255);
    return { peak: max, n: x.length, b64: b64encode(bytes) };
  }
  function unpackEnv(e){
    const bytes = b64decode(e.b64), out = new Float32Array(e.n), g = e.peak/255;
    for (let i=0;i<e.n;i++) out[i] = bytes[i]*g;
    return out;
  }

  // ---- pass 1: STFT ---------------------------------------------------------
  // Frames are centred (the signal is zero-padded by N/2), so frame f sits at exactly
  // f*HOP/sr seconds. Every downstream time — beat, boundary, event — inherits that.
  function spectrogram(L, R, sr, stereo, prog){
    const len = L.length;
    const F = Math.max(1, Math.floor(len/HOP) + 1);
    const bins = (FFT_N>>1) + 1;
    const KEEP = Math.min(bins, Math.ceil(KEEP_HZ*FFT_N/sr));
    const fft = new FFT(FFT_N);
    const win = new Float64Array(FFT_N);
    for (let i=0;i<FFT_N;i++) win[i] = 0.5 - 0.5*Math.cos(2*Math.PI*i/FFT_N);

    const S       = new Float32Array(F*KEEP);   // |mono| — the one big allocation
    const chroma  = new Float32Array(F*12);
    const rms     = new Float32Array(F);
    const eLow    = new Float32Array(F);
    const eMid    = new Float32Array(F);
    const eHigh   = new Float32Array(F);
    const centre  = new Float32Array(F);        // centre-panned energy 200-4k (vocal proxy)

    // bin -> pitch class, for chroma.
    // The floor is 200Hz, not the bass fundamentals: at a 21.5Hz bin width a semitone
    // is narrower than a bin below ~360Hz, so those bins assign an essentially arbitrary
    // pitch class — and the bass is the loudest thing in the mix, so that noise dominated
    // the profile and the key came out a fifth off. Roots still register through their
    // second harmonic, which lands an octave up in the SAME pitch class.
    // pw weights each bin by how close it actually sits to a semitone centre, so energy
    // falling between two notes doesn't get counted as fully as energy on one.
    const pc = new Int8Array(KEEP).fill(-1);
    const pw = new Float32Array(KEEP);
    for (let b=1;b<KEEP;b++){
      const f = b*sr/FFT_N;
      if (f < 200 || f > 2100) continue;
      const midi = 69 + 12*Math.log2(f/440);
      pc[b] = ((Math.round(midi) % 12) + 12) % 12;
      pw[b] = Math.exp(-0.5*Math.pow((midi - Math.round(midi))/0.28, 2));
    }
    const bLow = Math.max(1, Math.round(200*FFT_N/sr));
    const bMid = Math.min(KEEP, Math.round(2000*FFT_N/sr));
    const vLo  = Math.max(1, Math.round(200*FFT_N/sr));
    const vHi  = Math.min(KEEP, Math.round(4000*FFT_N/sr));

    const lre = new Float64Array(FFT_N), lim = new Float64Array(FFT_N);
    const rre = new Float64Array(FFT_N), rim = new Float64Array(FFT_N);

    for (let f=0;f<F;f++){
      const base = f*HOP - (FFT_N>>1);
      let r2 = 0;
      for (let i=0;i<FFT_N;i++){
        const s = base + i;
        const l = (s >= 0 && s < len) ? L[s] : 0;
        const r = stereo ? ((s >= 0 && s < len) ? R[s] : 0) : l;
        const w = win[i];
        lre[i] = l*w; lim[i] = 0;
        rre[i] = r*w; rim[i] = 0;
        const m = (l+r)*0.5; r2 += m*m;
      }
      rms[f] = Math.sqrt(r2/FFT_N);
      fft.forward(lre, lim);
      if (stereo) fft.forward(rre, rim);

      const off = f*KEEP, coff = f*12;
      let lo = 0, mid = 0, hi = 0, cen = 0;
      for (let b=0;b<KEEP;b++){
        // mono/mid and side straight from the two spectra: FFT is linear, so this is
        // exact, not an approximation, and saves a third transform.
        const mr = stereo ? (lre[b]+rre[b])*0.5 : lre[b];
        const mi = stereo ? (lim[b]+rim[b])*0.5 : lim[b];
        const m  = Math.sqrt(mr*mr + mi*mi);
        S[off+b] = m;
        if (b < bLow) lo += m; else if (b < bMid) mid += m; else hi += m;
        const p = pc[b];
        // log-compressed: raw magnitude lets one loud sustained note outvote a whole
        // chord, which reads as a key change every time the bass moves.
        if (p >= 0) chroma[coff+p] += Math.log(1 + m)*pw[b];
        if (stereo && b >= vLo && b < vHi){
          const sr_ = (lre[b]-rre[b])*0.5, si = (lim[b]-rim[b])*0.5;
          const side = Math.sqrt(sr_*sr_ + si*si);
          // 1 when the bin is identical in both channels, 0 when it is hard-panned.
          const centreness = m + side > 1e-9 ? m/(m+side) : 0;
          cen += m * Math.max(0, centreness - 0.5) * 2;
        }
      }
      eLow[f] = lo; eMid[f] = mid; eHigh[f] = hi; centre[f] = cen;
      if (prog && (f & 255) === 0) prog('spectrogram', f/F);
    }
    return { S, F, KEEP, chroma, rms, eLow, eMid, eHigh, centre, binHz: sr/FFT_N };
  }

  // ---- pass 2: HPSS ---------------------------------------------------------
  // A harmonic partial is a horizontal ridge (steady in time, narrow in frequency); a
  // drum hit is a vertical ridge (broadband, brief). Median-filtering along each axis
  // isolates one and suppresses the other. Only the ENVELOPES survive this pass — the
  // separated spectrograms would be another two 30MB arrays for no downstream use.
  function hpss(S, F, KEEP, prog){
    const H = new Float32Array(F*KEEP);          // time-median (harmonic estimate)
    const col = new Float32Array(F), win = new Float32Array(Math.max(MED_T, MED_F));
    const halfT = MED_T>>1;
    for (let b=0;b<KEEP;b++){
      for (let f=0;f<F;f++) col[f] = S[f*KEEP+b];
      for (let f=0;f<F;f++){
        for (let k=0;k<MED_T;k++) win[k] = col[clamp(f+k-halfT, 0, F-1)];
        H[f*KEEP+b] = medianOf(win, MED_T);
      }
      if (prog && (b & 31) === 0) prog('separation', b/KEEP*0.7);
    }

    const harm = new Float32Array(F), perc = new Float32Array(F), pflux = new Float32Array(F);
    const P = new Float32Array(KEEP), prevLog = new Float32Array(KEEP);
    const halfF = MED_F>>1;
    for (let f=0;f<F;f++){
      const off = f*KEEP;
      let hs = 0, ps = 0, fx = 0;
      for (let b=0;b<KEEP;b++){
        for (let k=0;k<MED_F;k++) win[k] = S[off + clamp(b+k-halfF, 0, KEEP-1)];
        P[b] = medianOf(win, MED_F);
      }
      for (let b=0;b<KEEP;b++){
        const h = H[off+b], p = P[b];
        const d = h*h + p*p;
        const mh = d > 1e-18 ? h*h/d : 0.5;      // soft (Wiener) mask, power 2
        const m = S[off+b];
        hs += m*mh;
        const pv = m*(1-mh);
        ps += pv;
        // flux on the log-compressed percussive part: a hit is energy ARRIVING, and the
        // log keeps a quiet snare from being buried under a loud one.
        const lg = Math.log(1 + 40*pv);
        const dl = lg - prevLog[b];
        if (dl > 0) fx += dl;
        prevLog[b] = lg;
      }
      harm[f] = hs; perc[f] = ps; pflux[f] = fx;
      if (prog && (f & 511) === 0) prog('separation', 0.7 + f/F*0.3);
    }
    return { harm, perc, pflux };
  }

  // ---- pass 3: tempo + beats ------------------------------------------------
  // Normalise the onset envelope: subtract a ~1.5s moving average and rectify, so a loud
  // chorus doesn't outvote a quiet verse in the autocorrelation.
  function onsetEnvelope(pflux, fps){
    const n = pflux.length;
    const sm = new Float32Array(n);
    for (let i=0;i<n;i++){
      sm[i] = 0.25*pflux[Math.max(0,i-1)] + 0.5*pflux[i] + 0.25*pflux[Math.min(n-1,i+1)];
    }
    const base = smoothBox(sm, Math.round(fps*0.75));
    const out = new Float32Array(n);
    for (let i=0;i<n;i++) out[i] = Math.max(0, sm[i] - base[i]);
    const m = mean(out, n), sd = stddev(out, n, m) || 1;
    for (let i=0;i<n;i++) out[i] = out[i]/sd;
    return out;
  }

  function estimateTempo(onset, fps){
    const n = onset.length;
    const loLag = Math.max(2, Math.round(fps*60/200));   // 200 BPM
    const hiLag = Math.min(n-1, Math.round(fps*60/60));  //  60 BPM
    const m = mean(onset, n);
    const scores = new Float32Array(hiLag+1);
    let best = -Infinity, bestLag = 0, sum = 0, cnt = 0;
    for (let lag=loLag; lag<=hiLag; lag++){
      let s = 0;
      const c = n - lag;
      for (let i=0;i<c;i++) s += (onset[i]-m)*(onset[i+lag]-m);
      s /= c;
      // Log-normal prior around 120 BPM. Without it the ACF happily picks half- or
      // double-time, which is the single most common failure of every tempo estimator.
      const bpm = fps*60/lag;
      const w = Math.exp(-0.5*Math.pow(Math.log2(bpm/120)/0.85, 2));
      const ws = s*w;
      scores[lag] = ws;
      sum += ws; cnt++;
      if (ws > best){ best = ws; bestLag = lag; }
    }
    // Refine to sub-frame accuracy by parabolic interpolation of the ACF peak: at 86fps
    // one frame of lag is ~1.5 BPM at 120, which drifts a whole beat over 90 seconds.
    let lag = bestLag;
    if (bestLag > loLag && bestLag < hiLag){
      const a = scores[bestLag-1], b = scores[bestLag], c = scores[bestLag+1];
      const d = a - 2*b + c;
      if (Math.abs(d) > 1e-12) lag = bestLag - 0.5*(c-a)/d;
    }
    const avg = sum/Math.max(1,cnt);
    const conf = avg > 1e-9 ? clamp((best/Math.abs(avg) - 1)/3, 0, 1) : 0;
    return { lag, bpm: fps*60/lag, conf };
  }

  // Ellis (2007): pick the beat sequence maximising (onset strength) + (how regularly
  // spaced it is), by dynamic programming over the whole song at once. This is what the
  // realtime tracker structurally cannot do — it only ever sees a 6-second window.
  function trackBeats(onset, period){
    const n = onset.length;
    const tight = 6, alpha = 0.8;
    const lo = Math.round(period*0.5), hi = Math.round(period*2);
    const span = hi - lo + 1;
    const txwt = new Float32Array(span);
    for (let k=0;k<span;k++){
      const d = (lo+k)/period;
      txwt[k] = -tight * Math.pow(Math.log(d), 2);
    }
    const cum = new Float32Array(n), back = new Int32Array(n).fill(-1);
    for (let i=0;i<n;i++){
      let bv = -Infinity, bj = -1;
      for (let k=0;k<span;k++){
        const j = i - (lo+k);
        if (j < 0) break;
        const v = txwt[k] + cum[j];
        if (v > bv){ bv = v; bj = j; }
      }
      if (bj < 0){ cum[i] = onset[i]; continue; }
      cum[i] = alpha*bv + (1-alpha)*onset[i];
      back[i] = bj;
    }
    // Start the backtrace at the last strong local maximum, not simply the global one —
    // otherwise a loud outro chops the tail off the grid.
    const maxes = [];
    for (let i=1;i<n-1;i++) if (cum[i] > cum[i-1] && cum[i] >= cum[i+1]) maxes.push(cum[i]);
    maxes.sort((a,b)=>a-b);
    const thr = maxes.length ? 0.5*maxes[maxes.length>>1] : 0;
    let start = -1;
    for (let i=n-2;i>0;i--){
      if (cum[i] > cum[i-1] && cum[i] >= cum[i+1] && cum[i] > thr){ start = i; break; }
    }
    if (start < 0){ let bv = -Infinity; for (let i=0;i<n;i++) if (cum[i] > bv){ bv = cum[i]; start = i; } }
    const beats = [];
    for (let i=start; i >= 0; i = back[i]) beats.push(i);
    beats.reverse();
    return beats;
  }

  // Which beat of the bar is "1"? Score every phase by what actually marks a downbeat:
  // low-end weight (the kick), and harmonic change (chords land on bar lines).
  function findDownbeats(beats, eLow, chroma, F, meterCandidates){
    const nb = beats.length;
    const lowAt = new Float32Array(nb), chgAt = new Float32Array(nb);
    for (let i=0;i<nb;i++){
      const f = clamp(beats[i], 0, F-1);
      let lo = 0;
      for (let k=-1;k<=1;k++) lo += eLow[clamp(f+k,0,F-1)];
      lowAt[i] = lo;
      if (i > 0){
        // cosine distance between the chroma either side of this beat
        const a = f*12, b = clamp(beats[i-1],0,F-1)*12;
        let d = 0, na = 0, nbv = 0;
        for (let p=0;p<12;p++){ d += chroma[a+p]*chroma[b+p]; na += chroma[a+p]**2; nbv += chroma[b+p]**2; }
        chgAt[i] = 1 - d/Math.max(1e-9, Math.sqrt(na*nbv));
      }
    }
    const lmax = Math.max(1e-9, Math.max.apply(null, Array.from(lowAt)));
    let best = { meter: 4, phase: 0, score: -Infinity };
    for (const meter of meterCandidates){
      for (let ph=0; ph<meter; ph++){
        let s = 0, c = 0;
        for (let i=ph;i<nb;i+=meter){ s += lowAt[i]/lmax + 1.5*chgAt[i]; c++; }
        s = c ? s/c : 0;
        // gentle preference for 4/4 — most of what this app will ever see is in four
        if (meter === 4) s *= 1.06;
        if (s > best.score) best = { meter, phase: ph, score: s };
      }
    }
    return best;
  }

  // ---- pass 4: structure ----------------------------------------------------
  // Bar-synchronous features. Bars, not frames: an 18k-frame SSM is 300M cells, a
  // 100-bar SSM is 10k, and musical structure changes on bar lines anyway.
  function barFeatures(bars, chroma, S, F, KEEP, harm, perc, rms, binHz){
    const nB = bars.length - 1;
    const NT = 16;                                  // log-spaced timbre bands, 60Hz..8k
    const edges = new Int32Array(NT+1);
    for (let i=0;i<=NT;i++) edges[i] = clamp(Math.round(60*Math.pow(8000/60, i/NT)/binHz), 1, KEEP);
    const ch = [], tb = [], en = new Float32Array(nB), pr = new Float32Array(nB);
    for (let i=0;i<nB;i++){
      const f0 = clamp(bars[i], 0, F-1), f1 = clamp(bars[i+1], f0+1, F);
      const c = new Float32Array(12), t = new Float32Array(NT);
      let e = 0, hsum = 0, psum = 0;
      for (let f=f0;f<f1;f++){
        for (let p=0;p<12;p++) c[p] += chroma[f*12+p];
        for (let k=0;k<NT;k++){
          let s = 0;
          for (let b=edges[k];b<edges[k+1];b++) s += S[f*KEEP+b];
          t[k] += s/Math.max(1, edges[k+1]-edges[k]);
        }
        e += rms[f]; hsum += harm[f]; psum += perc[f];
      }
      const n = f1-f0;
      let cn = 0; for (let p=0;p<12;p++) cn += c[p]*c[p];
      cn = Math.sqrt(cn) || 1;
      for (let p=0;p<12;p++) c[p] /= cn;
      for (let k=0;k<NT;k++) t[k] = Math.log(1 + t[k]/n*40);
      let tn = 0; for (let k=0;k<NT;k++) tn += t[k]*t[k];
      tn = Math.sqrt(tn) || 1;
      for (let k=0;k<NT;k++) t[k] /= tn;
      ch.push(c); tb.push(t);
      en[i] = e/n;
      pr[i] = psum+hsum > 1e-9 ? psum/(psum+hsum) : 0;
    }
    return { ch, tb, en, pr, nB };
  }

  // Foote: slide a checkerboard kernel down the diagonal of the self-similarity matrix.
  // Where the song changes, the "same as itself before / same as itself after / different
  // across" pattern spikes.
  function noveltyCurve(ch, tb, nB, L){
    const nov = new Float32Array(nB);
    const sim = (i,j) => {
      if (i<0||j<0||i>=nB||j>=nB) return 0;
      let a = 0, b = 0;
      const ci = ch[i], cj = ch[j], ti = tb[i], tj = tb[j];
      for (let p=0;p<12;p++) a += ci[p]*cj[p];
      for (let k=0;k<ti.length;k++) b += ti[k]*tj[k];
      return 0.5*a + 0.5*b;
    };
    const g = [];
    for (let u=-L;u<=L;u++) g.push(Math.exp(-0.5*Math.pow(u/(L*0.5), 2)));
    for (let c=0;c<nB;c++){
      let s = 0;
      for (let u=-L;u<=L;u++){
        for (let v=-L;v<=L;v++){
          if (u === 0 || v === 0) continue;
          const sign = (u*v > 0) ? 1 : -1;         // same quadrant = self-similar, cross = contrast
          s += sign * g[u+L]*g[v+L] * sim(c+u, c+v);
        }
      }
      nov[c] = Math.max(0, -s);                    // -s: a boundary is LOW self-similarity across
    }
    const m = mean(nov, nB), sd = stddev(nov, nB, m) || 1;
    for (let i=0;i<nB;i++) nov[i] = (nov[i]-m)/sd;
    return nov;
  }

  function pickBoundaries(nov, en, nB, minGap){
    const cand = [];
    const local = smoothBox(nov, 8);
    for (let i=1;i<nB-1;i++){
      if (nov[i] > nov[i-1] && nov[i] >= nov[i+1] && nov[i] > local[i] + 0.7) {
        cand.push({ bar: i, score: nov[i] - local[i] });
      }
    }
    // An energy cliff is a boundary even when the timbre barely moves — a drop into a
    // breakdown often keeps the same palette and just removes the drums.
    const eMax = Math.max(1e-9, Math.max.apply(null, Array.from(en)));
    for (let i=2;i<nB-1;i++){
      const before = (en[i-1]+en[i-2])/2/eMax, after = (en[i]+en[i+1])/2/eMax;
      const jump = Math.abs(after-before);
      if (jump > 0.20) cand.push({ bar: i, score: 1 + jump*3 });
    }
    cand.sort((a,b)=>b.score-a.score);
    const kept = [];
    for (const c of cand){
      if (kept.every(k => Math.abs(k - c.bar) >= minGap)) kept.push(c.bar);
    }
    kept.sort((a,b)=>a-b);
    return kept;
  }

  function keyOf(c){
    let best = { idx:-1, mode:'', score:-Infinity };
    const m = mean(c, 12);
    const dev = new Float32Array(12);
    for (let p=0;p<12;p++) dev[p] = c[p]-m;
    const norm = Math.sqrt(dev.reduce((s,v)=>s+v*v,0)) || 1;
    for (let rot=0;rot<12;rot++){
      for (const [prof, name] of [[KS_MAJOR,'major'],[KS_MINOR,'minor']]){
        const pm = mean(prof, 12);
        let dot = 0, pn = 0;
        for (let p=0;p<12;p++){
          const pv = prof[(p-rot+12)%12] - pm;
          dot += dev[p]*pv; pn += pv*pv;
        }
        const s = dot/(norm*Math.sqrt(pn) || 1);
        if (s > best.score) best = { idx: rot, mode: name, score: s };
      }
    }
    return { tonic: best.idx >= 0 ? NOTE_NAMES[best.idx] : '?', tonicIdx: best.idx,
             mode: best.mode, confidence: clamp(best.score, 0, 1) };
  }

  // ---- main -----------------------------------------------------------------
  function analyzeSong(o){
    const t0 = Date.now();
    const prog = o.onProgress || null;
    const sr = o.sampleRate;
    const L = o.left;
    const stereo = !!(o.right && o.right !== o.left && o.right.length === L.length);
    const R = stereo ? o.right : L;
    const fps = sr/HOP;
    const duration = L.length/sr;

    const sp = spectrogram(L, R, sr, stereo, prog);
    const { S, F, KEEP } = sp;
    if (F < 64) return { version:1, ok:false, reason:'too short to analyse', duration };

    const hp = hpss(S, F, KEEP, prog);
    if (prog) prog('tempo', 0);

    const onset = onsetEnvelope(hp.pflux, fps);
    const tempo = estimateTempo(onset, fps);
    const beatFrames = trackBeats(onset, tempo.lag);
    const beats = beatFrames.map(f => f/fps);
    const beatStrength = beatFrames.map(f => clamp(onset[clamp(f,0,F-1)]/3, 0, 1));

    const db = findDownbeats(beatFrames, sp.eLow, sp.chroma, F, [4,3]);
    const meter = db.meter;
    const downbeats = [], barFrames = [];
    for (let i=db.phase;i<beatFrames.length;i+=meter){ downbeats.push(beats[i]); barFrames.push(beatFrames[i]); }
    if (barFrames.length) barFrames.push(F);         // close the last bar

    if (prog) prog('structure', 0);
    let sections = [], events = [], arc = [], key = { tonic:'?', mode:'', confidence:0 };
    let bf = null;
    if (barFrames.length > 4){
      bf = barFeatures(barFrames, sp.chroma, S, F, KEEP, hp.harm, hp.perc, sp.rms, sp.binHz);
      const L8 = clamp(Math.round(8), 4, Math.max(4, Math.floor(bf.nB/4)));
      const nov = noveltyCurve(bf.ch, bf.tb, bf.nB, L8);
      const bounds = pickBoundaries(nov, bf.en, bf.nB, 4);
      const eMax = Math.max(1e-9, Math.max.apply(null, Array.from(bf.en)));
      arc = Array.from(bf.en, v => +(v/eMax).toFixed(4));

      const edges = [0].concat(bounds.filter(b => b > 0 && b < bf.nB)).concat([bf.nB]);
      for (let i=0;i<edges.length-1;i++){
        const a = edges[i], b = edges[i+1];
        let e = 0, p = 0;
        const c = new Float32Array(12);
        for (let k=a;k<b;k++){
          e += bf.en[k]; p += bf.pr[k];
          for (let q=0;q<12;q++) c[q] += bf.ch[k][q];
        }
        e /= (b-a); p /= (b-a);
        sections.push({
          startBar: a, endBar: b, bars: b-a,
          start: +(barFrames[a]/fps).toFixed(3),
          end:   +(barFrames[Math.min(b, barFrames.length-1)]/fps).toFixed(3),
          energy: +(e/eMax).toFixed(3),
          percussive: +p.toFixed(3),
          key: keyOf(c),
          label: ''
        });
      }
      // Labels are a HEURISTIC over the energy arc, not ground truth — they exist so a
      // director can say "cut on the drop" without a human annotating the song.
      sections.forEach((s, i) => {
        const prev = sections[i-1], next = sections[i+1];
        const rising = next && next.energy > s.energy + 0.12;
        if (i === 0 && s.energy < 0.5) s.label = 'INTRO';
        else if (i === sections.length-1 && s.energy < 0.7) s.label = 'OUTRO';
        else if (prev && s.energy > prev.energy + 0.22 && s.percussive > 0.30) s.label = 'DROP';
        else if (s.energy < 0.45 && prev && prev.energy > s.energy + 0.15) s.label = 'BREAKDOWN';
        else if (rising && s.energy < 0.75) s.label = 'BUILD';
        else if (s.energy > 0.75) s.label = 'CHORUS';
        else s.label = 'VERSE';
      });
      // Events carry the lookahead: a director reads these BEFORE the playhead reaches them.
      sections.forEach((s, i) => {
        const prev = sections[i-1];
        if (!prev) return;
        const d = s.energy - prev.energy;
        if (d > 0.20) events.push({ t: s.start, bar: s.startBar, type: 'drop', strength: +clamp(d*2,0,1).toFixed(3) });
        else if (d < -0.20) events.push({ t: s.start, bar: s.startBar, type: 'breakdown', strength: +clamp(-d*2,0,1).toFixed(3) });
        if (s.label === 'BUILD') {
          events.push({ t: s.start, bar: s.startBar, type: 'build_start', strength: 1,
                        untilBar: s.endBar, until: s.end });
        }
      });
      let ck = new Float32Array(12);
      for (let i=0;i<bf.nB;i++) for (let p=0;p<12;p++) ck[p] += bf.ch[i][p];
      key = keyOf(ck);
    }

    // vocal proxy: centre-panned energy, gated on the frame being harmonic. Vocals are
    // both — a centred kick is centre-panned but not harmonic, a panned guitar is
    // harmonic but not centred.
    const vocal = new Float32Array(F);
    if (stereo){
      for (let f=0;f<F;f++){
        const hr = hp.harm[f] + hp.perc[f] > 1e-9 ? hp.harm[f]/(hp.harm[f]+hp.perc[f]) : 0;
        vocal[f] = sp.centre[f] * Math.max(0, hr - 0.35) * 1.5;
      }
    }

    const env = {
      rate: fps,
      energy: packEnv(sp.rms),
      low:    packEnv(sp.eLow),
      mid:    packEnv(sp.eMid),
      high:   packEnv(sp.eHigh),
      percussive: packEnv(hp.perc),
      harmonic:   packEnv(hp.harm),
      onset:  packEnv(onset)
    };
    if (stereo) env.vocal = packEnv(vocal);

    if (prog) prog('done', 1);
    return {
      version: 1, ok: true,
      sampleRate: sr, duration: +duration.toFixed(3), stereo,
      frameRate: fps, hop: HOP, fftSize: FFT_N,
      tempo: { bpm: +tempo.bpm.toFixed(2), confidence: +tempo.conf.toFixed(3), meter,
               beatPeriod: +(60/tempo.bpm).toFixed(5) },
      key,
      beats: beats.map(t => +t.toFixed(3)),
      beatStrength: beatStrength.map(v => +v.toFixed(3)),
      downbeats: downbeats.map(t => +t.toFixed(3)),
      sections, events, arc, env,
      stems: { vocalAvailable: stereo },
      analysisMs: Date.now()-t0
    };
  }

  root.SongAnalysis = { analyzeSong, unpackEnv, packEnv, FFT, HOP, FFT_N };
})(typeof self !== 'undefined' ? self : globalThis);
