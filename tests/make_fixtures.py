"""Gera prints e uma gravação de tela "de mentira" para testar a detecção.

Imitam uma tela de comentários: vídeo rodando no topo, avatares, nomes,
textos, ícones e UMA figurinha. A posição da figurinha vai para fixtures.json.

Uso: python3 tests/make_fixtures.py   (precisa de Pillow e ffmpeg)
"""
import json
import math
import os
import random
import shutil
import subprocess

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixtures")
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def font(size, bold=False):
    try:
        return ImageFont.truetype(FONT_B if bold else FONT, size)
    except OSError:
        return ImageFont.load_default()


THEMES = {
    "dark": dict(sheet=(28, 28, 30), text=(235, 235, 235), sub=(140, 140, 145), line=(48, 48, 52)),
    "light": dict(sheet=(255, 255, 255), text=(22, 24, 35), sub=(130, 130, 135), line=(235, 235, 238)),
}


def video_area(draw, W, H, t):
    """Topo da tela: "vídeo" colorido que muda com o tempo."""
    top = int(H * 0.30)
    for y in range(0, top, 6):
        for x in range(0, W, 6):
            r = int(128 + 120 * math.sin(x * 0.011 + t * 3.1))
            g = int(128 + 120 * math.sin(y * 0.017 + t * 2.3))
            b = int(128 + 120 * math.sin((x + y) * 0.007 + t * 1.7))
            draw.rectangle([x, y, x + 6, y + 6], fill=(r, g, b))
    return top


def sticker(draw, cx, cy, size, t=0.0):
    """Carinha laranja com contorno branco (a "figurinha")."""
    s = size / 2
    wob = math.sin(t * 6) * 0.08
    rx, ry = s * (1 + wob), s * (1 - wob)
    o = max(4, int(size * 0.045))
    draw.ellipse([cx - rx - o, cy - ry - o, cx + rx + o, cy + ry + o], fill=(255, 255, 255))
    draw.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=(255, 140, 26))
    # orelhas
    for sgn in (-1, 1):
        ex = cx + sgn * rx * 0.62
        draw.polygon([(ex - s * 0.25, cy - ry * 0.7), (ex + s * 0.25, cy - ry * 0.7), (ex + sgn * s * 0.1, cy - ry * 1.25)],
                     fill=(255, 140, 26), outline=(255, 255, 255), width=o)
    eye = s * 0.16
    blink = 0.25 if (t % 1.0) > 0.8 else 1.0
    for sgn in (-1, 1):
        ex = cx + sgn * s * 0.35
        draw.ellipse([ex - eye, cy - s * 0.15 - eye * blink, ex + eye, cy - s * 0.15 + eye * blink], fill=(255, 255, 255))
        draw.ellipse([ex - eye * 0.5, cy - s * 0.15 - eye * 0.5 * blink, ex + eye * 0.5, cy - s * 0.15 + eye * 0.5 * blink], fill=(30, 20, 10))
    mouth = s * (0.3 + 0.15 * math.sin(t * 8))
    draw.chord([cx - s * 0.4, cy + s * 0.05, cx + s * 0.4, cy + s * 0.05 + mouth * 1.4], 0, 180, fill=(120, 30, 20))
    draw.ellipse([cx - s * 0.75, cy + s * 0.05, cx - s * 0.5, cy + s * 0.25], fill=(255, 100, 120))
    draw.ellipse([cx + s * 0.5, cy + s * 0.05, cx + s * 0.75, cy + s * 0.25], fill=(255, 100, 120))


def avatar(img, cx, cy, r, seed):
    rnd = random.Random(seed)
    c1 = tuple(rnd.randint(40, 230) for _ in range(3))
    c2 = tuple(rnd.randint(40, 230) for _ in range(3))
    tile = Image.new("RGB", (2 * r, 2 * r))
    td = ImageDraw.Draw(tile)
    for y in range(2 * r):
        k = y / (2 * r)
        td.line([(0, y), (2 * r, y)], fill=tuple(int(c1[i] * (1 - k) + c2[i] * k) for i in range(3)))
    mask = Image.new("L", (2 * r, 2 * r), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, 2 * r - 1, 2 * r - 1], fill=255)
    img.paste(tile, (cx - r, cy - r), mask)


