#!/usr/bin/env python3
"""Build the Ferminux logo system (SVG + PNG) from the traced artwork.

  python3 brand/build.py        (needs rsvg-convert: brew install librsvg)

Source: source/ferminux-logo.pdf. word.svg and tag.svg are potrace traces of
its light lockup at 4x; everything else is measured geometry below.

All geometry lives in the source image's pixel space (src-002.png, 1254 px):
  mark polygons  -> measured from the traced silhouette (corner points)
  wordmark       -> potrace of the dark letters (word.svg)
  E bars         -> three measured bars (the E has no spine)
  tagline        -> potrace (tag.svg)
"""
import os, re, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "dist")
os.makedirs(OUT, exist_ok=True)

UPPER = [(556.5, 201), (967.5, 201), (843.5, 337.5), (565.5, 337.5), (558, 345), (558, 407.5),
         (493, 471.5), (487.5, 475.5), (418, 475.5), (418, 338.5)]
LOWER = [(581, 404.5), (847.5, 404.5), (725.5, 530), (558, 530), (558, 693.5), (418, 828), (418, 565.5)]
MARK_BOX = (418, 201, 967.5, 828)          # x0 y0 x1 y1
E_BARS = [(233, 883, 322, 903), (233, 915, 322, 935), (233, 947, 322, 967)]

def pts(p):
    return " ".join(f"{x:g},{y:g}" for x, y in p)

def potrace_group(name, box, s=4):
    svg = open(os.path.join(HERE, "source", f"{name}.svg")).read()
    d = " ".join(re.findall(r' d="([^"]+)"', svg))
    d = re.sub(r"\s+", " ", d).strip()
    h = float(re.search(r'translate\(0\.000000,([0-9.]+)\)', svg).group(1))
    x0, y0 = box[0], box[1]
    return f'<g transform="translate({x0} {y0}) scale({1/s:g}) translate(0 {h:g}) scale(0.1 -0.1)"><path d="{d}"/></g>'

WORD = potrace_group("word", (90, 865, 1170, 985))
TAG = potrace_group("tag", (180, 995, 1080, 1045))

# Wordmark bbox, measured on the artwork's raster (dark letters + E bars).
WORD_BOX = (104, 883, 1150, 967)
TAG_BOX = (196, 1004, 1058, 1031)

# Faces of the folded ribbon, measured on the artwork. Each stroke is a light
# face; the upper one folds under along x+y=895, the lower one along x=558.
U_DARK = [(566, 329), (565.5, 337.5), (558, 345), (558, 407.5), (493, 471.5), (487.5, 475.5), (419.5, 475.5)]
U_BEVEL = [(566, 329), (851, 329), (843.5, 337.5), (565.5, 337.5)]
L_BAR = [(558, 427.2), (581, 404.5), (847.5, 404.5), (725.5, 530), (558, 530)]

def lin(id_, x1, y1, x2, y2, stops):
    s = "".join(f'<stop offset="{o:g}" stop-color="{c}"/>' for o, c in stops)
    return f'<linearGradient id="{id_}" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" gradientUnits="userSpaceOnUse">{s}</linearGradient>'

def defs(uid, glow=False):
    g = "".join([
        lin(f"u{uid}", 418, 0, 967.5, 0, [(0, "#3CFBC0"), (.12, "#05EE93"), (.33, "#02D181"), (.52, "#02CF8C"), (.84, "#02FBD5"), (1, "#1CFCEE")]),
        lin(f"d{uid}", 560, 338, 440, 476, [(0, "#022E1E"), (.3, "#01563B"), (.72, "#0F8A66"), (1, "#04B27A")]),
        lin(f"v{uid}", 566, 0, 851, 0, [(0, "#063A25"), (.55, "#07885F"), (1, "#09BB96")]),
        lin(f"s{uid}", 558, 427, 418, 828, [(0, "#10FBC8"), (.3, "#02D48A"), (.62, "#02F0AA"), (1, "#24FCF2")]),
        lin(f"b{uid}", 558, 0, 847.5, 0, [(0, "#01583D"), (.2, "#019566"), (.42, "#02C58C"), (.63, "#02EEB7"), (.85, "#01FCE5"), (1, "#1CFCEE")]),
        lin(f"e{uid}", 0, 883, 0, 967, [(0, "#0BDEC6"), (.5, "#00B38F"), (1, "#028A69")]),
    ])
    if glow:
        g += (f'<filter id="g{uid}" x="-30%" y="-30%" width="160%" height="160%">'
              '<feGaussianBlur in="SourceAlpha" stdDeviation="22" result="b"/>'
              '<feFlood flood-color="#05EFB6" flood-opacity=".45"/><feComposite in2="b" operator="in" result="glow"/>'
              '<feMerge><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/></feMerge></filter>')
    return f"<defs>{g}</defs>"

