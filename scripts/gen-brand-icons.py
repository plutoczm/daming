#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Generate the Daming app-icon set from the flowing ribbon M mark.

The mark keeps its original ribbon shape (including the curled tail) — that is
the brand.  Geometry and generation method mirror the DSH / Magpie app icons
(measured on this machine):

  * the rounded tile is **inset by a small transparent margin** (~3.5%) so its
    anti-aliased edge floats inside the canvas instead of being clipped by the
    canvas edge — this is what keeps all four corners clean on every shell
    surface (taskbar, tray flyout, shortcut, Start menu);
  * the tile corner radius is ~0.13 of the tile side (DSH-like);
  * every size is rendered **natively at that size** (4x supersample then BOX
    downscale) rather than downscaling one big master — no LANCZOS ringing and
    no white halo bleeding into the transparent margin;
  * the .ico is written by hand as 32-bit BMP frames, keeping each pixel's true
    RGB even where alpha is 0, so a partially transparent edge can only feather
    tile-white -> transparent, never to black.

Outputs:
  apps/desktop/electron/assets/tray-<n>.png     window / taskbar / tray icons
  apps/desktop/electron/assets/app.ico          packaged exe + shortcut icon
  apps/web/public/brand/mark-256.png            in-app rail brand tile

Run:  D:/Anaconda3/envs/daming/python.exe -X utf8 scripts/gen-brand-icons.py
"""
from PIL import Image, ImageDraw
from pathlib import Path
import struct

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "apps/web/public/brand/mark-source.png"
DESK_ASSETS = ROOT / "apps/desktop/electron/assets"
WEB_BRAND = ROOT / "apps/web/public/brand"

MARGIN_FRAC = 0.04          # transparent breathing margin around the tile (like DSH/Magpie)
RADIUS_FRAC = 0.27          # corner radius as a fraction of the TILE side (round, iOS/DSH-like)
MARK_FRAC = 0.66            # the M occupies 66% of the tile
SS = 4                      # supersample factor for native per-size rendering
TOP = (255, 255, 255)       # flat pure-white tile (no tint -> no grey edge)
BOT = (255, 255, 255)


def load_mark():
    """Return an RGBA image of the ribbon M with the white background removed."""
    src = Image.open(SRC).convert("RGB")
    px = src.load()
    w, h = src.size
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    op = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            m = min(r, g, b)
            if m >= 245:
                a = 0
            elif m <= 190:
                a = 255
            else:
                a = int(round((245 - m) / (245 - 190) * 255))
            if a:
                op[x, y] = (r, g, b, a)
    bbox = out.getbbox()
    if bbox:
        out = out.crop(bbox)
    return out


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def white_flood(img):
    """Force RGB of fully-transparent pixels to white so resize can't bleed black."""
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 8:
                px[x, y] = (255, 255, 255, 0)
    return img


def make_tile(mark, size):
    """Render the rounded white tile + ribbon M at exactly `size` px."""
    inner = max(1, int(round(size * (1 - 2 * MARGIN_FRAC))))
    grad = Image.new("RGB", (1, inner))
    gp = grad.load()
    for y in range(inner):
        t = y / (inner - 1)
        gp[0, y] = (
            int(TOP[0] + (BOT[0] - TOP[0]) * t),
            int(TOP[1] + (BOT[1] - TOP[1]) * t),
            int(TOP[2] + (BOT[2] - TOP[2]) * t),
        )
    bg = grad.resize((inner, inner))
    tile = Image.new("RGBA", (inner, inner), (255, 255, 255, 0))
    tile.paste(bg, (0, 0))
    tile.putalpha(rounded_mask(inner, int(inner * RADIUS_FRAC)))

    target = int(inner * MARK_FRAC)
    scale = target / max(mark.width, mark.height)
    mw, mh = max(1, int(mark.width * scale)), max(1, int(mark.height * scale))
    m = mark.resize((mw, mh), Image.LANCZOS)
    tile.alpha_composite(m, ((inner - mw) // 2, (inner - mh) // 2))
    tile = white_flood(tile)

    canvas = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    off = (size - inner) // 2
    canvas.alpha_composite(tile, (off, off))
    return white_flood(canvas)


def render(mark, size):
    """Native render at `size`: supersample then BOX downscale (crisp, no halo)."""
    big = make_tile(mark, size * SS)
    return white_flood(big.resize((size, size), Image.BOX))


def _bmp_frame(im):
    """Encode one RGBA image as a 32-bit BMP DIB frame for the ICO file.

    Unlike Pillow's built-in ICO writer (which zeroes RGB on fully-transparent
    pixels), this keeps each pixel's true BGR even where alpha is 0, so a
    partially-transparent edge pixel is white -> the corner can only feather to
    white, never to black.
    """
    im = im.convert("RGBA")
    w, h = im.size
    px = im.load()
    xor = bytearray()
    for y in range(h - 1, -1, -1):          # BMP rows are bottom-up
        for x in range(w):
            r, g, b, a = px[x, y]
            xor += bytes((b, g, r, a))
    row_bytes = ((w + 31) // 32) * 4         # AND mask, 1bpp, rows padded to 4 bytes
    and_mask = bytes(row_bytes * h)
    header = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0,
                         len(xor) + len(and_mask), 0, 0, 0, 0)
    return header + bytes(xor) + and_mask


def write_ico(path, frames):
    """frames: list of (size, RGBA image). Writes a multi-size 32-bit ICO."""
    n = len(frames)
    datas = [_bmp_frame(im) for _, im in frames]
    offset = 6 + 16 * n
    entries = b""
    for (s, _im), data in zip(frames, datas):
        w = 0 if s >= 256 else s
        entries += struct.pack("<BBBBHHII", w, w, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    Path(path).write_bytes(struct.pack("<HHH", 0, 1, n) + entries + b"".join(datas))


def main():
    mark = load_mark()
    DESK_ASSETS.mkdir(parents=True, exist_ok=True)
    WEB_BRAND.mkdir(parents=True, exist_ok=True)

    for n in (16, 20, 24, 32, 40, 48, 64, 256):
        render(mark, n).save(DESK_ASSETS / f"tray-{n}.png")

    ico_sizes = (16, 24, 32, 48, 64, 128, 256)
    write_ico(DESK_ASSETS / "app.ico", [(s, render(mark, s)) for s in ico_sizes])

    render(mark, 512).save(WEB_BRAND / "mark-256.png")
    print("generated icons OK (native per-size, DSH-like margin+radius, custom ICO)")


if __name__ == "__main__":
    main()