def screen(theme, W, H, t=0.0, scroll=0, sticker_t=None):
    """Desenha a tela inteira. Devolve (imagem, caixa da figurinha)."""
    th = THEMES[theme]
    img = Image.new("RGB", (W, H), th["sheet"])
    draw = ImageDraw.Draw(img)
    u = W / 393  # unidade em "pontos" de iPhone
    sheet_top = video_area(draw, W, H, t)
    draw.rounded_rectangle([0, sheet_top, W, H + 40], radius=int(14 * u), fill=th["sheet"])
    f_title, f_name, f_text, f_small = font(int(14 * u), True), font(int(13 * u)), font(int(15 * u)), font(int(12 * u))
    draw.text((W / 2, sheet_top + 22 * u), "1.234 comentários", font=f_title, fill=th["text"], anchor="mm")

    names = ["@ana.clara", "@joaozinho", "@memes_br", "@vini", "@lulu", "@carlos.s"]
    texts = [["kkkkkkk eu demais", "alguém mais viu isso?"], ["MDSSS que isso"], ["sticker abaixo"],
             ["não aguento", "socorro kkkk", "melhor vídeo do dia"], ["eu chorando de rir"], ["parte 2 por favor"]]
    y = sheet_top + 48 * u - scroll
    box = None
    for i, name in enumerate(names):
        r = int(16 * u)
        ax = int(16 * u + r)
        if y > sheet_top + 30 * u and y < H:
            avatar(img, ax, int(y + r), r, i * 7 + 3)
        tx = 16 * u + 2 * r + 12 * u
        draw.text((tx, y), name, font=f_name, fill=th["sub"])
        yy = y + 20 * u
        for line in texts[i]:
            draw.text((tx, yy), line, font=f_text, fill=th["text"])
            yy += 21 * u
        if i == 2:  # este comentário tem a figurinha
            size = int(120 * u)
            cx, cy = int(tx + size / 2 + 6 * u), int(yy + size / 2 + 8 * u)
            sticker(draw, cx, cy, size, sticker_t if sticker_t is not None else 0.3)
            pad = size * 0.75
            box = [cx - pad, cy - pad, cx + pad, cy + pad]
            yy += size + 22 * u
        draw.text((tx, yy + 2 * u), "Responder", font=f_small, fill=th["sub"])
        # coração de curtida à direita
        hx, hy = W - 26 * u, y + 24 * u
        draw.polygon([(hx - 8 * u, hy - 3 * u), (hx, hy + 7 * u), (hx + 8 * u, hy - 3 * u), (hx + 4 * u, hy - 8 * u),
                      (hx, hy - 5 * u), (hx - 4 * u, hy - 8 * u)], outline=th["sub"], width=max(1, int(1.5 * u)))
        draw.text((hx, hy + 18 * u), str(10 + i * 37), font=f_small, fill=th["sub"], anchor="mm")
        y = yy + 34 * u
    # barra de digitar comentário
    bar = H - 60 * u
    draw.rectangle([0, bar, W, H], fill=th["sheet"])
    draw.line([(0, bar), (W, bar)], fill=th["line"], width=max(1, int(u)))
    draw.rounded_rectangle([16 * u, bar + 10 * u, W - 16 * u, bar + 46 * u], radius=int(18 * u), fill=th["line"])
    draw.text((32 * u, bar + 28 * u), "Adicionar comentário...", font=f_text, fill=th["sub"], anchor="lm")
    # barra de status
    draw.text((30 * u, 18 * u), "9:41", font=f_title, fill=(255, 255, 255))
    return img, box


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)
    meta = {}
    W, H = 1179, 2556  # print de iPhone 16
    for theme in THEMES:
        img, box = screen(theme, W, H)
        name = f"print-{theme}.png"
        img.save(os.path.join(OUT, name))
        meta[name] = dict(box=box, size=[W, H])
        # mesmo print em JPEG (como sai às vezes da galeria)
        jname = f"print-{theme}.jpg"
        img.save(os.path.join(OUT, jname), quality=85)
        meta[jname] = dict(box=box, size=[W, H])

    # Gravação de tela: rola, para 3,5 s com a figurinha animando, rola de novo.
    VW, VH, FPS = 590, 1278, 30
    frames_dir = os.path.join(OUT, "frames")
    os.makedirs(frames_dir)
    total = int(FPS * 5.5)
    vbox = None
    for k in range(total):
        t = k / FPS
        if t < 1.0:
            scroll = int((1.0 - t) * 260)
        elif t < 4.5:
            scroll = 0
        else:
            scroll = int((t - 4.5) * -300)
        img, box = screen("dark", VW, VH, t=t, scroll=scroll, sticker_t=t)
        if 1.0 <= t < 4.5:
            vbox = box
        img.save(os.path.join(frames_dir, f"{k:04d}.png"))
    video = os.path.join(OUT, "gravacao-dark.webm")
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-framerate", str(FPS), "-i",
                    os.path.join(frames_dir, "%04d.png"), "-c:v", "libvpx-vp9", "-b:v", "2M",
                    "-pix_fmt", "yuv420p", video], check=True)
    shutil.rmtree(frames_dir)
    meta["gravacao-dark.webm"] = dict(box=vbox, size=[VW, VH], animated=True)

    with open(os.path.join(OUT, "fixtures.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print("ok:", ", ".join(meta))


if __name__ == "__main__":
    main()
