"""Draw the extension icon: an "A" whose crossbar is a Run triangle.

The two legs of the letter stand on a deep blue rounded square with a soft
top-to-bottom gradient. The crossbar is an amber play triangle, for the
one-click Run the extension is built around.

Run from the vscode folder:  python tools/make-icon.py
Needs Pillow. Writes icon.png (256x256).
"""
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 256
SCALE = 8  # draw large, then shrink, for smooth edges
UNIT = SIZE * SCALE / 128  # coordinates below are on a 128 grid
TOP = (0x25, 0x63, 0xEB)
BOTTOM = (0x1E, 0x2A, 0x78)
WHITE = (255, 255, 255, 255)
AMBER = (0xFB, 0xBF, 0x24, 255)


def s(*points):
    return [(x * UNIT, y * UNIT) for x, y in points]


def background(big):
    gradient = Image.new("RGBA", (big, big))
    draw = ImageDraw.Draw(gradient)
    for y in range(big):
        t = y / (big - 1)
        colour = tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM))
        draw.line((0, y, big, y), fill=colour + (255,))
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, big - 1, big - 1), radius=26 * UNIT, fill=255)
    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    image.paste(gradient, (0, 0), mask)
    return image


def main():
    big = SIZE * SCALE
    image = background(big)
    draw = ImageDraw.Draw(image)

    # The letter: a flat-topped apex and two legs, with no crossbar.
    draw.polygon(s((56, 18), (72, 18), (106, 110), (90, 110), (64, 44), (38, 110), (22, 110)), fill=WHITE)

    # The crossbar: a play triangle that sits between the legs.
    draw.polygon(s((56, 72), (56, 102), (78, 87)), fill=AMBER)

    icon = image.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    out = Path(__file__).resolve().parent.parent / "icon.png"
    icon.save(out, optimize=True)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
