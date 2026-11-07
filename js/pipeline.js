// Liga tudo: abre print/vídeo, acha candidatos e recorta o escolhido.

import {
  grab,
  workingSize,
  estimateBackground,
  foregroundMask,
  findCandidates,
  cutout,
  alphaBox,
  alphaSum,
} from './detect.js';
import { toCanvas } from './compose.js';

const WORK_IMAGE = 720;
const WORK_VIDEO = 480;
const ANALYSIS_FPS = 5;
const ANALYSIS_MAX_SECONDS = 20;
export const ANIM_FPS = 12;
export const ANIM_SECONDS = 3;

// ---------------------------------------------------------------- utilidades

function toSource(cands, scale, sw, sh) {
  return cands.map((c) => ({
    ...c,
    x0: Math.max(0, Math.floor(c.x0 / scale)),
    y0: Math.max(0, Math.floor(c.y0 / scale)),
    x1: Math.min(sw - 1, Math.ceil((c.x1 + 1) / scale) - 1),
    y1: Math.min(sh - 1, Math.ceil((c.y1 + 1) / scale) - 1),
  }));
}

function padRect(c, sw, sh) {
  const pad = Math.round(Math.max(8, 0.05 * Math.max(c.x1 - c.x0, c.y1 - c.y0)));
  const x = Math.max(0, c.x0 - pad);
  const y = Math.max(0, c.y0 - pad);
  return {
    x,
    y,
    w: Math.min(sw, c.x1 + pad + 1) - x,
    h: Math.min(sh, c.y1 + pad + 1) - y,
    keep: { x0: c.x0 - x, y0: c.y0 - y, x1: c.x1 - x, y1: c.y1 - y },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------- imagem

export function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Não consegui abrir essa imagem.'));
    img.src = URL.createObjectURL(file);
  });
}

export function analyzeImage(img) {
  const sw = img.naturalWidth;
  const sh = img.naturalHeight;
  const { w, h, scale } = workingSize(sw, sh, WORK_IMAGE);
  const work = grab(img, 0, 0, sw, sh, w, h);
  const bg = estimateBackground(work);
  const fg = foregroundMask(work, bg);
  let candidates = toSource(findCandidates(work, fg), scale, sw, sh);
  if (!candidates.length) candidates = [{ x0: 0, y0: 0, x1: sw - 1, y1: sh - 1, whole: true }];
  return { kind: 'image', source: img, sw, sh, bg, candidates };
}

/**
 * Decide qual pedaço da imagem vai virar figurinha.
 * - whole: a imagem inteira, sem recortar nada;
 * - removeBg=false: só o retângulo do candidato, com o fundo original;
 * - padrão: o candidato com folga, para tirar o fundo.
 * Regiões grandes são reduzidas (a figurinha final tem 512 px).
 */
function regionFor(analysis, cand, { whole = false, removeBg = true } = {}) {
  const { sw, sh } = analysis;
  let r;
  if (whole) {
    r = { x: 0, y: 0, w: sw, h: sh, keep: null };
  } else if (!removeBg) {
    r = { x: cand.x0, y: cand.y0, w: cand.x1 - cand.x0 + 1, h: cand.y1 - cand.y0 + 1, keep: null };
  } else {
    r = padRect(cand, sw, sh);
  }
  const s = r.keep ? 1 : Math.min(1, MAX_PLAIN / Math.max(r.w, r.h));
  r.dw = Math.max(1, Math.round(r.w * s));
  r.dh = Math.max(1, Math.round(r.h * s));
  return r;
}

const MAX_PLAIN = 1024;

function cutRegion(src, analysis, r) {
  const data = grab(src, r.x, r.y, r.w, r.h, r.dw, r.dh);
  return r.keep ? cutout(data, analysis.bg, r.keep) : data;
}

export function cutImage(analysis, cand, opts) {
  const r = regionFor(analysis, cand, opts);
  const res = cutRegion(analysis.source, analysis, r);
  const box = alphaBox(res) || { x0: 0, y0: 0, x1: r.dw - 1, y1: r.dh - 1 };
  return { frames: [toCanvas(res)], box, stillIndex: 0 };
}

// ---------------------------------------------------------------- vídeo

export async function loadVideo(file) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.setAttribute('muted', '');
  v.preload = 'auto';
  v.src = URL.createObjectURL(file);
  await new Promise((resolve, reject) => {
    v.onloadeddata = resolve;
    v.onerror = () => reject(new Error('Não consegui abrir esse vídeo.'));
  });
  // Safari às vezes só libera os quadros depois de um play().
  try {
    await v.play();
    v.pause();
  } catch {
    /* sem problema */
  }
  if (!Number.isFinite(v.duration)) {
    await seek(v, 1e7);
  }
  return v;
}

function seek(v, t) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      v.removeEventListener('seeked', finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 3000);
    v.addEventListener('seeked', finish);
    v.currentTime = t;
  });
}

function iou(a, b) {
  let inter = 0;
  let uni = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x | y) uni++;
    if (x & y) inter++;
  }
  return uni ? inter / uni : 1;
}

