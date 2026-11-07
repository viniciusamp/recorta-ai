// Detecção e recorte da figurinha, 100% no aparelho.
//
// Ideia: em prints do TikTok (comentários, figurinha aberta, etc.) a figurinha
// fica em cima de um fundo liso. Então:
//   1. descobrimos as cores de fundo dominantes;
//   2. tudo que não é fundo vira "objeto" (componentes conectados);
//   3. damos nota para cada objeto (tamanho, formato, cor, movimento...);
//   4. o melhor objeto é recortado: o fundo ligado à borda vira transparente.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function ctx2d(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true });
}

/** Desenha um pedaço de `src` (imagem, vídeo ou canvas) e devolve ImageData. */
export function grab(src, sx, sy, sw, sh, dw = sw, dh = sh) {
  const c = makeCanvas(dw, dh);
  const ctx = ctx2d(c);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, dw, dh);
  return ctx.getImageData(0, 0, dw, dh);
}

export function workingSize(sw, sh, max) {
  const scale = Math.min(1, max / Math.max(sw, sh));
  return {
    w: Math.max(1, Math.round(sw * scale)),
    h: Math.max(1, Math.round(sh * scale)),
    scale,
  };
}

// ---------------------------------------------------------------- fundo

/**
 * Encontra até 3 cores de fundo: cores lisas que ocupam boa parte da tela.
 * Devolve { colors: [[r,g,b], ...], hasAlpha }.
 */
export function estimateBackground(img) {
  const d = img.data;
  const n = img.width * img.height;
  const counts = new Float64Array(4096);
  const sums = new Float64Array(4096 * 3);
  let opaque = 0;
  let transparent = 0;
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    if (d[o + 3] < 16) {
      transparent++;
      continue;
    }
    opaque++;
    const b = ((d[o] >> 4) << 8) | ((d[o + 1] >> 4) << 4) | (d[o + 2] >> 4);
    counts[b]++;
    sums[b * 3] += d[o];
    sums[b * 3 + 1] += d[o + 1];
    sums[b * 3 + 2] += d[o + 2];
  }

  // Contagem somada da vizinhança 3x3x3 (cores que caem na divisa de dois
  // "baldes" não se perdem).
  const hood = new Float64Array(4096);
  for (let r = 0; r < 16; r++)
    for (let g = 0; g < 16; g++)
      for (let b = 0; b < 16; b++) {
        let s = 0;
        for (let dr = -1; dr <= 1; dr++)
          for (let dg = -1; dg <= 1; dg++)
            for (let db = -1; db <= 1; db++) {
              const R = r + dr, G = g + dg, B = b + db;
              if (R < 0 || G < 0 || B < 0 || R > 15 || G > 15 || B > 15) continue;
              s += counts[(R << 8) | (G << 4) | B];
            }
        hood[(r << 8) | (g << 4) | b] = s;
      }

  const colors = [];
  const used = new Uint8Array(4096);
  for (let k = 0; k < 3; k++) {
    let best = -1;
    let bestCount = 0;
    for (let i = 0; i < 4096; i++) {
      if (!used[i] && counts[i] > 0 && hood[i] > bestCount) {
        bestCount = hood[i];
        best = i;
      }
    }
    if (best < 0 || bestCount < opaque * (k === 0 ? 0.08 : 0.06)) break;
    // Dentro da vizinhança vencedora, usa o balde mais populoso como cor.
    {
      const r = best >> 8, g = (best >> 4) & 15, b = best & 15;
      let top = counts[best];
      for (let dr = -1; dr <= 1; dr++)
        for (let dg = -1; dg <= 1; dg++)
          for (let db = -1; db <= 1; db++) {
            const R = r + dr, G = g + dg, B = b + db;
            if (R < 0 || G < 0 || B < 0 || R > 15 || G > 15 || B > 15) continue;
            const i = (R << 8) | (G << 4) | B;
            if (!used[i] && counts[i] > top) {
              top = counts[i];
              best = i;
            }
          }
    }
    const color = [
      sums[best * 3] / counts[best],
      sums[best * 3 + 1] / counts[best],
      sums[best * 3 + 2] / counts[best],
    ];
    colors.push(color);
    // Suprime baldes parecidos com a cor escolhida.
    for (let i = 0; i < 4096; i++) {
      const cr = ((i >> 8) & 15) * 16 + 8;
      const cg = ((i >> 4) & 15) * 16 + 8;
      const cb = (i & 15) * 16 + 8;
      const dr = cr - color[0], dg = cg - color[1], db = cb - color[2];
      if (dr * dr + dg * dg + db * db < 44 * 44) used[i] = 1;
    }
  }
  return { colors, hasAlpha: transparent > n * 0.01 };
}

