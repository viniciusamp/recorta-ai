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
  looksLikePhoto,
} from './detect.js';
import { toCanvas } from './compose.js';

const WORK_IMAGE = 720;
const WORK_VIDEO = 480;
const MAX_PLAIN = 1024;
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
  return { kind: 'image', source: img, sw, sh, bg, candidates, photo: looksLikePhoto(work, bg) };
}

/**
 * Decide qual pedaço da imagem vai virar figurinha.
 * - whole: a imagem inteira, sem recortar nada;
 * - removeBg=false: só o retângulo do candidato, com o fundo original;
 * - padrão: o candidato com folga, para tirar o fundo.
 * Regiões grandes são reduzidas (a figurinha final tem 512 px).
 */
function regionFor(analysis, cand, { whole = false, removeBg = true, maxPlain = MAX_PLAIN } = {}) {
  const { sw, sh } = analysis;
  let r;
  if (whole) {
    r = { x: 0, y: 0, w: sw, h: sh, keep: null };
  } else if (!removeBg) {
    r = { x: cand.x0, y: cand.y0, w: cand.x1 - cand.x0 + 1, h: cand.y1 - cand.y0 + 1, keep: null };
  } else {
    r = padRect(cand, sw, sh);
  }
  const s = r.keep ? 1 : Math.min(1, maxPlain / Math.max(r.w, r.h));
  r.dw = Math.max(1, Math.round(r.w * s));
  r.dh = Math.max(1, Math.round(r.h * s));
  return r;
}

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
//
// No iPhone, pular de quadro em quadro (currentTime + "seeked") é lento e às
// vezes o Safari nem avisa que chegou. Por isso os quadros são capturados com
// o vídeo TOCANDO (mudo e invisível): é rápido e confiável.

const ANALYSIS_RATE = 2; // análise com o vídeo em 2x
const STALL_MS = 8000; // sem quadro novo por esse tempo = vídeo travou

export async function loadVideo(file) {
  const v = document.createElement('video');
  v.muted = true;
  v.defaultMuted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.setAttribute('muted', '');
  v.preload = 'auto';
  // O Safari decodifica melhor com o vídeo dentro da página.
  v.style.cssText =
    'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
  document.body.appendChild(v);
  v.src = URL.createObjectURL(file);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('O vídeo demorou demais para abrir.')), 20000);
    v.onloadeddata = () => {
      clearTimeout(timer);
      resolve();
    };
    v.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Não consegui abrir esse vídeo.'));
    };
  });
  return v;
}

/** Remove o vídeo escondido da página (quando escolher outro arquivo). */
export function disposeVideo(v) {
  if (!v) return;
  v.pause();
  URL.revokeObjectURL(v.src);
  v.removeAttribute('src');
  v.load();
  v.remove();
}

function seek(v, t) {
  if (Math.abs(v.currentTime - t) < 0.01) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      v.removeEventListener('seeked', finish);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 1500);
    v.addEventListener('seeked', finish);
    v.currentTime = t;
  });
}

/**
 * Toca o vídeo de t0 até t1 e chama onFrame(tempo) a cada ~1/fps segundos de
 * vídeo, com o quadro atual pronto para ser desenhado.
 */
