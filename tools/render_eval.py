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
# Software WebGL intermittently hands back a frame with nothing but the HUD on it.
# It is not a code bug and it does not correlate with the state -- the same query
# renders fine on a retry. Left unhandled it silently poisons a sweep: a black frame
# measures as brightness ~0.2 / nonblack ~0, which reads as a plausible "the change
# made everything dark" rather than as the failure it is.
# Default 3, measured rather than guessed: 6 states of fluid took 8m00s at 3 workers
# with ZERO blank-frame retries, against ~24 min serial. The old 6-way default is what
# produced the 5-of-9 blank run that made a whole sweep unusable, and 1 was an
# over-cautious reaction to it that cost ~3x for no reliability gain now that is_blank
# and EVAL_RETRY exist. Override with EVAL_WORKERS for a heavier machine or a
# web-geometry sweep (those are ~5x overdraw of translucent quads and much slower).
WORKERS = int(os.environ.get("EVAL_WORKERS", "0")) or 3
RETRIES = int(os.environ.get("EVAL_RETRY", "2"))
# Taller window than the canvas needs: the control bar sits ABOVE the stage, so a
# short window makes UI changes shrink the rendered preview and silently corrupt
# every measurement. Give the stage room so metrics track the visuals, not the layout.
W, H = 960, 1000         # browser window
TW, TH = 200, 356        # contact-sheet thumb (the frame itself is 9:16)

# (label, query string). Each is one rendered state.
# `mode=nebula` adds `warm=` : the particle sim is iterative, so a frame has to be
# warmed up with fixed steps or it only ever shows the seed distribution.
# Standard states pin trails=0 so the numbers stay comparable frame to frame; the
# dedicated "trails" states use &anim= to actually accumulate a wake.
STATES = [
    ("web idle / quiet",        "test=1&res=540&trails=0&bass=0.08&mid=0.06&treb=0.05&theme=0&t=2"),
    ("web bass SPIKE (expo=1)", "test=1&res=540&trails=0&bass=0.95&mid=0.3&treb=0.2&beat=1&expo=1&theme=0&t=2"),
    ("web bass SETTLED (auto)", "test=1&res=540&trails=0&bass=0.95&mid=0.3&treb=0.2&theme=0&t=2"),
    ("web treble / cyan",       "test=1&res=540&trails=0&bass=0.2&mid=0.4&treb=0.9&theme=2&t=2"),
    ("web TESTIFY loud+beat",   "test=1&res=540&trails=0&bass=0.7&mid=0.6&treb=0.4&beat=1&theme=4&t=2"),
    ("web CALM loud+beat",      "test=1&res=540&trails=0&bass=0.95&mid=0.5&treb=0.3&beat=1&safe=1&theme=0&t=2"),
    ("web TRAILS (anim)",       "test=1&res=540&trails=1&anim=45&bass=0.6&mid=0.5&treb=0.4&beat=0.7&theme=4&t=2"),
    # The geometry rewrite is only worth anything if the count actually scales, so
    # bracket it: a sparse graph and one an order of magnitude past the old 48 cap.
    # These deliberately run a QUIET background -- at high mid the AT-field hex grid
    # outshines the web entirely and both frames look identical regardless of count.
    ("web 24 nodes",            "test=1&res=540&trails=0&nodes=24&bass=0.12&mid=0.10&treb=0.08&theme=0&t=2"),
    ("web 400 nodes",           "test=1&res=540&trails=0&nodes=400&bass=0.12&mid=0.10&treb=0.08&theme=0&t=2"),
    ("wtr quiet",               "test=1&res=540&trails=0&mode=water&bass=0.15&mid=0.12&treb=0.10&theme=0&t=2"),
    ("wtr groove",              "test=1&res=540&trails=0&mode=water&bass=0.55&mid=0.45&treb=0.30&beat=0.5&theme=2&t=2"),
    ("wtr LOUD+beat",           "test=1&res=540&trails=0&mode=water&bass=0.85&mid=0.6&treb=0.5&beat=1&theme=4&t=2"),
    ("fld quiet",               "test=1&res=540&trails=0&mode=fluid&bass=0.15&mid=0.12&treb=0.10&theme=0&t=2&warm=200"),
    ("fld groove",              "test=1&res=540&trails=0&mode=fluid&bass=0.55&mid=0.45&treb=0.30&beat=0.5&theme=2&t=2&warm=200"),
    ("fld LOUD+beat",           "test=1&res=540&trails=0&mode=fluid&bass=0.85&mid=0.6&treb=0.5&beat=1&theme=4&t=2&warm=200"),
    ("fld BURST",               "test=1&res=540&trails=0&mode=fluid&bass=0.9&mid=0.6&treb=0.4&beat=1&burst=1.2&theme=3&t=2&warm=200"),
    ("neb idle / quiet",        "test=1&res=540&trails=0&mode=nebula&bass=0.10&mid=0.08&treb=0.06&theme=0&t=4&warm=200"),
    ("neb mid groove",          "test=1&res=540&trails=0&mode=nebula&bass=0.55&mid=0.45&treb=0.30&beat=0.5&theme=2&t=4&warm=200"),
    ("neb TESTIFY loud+beat",   "test=1&res=540&trails=0&mode=nebula&bass=0.85&mid=0.6&treb=0.5&beat=1&theme=4&t=4&warm=200"),
    ("neb COILED (build)",      "test=1&res=540&trails=0&mode=nebula&bass=0.6&mid=0.5&treb=0.6&coil=0.9&theme=1&t=4&warm=200"),
    ("neb BURST (drop)",        "test=1&res=540&trails=0&mode=nebula&bass=0.9&mid=0.6&treb=0.4&beat=1&burst=1.2&theme=3&t=4&warm=200"),
    ("neb CALM loud+beat",      "test=1&res=540&trails=0&mode=nebula&bass=0.9&mid=0.5&treb=0.3&beat=1&safe=1&theme=0&t=4&warm=200"),
    ("neb TRAILS (anim)",       "test=1&res=540&trails=1&anim=45&mode=nebula&bass=0.7&mid=0.5&treb=0.4&beat=0.8&theme=2&t=4&warm=150"),
]

