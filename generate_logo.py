"""
Nexus Pixel Logo Generator v8
Design: Pixel art spider — single blue color on transparent background.
Style: 16x16 retro pixel art, spider blue #0D79C1.
"""
from PIL import Image, ImageDraw, ImageFont
import os

# === CONFIGURATION ===
PIXEL_SIZE = 48  # Size of each "pixel" block in the final image
GRID_W = 16      # Grid width in pixels
GRID_H = 16      # Grid height in pixels
MARGIN = 2       # Margin in grid pixels around the design
CANVAS_W = (GRID_W + MARGIN * 2) * PIXEL_SIZE
CANVAS_H = (GRID_H + MARGIN * 2) * PIXEL_SIZE

# Color palette — spider blue
BG_COLOR = (10, 14, 26)           # dark navy #0A0E1A
SPIDER_COLOR = (13, 121, 193)     # spider blue #0D79C1

COLOR_MAP = {
    1: SPIDER_COLOR,   # spider blue — spider body & legs
}

# === 16x16 PIXEL GRID — pixel spider ===
# Single color: spider body & legs (1)
LOGO_GRID = [
    [0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0],
    [0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0],
    [0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0],
    [0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0],
    [0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 0],
    [0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1],
    [0, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1],
    [1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1],
    [1, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1],
    [0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1],
    [0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1],
    [0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0],
    [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
]

# === RENDER ===
img = Image.new('RGB', (CANVAS_W, CANVAS_H), BG_COLOR)
draw = ImageDraw.Draw(img)

for gy, row in enumerate(LOGO_GRID):
    for gx, cell in enumerate(row):
        if cell == 0:
            continue
        color = COLOR_MAP[cell]
        x = (gx + MARGIN) * PIXEL_SIZE
        y = (gy + MARGIN) * PIXEL_SIZE
        gap = 2
        draw.rectangle(
            [x + gap, y + gap, x + PIXEL_SIZE - gap - 1, y + PIXEL_SIZE - gap - 1],
            fill=color
        )

# Save the icon version
output_path = os.path.join(r'd:\Nexus', 'nexus-logo.png')
img.save(output_path, 'PNG')
print(f"Logo saved: {output_path} ({CANVAS_W}x{CANVAS_H})")

# === WORDMARK VERSION ===
font_path = r'C:\Users\18500\.qoder-cn\skills\canvas-design\canvas-fonts\Silkscreen-Regular.ttf'
try:
    font = ImageFont.truetype(font_path, PIXEL_SIZE * 2)
    tmp = Image.new('RGB', (1, 1))
    tmp_d = ImageDraw.Draw(tmp)
    bbox = tmp_d.textbbox((0, 0), "NEXUS", font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]

    wm_w = CANVAS_W + tw + PIXEL_SIZE * 3
    wm_h = CANVAS_H
    img_wm = Image.new('RGB', (wm_w, wm_h), BG_COLOR)
    img_wm.paste(img, (0, 0))
    draw_wm = ImageDraw.Draw(img_wm)
    text_x = CANVAS_W + PIXEL_SIZE
    text_y = (wm_h - th) // 2 - bbox[1]
    draw_wm.text((text_x, text_y), "NEXUS", fill=SPIDER_COLOR, font=font)

    wm_path = os.path.join(r'd:\Nexus', 'nexus-logo-wordmark.png')
    img_wm.save(wm_path, 'PNG')
    print(f"Wordmark saved: {wm_path} ({wm_w}x{wm_h})")
except Exception as e:
    print(f"Font note: {e}")

# === FAVICON (64x64) ===
favicon = img.resize((64, 64), Image.NEAREST)
favicon_path = os.path.join(r'd:\Nexus', 'nexus-favicon.png')
favicon.save(favicon_path, 'PNG')
print(f"Favicon saved: {favicon_path} (64x64)")

# === TRANSPARENT BACKGROUND VERSION ===
img_rgba = Image.new('RGBA', (CANVAS_W, CANVAS_H), (0, 0, 0, 0))
draw_rgba = ImageDraw.Draw(img_rgba)
for gy, row in enumerate(LOGO_GRID):
    for gx, cell in enumerate(row):
        if cell == 0:
            continue
        color = COLOR_MAP[cell]
        x = (gx + MARGIN) * PIXEL_SIZE
        y = (gy + MARGIN) * PIXEL_SIZE
        gap = 2
        draw_rgba.rectangle(
            [x + gap, y + gap, x + PIXEL_SIZE - gap - 1, y + PIXEL_SIZE - gap - 1],
            fill=(*color, 255)
        )
trans_path = os.path.join(r'd:\Nexus', 'nexus-logo-transparent.png')
img_rgba.save(trans_path, 'PNG')
print(f"Transparent version saved: {trans_path}")
