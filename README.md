# Sound Visualizers

Free, browser-based music visualizers. Load any audio file (or use your mic),
watch it react in real time, then **record a video** to post on your socials.
Everything runs locally in the browser — no uploads, no signup, works offline.

**▶ Live site:** https://rabidlego25.github.io/visualizer/

## What's inside

| Page | Tech | Highlights |
|-----------|------|-----------|
| **Pulse** (`pulse.html`) | Canvas 2D | Radial aurora, frequency bars, waveform ribbon, particle orbit · 5 palettes |
| **MAGI** (`eva.html`) | WebGL2 (GPU) | Four engines — neural web, 100k-particle nebula, spectral waterfall, fluid smoke · 5 palettes · feedback trails · your own title card |
| **Timeline** (`analyze.html`) | Web Audio + DSP | Analyses a whole track *before* playback: beat grid, downbeats, key, sections, drops, and separated drum/harmony/vocal envelopes |

Both visualizers support: loading audio or mic input, a scrub/seek timeline, one-click
video recording, and vertical (9:16, the default) / square (1:1) / wide (16:9) formats.
MAGI adds bar-locked loop recording, Reels safe-area guides, and a song "fingerprint"
you can export as cover art.

### Install it as an app

It's a PWA, so it works offline and installs to a home screen:
Android Chrome ⋮ → *Add to Home screen*; iOS Safari → Share → *Add to Home Screen*.

## Run locally

It's plain static HTML — just open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploy to GitHub Pages

1. Create a repo on GitHub and push this folder to it.
2. In the repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   pick your `main` branch and `/ (root)`, then **Save**.
3. Wait a minute; your site goes live at `https://rabidlego25.github.io/visualizer/`.

## Notes

- Recordings save as `.mp4` where the browser supports it, falling back to `.webm`.
- Sending a take over WhatsApp as a *video* re-encodes it to ~480–720p. Attach it as a
  **Document** instead and the file transfers untouched.
- MAGI needs a WebGL2-capable browser (any recent Chrome, Safari, Edge, Firefox).
  Fluid smoke additionally needs float render targets, and hides itself when they're missing.

## For developers

Plain static files — no build step, no dependencies, no backend. Two harnesses let the
visual and audio code be checked without a human in the loop:

```bash
python3 tools/render_eval.py      # headless renders of eva.html -> contact sheet + metrics
node tools/test_analysis.mjs      # analysis.js vs a synthesised song with known ground truth
```

`analysis.js` is the offline song analyser (also runs in Node); `analyze.html` is its
inspection page — open it with **Click** enabled to hear a metronome on the detected
beat grid over your own track.

## License

MIT — see [LICENSE](LICENSE).
