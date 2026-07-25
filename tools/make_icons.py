#!/usr/bin/env python3
"""Generate original NERV/MAGI-style PWA app icons (hexagon + cross, amber on dark).
Pure geometry -- no external assets. Outputs to ../icons/."""
import os, math
from PIL import Image, ImageDraw

OUT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "icons"))
os.makedirs(OUT, exist_ok=True)

BG      = (11, 10, 14)      # near-black
AMBER   = (255, 176, 74)
AMBERD  = (150, 92, 30)
HOT     = (255, 240, 210)

def hexagon(cx, cy, r, rot=math.pi/2):
    return [(cx + r*math.cos(rot + i*math.pi/3), cy + r*math.sin(rot + i*math.pi/3)) for i in range(6)]

def draw_icon(size, motif_frac):
    # supersample 4x for clean edges
    S = size*4
    im = Image.new("RGB", (S, S), BG)
    d = ImageDraw.Draw(im)
    cx = cy = S/2
    R = S*0.5*motif_frac
    lw = max(2, int(S*0.018))
    # outer hexagon (double ring)
    d.polygon(hexagon(cx, cy, R), outline=AMBER, width=lw)
    d.polygon(hexagon(cx, cy, R*0.80), outline=AMBERD, width=max(2, lw//2))
    # cruciform through the middle
    d.line([(cx, cy-R*0.62), (cx, cy+R*0.62)], fill=AMBER, width=lw)
    d.line([(cx-R*0.62, cy), (cx+R*0.62, cy)], fill=AMBER, width=lw)
    # eye/core
    rr = R*0.16
    d.ellipse([cx-rr, cy-rr, cx+rr, cy+rr], fill=HOT)
    rr2 = R*0.30
    d.ellipse([cx-rr2, cy-rr2, cx+rr2, cy+rr2], outline=AMBER, width=max(2, lw//2))
    return im.resize((size, size), Image.LANCZOS)

draw_icon(512, 0.86).save(os.path.join(OUT, "icon-512.png"))
draw_icon(512, 0.86).resize((192,192), Image.LANCZOS).save(os.path.join(OUT, "icon-192.png"))
draw_icon(512, 0.60).save(os.path.join(OUT, "maskable-512.png"))   # motif inside safe zone
print("icons ->", OUT, os.listdir(OUT))
