// Monta a figurinha final: 512x512, centralizada, com borda branca opcional,
// e exporta como PNG (parada) ou GIF (animada).

import { GIFEncoder, quantize, applyPalette } from '../vendor/gifenc.esm.js';
import { makeCanvas, ctx2d } from './detect.js';

export const SIZE = 512;
const OUTLINE = 11;

/** Converte ImageData em canvas. */
export function toCanvas(img) {
  const c = makeCanvas(img.width, img.height);
  ctx2d(c).putImageData(img, 0, 0);
  return c;
}

/** Calcula escala e posição para caber `box` no quadrado final. */
export function layoutFor(box, outline) {
  const pad = outline ? OUTLINE + 8 : 10;
  const bw = box.x1 - box.x0 + 1;
  const bh = box.y1 - box.y0 + 1;
  const avail = SIZE - pad * 2;
  const s = Math.min(avail / bw, avail / bh);
  return {
    s,
    dx: (SIZE - bw * s) / 2 - box.x0 * s,
    dy: (SIZE - bh * s) / 2 - box.y0 * s,
  };
}

/** Desenha um quadro (canvas com alfa) no quadrado final. */
export function renderFrame(cut, layout, outline) {
  const out = makeCanvas(SIZE, SIZE);
  const ctx = ctx2d(out);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const w = cut.width * layout.s;
  const h = cut.height * layout.s;

  if (outline) {
    // Silhueta branca, desenhada várias vezes em volta: vira o contorno.
    const sil = makeCanvas(SIZE, SIZE);
    const sctx = ctx2d(sil);
    sctx.drawImage(cut, layout.dx, layout.dy, w, h);
    // Só pixels firmes entram na silhueta (chiado de JPEG não vira contorno).
    const sd = sctx.getImageData(0, 0, SIZE, SIZE);
    for (let o = 3; o < sd.data.length; o += 4) sd.data[o] = sd.data[o] > 120 ? 255 : 0;
    sctx.putImageData(sd, 0, 0);
    sctx.globalCompositeOperation = 'source-in';
    sctx.fillStyle = '#ffffff';
    sctx.fillRect(0, 0, SIZE, SIZE);
    for (const [radius, steps] of [[OUTLINE, 36], [OUTLINE * 0.55, 20]]) {
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2;
        ctx.drawImage(sil, Math.cos(a) * radius, Math.sin(a) * radius);
      }
    }
    // Fecha buraquinhos semitransparentes no contorno.
    const id = ctx.getImageData(0, 0, SIZE, SIZE);
    const d = id.data;
    for (let o = 3; o < d.length; o += 4) d[o] = d[o] > 40 ? 255 : 0;
    ctx.putImageData(id, 0, 0);
  }
  ctx.drawImage(cut, layout.dx, layout.dy, w, h);
  return out;
}

export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Falha ao gerar imagem'))), type, quality);
  });
}

/** GIF animado com fundo transparente, repetindo para sempre. */
export function encodeGif(frames, delayMs) {
  const gif = GIFEncoder();
  for (const frame of frames) {
    const { width, height } = frame;
    const data = ctx2d(frame).getImageData(0, 0, width, height).data;
    const palette = quantize(data, 256, { format: 'rgba4444', oneBitAlpha: true });
    const index = applyPalette(data, palette, 'rgba4444');
    const ti = palette.findIndex((p) => p[3] === 0);
    gif.writeFrame(index, width, height, {
      palette,
      delay: delayMs,
      transparent: ti >= 0,
      transparentIndex: ti >= 0 ? ti : 0,
      dispose: 2,
    });
  }
  gif.finish();
  return new Blob([gif.bytes()], { type: 'image/gif' });
}
