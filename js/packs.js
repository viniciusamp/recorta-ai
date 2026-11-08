// Pacotes de figurinhas: criar, adicionar, e mandar para o WhatsApp.
//
// Regras do WhatsApp (repositório oficial WhatsApp/stickers):
//  - 3 a 30 figurinhas por pacote, todas paradas OU todas animadas;
//  - figurinha WebP 512x512 (parada <= 100 KB, animada <= 500 KB);
//  - ícone do pacote (tray) PNG 96x96 <= 50 KB;
//  - 1 a 3 emojis por figurinha; nome e autor com até 128 caracteres.

import { encodeStatic, encodeAnimated, toBase64, fromBase64, isAnimatedWebP, LIMIT_STATIC, LIMIT_ANIMATED } from './webp.js';
import { makeCanvas, ctx2d } from './detect.js';
import { savePack } from './store.js';
import { isNative, call } from './native.js';
import { canvasToBlob } from './compose.js';

export const MAX_STICKERS = 30;
export const MIN_STICKERS = 3;
export const DEFAULT_EMOJI = '😂';
const PUBLISHER = 'Recorta Aí';

function randomId(prefix) {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return prefix + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function newPack(name) {
  return {
    id: randomId('ra_'),
    name: (name || 'Meu pacote').slice(0, 128),
    publisher: PUBLISHER,
    animated: null, // definido pela primeira figurinha
    trayId: null,
    stickers: [],
    created: Date.now(),
    updated: Date.now(),
  };
}

/** Separa os emojis de um texto (no máximo 3). */
export function emojiList(text) {
  const str = String(text || '').trim();
  let parts;
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    parts = Array.from(new Intl.Segmenter('pt', { granularity: 'grapheme' }).segment(str), (x) => x.segment);
  } else {
    parts = Array.from(str);
  }
  return parts.filter((g) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g)).slice(0, 3);
}

export function cleanEmojis(text) {
  return emojiList(text).join('');
}

export const stickerSrc = (s) => `data:image/webp;base64,${s.webp}`;

export function packKind(pack) {
  if (pack.animated == null) return 'vazio';
  return pack.animated ? 'animado' : 'parado';
}

/**
 * Adiciona uma figurinha já montada (512x512).
 * @param art { still: canvas, frames: canvas[] | null, delay }
 * Se o tipo não bate com o pacote, converte: animada vira parada (melhor
 * quadro) e parada vira "animada" de 2 quadros iguais.
 */
export async function addSticker(pack, art, onProgress = () => {}) {
  if (pack.stickers.length >= MAX_STICKERS) {
    throw new Error(`Esse pacote já tem ${MAX_STICKERS} figurinhas, o máximo do WhatsApp.`);
  }
  const isAnim = !!(art.frames && art.frames.length > 1);
  if (pack.animated == null) pack.animated = isAnim;

  let bytes;
  if (pack.animated) {
    const frames = isAnim ? art.frames : [art.still, art.still];
    bytes = await encodeAnimated(frames, isAnim ? art.delay : 500, onProgress);
  } else {
    bytes = await encodeStatic(art.still);
  }
  const limit = pack.animated ? LIMIT_ANIMATED : LIMIT_STATIC;
  if (bytes.length > limit) {
    throw new Error('Essa figurinha ficou pesada demais para o WhatsApp, mesmo comprimida.');
  }
  const sticker = { id: randomId('s_'), webp: toBase64(bytes), emoji: DEFAULT_EMOJI, size: bytes.length };
  pack.stickers.push(sticker);
  if (!pack.trayId) pack.trayId = sticker.id;
  await savePack(pack);
  return sticker;
}

export async function removeSticker(pack, id) {
  pack.stickers = pack.stickers.filter((s) => s.id !== id);
  if (pack.trayId === id) pack.trayId = pack.stickers[0] ? pack.stickers[0].id : null;
  if (!pack.stickers.length) pack.animated = null;
  await savePack(pack);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Não consegui ler a figurinha.'));
    img.src = src;
  });
}

/** Ícone do pacote: PNG 96x96 a partir da figurinha escolhida. */
export async function trayImage(pack) {
  const st = pack.stickers.find((s) => s.id === pack.trayId) || pack.stickers[0];
  const img = await loadImage(stickerSrc(st));
  const c = makeCanvas(96, 96);
  const ctx = ctx2d(c);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, 96, 96);
  const blob = await canvasToBlob(c, 'image/png');
  return toBase64(new Uint8Array(await blob.arrayBuffer()));
}

/** Confere o pacote antes de mandar. Devolve uma mensagem de erro ou null. */
export function validate(pack) {
  const n = pack.stickers.length;
  if (n < MIN_STICKERS) {
    const falta = MIN_STICKERS - n;
    return `O WhatsApp pede pelo menos ${MIN_STICKERS} figurinhas. Falta${falta > 1 ? 'm' : ''} ${falta}.`;
  }
  if (n > MAX_STICKERS) return `O WhatsApp aceita até ${MAX_STICKERS} figurinhas por pacote.`;
  for (const s of pack.stickers) {
    const bytes = fromBase64(s.webp);
    if (isAnimatedWebP(bytes) !== !!pack.animated) {
      return 'O pacote mistura figurinhas paradas e animadas. Remova a que estiver diferente.';
    }
    if (bytes.length > (pack.animated ? LIMIT_ANIMATED : LIMIT_STATIC)) {
      return 'Uma das figurinhas passou do tamanho que o WhatsApp aceita.';
    }
  }
  return null;
}

/** Monta o JSON no formato que o WhatsApp lê. */
export async function whatsappJson(pack) {
  const json = {
    identifier: pack.id,
    name: pack.name.slice(0, 128) || 'Recorta Aí',
    publisher: (pack.publisher || PUBLISHER).slice(0, 128),
    tray_image: await trayImage(pack),
    stickers: pack.stickers.map((s) => ({
      image_data: s.webp,
      emojis: emojiList(s.emoji).length ? emojiList(s.emoji) : [DEFAULT_EMOJI],
    })),
  };
  if (pack.animated) json.animated_sticker_pack = true;
  return json;
}

/** Manda o pacote para o WhatsApp (só no app do iPhone). */
export async function sendToWhatsApp(pack) {
  const err = validate(pack);
  if (err) throw new Error(err);
  if (!isNative) throw new Error('Mandar o pacote direto só funciona no app do Recorta Aí.');
  const info = await call('info');
  if (!info || !info.whatsapp) throw new Error('Não encontrei o WhatsApp neste iPhone.');
  const json = await whatsappJson(pack);
  const ok = await call('sendToWhatsApp', { json: JSON.stringify(json) });
  if (!ok) throw new Error('O WhatsApp não abriu. Tenta de novo?');
}

/** Arquivos .webp de todas as figurinhas (para salvar/compartilhar). */
export function packFiles(pack) {
  return pack.stickers.map(
    (s, i) => new File([fromBase64(s.webp)], `${pack.name.replace(/[^\w-]+/g, '_')}-${i + 1}.webp`, { type: 'image/webp' }),
  );
}
