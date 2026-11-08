import * as P from './pipeline.js';
import { layoutFor, renderFrame, canvasToBlob, encodeGif } from './compose.js';
import * as Packs from './packs.js';
import { listPacks, savePack, deletePack } from './store.js';
import { isNative, call } from './native.js';
import { toBase64 } from './webp.js';

const $ = (s) => document.querySelector(s);
const screens = {
  home: $('#screen-home'),
  busy: $('#screen-busy'),
  result: $('#screen-result'),
  pack: $('#screen-pack'),
};

const state = {
  screen: 'home',
  packs: [],
  pack: null, // pacote aberto
  targetPackId: null, // pacote de destino da figurinha em edição
  analysis: null,
  candIndex: 0,
  cut: null,
  outline: true,
  removeBg: true,
  whole: false,
  mode: 'still',
  blob: null,
  url: null,
};
window.__recorta = state; // ajuda nos testes automáticos

const tick = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// ------------------------------------------------------------ navegação

function show(name) {
  state.screen = name;
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
  $('#btn-back').hidden = !(name === 'result' || name === 'pack');
  window.scrollTo({ top: 0 });
}

function back() {
  if (state.screen === 'result' && state.targetPackId) return openPack(state.targetPackId);
  goHome();
}

async function goHome() {
  state.targetPackId = null;
  await refreshPacks();
  show('home');
}

function setBusy(text, progress) {
  if (text) $('#busy-text').textContent = text;
  if (progress != null) $('#busy-bar').style.width = `${Math.round(progress * 100)}%`;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3400);
}

// ------------------------------------------------------------ folha (menu)

let sheetResolve = null;
function closeSheet(value) {
  $('#sheet').hidden = true;
  const r = sheetResolve;
  sheetResolve = null;
  if (r) r(value);
}

/**
 * Menu de baixo. items: [{ label, sub, img, value, danger, disabled }]
 * input: { value, placeholder } → OK devolve o texto. Cancelar devolve null.
 */
function sheet({ title, text = '', items = [], input = null, okLabel = 'OK' }) {
  if (sheetResolve) closeSheet(null);
  $('#sheet-title').textContent = title;
  $('#sheet-text').textContent = text;
  $('#sheet-text').hidden = !text;
  const inp = $('#sheet-input');
  inp.hidden = !input;
  $('#sheet-ok').hidden = !input;
  $('#sheet-ok').textContent = okLabel;
  if (input) {
    inp.value = input.value || '';
    inp.placeholder = input.placeholder || '';
  }
  const list = $('#sheet-items');
  list.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sheet-item' + (it.danger ? ' danger' : '');
    b.disabled = !!it.disabled;
    if (it.img) {
      const im = document.createElement('img');
      im.src = it.img;
      im.alt = '';
      b.appendChild(im);
    } else if (it.icon) {
      const ic = document.createElement('span');
      ic.className = 'sheet-icon';
      ic.textContent = it.icon;
      b.appendChild(ic);
    }
    const tx = document.createElement('span');
    tx.className = 'sheet-label';
    tx.textContent = it.label;
    if (it.sub) {
      const s = document.createElement('small');
      s.textContent = it.sub;
      tx.appendChild(s);
    }
    b.appendChild(tx);
    b.addEventListener('click', () => closeSheet(it.value));
    list.appendChild(b);
  }
  $('#sheet').hidden = false;
  if (input) setTimeout(() => inp.focus(), 50);
  return new Promise((resolve) => (sheetResolve = resolve));
}

$('#sheet').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeSheet(null);
});
$('#sheet-ok').addEventListener('click', () => closeSheet($('#sheet-input').value.trim()));
$('#sheet-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') closeSheet($('#sheet-input').value.trim());
});

// ------------------------------------------------------------ pacotes (início)

async function refreshPacks() {
  try {
    state.packs = await listPacks();
  } catch (err) {
    console.error(err);
    state.packs = [];
  }
  renderPackList();
}

function trayOf(pack) {
  const st = pack.stickers.find((s) => s.id === pack.trayId) || pack.stickers[0];
  return st ? Packs.stickerSrc(st) : null;
}

function kindLabel(pack) {
  const k = Packs.packKind(pack);
  return k === 'vazio' ? 'vazio' : k === 'animado' ? 'animadas' : 'paradas';
}

