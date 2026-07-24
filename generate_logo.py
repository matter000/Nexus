"""
Nexus Pixel Logo Generator v7
Design: Microchip processor top-down view with glowing "N" core,
circuit traces radiating outward, chip pins on all four sides.
Style: 15x15 retro pixel art, electric blue + neon cyan, dark navy bg.
"""
from PIL import Image, ImageDraw, ImageFont
import os

# === CONFIGURATION ===
PIXEL_SIZE = 48  # Size of each "pixel" block in the final image
GRID_W = 15      # Grid width in pixels
GRID_H = 15      # Grid height in pixels
MARGIN = 2       # Margin in grid pixels around the design
CANVAS_W = (GRID_W + MARGIN * 2) * PIXEL_SIZE
CANVAS_H = (GRID_H + MARGIN * 2) * PIXEL_SIZE

# Color palette — electric blue / neon cyan / dark navy
BG_COLOR = (10, 14, 26)           # dark navy #0A0E1A
PIN_COLOR = (74, 144, 217)        # steel blue #4A90D9
BODY_COLOR = (0, 136, 255)        # electric blue #0088FF
TRACE_COLOR = (0, 102, 204)       # medium blue #0066CC
GLOW_COLOR = (0, 255, 255)        # neon cyan #00FFFF
NODE_COLOR = (0, 229, 255)        # bright cyan #00E5FF

COLOR_MAP = {
    1: BODY_COLOR,     # electric blue — chip body border
    2: TRACE_COLOR,    # medium blue — circuit traces
    3: PIN_COLOR,      # steel blue — chip pins/legs
    4: GLOW_COLOR,     # neon cyan — glowing "N" core
    5: NODE_COLOR,     # bright cyan — corner accent nodes
}

# === 15x15 PIXEL GRID — microchip with glowing N core ===
# Symmetric design: pins(3) → traces(2) → body(1) → N letter(4) → nodes(5)
LOGO_GRID = [
    [0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0],
    [0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0],
    [0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0],
    [0, 5, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 5, 0],
    [0, 0, 2, 1, 4, 4, 0, 0, 0, 4, 4, 1, 2, 0, 0],
    [0, 0, 2, 1, 4, 0, 4, 0, 0, 0, 4, 1, 2, 0, 0],
    [0, 0, 2, 1, 4, 0, 0, 4, 0, 0, 4, 1, 2, 0, 0],
    [0, 0, 2, 1, 4, 0, 0, 0, 4, 0, 4, 1, 2, 0, 0],
    [0, 0, 2, 1, 4, 0, 0, 0, 0, 4, 4, 1, 2, 0, 0],
    [0, 5, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 5, 0],
    [0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0],
    [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0],
    [0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0],
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
    draw_wm.text((text_x, text_y), "NEXUS", fill=GLOW_COLOR, font=font)

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