RIM = ' stroke="#8CFFDD" stroke-opacity=".55" stroke-width="2.5" stroke-linejoin="round"'

def mark(uid, glow=False):
    f = f' filter="url(#g{uid})"' if glow else ""
    return (f'<g{f}><polygon fill="url(#u{uid})"{RIM} points="{pts(UPPER)}"/>'
            f'<polygon fill="url(#d{uid})" points="{pts(U_DARK)}"/><polygon fill="url(#v{uid})" points="{pts(U_BEVEL)}"/>'
            f'<polygon fill="url(#s{uid})"{RIM} points="{pts(LOWER)}"/><polygon fill="url(#b{uid})" points="{pts(L_BAR)}"/></g>')

def wordmark(uid, ink):
    bars = "".join(f'<rect x="{a}" y="{b}" width="{c-a}" height="{d-b}" rx="2"/>' for a, b, c, d in E_BARS)
    return f'<g fill="{ink}">{WORD}</g><g fill="url(#e{uid})">{bars}</g>'

def svg(vb, body, title):
    x, y, w, h = vb
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x:g} {y:g} {w:g} {h:g}" role="img" aria-label="{title}">'
            f"<title>{title}</title>{body}</svg>\n")

def write(name, text):
    open(os.path.join(OUT, name), "w").write(text)

INK_DARK_BG, INK_LIGHT_BG, TAG_INK = "#F2F6F4", "#08121B", "#24CFA1"
mx0, my0, mx1, my1 = MARK_BOX
pad = 8

# 1. Mark only (transparent) + glowing mark for dark heroes.
write("fmx-mark.svg", svg((mx0 - pad, my0 - pad, mx1 - mx0 + 2 * pad, my1 - my0 + 2 * pad), defs("a") + mark("a"), "Ferminux"))
gp = 70
write("fmx-mark-glow.svg", svg((mx0 - gp, my0 - gp, mx1 - mx0 + 2 * gp, my1 - my0 + 2 * gp), defs("b", True) + mark("b", True), "Ferminux"))

# 2. Stacked lockups (as the artwork): mark, wordmark, tagline.
sx0, sy0, sx1, sy1 = min(WORD_BOX[0], TAG_BOX[0]) - 30, my0 - 40, max(WORD_BOX[2], TAG_BOX[2]) + 30, TAG_BOX[3] + 30
for tone, ink in (("dark", INK_DARK_BG), ("light", INK_LIGHT_BG)):
    body = defs("s" + tone) + mark("s" + tone) + wordmark("s" + tone, ink) + f'<g fill="{TAG_INK}">{TAG}</g>'
    write(f"ferminux-lockup-{tone}.svg", svg((sx0, sy0, sx1 - sx0, sy1 - sy0), body, "Ferminux — AI economy on chain"))

# 3. Horizontal header lockups: mark at 1.9x cap height, then the wordmark.
cap = WORD_BOX[3] - WORD_BOX[1]
ms = (1.75 * cap) / (my1 - my0)
mh, mw = (my1 - my0) * ms, (mx1 - mx0) * ms
gap = cap * 0.55
wx = mw + gap - WORD_BOX[0]
wy = (mh - cap) / 2 - WORD_BOX[1]
for tone, ink in (("dark", INK_DARK_BG), ("light", INK_LIGHT_BG)):
    body = (defs("h" + tone) + f'<g transform="translate({-mx0 * ms:g} {-my0 * ms:g}) scale({ms:g})">{mark("h" + tone)}</g>'
            + f'<g transform="translate({wx:g} {wy:g})">{wordmark("h" + tone, ink)}</g>')
    write(f"ferminux-wordmark-{tone}.svg", svg((-3, -3, wx + WORD_BOX[2] + 6, mh + 6), body, "Ferminux"))

# 4. Favicon / app icon: mark on a black rounded square; round token icon.
def icon(uid, shape):
    s = 640 / (my1 - my0) * (0.74 if shape == "square" else 0.6)
    tx = 320 - ((mx0 + mx1) / 2) * s
    ty = 320 - ((my0 + my1) / 2) * s
    bg = ('<rect width="640" height="640" rx="140" fill="#000"/>' if shape == "square"
          else '<circle cx="320" cy="320" r="320" fill="#000"/><circle cx="320" cy="320" r="304" fill="none" stroke="#0B2A20" stroke-width="10"/>')
    return svg((0, 0, 640, 640), defs(uid) + bg + f'<g transform="translate({tx:g} {ty:g}) scale({s:g})">{mark(uid)}</g>', "Ferminux")