async function captureByPlaying(v, t0, t1, fps, rate, onFrame) {
  v.pause();
  await seek(v, t0);
  v.playbackRate = rate;
  const step = 1 / fps;
  const hasRVFC = typeof v.requestVideoFrameCallback === 'function';

  await new Promise((resolve, reject) => {
    let done = false;
    let next = t0;
    let lastT = -1;
    let lastChange = performance.now();

    const stop = (err) => {
      if (done) return;
      done = true;
      v.pause();
      clearInterval(watchdog);
      v.removeEventListener('ended', onEnded);
      err ? reject(err) : resolve();
    };
    const onEnded = () => stop();
    const watchdog = setInterval(() => {
      if (performance.now() - lastChange > STALL_MS) {
        stop(new Error('O vídeo travou no meio. Tenta de novo ou grave um trecho mais curto.'));
      }
    }, 500);

    const handle = (mediaTime) => {
      if (done) return;
      const t = mediaTime != null ? mediaTime : v.currentTime;
      if (t !== lastT) {
        lastT = t;
        lastChange = performance.now();
      }
      if (t >= next - 0.002) {
        try {
          onFrame(t);
        } catch (err) {
          return stop(err);
        }
        next = Math.max(next + step, t + step * 0.5);
      }
      if (t >= t1 || v.ended) return stop();
      schedule();
    };
    const schedule = () => {
      if (hasRVFC) v.requestVideoFrameCallback((_, meta) => handle(meta.mediaTime));
      else requestAnimationFrame(() => handle());
    };

    v.addEventListener('ended', onEnded);
    const p = v.play();
    (p && p.then ? p : Promise.resolve()).then(schedule, (err) =>
      stop(new Error('O navegador não deixou tocar o vídeo. ' + (err && err.message ? err.message : ''))),
    );
  });
  v.playbackRate = 1;
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
  const duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : ANALYSIS_MAX_SECONDS;
  const { w, h, scale } = workingSize(sw, sh, WORK_VIDEO);
  const span = Math.min(duration, ANALYSIS_MAX_SECONDS);

  // Uma passada tocando o vídeo, guardando quadros pequenos.
  const frames = [];
  await captureByPlaying(v, 0, span, ANALYSIS_FPS, ANALYSIS_RATE, (t) => {
    frames.push({ t, img: grab(v, 0, 0, sw, sh, w, h) });
    onProgress(Math.min(1, t / span));
  });
  if (!frames.length) throw new Error('Não consegui ler os quadros desse vídeo.');

  const midImg = frames[frames.length >> 1].img;
  const bg = estimateBackground(midImg);
  const photo = looksLikePhoto(midImg, bg);
  for (const f of frames) {
    f.fg = foregroundMask(f.img, bg);
    f.gray = grayOf(f.img);
  }
  const count = frames.length;

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

  const colorImg = frames[(a + b) >> 1].img;
  let candidates = toSource(findCandidates(colorImg, union, b > a ? motion : null), scale, sw, sh);
  if (!candidates.length) candidates = [{ x0: 0, y0: 0, x1: sw - 1, y1: sh - 1, whole: true }];

  const step = 1 / ANALYSIS_FPS;
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
    photo,
    animated: b > a,
  };
}

export async function cutVideo(analysis, cand, opts, onProgress = () => {}) {
  const { source: v, window } = analysis;
  const r = regionFor(analysis, cand, { ...opts, maxPlain: 640 });
  const span = Math.max(0.05, Math.min(ANIM_SECONDS, window.t1 - window.t0));

  // Captura rápida (só copia os pixels); o recorte vem depois, sem pressa.
  const raw = [];
  await captureByPlaying(v, window.t0, window.t0 + span, ANIM_FPS, 1, (t) => {
    if (raw.length < ANIM_FPS * ANIM_SECONDS) raw.push(grab(v, r.x, r.y, r.w, r.h, r.dw, r.dh));
    onProgress(Math.min(0.5, ((t - window.t0) / span) * 0.5));
  });
  if (!raw.length) raw.push(grab(v, r.x, r.y, r.w, r.h, r.dw, r.dh));

  const cuts = [];
  for (let i = 0; i < raw.length; i++) {
    cuts.push(r.keep ? cutout(raw[i], analysis.bg, r.keep) : raw[i]);
    raw[i] = null;
    onProgress(0.5 + ((i + 1) / raw.length) * 0.5);
    if (i % 3 === 2) await tick();
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
  // Intervalo real entre quadros capturados (o vídeo pode ter menos fps).
  const delay = Math.round((span * 1000) / cuts.length);
  return { frames: cuts.map(toCanvas), box, stillIndex, delay: Math.max(20, delay) };
}

/** Miniatura (canvas) de um candidato, para o usuário escolher outro. */
export function thumbnail(analysis, cand, size = 96) {
  const { source, sw, sh } = analysis;
  const r = padRect(cand, sw, sh);
  const s = size / Math.max(r.w, r.h);
  return toCanvas(grab(source, r.x, r.y, r.w, r.h, Math.max(1, Math.round(r.w * s)), Math.max(1, Math.round(r.h * s))));
}