/**
 * Distância (0..255) de cada pixel até a cor de fundo mais próxima, e o índice
 * dessa cor. Pixels transparentes contam como fundo (distância 0).
 */
export function distanceMap(img, colors) {
  const d = img.data;
  const n = img.width * img.height;
  const dist = new Uint8Array(n).fill(255);
  const near = new Uint8Array(n);
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    if (d[o + 3] < 16) {
      dist[i] = 0;
      continue;
    }
    let best = 1e9;
    for (let k = 0; k < colors.length; k++) {
      const c = colors[k];
      const dr = d[o] - c[0], dg = d[o + 1] - c[1], db = d[o + 2] - c[2];
      const v = dr * dr + dg * dg + db * db;
      if (v < best) {
        best = v;
        near[i] = k;
      }
    }
    if (best < 1e9) dist[i] = Math.min(255, Math.sqrt(best));
  }
  return { dist, near };
}

export const BG_THRESHOLD = 28;

/** Máscara 1 = objeto (não é fundo). */
export function foregroundMask(img, bg) {
  const n = img.width * img.height;
  const fg = new Uint8Array(n);
  if (!bg.colors.length && !bg.hasAlpha) return fg.fill(1);
  const { dist } = distanceMap(img, bg.colors);
  for (let i = 0; i < n; i++) fg[i] = dist[i] >= BG_THRESHOLD ? 1 : 0;
  return fg;
}

/**
 * Quanto do "fundo" é liso de verdade. Prints de app (comentários, figurinha
 * aberta) têm fundo chapado; fotos têm textura/granulado até nas partes escuras.
 * Devolve { coverage, flat }: fração da tela que é fundo, e fração desse
 * fundo que é lisa.
 */
export function backgroundStats(img, bg) {
  const w = img.width;
  const h = img.height;
  const d = img.data;
  if (!bg.colors.length) return { coverage: 0, flat: 0, exact: 0 };
  const { dist } = distanceMap(img, bg.colors);
  let count = 0;
  let flat = 0;
  let exact = 0;
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = y * w + x;
      if (dist[i] >= BG_THRESHOLD) continue;
      count++;
      if (dist[i] < 6) exact++;
      const o = i * 4;
      let m = 0;
      for (const q of [o + 4, o + w * 4]) {
        for (let k = 0; k < 3; k++) m = Math.max(m, Math.abs(d[o + k] - d[q + k]));
      }
      if (m <= 3) flat++;
    }
  }
  return {
    coverage: count / (w * h),
    flat: count ? flat / count : 0,
    exact: count ? exact / count : 0,
  };
}

/** É uma foto (e não um print com fundo chapado)? */
export function looksLikePhoto(img, bg) {
  if (!bg.colors.length) return !bg.hasAlpha;
  const s = backgroundStats(img, bg);
  return s.exact < 0.75 || s.flat < 0.8;
}

// ---------------------------------------------------------------- máscaras

export function dilate(mask, w, h, r) {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let count = 0;
    for (let x = 0; x < Math.min(r, w); x++) count += mask[row + x];
    for (let x = 0; x < w; x++) {
      if (x + r < w) count += mask[row + x + r];
      if (x - r - 1 >= 0) count -= mask[row + x - r - 1];
      tmp[row + x] = count > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = 0; y < Math.min(r, h); y++) count += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      if (y + r < h) count += tmp[(y + r) * w + x];
      if (y - r - 1 >= 0) count -= tmp[(y - r - 1) * w + x];
      out[y * w + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}

/** Rotula componentes 8-conectados. Devolve { labels, comps }. */
export function label(mask, w, h) {
  const n = w * h;
  const labels = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const comps = [];
  for (let start = 0; start < n; start++) {
    if (!mask[start] || labels[start] !== -1) continue;
    const id = comps.length;
    const c = { id, count: 0, x0: w, y0: h, x1: -1, y1: -1 };
    let sp = 0;
    stack[sp++] = start;
    labels[start] = id;
    while (sp) {
      const p = stack[--sp];
      const x = p % w;
      const y = (p - x) / w;
      c.count++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (mask[q] && labels[q] === -1) {
            labels[q] = id;
            stack[sp++] = q;
          }
        }
      }
    }
    comps.push(c);
  }
  return { labels, comps };
}

