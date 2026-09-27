"""Turn the frames tools/capture-window.ps1 recorded into an optimised GIF.

Run by tools/capture-screenshots.mjs, or by hand:
    python tools/make-gif.py <frames dir> images/run.gif
Needs Pillow. The frames are named by their time in ms, which sets how long
each one shows. Repeated frames are merged, the last one is held a while, and
all frames share one palette, taken from the first and last frame.
"""
import sys
from pathlib import Path

from PIL import Image, ImageChops

HOLD_LAST_MS = 2000


def main(frames_dir: str, out: str) -> None:
    paths = sorted(Path(frames_dir).glob("*.png"), key=lambda p: int(p.stem))
    if not paths:
        sys.exit(f"No frames in {frames_dir}.")
    times = [int(p.stem) for p in paths]
    images = [Image.open(p).convert("RGB") for p in paths]

    # One palette for every frame, so colours do not shift between frames.
    first, last = images[0], images[-1]
    both = Image.new("RGB", (first.width, first.height * 2))
    both.paste(first, (0, 0))
    both.paste(last, (0, first.height))
    palette = both.quantize(colors=256, method=Image.Quantize.MEDIANCUT)

    frames, durations = [], []
    for i, img in enumerate(images):
        shown = (times[i + 1] - times[i]) if i + 1 < len(images) else HOLD_LAST_MS
        if frames and ImageChops.difference(img, frames[-1][0]).getbbox() is None:
            durations[-1] += shown
            continue
        frames.append((img, img.quantize(palette=palette, dither=Image.Dither.NONE)))
        durations.append(shown)

    pal = [f[1] for f in frames]
    # GIF delays are in 10 ms steps.
    durations = [max(20, round(d / 10) * 10) for d in durations]
    pal[0].save(out, save_all=True, append_images=pal[1:], duration=durations, loop=0, optimize=True, disposal=1)
    total = sum(durations) / 1000
    print(f"{out}: {len(pal)} frames, {total:.1f} s, {Path(out).stat().st_size / 1024:.0f} KiB")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
