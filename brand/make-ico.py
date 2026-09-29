#!/usr/bin/env python3
"""favicon.ico for every Ferminux site, from the PNGs build.py renders (never redrawn by hand).
   python3 brand/make-ico.py   ->  brand/dist/favicon.ico (16, 32 and 48 px)"""
import os
from PIL import Image
here = os.path.dirname(os.path.abspath(__file__))
dist = os.path.join(here, "dist")
base = Image.open(os.path.join(dist, "favicon-48.png")).convert("RGBA")
imgs = {s: Image.open(os.path.join(dist, f"favicon-{s}.png")).convert("RGBA") for s in (16, 32, 48)}
base.save(os.path.join(dist, "favicon.ico"), format="ICO", sizes=[(16, 16), (32, 32), (48, 48)],
          append_images=[imgs[16], imgs[32]])
print("wrote", os.path.join(dist, "favicon.ico"), os.path.getsize(os.path.join(dist, "favicon.ico")), "bytes")
