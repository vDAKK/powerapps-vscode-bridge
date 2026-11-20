import math, sys, os
from PIL import Image, ImageDraw, ImageFont
out = sys.argv[1]  # usage: python assets/make-logo.py <output dir>
S = 1024
def grad(size, c1, c2):
    g = Image.new('RGBA', (size, size))
    px = g.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3)) + (255,)
    return g
def logo(arrows=True):
    bg = grad(S, (124, 58, 237), (14, 116, 144))  # violet -> teal
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=220, fill=255)
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    img.paste(bg, (0, 0), mask)
    d = ImageDraw.Draw(img)
    W = (255, 255, 255, 255)
    if arrows:
        c, r, w = S / 2, 365, 54
        box = [c - r, c - r, c + r, c + r]
        # two arcs, each ending in an arrowhead (clockwise sync)
        for start, end in ((205, 325), (25, 145)):
            d.arc(box, start, end, fill=W, width=w)
            a = math.radians(end)
            tip_r = r - w / 2
            px, py = c + tip_r * math.cos(a), c + tip_r * math.sin(a)
            tx, ty = -math.sin(a), math.cos(a)          # tangent (clockwise direction)
            nx, ny = math.cos(a), math.sin(a)           # outward normal
            L, H = 80, 72
            d.polygon([(px + tx * L, py + ty * L),
                       (px + nx * H, py + ny * H),
                       (px - nx * H, py - ny * H)], fill=W)
    size = 300 if arrows else 640
    f = ImageFont.truetype('C:/Windows/Fonts/consolaz.ttf', size)  # Consolas bold italic
    bb = d.textbbox((0, 0), 'fx', font=f)
    d.text(((S - (bb[2] - bb[0])) / 2 - bb[0], (S - (bb[3] - bb[1])) / 2 - bb[1]), 'fx', font=f, fill=W)
    return img
full, small = logo(True), logo(False)
os.makedirs(out, exist_ok=True)
full.save(os.path.join(out, 'icon-1024.png'))
for n in (128, 48):
    full.resize((n, n), Image.LANCZOS).save(os.path.join(out, f'icon-{n}.png'))
for n in (32, 16):
    small.resize((n, n), Image.LANCZOS).save(os.path.join(out, f'icon-{n}.png'))
# preview sheet
sheet = Image.new('RGBA', (1024 + 3 * 40 + 128 + 48 + 32 + 16 + 40, 1024 + 80), (245, 245, 245, 255))
x = 40
for n in (1024, 128, 48, 32, 16):
    im = Image.open(os.path.join(out, f'icon-{n}.png'))
    sheet.paste(im, (x, 40), im); x += n + 30
sheet.save(os.path.join(out, 'preview.png'))
