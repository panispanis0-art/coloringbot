"""Lay out pages and write a printable PDF."""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

DPI = 300
SIZES = {"A4": (2480, 3508), "LETTER": (2550, 3300)}
MARGIN = 170  # ~0.57 in

HAND_FONT = str(Path(__file__).parent / "fonts" / "Chewy-Regular.ttf")  # hand-lettered look, Apache-2.0
FONT_CANDIDATES = [HAND_FONT,
    "DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "arialbd.ttf", "C:/Windows/Fonts/comicbd.ttf", "C:/Windows/Fonts/arialbd.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf",
]


def _font(size: int) -> ImageFont.ImageFont:
    for f in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def _fit_text(draw, text, max_w, start=200, min_size=60):
    size = start
    while size > min_size:
        f = _font(size)
        if draw.textlength(text, font=f) <= max_w:
            return f
        size -= 8
    return _font(min_size)


def _wrap(draw, text, font, max_w):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=font) <= max_w or not cur:
            cur = t
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def _place(art: Image.Image, page_size, top=MARGIN, bottom=MARGIN) -> Image.Image:
    W, H = page_size
    page = Image.new("L", (W, H), 255)
    a = art.convert("L")
    bbox = ImageOps.invert(a).getbbox()  # crop to drawing
    if bbox:
        pad = 20
        a = a.crop((max(0, bbox[0] - pad), max(0, bbox[1] - pad),
                    min(a.width, bbox[2] + pad), min(a.height, bbox[3] + pad)))
    box_w, box_h = W - 2 * MARGIN, H - top - bottom
    s = min(box_w / a.width, box_h / a.height)
    a = a.resize((max(1, int(a.width * s)), max(1, int(a.height * s))), Image.LANCZOS)
    page.paste(a, ((W - a.width) // 2, top + (box_h - a.height) // 2))
    return page


def _outlined_title(draw, xy, text, font):
    # hollow letters kids can color too
    draw.text(xy, text, font=font, fill=255, stroke_width=max(4, font.size // 18),
              stroke_fill=0, anchor="mm")


def cover(title: str, art: Image.Image, page_size) -> Image.Image:
    W, H = page_size
    title_h = 900
    page = _place(art, page_size, top=title_h, bottom=MARGIN + 150)
    d = ImageDraw.Draw(page)
    # biggest size at which the title fits on at most 3 lines
    for size in range(300, 90, -10):
        f = _font(size)
        lines = _wrap(d, title, f, W - 2 * MARGIN)
        if len(lines) <= 3 and all(d.textlength(l, font=f) <= W - 2 * MARGIN for l in lines) \
                and len(lines) * size * 1.15 <= title_h - 120:
            break
    y0 = title_h // 2 - (len(lines) - 1) * f.size * 0.575
    for i, ln in enumerate(lines):
        _outlined_title(d, (W // 2, int(y0 + i * f.size * 1.15)), ln, f)
    d.text((W // 2, H - MARGIN - 40), "Coloring Book", font=_font(90), fill=0, anchor="mm")
    return page


def belongs_to(page_size) -> Image.Image:
    W, H = page_size
    page = Image.new("L", (W, H), 255)
    d = ImageDraw.Draw(page)
    _outlined_title(d, (W // 2, H // 3), "This book belongs to", _fit_text(d, "This book belongs to", W - 2 * MARGIN, 190))
    y = H // 2
    d.line([(MARGIN + 150, y), (W - MARGIN - 150, y)], fill=0, width=8)
    for i in range(7):  # little stars to color
        cx = MARGIN + 200 + i * (W - 2 * MARGIN - 400) // 6
        cy = int(H * 0.68) + (60 if i % 2 else -60)
        r, pts = 110, []
        import math
        for k in range(10):
            ang = -math.pi / 2 + k * math.pi / 5
            rr = r if k % 2 == 0 else r * 0.45
            pts.append((cx + rr * math.cos(ang), cy + rr * math.sin(ang)))
        d.polygon(pts, outline=0, width=8)
    return page


def make_pdf(title: str, arts: list[Image.Image], out: Path, page_size_name="A4") -> Path:
    size = SIZES.get(page_size_name, SIZES["A4"])
    pages = [cover(title, arts[0], size), belongs_to(size)]
    pages += [_place(a, size) for a in arts]
    bw = [p.convert("1", dither=Image.Dither.NONE) for p in pages]
    bw[0].save(out, "PDF", resolution=DPI, save_all=True, append_images=bw[1:],
               title=title, author="Coloring Book Bot")
    return out
