"""Draw the extension icon: a white "A" on a cobalt rounded square.

Run from the vscode folder:  python tools/make-icon.py
Needs Pillow. Writes icon.png (128x128).
"""
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 128
SCALE = 8  # draw large, then shrink, for smooth edges
COBALT = (0x2F, 0x5B, 0xEA, 255)
WHITE = (255, 255, 255, 255)


def s(*points):
    return [(x * SCALE, y * SCALE) for x, y in points]


def main():
    big = SIZE * SCALE
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, big - 1, big - 1), radius=24 * SCALE, fill=COBALT)

    # The letter as an outer triangle with a hole, plus a crossbar.
    draw.polygon(s((64, 22), (100, 106), (84, 106), (64, 56), (44, 106), (28, 106)), fill=WHITE)
    draw.polygon(s((50, 76), (78, 76), (82, 88), (46, 88)), fill=WHITE)

    icon = image.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    out = Path(__file__).resolve().parent.parent / "icon.png"
    icon.save(out, optimize=True)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
