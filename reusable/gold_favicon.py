"""Transparent golden book favicon matching the shared homepage's h1::before glyph.

Generated during staging only: the existing reader source assets stay untouched.
"""
from __future__ import annotations

from io import BytesIO
from pathlib import Path
from PIL import Image, ImageDraw

SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
<path d="M18 13 L49 11 Q52 11 52 15 L52 49 Q52 51 49 51 L18 53 Q15 53 15 50 L15 16 Q15 14 18 13Z" fill="none" stroke="#febd69" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
<path d="M17 15 L17 51" fill="none" stroke="#ff9900" stroke-width="11" stroke-linecap="square"/>
<path d="M26 16 L48 15" fill="none" stroke="#ffe0a1" stroke-width="1.5" stroke-linecap="round" opacity=".85"/>
</svg>'''


def _image(size: int):
    scale=8
    image=Image.new('RGBA',(size*scale,size*scale),(0,0,0,0))
    draw=ImageDraw.Draw(image)
    x=lambda v: round(v*size*scale/64)
    points=[(18,13),(49,11),(52,12),(52,49),(49,51),(18,53),(15,51),(15,16),(18,13)]
    coords=[(x(px),x(py)) for px,py in points]
    draw.line(coords,fill=(254,189,105,255),width=max(1,x(4)),joint='curve')
    draw.line([(x(17),x(15)),(x(17),x(51))],fill=(255,153,0,255),width=max(1,x(11)))
    draw.line([(x(26),x(16)),(x(48),x(15))],fill=(255,224,161,230),width=max(1,x(1.5)))
    return image.resize((size,size),Image.Resampling.LANCZOS)


def stage_icons(stage: Path):
    stage=Path(stage)
    (stage/'favicon.svg').write_text(SVG,encoding='utf-8')
    for size in (16,32,48,180,192,512):
        _image(size).save(stage/f'favicon-{size}.png',format='PNG')
    _image(48).save(stage/'favicon.ico',format='ICO',sizes=[(16,16),(32,32),(48,48)])
    return ('favicon.svg', 'favicon.ico') + tuple(f'favicon-{n}.png' for n in (16,32,48,180,192,512))