// ---------------------------------------------------------------- candidatos

/**
 * Procura figurinhas candidatas.
 * @param img     ImageData de trabalho (resolução reduzida), usado para cor.
 * @param fg      máscara de objeto (mesmo tamanho de img).
 * @param motion  (opcional) máscara de pixels que se mexem (vídeo).
 * Devolve candidatos ordenados pela nota, em coordenadas de `img`.
 */
export function findCandidates(img, fg, motion = null) {
  const w = img.width;
  const h = img.height;
  const d = img.data;
  const short = Math.min(w, h);
  const r = Math.max(1, Math.round(short / 150));
  const grown = dilate(fg, w, h, r);
  const { labels, comps } = label(grown, w, h);

  for (const c of comps) {
    c.fg = 0;
    c.sat = 0;
    c.moving = 0;
  }
  for (let i = 0, o = 0; i < w * h; i++, o += 4) {
    const id = labels[i];
    if (id < 0 || !fg[i]) continue;
    const c = comps[id];
    c.fg++;
    const mx = Math.max(d[o], d[o + 1], d[o + 2]);
    const mn = Math.min(d[o], d[o + 1], d[o + 2]);
    c.sat += (mx - mn) / 255;
    if (motion && motion[i]) c.moving++;
  }

  const out = [];
  for (const c of comps) {
    const bw = c.x1 - c.x0 + 1;
    const bh = c.y1 - c.y0 + 1;
    const minRel = Math.min(bw, bh) / short;
    const aspect = Math.max(bw, bh) / Math.min(bw, bh);
    const areaRel = (bw * bh) / (w * h);
    const fill = c.fg / (bw * bh);
    if (minRel < 0.06 || aspect > 3.2 || fill < 0.1 || c.fg < 30) continue;

    const meanSat = c.sat / c.fg;
    const colorScore = 0.35 + Math.min(1, meanSat * 2.5);
    let edges = 0;
    if (c.x0 <= r) edges++;
    if (c.y0 <= r) edges++;
    if (c.x1 >= w - 1 - r) edges++;
    if (c.y1 >= h - 1 - r) edges++;
    const edgePenalty = Math.pow(0.4, edges);
    const bigPenalty = areaRel > 0.6 ? 0.3 : 1;
    const motionFrac = motion ? c.moving / c.fg : 0;
    const motionScore = motion ? 0.4 + Math.min(1.6, motionFrac * 4) : 1;

    const score =
      Math.sqrt(areaRel) *
      Math.pow(1 / aspect, 0.7) *
      colorScore *
      edgePenalty *
      bigPenalty *
      motionScore;

    out.push({
      x0: c.x0,
      y0: c.y0,
      x1: c.x1,
      y1: c.y1,
      score,
      meanSat,
      motionFrac,
      edges,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 6);
}

// ---------------------------------------------------------------- recorte

const T0 = 10; // abaixo disso: fundo puro (transparente)
const T1 = 38; // acima disso: objeto (opaco). Entre os dois: borda suave.

/**
 * Recorta: o fundo ligado à borda da imagem vira transparente, com borda
 * suave e "descontaminação" da cor do fundo. Depois mantém só os pedaços
 * que estão (na maior parte) dentro de `keep`.
 * @param img  ImageData (resolução cheia) da região da figurinha.
 * @param bg   resultado de estimateBackground.
 * @param keep retângulo {x0,y0,x1,y1} em coordenadas de img.
 * Devolve um novo ImageData com alfa.
 */
export function cutout(img, bg, keep) {
  const w = img.width;
  const h = img.height;
  const n = w * h;
  const src = img.data;
  const out = new ImageData(new Uint8ClampedArray(src), w, h);
  const o8 = out.data;
  if (!bg.colors.length && !bg.hasAlpha) return out;

  const { dist, near } = distanceMap(img, bg.colors);

  // Flood fill a partir das bordas, passando só por pixels "parecidos com fundo".
  const filled = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qh = 0;
  let qt = 0;
  const seed = (p) => {
    if (!filled[p] && dist[p] < T1) {
      filled[p] = 1;
      queue[qt++] = p;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (qh < qt) {
    const p = queue[qh++];
    const x = p % w;
    if (x > 0) seed(p - 1);
    if (x < w - 1) seed(p + 1);
    if (p >= w) seed(p - w);
    if (p < n - w) seed(p + w);
  }

  const alpha = new Float32Array(n);
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    const a0 = src[o + 3] / 255;
    let a = 1;
    if (filled[i]) a = clamp01((dist[i] - T0) / (T1 - T0));
    alpha[i] = a * a0;
    if (filled[i] && a > 0 && a < 1 && bg.colors.length) {
      // Tira a "contaminação" da cor de fundo nos pixels da borda.
      const c = bg.colors[near[i]];
      for (let k = 0; k < 3; k++) {
        o8[o + k] = (src[o + k] - (1 - a) * c[k]) / a;
      }
    }
  }

  // Mantém só os pedaços que pertencem à figurinha escolhida.
  const solid = new Uint8Array(n);
  for (let i = 0; i < n; i++) solid[i] = alpha[i] >= 0.5 ? 1 : 0;
  const { labels, comps } = label(solid, w, h);
  if (comps.length) {
    const inside = new Float64Array(comps.length);
    for (let i = 0; i < n; i++) {
      const id = labels[i];
      if (id < 0) continue;
      const x = i % w;
      const y = (i - x) / w;
      if (x >= keep.x0 && x <= keep.x1 && y >= keep.y0 && y <= keep.y1) inside[id]++;
    }
    // O maior pedaço dentro da área é a figurinha. Outros pedaços só ficam se
    // forem grandes (ex.: duas partes separadas) ou estiverem dentro dela
    // (ex.: uma lágrima solta). Letras de comentários vizinhos caem fora.
    let main = null;
    for (const c of comps) {
      if (inside[c.id] / c.count >= 0.5 && (!main || c.count > main.count)) main = c;
    }
    const keepIds = new Uint8Array(comps.length);
    let any = false;
    if (main) {
      // Cor média de cada pedaço (letras costumam ser cinza/preto/branco).
      const chroma = new Float64Array(comps.length);
      for (let i = 0, o = 0; i < n; i++, o += 4) {
        const id = labels[i];
        if (id < 0) continue;
        chroma[id] += (Math.max(o8[o], o8[o + 1], o8[o + 2]) - Math.min(o8[o], o8[o + 1], o8[o + 2])) / 255;
      }
      const minSize = Math.max(12, main.count * 0.08);
      const gap = Math.max(4, 0.06 * Math.max(main.x1 - main.x0, main.y1 - main.y0));
      for (const c of comps) {
        if (inside[c.id] / c.count < 0.5) continue;
        const within = c.x0 >= main.x0 && c.x1 <= main.x1 && c.y0 >= main.y0 && c.y1 <= main.y1;
        const near =
          c.x1 >= main.x0 - gap && c.x0 <= main.x1 + gap && c.y1 >= main.y0 - gap && c.y0 <= main.y1 + gap;
        const colorful = chroma[c.id] / c.count > 0.2 && c.count >= Math.max(12, main.count * 0.004);
        if (c === main || c.count >= minSize || within || (near && colorful)) {
          keepIds[c.id] = 1;
          any = true;
        }
      }
    }
    if (any) {
      const keepMask = new Uint8Array(n);
      for (let i = 0; i < n; i++) if (labels[i] >= 0 && keepIds[labels[i]]) keepMask[i] = 1;
      const near2 = dilate(keepMask, w, h, 2);
      for (let i = 0; i < n; i++) if (!near2[i]) alpha[i] = 0;
    }
  }

  for (let i = 0; i < n; i++) o8[i * 4 + 3] = Math.round(alpha[i] * 255);
  return out;
}

/** Caixa que envolve os pixels visíveis (alfa > thr). null se vazio. */
export function alphaBox(img, thr = 10) {
  const { width: w, height: h, data } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > thr) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

export function alphaSum(img) {
  let s = 0;
  const d = img.data;
  for (let o = 3; o < d.length; o += 4) s += d[o];
  return s;
}
