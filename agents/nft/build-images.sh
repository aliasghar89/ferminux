#!/bin/sh
# Gallery copies of the artwork: <id>-256 / <id>-512 in AVIF and WebP next to each <id>.png.
#
# The PNGs stay the canonical token images (the metadata's "image" points at them and marketplaces cache
# that URL). They are ~245 kB each, 10 MB for the collection, and on a phone the gallery's lazy loader asks
# for a dozen at once: on a mobile connection none of them finished for tens of seconds and the cards sat
# black. The copies are ~10-30 kB; ferminux.net/nfts/ and the home strip serve them through <picture>.
#
# Needs ffmpeg (resize), cwebp (libwebp) and avifenc (libavif). Re-run after changing an image and commit
# the outputs; then copy images/ to <site-root>/nft/agents/images/ with the rest of agents/nft/.
set -eu
cd "$(dirname "$0")/images"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for png in [0-9]*.png; do
  id=${png%.png}
  case $id in *[!0-9]*) continue ;; esac
  for w in 256 512; do
    src=$png
    if [ "$w" != 512 ]; then
      src="$tmp/$id-$w.png"
      ffmpeg -v error -y -i "$png" -vf "scale=$w:$w:flags=lanczos" "$src"
    fi
    cwebp -quiet -q 80 -m 6 "$src" -o "$id-$w.webp"
    avifenc -q 60 -s 4 --sharpyuv "$src" "$id-$w.avif" >/dev/null
  done
done
ls -1 ./*-256.webp | wc -l | xargs printf '%s ids encoded\n'
