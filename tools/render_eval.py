#!/usr/bin/env python3
"""
Visual self-evaluation harness for eva.html.

Drives headless Chrome (software WebGL) to render the visualizer in a set of
DETERMINISTIC states (via eva.html?test=...&bass=...&beat=...), screenshots each,
measures objective metrics (brightness, clipped-white %, non-black %), and stitches
a labeled contact sheet so the frames can be eyeballed in one image.

This lets the assistant verify its own visual code (correctness) without a human
in the loop. Usage:  python3 tools/render_eval.py
Output: scratchpad/eval/*.png  and  scratchpad/eval/contact_sheet.png
"""
import os, subprocess, tempfile, sys
from PIL import Image, ImageDraw

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
EVA = "file://" + os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "eva.html"))
OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scratchpad_eval"))
W, H = 960, 540

# (label, query string). Each is one rendered state.
STATES = [
    ("idle / quiet",            "test=1&bass=0.08&mid=0.06&treb=0.05&theme=0&t=2"),
    ("bass SPIKE (expo=1)",     "test=1&bass=0.95&mid=0.3&treb=0.2&beat=1&expo=1&theme=0&t=2"),
    ("bass SETTLED (auto)",     "test=1&bass=0.95&mid=0.3&treb=0.2&theme=0&t=2"),
    ("treble / cyan",           "test=1&bass=0.2&mid=0.4&treb=0.9&theme=2&t=2"),
    ("TESTIFY loud+beat",       "test=1&bass=0.7&mid=0.6&treb=0.4&beat=1&theme=4&t=2"),
    ("CALM (safe) loud+beat",   "test=1&bass=0.95&mid=0.5&treb=0.3&beat=1&safe=1&theme=0&t=2"),
]

def render(query, png):
    with tempfile.TemporaryDirectory() as prof:
        try:
            subprocess.run([
                CHROME, "--headless=new", "--hide-scrollbars", "--no-first-run",
                f"--user-data-dir={prof}",
                # kill background networking so virtual-time can actually idle & exit
                "--disable-background-networking", "--disable-default-apps",
                "--disable-sync", "--no-default-browser-check", "--disable-component-update",
                "--disable-features=Translate,MediaRouter,OptimizationHints,WebAppInstallation",
                "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
                "--run-all-compositor-stages-before-draw",  # avoid blank/early captures
                f"--window-size={W},{H}", "--virtual-time-budget=2000",
                f"--screenshot={png}", f"{EVA}?{query}",
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        except subprocess.TimeoutExpired:
            pass  # non-fatal: leave png missing, caller reports RENDER FAILED

def measure(png):
    im = Image.open(png).convert("RGB")
    small = im.resize((160, 90))
    px = list(small.getdata()); n = len(px)
    lum = [0.299*r+0.587*g+0.114*b for r,g,b in px]
    avg_lum = sum(lum)/n
    clipped = sum(1 for L in lum if L > 230)/n     # near-white "blown out"
    nonblack = sum(1 for L in lum if L > 12)/n
    return im, avg_lum, clipped*100, nonblack*100

def main():
    os.makedirs(OUT, exist_ok=True)
    results, thumbs = [], []
    print(f"{'state':26} {'brightness':>11} {'clipped%':>9} {'nonblack%':>10}")
    print("-"*60)
    for i,(label, q) in enumerate(STATES):
        slug = "".join(c if c.isalnum() else "_" for c in label.lower())[:20]
        png = os.path.join(OUT, f"{i}_{slug}.png")
        render(q, png)
        if not os.path.exists(png):
            print(f"{label:26}  RENDER FAILED"); continue
        im, L, clip, nb = measure(png)
        print(f"{label:26} {L:11.1f} {clip:9.1f} {nb:10.1f}")
        results.append((label, L, clip, nb))
        thumbs.append((label, im.resize((W//2, H//2))))

    # contact sheet: 2 columns
    if thumbs:
        tw, th = W//2, H//2
        cols, rows = 2, (len(thumbs)+1)//2
        pad, bar = 8, 22
        sheet = Image.new("RGB", (cols*tw + (cols+1)*pad, rows*(th+bar) + (rows+1)*pad), (10,10,12))
        d = ImageDraw.Draw(sheet)
        for i,(label,thumb) in enumerate(thumbs):
            c,r = i%cols, i//cols
            x = pad + c*(tw+pad); y = pad + r*(th+bar+pad)
            d.text((x+2,y), label, fill=(255,180,90))
            sheet.paste(thumb, (x, y+bar))
        cs = os.path.join(OUT, "contact_sheet.png")
        sheet.save(cs)
        print("\ncontact sheet ->", cs)

if __name__ == "__main__":
    main()
