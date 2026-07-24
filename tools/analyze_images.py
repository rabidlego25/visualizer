#!/usr/bin/env python3
"""
Zero-token image analyzer for pulling visualizer themes from inspiration art.

Uses Pillow to extract, WITHOUT any AI/model cost:
  - dimensions & aspect
  - average brightness and warm/cool balance
  - a dominant color palette (hex + how much of the frame each color covers)

Run:
  python3 tools/analyze_images.py inspiration/          # a folder
  python3 tools/analyze_images.py a.jpg b.jpg           # specific files

Output is compact text designed to be pasted back to the assistant so it can
turn the exact hex values into shader themes (u_c1 / u_c2 / hud colors).
"""
import sys, os, glob
from PIL import Image

EXTS = (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif")

def hexify(rgb):
    return "#%02x%02x%02x" % (rgb[0], rgb[1], rgb[2])

def analyze(path, n_colors=8):
    im = Image.open(path).convert("RGB")
    w, h = im.size
    small = im.copy()
    small.thumbnail((240, 240))  # speed: analyze a downscaled copy

    # average brightness + warm/cool
    px = list(small.getdata())
    n = len(px)
    avg = tuple(sum(c[i] for c in px) // n for i in range(3))
    lum = 0.299*avg[0] + 0.587*avg[1] + 0.114*avg[2]
    warm = sum(1 for c in px if c[0] > c[2]) / n  # red-leaning vs blue-leaning

    # dominant palette via adaptive quantization
    q = small.quantize(colors=n_colors, method=Image.Quantize.FASTOCTREE)
    pal = q.getpalette()
    counts = sorted(q.getcolors(), reverse=True)  # [(count, index), ...]
    total = sum(c for c, _ in counts)
    palette = []
    for count, idx in counts:
        rgb = tuple(pal[idx*3:idx*3+3])
        palette.append((hexify(rgb), round(100*count/total, 1)))

    print(f"\n=== {os.path.basename(path)}  ({w}x{h}, aspect {w/h:.2f}) ===")
    print(f"  avg color:  {hexify(avg)}   brightness: {lum:.0f}/255"
          f"   tone: {'warm' if warm>0.5 else 'cool'} ({warm*100:.0f}% warm px)")
    print("  palette (hex  coverage):")
    for hx, pct in palette:
        bar = "#" * max(1, int(pct/2))
        print(f"    {hx}  {pct:5.1f}%  {bar}")

def collect(args):
    paths = []
    for a in args:
        if os.path.isdir(a):
            for e in EXTS:
                paths += glob.glob(os.path.join(a, "*"+e))
                paths += glob.glob(os.path.join(a, "*"+e.upper()))
        elif os.path.isfile(a):
            paths.append(a)
    return sorted(set(paths))

if __name__ == "__main__":
    args = sys.argv[1:] or ["inspiration"]
    paths = collect(args)
    if not paths:
        print("No images found. Put files in ./inspiration/ or pass paths.")
        sys.exit(0)
    for p in paths:
        try:
            analyze(p)
        except Exception as e:
            print(f"  ! {p}: {e}")
    print(f"\nAnalyzed {len(paths)} image(s).")
