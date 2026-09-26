# Ferminux logo

`source/ferminux-logo.pdf` is the master artwork: the folded F mark, the FERMINUX wordmark (the E is three
green bars) and the "AI economy on chain" tagline. `build.py` rebuilds every file in `dist/` from it:

| File | Use |
|---|---|
| `fmx-mark.svg` | The F alone, transparent background |
| `fmx-mark-glow.svg` | The F with a green glow, for dark heroes |
| `ferminux-lockup-{dark,light}.svg` | Mark over wordmark and tagline, as in the artwork (`dark` = for dark backgrounds) |
| `ferminux-wordmark-{dark,light}.svg` | Mark beside the wordmark, one line |
| `favicon.svg`, `favicon-*.png` | The F on a black rounded square: tab icon, apple-touch (180), PWA (192/512) |
| `fmx-token.svg`, `fmx-token-*.png` | The FMX token icon (round); published as `fmx-round.svg` / `fmx-256.png` |
| `fmx-og-dark.svg` | 1200×630 share card: glowing mark, wordmark, tagline |
| `sprite.html` | Gradients plus `#fx-mark` and `#fx-word` symbols, inlined by the sites |

On the sites the header is `#fx-mark` (24 px) followed by `#fx-word` (12 px tall, `currentColor` letters).
The mark is never redrawn by hand: change the geometry or colours in `build.py` and rebuild.