function grayOf(img) {
  const d = img.data;
  const g = new Uint8Array(img.width * img.height);
  for (let i = 0, o = 0; i < g.length; i++, o += 4) {
    g[i] = (d[o] * 77 + d[o + 1] * 150 + d[o + 2] * 29) >> 8;
  }
  return g;
}

export async function analyzeVideo(v, onProgress = () => {}) {
  const sw = v.videoWidth;
  const sh = v.videoHeight;
  const duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 1;
  const { w, h, scale } = workingSize(sw, sh, WORK_VIDEO);
  const span = Math.min(duration, ANALYSIS_MAX_SECONDS);
  const count = Math.max(2, Math.floor(span * ANALYSIS_FPS));
  const times = Array.from({ length: count }, (_, i) =>
    Math.min(duration - 0.05, (i + 0.5) * (span / count)),
  );

  // Cores de fundo a partir de um quadro do meio.
  await seek(v, times[count >> 1]);
  const bg = estimateBackground(grab(v, 0, 0, sw, sh, w, h));

  const frames = [];
  for (let i = 0; i < count; i++) {
    await seek(v, times[i]);
    const img = grab(v, 0, 0, sw, sh, w, h);
    frames.push({ t: times[i], fg: foregroundMask(img, bg), gray: grayOf(img) });
    onProgress((i + 1) / count);
    if (i % 4 === 0) await tick();
  }

  // Trechos "parados": a tela não rolou entre um quadro e outro.
  let best = [0, 0];
  let start = 0;
  for (let i = 1; i <= count; i++) {
    const stable = i < count && iou(frames[i - 1].fg, frames[i].fg) > 0.85;
    if (!stable) {
      if (i - 1 - start > best[1] - best[0]) best = [start, i - 1];
      start = i;
    }
  }

  // Janela de até ANIM_SECONDS no meio do trecho parado.
  const maxFrames = Math.max(1, Math.round(ANIM_SECONDS * ANALYSIS_FPS));
  const runLen = best[1] - best[0] + 1;
  const a = best[0] + Math.max(0, Math.floor((runLen - maxFrames) / 2));
  const b = Math.min(best[1], a + maxFrames - 1);

  const n = w * h;
  const union = new Uint8Array(n);
  const motion = new Uint8Array(n);
  const ref = frames[a].gray;
  for (let k = a; k <= b; k++) {
    const { fg, gray } = frames[k];
    for (let i = 0; i < n; i++) {
      if (fg[i]) union[i] = 1;
      if (Math.abs(gray[i] - ref[i]) > 28) motion[i] = 1;
    }
  }

  const mid = frames[(a + b) >> 1];
  await seek(v, mid.t);
  const colorImg = grab(v, 0, 0, sw, sh, w, h);
  let candidates = toSource(findCandidates(colorImg, union, b > a ? motion : null), scale, sw, sh);
  if (!candidates.length) candidates = [{ x0: 0, y0: 0, x1: sw - 1, y1: sh - 1, whole: true }];

  const step = span / count;
  const t0 = Math.max(0, frames[a].t - step / 2);
  const t1 = Math.min(duration, frames[b].t + step / 2);
  return {
    kind: 'video',
    source: v,
    sw,
    sh,
    bg,
    candidates,
    window: { t0, t1 },
    animated: b > a,
  };
}

export async function cutVideo(analysis, cand, opts, onProgress = () => {}) {
  const { source: v, window } = analysis;
  const r = regionFor(analysis, cand, opts);
  const len = Math.max(1, Math.min(ANIM_FPS * ANIM_SECONDS, Math.round((window.t1 - window.t0) * ANIM_FPS)));
  const cuts = [];
  for (let i = 0; i < len; i++) {
    await seek(v, Math.min(window.t1 - 0.01, window.t0 + i / ANIM_FPS));
    cuts.push(cutRegion(v, analysis, r));
    onProgress((i + 1) / len);
    await tick();
  }

  let box = null;
  let stillIndex = 0;
  let bestSum = -1;
  cuts.forEach((c, i) => {
    const b = alphaBox(c);
    if (b) {
      box = box
        ? { x0: Math.min(box.x0, b.x0), y0: Math.min(box.y0, b.y0), x1: Math.max(box.x1, b.x1), y1: Math.max(box.y1, b.y1) }
        : b;
    }
    const s = alphaSum(c);
    if (s > bestSum) {
      bestSum = s;
      stillIndex = i;
    }
  });
  if (!box) box = { x0: 0, y0: 0, x1: r.dw - 1, y1: r.dh - 1 };
  return { frames: cuts.map(toCanvas), box, stillIndex, delay: Math.round(1000 / ANIM_FPS) };
}

/** Miniatura (canvas) de um candidato, para o usuário escolher outro. */
export function thumbnail(analysis, cand, size = 96) {
  const { source, sw, sh } = analysis;
  const r = padRect(cand, sw, sh);
  const s = size / Math.max(r.w, r.h);
  return toCanvas(grab(source, r.x, r.y, r.w, r.h, Math.max(1, Math.round(r.w * s)), Math.max(1, Math.round(r.h * s))));
}