function renderPackList() {
  const list = $('#pack-list');
  list.innerHTML = '';
  $('#pack-empty').hidden = state.packs.length > 0;
  for (const p of state.packs) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pack-card';
    const tray = trayOf(p);
    const thumb = document.createElement(tray ? 'img' : 'span');
    thumb.className = 'pack-thumb';
    if (tray) {
      thumb.src = tray;
      thumb.alt = '';
    } else thumb.textContent = '✂';
    const info = document.createElement('span');
    info.className = 'pack-info';
    const name = document.createElement('b');
    name.textContent = p.name;
    const meta = document.createElement('small');
    meta.textContent = `${p.stickers.length} de ${Packs.MAX_STICKERS} · ${kindLabel(p)}`;
    info.append(name, meta);
    const arrow = document.createElement('span');
    arrow.className = 'pack-arrow';
    arrow.textContent = '›';
    b.append(thumb, info, arrow);
    b.addEventListener('click', () => openPack(p.id));
    list.appendChild(b);
  }
}

async function createPack(name) {
  const n = await sheet({
    title: 'Nome do pacote',
    input: { value: name || '', placeholder: 'Ex.: Memes do TikTok' },
    okLabel: 'Criar',
  });
  if (n == null) return null;
  const pack = Packs.newPack(n || 'Meu pacote');
  await savePack(pack);
  state.packs.unshift(pack);
  return pack;
}

/** Pergunta em qual pacote colocar. Devolve o pacote (ou null). */
async function pickPack(isAnim, title = 'Colocar em qual pacote?') {
  await refreshPacks();
  const items = state.packs.map((p) => {
    const full = p.stickers.length >= Packs.MAX_STICKERS;
    let sub = `${p.stickers.length} de ${Packs.MAX_STICKERS} · ${kindLabel(p)}`;
    if (full) sub += ' · cheio';
    else if (isAnim != null && p.animated != null && p.animated !== isAnim) {
      sub += p.animated ? ' · vai ficar animada' : ' · vai entrar parada';
    }
    return { label: p.name, sub, img: trayOf(p), value: p.id, disabled: full };
  });
  items.push({ label: 'Novo pacote', icon: '＋', value: '__new' });
  const v = await sheet({ title, items });
  if (v == null) return null;
  if (v === '__new') return createPack();
  return state.packs.find((p) => p.id === v) || null;
}

// ------------------------------------------------------------ um pacote

async function openPack(id) {
  await refreshPacks();
  const pack = state.packs.find((p) => p.id === id);
  if (!pack) return goHome();
  state.pack = pack;
  state.targetPackId = pack.id;
  renderPack();
  show('pack');
}

function renderPack() {
  const p = state.pack;
  const n = p.stickers.length;
  $('#pack-name').textContent = p.name;
  $('#pack-meta').textContent = `${n} de ${Packs.MAX_STICKERS} figurinhas · ${kindLabel(p)}`;
  const grid = $('#pack-grid');
  grid.innerHTML = '';
  for (const s of p.stickers) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sticker' + (s.id === p.trayId ? ' tray' : '');
    const img = document.createElement('img');
    img.src = Packs.stickerSrc(s);
    img.alt = 'Figurinha';
    const em = document.createElement('span');
    em.className = 'sticker-emoji';
    em.textContent = s.emoji;
    b.append(img, em);
    b.addEventListener('click', () => stickerMenu(s));
    grid.appendChild(b);
  }
  if (!n) {
    const e = document.createElement('p');
    e.className = 'empty';
    e.textContent = 'Pacote vazio. Toque em “Adicionar figurinhas”.';
    grid.appendChild(e);
  }

  const err = Packs.validate(p);
  const btn = $('#btn-whatsapp');
  btn.disabled = !!err;
  let hint = err || '';
  if (!err && !isNative) hint = 'No navegador não dá para mandar o pacote direto. Use o app do Recorta Aí no iPhone.';
  if (!err && isNative) hint = 'O WhatsApp vai abrir pedindo para confirmar.';
  $('#pack-hint').textContent = hint;
  $('#btn-save-all').disabled = !n;
}

