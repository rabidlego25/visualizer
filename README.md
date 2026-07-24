# Sound Visualizers

Free, browser-based music visualizers. Load any audio file (or use your mic),
watch it react in real time, then **record a video** to post on your socials.
Everything runs locally in the browser — no uploads, no signup, works offline.

**▶ Live site:** https://rabidlego25.github.io/visualizer/

## What's inside

| Visualizer | Tech | Highlights |
|-----------|------|-----------|
| **Pulse** (`pulse.html`) | Canvas 2D | Radial aurora, frequency bars, waveform ribbon, particle orbit · 5 palettes |
| **MAGI** (`eva.html`) | WebGL2 (GPU) | Neon-Genesis NERV terminal · AT-field hex grid, eye-core, cruciform bursts, live neural network |

Both support: loading audio or mic input, a scrub/seek timeline, one-click video
recording, and vertical (9:16) / square (1:1) / wide (16:9) formats for any platform.

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

- Recordings save as `.webm`. That plays on YouTube and most desktop uploads;
  some phone apps prefer `.mp4` (convertible with any tool, e.g. HandBrake).
- MAGI needs a WebGL2-capable browser (any recent Chrome, Safari, Edge, Firefox).

## License

MIT — see [LICENSE](LICENSE).
