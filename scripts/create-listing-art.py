"""Create original OnlineSync icon artwork; no external image inputs."""
from pathlib import Path
from PIL import Image, ImageDraw

out = Path(__file__).resolve().parents[1] / 'docs' / 'listing'
out.mkdir(parents=True, exist_ok=True)
scale = 3
im = Image.new('RGB', (1200 * scale, 1200 * scale), '#103e32')
d = ImageDraw.Draw(im)
def box(coords, fill, radius=0, outline=None, width=1):
    d.rounded_rectangle(tuple(int(v*scale) for v in coords), radius=radius*scale,
                        fill=fill, outline=outline, width=width*scale)
def line(points, fill, width=1):
    d.line([(int(x*scale), int(y*scale)) for x,y in points], fill=fill,
           width=width*scale, joint='curve')
def poly(points, fill):
    d.polygon([(int(x*scale), int(y*scale)) for x,y in points], fill=fill)
# Two connected stock boxes and a pair of opposing arrows.
box((185,360,525,785),'#edf8ef',radius=44)
box((675,415,1015,840),'#b5ebce',radius=44)
line([(355,375),(355,485)],'#103e32',22)
line([(845,430),(845,540)],'#103e32',22)
line([(245,710),(365,710)],'#103e32',20)
line([(735,765),(855,765)],'#103e32',20)
line([(355,290),(800,290)],'#b5ebce',38)
poly([(795,220),(900,290),(795,360)],'#b5ebce')
line([(845,910),(400,910)],'#edf8ef',38)
poly([(405,840),(300,910),(405,980)],'#edf8ef')
im.resize((1200,1200), Image.Resampling.LANCZOS).save(out/'icon.png')
print(out/'icon.png')