async function stickerMenu(s) {
  const p = state.pack;
  const v = await sheet({
    title: 'Figurinha',
    items: [
      { label: 'Usar como ícone do pacote', icon: '★', value: 'tray', disabled: p.trayId === s.id },
      { label: `Trocar emoji (${s.emoji})`, sub: 'Ajuda a achar a figurinha pela busca do WhatsApp', icon: '☺', value: 'emoji' },
      { label: 'Remover do pacote', icon: '✕', value: 'remove', danger: true },
    ],
  });
  if (v === 'tray') {
    p.trayId = s.id;
    await savePack(p);
  } else if (v === 'emoji') {
    const e = await sheet({ title: 'Emoji da figurinha', text: 'Até 3 emojis.', input: { value: s.emoji } });
    if (e) {
      s.emoji = Packs.cleanEmojis(e) || s.emoji;
      await savePack(p);
    }
  } else if (v === 'remove') {
    await Packs.removeSticker(p, s.id);
  }
  renderPack();
}

async function renamePack() {
  const p = state.pack;
  const n = await sheet({ title: 'Nome do pacote', input: { value: p.name }, okLabel: 'Salvar' });
  if (!n) return;
  p.name = n.slice(0, 128);
  await savePack(p);
  renderPack();
}

async function sendPack() {
  const btn = $('#btn-whatsapp');
  btn.disabled = true;
  try {
    if (!isNative) {
      await sheet({
        title: 'Só no app do iPhone',
        text:
          'O WhatsApp só aceita pacotes vindos de um app instalado, então pelo navegador não dá. ' +
          'Você pode usar “Salvar todas” e criar as figurinhas no próprio WhatsApp, ou instalar o app do Recorta Aí.',
        items: [{ label: 'Entendi', value: 'ok' }],
      });
      return;
    }
    await Packs.sendToWhatsApp(state.pack);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = !!Packs.validate(state.pack);
  }
}

