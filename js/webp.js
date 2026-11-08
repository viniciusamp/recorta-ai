// WebP no formato que o WhatsApp exige:
//  - parada: 512x512, até 100 KB
//  - animada: 512x512, até 500 KB, quadros >= 8 ms, total <= 10 s
// O codificador é o libwebp (Google) compilado para WebAssembly. O WebP
// animado é montado aqui mesmo (contêiner RIFF com quadros ANMF).

import factory from '../vendor/webp/webp_enc.js';
import { ctx2d } from './detect.js';

export const LIMIT_STATIC = 100 * 1024;
export const LIMIT_ANIMATED = 500 * 1024;
const MAX_TOTAL_MS = 10000;
const MIN_FRAME_MS = 8;

const OPTIONS = {
  quality: 80,
  target_size: 0,
  target_PSNR: 0,
  method: 4,
  sns_strength: 50,
  filter_strength: 60,
  filter_sharpness: 0,
  filter_type: 1,
  partitions: 0,
  segments: 4,
  pass: 1,
  show_compressed: 0,
  preprocessing: 0,
  autofilter: 0,
  partition_limit: 0,
  alpha_compression: 1,
  alpha_filtering: 1,
  alpha_quality: 100,
  lossless: 0,
  exact: 0,
  image_hint: 0,
  emulate_jpeg_size: 0,
  thread_level: 0,
  low_memory: 0,
  near_lossless: 100,
  use_delta_palette: 0,
  use_sharp_yuv: 0,
};

let modulePromise = null;
function encoder() {
  if (!modulePromise) modulePromise = factory({ noInitialRun: true });
  return modulePromise;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function pixels(canvas) {
  return ctx2d(canvas).getImageData(0, 0, canvas.width, canvas.height);
}

/** Codifica um quadro (ImageData) em WebP. */
export async function encodeFrame(img, quality) {
  const m = await encoder();
  const out = m.encode(img.data, img.width, img.height, { ...OPTIONS, quality });
  if (!out) throw new Error('Falha ao gerar WebP.');
  return new Uint8Array(out); // cópia, fora da memória do wasm
}

/** Figurinha parada: diminui a qualidade até caber em 100 KB. */
export async function encodeStatic(canvas) {
  const img = pixels(canvas);
  let last = null;
  for (const q of [85, 72, 60, 48, 36, 24, 12]) {
    last = await encodeFrame(img, q);
    if (last.length <= LIMIT_STATIC) return last;
  }
  return last;
}

// ------------------------------------------------------------ contêiner RIFF

const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function chunk(fourcc, payload) {
  const pad = payload.length & 1;
  const out = new Uint8Array(8 + payload.length + pad);
  out.set(enc(fourcc), 0);
  new DataView(out.buffer).setUint32(4, payload.length, true);
  out.set(payload, 8);
  return out;
}

function put24(arr, off, v) {
  arr[off] = v & 255;
  arr[off + 1] = (v >> 8) & 255;
  arr[off + 2] = (v >> 16) & 255;
}

/** Lista os blocos (chunks) de um arquivo WebP. */
export function readChunks(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const list = [];
  let off = 12; // "RIFF" + tamanho + "WEBP"
  while (off + 8 <= bytes.length) {
    const fourcc = String.fromCharCode(...bytes.subarray(off, off + 4));
    const size = dv.getUint32(off + 4, true);
    const total = 8 + size + (size & 1);
    list.push({ fourcc, size, bytes: bytes.subarray(off, off + total), payload: bytes.subarray(off + 8, off + 8 + size) });
    off += total;
  }
  return list;
}

/** Junta quadros WebP (todos do mesmo tamanho) num WebP animado em loop. */
export function muxAnimated(frames, width, height, durations) {
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x10 | 0x02; // tem transparência + é animado
  put24(vp8x, 4, width - 1);
  put24(vp8x, 7, height - 1);
  const anim = new Uint8Array(6); // fundo transparente, loop infinito

  const parts = [chunk('VP8X', vp8x), chunk('ANIM', anim)];
  frames.forEach((file, i) => {
    const data = readChunks(file)
      .filter((c) => c.fourcc === 'ALPH' || c.fourcc === 'VP8 ' || c.fourcc === 'VP8L')
      .map((c) => c.bytes);
    const head = new Uint8Array(16);
    // x/2 = 0, y/2 = 0
    put24(head, 6, width - 1);
    put24(head, 9, height - 1);
    put24(head, 12, durations[i]);
    head[15] = 0x02; // não mistura com o quadro anterior (substitui)
    parts.push(chunk('ANMF', concat([head, ...data])));
  });
  const body = concat([enc('WEBP'), ...parts]);
  const riff = new Uint8Array(8);
  riff.set(enc('RIFF'), 0);
  new DataView(riff.buffer).setUint32(4, body.length, true);
  return concat([riff, body]);
}

/**
 * Figurinha animada dentro de 500 KB: tenta qualidades menores e, se ainda
 * não couber, usa um quadro sim, outro não (a duração de cada um dobra).
 */
export async function encodeAnimated(canvases, delayMs, onProgress = () => {}) {
  let frames = canvases.map(pixels);
  let delay = Math.max(MIN_FRAME_MS, Math.round(delayMs));
  // Respeita o limite de 10 s.
  while (frames.length * delay > MAX_TOTAL_MS && frames.length > 2) {
    frames = frames.filter((_, i) => i % 2 === 0);
    delay *= 2;
  }
  const { width, height } = frames[0];
  let last = null;
  let attempt = 0;
  for (;;) {
    for (const q of [70, 55, 40, 28]) {
      attempt++;
      const files = [];
      for (let i = 0; i < frames.length; i++) {
        files.push(await encodeFrame(frames[i], q));
        if (i % 4 === 3) {
          onProgress(Math.min(0.95, (attempt - 1 + i / frames.length) / 6));
          await tick();
        }
      }
      last = muxAnimated(files, width, height, frames.map(() => delay));
      if (last.length <= LIMIT_ANIMATED) return last;
    }
    if (frames.length <= 4) return last;
    frames = frames.filter((_, i) => i % 2 === 0);
    delay *= 2;
  }
}

// ------------------------------------------------------------ utilidades

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** É um WebP animado? (olha a flag no bloco VP8X) */
export function isAnimatedWebP(bytes) {
  const first = readChunks(bytes)[0];
  return !!first && first.fourcc === 'VP8X' && (first.payload[0] & 0x02) !== 0;
}