write("favicon.svg", icon("f", "square"))
write("fmx-token.svg", icon("t", "round"))

# 5. Social card 1200x630: glowing mark over the wordmark and tagline.
W, H = 1200, 630
card_mark_h = 300
cs = card_mark_h / (my1 - my0)
ctx = W / 2 - ((mx0 + mx1) / 2) * cs
cty = 70 - my0 * cs
lw = (WORD_BOX[2] - WORD_BOX[0])
ls = 760 / lw
ltx = W / 2 - ((WORD_BOX[0] + WORD_BOX[2]) / 2) * ls
lty = 430 - WORD_BOX[1] * ls
grid = "".join(f'<path d="M{x} 0V{H}" stroke="#0E1512"/>' for x in range(0, W + 1, 60)) + \
       "".join(f'<path d="M0 {y}H{W}" stroke="#0E1512"/>' for y in range(0, H + 1, 60))
card = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}">' + defs("c", True) +
        f'<rect width="{W}" height="{H}" fill="#000"/><g opacity=".8">{grid}</g>'
        f'<g transform="translate({ctx:g} {cty:g}) scale({cs:g})">{mark("c", True)}</g>'
        f'<g transform="translate({ltx:g} {lty:g}) scale({ls:g})">{wordmark("c", INK_DARK_BG)}<g fill="{TAG_INK}">{TAG}</g></g></svg>\n')
write("fmx-og-dark.svg", card)

def png(name, w, h=None, bg=None):
    args = ["rsvg-convert", "-w", str(w)] + (["-h", str(h)] if h else []) + (["-b", bg] if bg else [])
    subprocess.run(args + [os.path.join(OUT, name), "-o", os.path.join(OUT, name.replace(".svg", f"-{w}.png"))], check=True)

for w in (16, 32, 48, 180, 192, 512):
    png("favicon.svg", w)
for w in (64, 256, 512):
    png("fmx-token.svg", w)
png("fmx-og-dark.svg", 1200, 630)
png("ferminux-lockup-dark.svg", 1200, bg="#000000")
png("ferminux-lockup-light.svg", 1200, bg="#ffffff")
png("ferminux-wordmark-dark.svg", 640, bg="#000000")
png("fmx-mark-glow.svg", 512, bg="#000000")
print("\n".join(sorted(os.listdir(OUT))))

# 6. Inline snippets for the sites: one sprite (gradients + two symbols) and a
#    React component. Symbols keep the artwork's own coordinates.
def grads(prefix):
    d = defs(prefix)
    return d[len("<defs>"):-len("</defs>")]

def mark_body(uid):
    return (f'<polygon fill="url(#u{uid})" points="{pts(UPPER)}"/><polygon fill="url(#d{uid})" points="{pts(U_DARK)}"/>'
            f'<polygon fill="url(#v{uid})" points="{pts(U_BEVEL)}"/><polygon fill="url(#s{uid})" points="{pts(LOWER)}"/>'
            f'<polygon fill="url(#b{uid})" points="{pts(L_BAR)}"/>')

MARK_VB = f"{mx0 - 1:g} {my0 - 1:g} {mx1 - mx0 + 2:g} {my1 - my0 + 2:g}"
WORD_VB = f"{WORD_BOX[0] - 1:g} {WORD_BOX[1] - 1:g} {WORD_BOX[2] - WORD_BOX[0] + 2:g} {WORD_BOX[3] - WORD_BOX[1] + 2:g}"
bars = "".join(f'<rect x="{a}" y="{b}" width="{c-a}" height="{d-b}" rx="2" fill="url(#efx)"/>' for a, b, c, d in E_BARS)
sprite = (f'{grads("fx")}\n'
          f'<symbol id="fx-mark" viewBox="{MARK_VB}">{mark_body("fx")}</symbol>\n'
          f'<symbol id="fx-word" viewBox="{WORD_VB}"><g fill="currentColor">{WORD}</g>{bars}</symbol>\n')
write("sprite.html", sprite)
ww = WORD_BOX[2] - WORD_BOX[0] + 2
wh = WORD_BOX[3] - WORD_BOX[1] + 2
open(os.path.join(OUT, "dims.txt"), "w").write(f"MARK_VB {MARK_VB}\nWORD_VB {WORD_VB}\nword aspect {ww / wh:.4f}\nmark aspect {(mx1 - mx0 + 2) / (my1 - my0 + 2):.4f}\n")