async function shareFiles(files) {
  if (!files.length) return;
  if (isNative) {
    const payload = [];
    for (const f of files) payload.push({ name: f.name, base64: toBase64(new Uint8Array(await f.arrayBuffer())) });
    await call('share', { files: payload });
    return;
  }
  if (navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  toast(files.length > 1 ? 'Figurinhas baixadas!' : 'Figurinha baixada!');
}

async function removePack() {
  const p = state.pack;
  const v = await sheet({
    title: `Excluir “${p.name}”?`,
    text: 'As figurinhas desse pacote somem daqui. As que já estão no WhatsApp continuam lá.',
    items: [{ label: 'Excluir pacote', value: 'yes', danger: true }],
  });
  if (v !== 'yes') return;
  await deletePack(p.id);
  state.pack = null;
  goHome();
}

// ------------------------------------------------------------ uma figurinha

function isVideo(file) {
  return file.type.startsWith('video/') || /\.(mov|mp4|m4v|webm)$/i.test(file.name);
}

function disposeAnalysis() {
  if (state.analysis && state.analysis.kind === 'video') P.disposeVideo(state.analysis.source);
  state.analysis = null;
}

async function analyzeFile(file, onProgress = () => {}) {
  if (isVideo(file)) {
    const v = await P.loadVideo(file);
    return P.analyzeVideo(v, onProgress);
  }
  const img = await P.loadImage(file);
  await tick();
  return P.analyzeImage(img);
}

async function handleFile(file) {
  disposeAnalysis();
  state.whole = false;
  state.removeBg = true;
  show('busy');
  setBusy(isVideo(file) ? 'Assistindo a gravação…' : 'Procurando a figurinha…', 0.05);
  await tick();
  try {
    state.analysis = await analyzeFile(file, (p) => setBusy(null, 0.05 + p * 0.55));
    // Foto de verdade (selfie, story...): começa com a imagem inteira.
    if (state.analysis.photo) {
      state.whole = true;
      state.removeBg = false;
    }
    await choose(0);
  } catch (err) {
    console.error(err);
    toast(err.message || 'Algo deu errado. Tenta outro print?');
    back();
  }
}

async function choose(i) {
  const a = state.analysis;
  state.candIndex = i;
  show('busy');
  setBusy('Recortando…', 0.62);
  await tick();
  const opts = { whole: state.whole, removeBg: state.removeBg };
  state.cut =
    a.kind === 'video'
      ? await P.cutVideo(a, a.candidates[i], opts, (p) => setBusy(null, 0.62 + p * 0.3))
      : P.cutImage(a, a.candidates[i], opts);
  state.mode = state.cut.frames.length > 1 ? 'anim' : 'still';
  await render();
  renderCandidates();
  $('#btn-add').textContent = state.targetPackId
    ? `Adicionar em “${(state.packs.find((p) => p.id === state.targetPackId) || { name: 'pacote' }).name}”`
    : 'Adicionar ao pacote';
  show('result');
}

/**
 * Monta a figurinha final (512x512). Na animada, começa pelo quadro mais
 * completo: o WhatsApp para a animação no primeiro quadro.
 */
function makeArt(cut, outline, animated) {
  const layout = layoutFor(cut.box, outline);
  const still = renderFrame(cut.frames[cut.stillIndex], layout, outline);
  if (!animated || cut.frames.length < 2) return { still, frames: null, delay: cut.delay };
  const order = cut.frames.slice(cut.stillIndex).concat(cut.frames.slice(0, cut.stillIndex));
  return { still, frames: order.map((f) => renderFrame(f, layout, outline)), delay: cut.delay };
}

async function render() {
  const animated = state.mode === 'anim' && state.cut.frames.length > 1;
  if (animated) {
    setBusy('Montando a animação…', 0.94);
    await tick();
  }
  state.art = makeArt(state.cut, state.outline, animated);
  state.blob = animated ? encodeGif(state.art.frames, state.art.delay) : await canvasToBlob(state.art.still);
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = URL.createObjectURL(state.blob);
  $('#result-img').src = state.url;

  $('#result-badge').textContent = animated ? 'Animada' : 'Parada · 512×512';
  $('#anim-mode').hidden = state.cut.frames.length <= 1;
  for (const b of document.querySelectorAll('#anim-mode button')) {
    b.classList.toggle('on', b.dataset.mode === state.mode);
  }
  for (const b of document.querySelectorAll('#crop-mode button')) {
    b.classList.toggle('on', (b.dataset.crop === 'whole') === state.whole);
  }
  $('#removebg-wrap').hidden = state.whole;
  $('#photo-note').hidden = !(state.analysis.photo && state.whole);
  $('#opt-removebg').checked = state.removeBg;
}

function renderCandidates() {
  const a = state.analysis;
  const list = $('#cand-list');
  list.innerHTML = '';
  const usable = a.candidates.filter((c) => !c.whole);
  $('#cand-row').hidden = usable.length < 2 || state.whole;
  if (usable.length < 2) return;
  a.candidates.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = i === state.candIndex ? 'on' : '';
    b.setAttribute('aria-label', `Opção ${i + 1}`);
    b.appendChild(P.thumbnail(a, c));
    b.addEventListener('click', () => {
      if (i !== state.candIndex) choose(i);
    });
    list.appendChild(b);
  });
}