def is_blank(png):
    """True if the render came back as HUD-only (the SwiftShader flake).

    Measured on the CENTRE of the stage, not the whole window and not crop_frame().
    The whole window does not separate the two cases: the NERV chrome alone lights
    8.9% of it, against 12.1% for a legitimately quiet nebula -- far too tight to
    threshold. crop_frame() is worse, because it takes the bounding box of everything
    lit, so on a blank frame it crops down to the HUD and hands back something that
    measures like a perfectly normal image. The middle of the stage is where the HUD
    chrome is not and where every mode puts its subject, so it separates cleanly:
    blank frames measure exactly 0.000, the dimmest real frame in any sweep measures
    0.185, and the web states sit at 0.37-0.67.
    """
    if not os.path.exists(png):
        return True
    im = Image.open(png).convert("L")
    stage = im.crop((0, 0, im.width, int(im.height*0.78)))
    w, h = stage.size
    mid = stage.crop((int(w*0.35), int(h*0.35), int(w*0.65), int(h*0.65))).resize((80, 80))
    px = list(mid.getdata())
    return sum(1 for v in px if v > 10) / len(px) < 0.03

def render(query, png, retries=0):
    for attempt in range(retries + 1):
        _render_once(query, png)
        if not is_blank(png):
            return
        if attempt < retries:
            print(f"  blank frame, retrying ({attempt+1}/{retries}): {query[:60]}",
                  file=sys.stderr)

def _render_once(query, png):
    # Delete first. A failed/timed-out render leaves the PREVIOUS run's file in place,
    # and measure() would happily report it as the current one -- stale numbers that
    # look plausible are far worse than a loud RENDER FAILED.
    if os.path.exists(png):
        os.remove(png)
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
                f"--window-size={W},{H}", "--virtual-time-budget=6000",
                f"--screenshot={png}", f"{EVA}?{query}",
            # 240s, not 60: the web is instanced geometry now, and software
            # rasterising ~5x overdraw of translucent quads is slow in a way a
            # real GPU never will be. A too-short timeout just yields black frames.
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=240)
        except subprocess.TimeoutExpired:
            pass  # non-fatal: leave png missing, caller reports RENDER FAILED

def crop_frame(im):
    """Crop to just the rendered canvas.

    The 9:16 canvas is a small part of a 960x540 window, so measuring the whole
    screenshot dilutes every number with page background and the control bar (that is
    why 'non-black %' used to sit near 24 regardless of what was on screen). Take the
    stage area above the seek bar, then the bounding box of what is actually lit.
    """
    stage = im.crop((0, 0, im.width, int(im.height * 0.78)))
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
    workers = max(1, min(WORKERS, os.cpu_count() or 4))
    if workers == 1:
        for j in jobs:
            render(j[1], j[2], RETRIES)
    else:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            list(pool.map(lambda j: render(j[1], j[2], RETRIES), jobs))

    print(f"{'state':26} {'brightness':>11} {'clipped%':>9} {'nonblack%':>10}")
    print("-"*60)
    for label, q, png in jobs:
        if not os.path.exists(png):
            print(f"{label:26}  RENDER FAILED"); continue
        if is_blank(png):
            # Report it, don't measure it. A blank frame's numbers are indistinguishable
            # from "the change made the scene disappear", which is the wrong conclusion
            # to hand back after an unattended sweep.
            print(f"{label:26}  BLANK (swiftshader flake, retries exhausted)"); continue
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
