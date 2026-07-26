/* analysis-worker.js — runs analysis.js off the main thread.
   The analysis is a couple of seconds of tight numeric loops; on the UI thread that is
   a couple of seconds of frozen page, right at the moment the user has just handed the
   app their track. */
importScripts('analysis.js');

self.onmessage = function (e) {
  const { left, right, sampleRate } = e.data;
  try {
    const result = self.SongAnalysis.analyzeSong({
      left: new Float32Array(left),
      right: right ? new Float32Array(right) : null,
      sampleRate,
      onProgress: (phase, frac) => self.postMessage({ type: 'progress', phase, frac })
    });
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.stack || err) });
  }
};