async function withDisabled(fn) {
  const btns = document.querySelectorAll('#screen-result button, #opt-outline, #opt-removebg');
  btns.forEach((b) => (b.disabled = true));
  try {
    await fn();
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}

async function recut() {
  const mode = state.mode;
  await choose(state.candIndex);
  if (mode !== state.mode && state.cut.frames.length > 1) {
    state.mode = mode;
    await render();
  }
}

/** Coloca a figurinha atual num pacote. */
async function addCurrent() {
  const isAnim = !!state.art.frames;
  let pack = state.targetPackId ? state.packs.find((p) => p.id === state.targetPackId) : null;
  if (!pack) pack = await pickPack(isAnim);
  if (!pack) return;
  show('busy');
  setBusy('Guardando no pacote…', 0.2);
  try {
    await Packs.addSticker(pack, state.art, (p) => setBusy(null, 0.2 + p * 0.8));
    disposeAnalysis();
    toast(`Adicionada em “${pack.name}” (${pack.stickers.length}/${Packs.MAX_STICKERS})`);
    openPack(pack.id);
  } catch (err) {
    console.error(err);
    toast(err.message);
    show('result');
  }
}

async function saveCurrent() {
  const blob = state.blob;
  if (!blob) return;
  const ext = blob.type === 'image/gif' ? 'gif' : 'png';
  await shareFiles([new File([blob], `figurinha-${Date.now()}.${ext}`, { type: blob.type })]);
}

// ------------------------------------------------------------ vários de uma vez

/** Recorta cada arquivo automaticamente e coloca no pacote. */
async function batch(files, pack) {
  show('busy');
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < files.length; i++) {
    if (pack.stickers.length >= Packs.MAX_STICKERS) {
      toast(`O pacote encheu (${Packs.MAX_STICKERS}). ${files.length - i} ficaram de fora.`);
      break;
    }
    const label = `Figurinha ${i + 1} de ${files.length}…`;
    const base = i / files.length;
    const part = 1 / files.length;
    setBusy(label, base);
    try {
      disposeAnalysis();
      const a = await analyzeFile(files[i], (p) => setBusy(null, base + part * 0.5 * p));
      state.analysis = a;
      const opts = a.photo ? { whole: true, removeBg: false } : { whole: false, removeBg: true };
      const cut =
        a.kind === 'video'
          ? await P.cutVideo(a, a.candidates[0], opts, (p) => setBusy(null, base + part * (0.5 + 0.2 * p)))
          : P.cutImage(a, a.candidates[0], opts);
      const art = makeArt(cut, true, cut.frames.length > 1);
      await Packs.addSticker(pack, art, (p) => setBusy(null, base + part * (0.7 + 0.3 * p)));
      ok++;
    } catch (err) {
      console.error(err);
      fail++;
    }
  }
  disposeAnalysis();
  if (ok) toast(`${ok} figurinha${ok > 1 ? 's' : ''} adicionada${ok > 1 ? 's' : ''}${fail ? ` · ${fail} não deu` : ''}`);
  else toast('Não consegui fazer figurinha com esses arquivos.');
  openPack(pack.id);
}

async function onFiles(files, fromPack) {
  files = Array.from(files || []);
  if (!files.length) return;
  if (fromPack) state.targetPackId = state.pack.id;
  else state.targetPackId = null;
  if (files.length === 1) return handleFile(files[0]);
  const pack = fromPack ? state.pack : await pickPack(null, `Colocar ${files.length} figurinhas em qual pacote?`);
  if (!pack) return;
  return batch(files, pack);
}

// ------------------------------------------------------------ eventos

$('#file').addEventListener('change', (e) => {
  const f = e.target.files;
  onFiles(f, false).finally(() => (e.target.value = ''));
});
$('#pack-file').addEventListener('change', (e) => {
  const f = e.target.files;
  onFiles(f, true).finally(() => (e.target.value = ''));
});
$('#btn-back').addEventListener('click', back);
$('#btn-add').addEventListener('click', () => withDisabled(addCurrent));
$('#btn-save').addEventListener('click', saveCurrent);
$('#btn-new').addEventListener('click', () => {
  disposeAnalysis();
  back();
});
$('#btn-new-pack').addEventListener('click', async () => {
  const p = await createPack();
  if (p) openPack(p.id);
});
$('#pack-name').addEventListener('click', renamePack);
$('#btn-whatsapp').addEventListener('click', sendPack);
$('#btn-save-all').addEventListener('click', () => shareFiles(Packs.packFiles(state.pack)));
$('#btn-delete-pack').addEventListener('click', removePack);
$('#opt-outline').addEventListener('change', (e) => {
  state.outline = e.target.checked;
  withDisabled(render);
});
for (const b of document.querySelectorAll('#crop-mode button')) {
  b.addEventListener('click', () => {
    const whole = b.dataset.crop === 'whole';
    if (whole === state.whole) return;
    state.whole = whole;
    recut();
  });
}
$('#opt-removebg').addEventListener('change', (e) => {
  state.removeBg = e.target.checked;
  recut();
});
for (const b of document.querySelectorAll('#anim-mode button')) {
  b.addEventListener('click', () => {
    if (state.mode === b.dataset.mode) return;
    state.mode = b.dataset.mode;
    withDisabled(render);
  });
}

// Arrastar e soltar (no computador).
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (state.screen === 'home') onFiles(e.dataTransfer.files, false);
  else if (state.screen === 'pack') onFiles(e.dataTransfer.files, true);
});

if (isNative) document.documentElement.classList.add('native');
if (!isNative && 'serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

refreshPacks();
