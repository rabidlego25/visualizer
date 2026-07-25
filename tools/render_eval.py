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
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageDraw

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
# EVA_FILE lets this run against another copy (e.g. `git show HEAD:eva.html`) so a
# change can be measured against its own baseline with identical states and cropping.
EVA = "file://" + os.path.abspath(os.environ.get(
    "EVA_FILE", os.path.join(os.path.dirname(__file__), "..", "eva.html")))
OUT = os.path.abspath(os.environ.get(
    "EVAL_OUT", os.path.join(os.path.dirname(__file__), "..", "scratchpad_eval")))
W, H = 960, 540          # browser window
TW, TH = 200, 356        # contact-sheet thumb (the frame itself is 9:16)

# (label, query string). Each is one rendered state.
# `mode=nebula` adds `warm=` : the particle sim is iterative, so a frame has to be
# warmed up with fixed steps or it only ever shows the seed distribution.
STATES = [
    ("web idle / quiet",        "test=1&bass=0.08&mid=0.06&treb=0.05&theme=0&t=2"),
    ("web bass SPIKE (expo=1)", "test=1&bass=0.95&mid=0.3&treb=0.2&beat=1&expo=1&theme=0&t=2"),
    ("web bass SETTLED (auto)", "test=1&bass=0.95&mid=0.3&treb=0.2&theme=0&t=2"),
    ("web treble / cyan",       "test=1&bass=0.2&mid=0.4&treb=0.9&theme=2&t=2"),
    ("web TESTIFY loud+beat",   "test=1&bass=0.7&mid=0.6&treb=0.4&beat=1&theme=4&t=2"),
    ("web CALM loud+beat",      "test=1&bass=0.95&mid=0.5&treb=0.3&beat=1&safe=1&theme=0&t=2"),
    ("neb idle / quiet",        "test=1&mode=nebula&bass=0.10&mid=0.08&treb=0.06&theme=0&t=4&warm=200"),
    ("neb mid groove",          "test=1&mode=nebula&bass=0.55&mid=0.45&treb=0.30&beat=0.5&theme=2&t=4&warm=200"),
    ("neb TESTIFY loud+beat",   "test=1&mode=nebula&bass=0.85&mid=0.6&treb=0.5&beat=1&theme=4&t=4&warm=200"),
    ("neb COILED (build)",      "test=1&mode=nebula&bass=0.6&mid=0.5&treb=0.6&coil=0.9&theme=1&t=4&warm=200"),
    ("neb BURST (drop)",        "test=1&mode=nebula&bass=0.9&mid=0.6&treb=0.4&beat=1&burst=1.2&theme=3&t=4&warm=200"),
    ("neb CALM loud+beat",      "test=1&mode=nebula&bass=0.9&mid=0.5&treb=0.3&beat=1&safe=1&theme=0&t=4&warm=200"),
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
                f"--window-size={W},{H}", "--virtual-time-budget=3000",
                f"--screenshot={png}", f"{EVA}?{query}",
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
        except subprocess.TimeoutExpired:
            pass  # non-fatal: leave png missing, caller reports RENDER FAILED

def crop_frame(im):
    """Crop to just the rendered canvas.

    The 9:16 canvas is a small part of a 960x540 window, so measuring the whole
    screenshot dilutes every number with page background and the control bar (that is
    why 'non-black %' used to sit near 24 regardless of what was on screen). Take the
    stage area above the seek bar, then the bounding box of what is actually lit.
    """
    stage = im.crop((0, 0, im.width, int(im.height * 0.64)))
    mask = stage.convert("L").point(lambda v: 255 if v > 10 else 0)
    bb = mask.getbbox()
    return stage.crop(bb) if bb else stage

def measure(png):
    im = Image.open(png).convert("RGB")
    frame = crop_frame(im)
    small = frame.resize((120, 200))
    px = list(small.getdata()); n = len(px)
    lum = [0.299*r+0.587*g+0.114*b for r,g,b in px]
    avg_lum = sum(lum)/n
    clipped = sum(1 for L in lum if L > 230)/n     # near-white "blown out"
    nonblack = sum(1 for L in lum if L > 12)/n
    return frame, avg_lum, clipped*100, nonblack*100

def main():
    os.makedirs(OUT, exist_ok=True)
    results, thumbs = [], []
    # Chrome instances are independent, and software WebGL is CPU-bound -- rendering
    # the states in parallel turns a ~12 minute sweep into a couple of minutes.
    jobs = []
    for i, (label, q) in enumerate(STATES):
        slug = "".join(c if c.isalnum() else "_" for c in label.lower())[:20]
        jobs.append((label, q, os.path.join(OUT, f"{i}_{slug}.png")))
    workers = min(6, max(1, (os.cpu_count() or 4) // 2))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(lambda j: render(j[1], j[2]), jobs))

    print(f"{'state':26} {'brightness':>11} {'clipped%':>9} {'nonblack%':>10}")
    print("-"*60)
    for label, q, png in jobs:
        if not os.path.exists(png):
            print(f"{label:26}  RENDER FAILED"); continue
        im, L, clip, nb = measure(png)
        print(f"{label:26} {L:11.1f} {clip:9.1f} {nb:10.1f}")
        results.append((label, L, clip, nb))
        thumbs.append((label, im.resize((TW, TH))))

    # contact sheet: the frames are 9:16, so lay them out as a wide strip of portraits
    if thumbs:
        tw, th = TW, TH
        cols = min(6, len(thumbs))
        rows = (len(thumbs)+cols-1)//cols
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
