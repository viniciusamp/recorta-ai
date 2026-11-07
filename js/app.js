import * as P from './pipeline.js';
import { layoutFor, renderFrame, canvasToBlob, encodeGif } from './compose.js';

const $ = (s) => document.querySelector(s);
const screens = {
  home: $('#screen-home'),
  busy: $('#screen-busy'),
  result: $('#screen-result'),
};

const state = {
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

function show(name) {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
  window.scrollTo({ top: 0 });
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
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

function isVideo(file) {
  return file.type.startsWith('video/') || /\.(mov|mp4|m4v|webm)$/i.test(file.name);
}

async function handleFile(file) {
  if (!file) return;
  if (state.analysis && state.analysis.kind === 'video') P.disposeVideo(state.analysis.source);
  state.analysis = null;
  state.whole = false;
  state.removeBg = true;
  show('busy');
  setBusy('Abrindo…', 0.02);
  await tick();
  try {
    if (isVideo(file)) {
      const v = await P.loadVideo(file);
      setBusy('Assistindo a gravação…', 0.05);
      const t0 = performance.now();
      state.analysis = await P.analyzeVideo(v, (p) => setBusy(null, 0.05 + p * 0.55));
      console.info(`análise do vídeo: ${Math.round(performance.now() - t0)} ms`);
    } else {
      const img = await P.loadImage(file);
      setBusy('Procurando a figurinha…', 0.3);
      await tick();
      state.analysis = P.analyzeImage(img);
    }
    // Foto de verdade (selfie, story...): começa com a imagem inteira, sem
    // tirar fundo. O usuário ainda pode trocar para "Só a figurinha".
    if (state.analysis.photo) {
      state.whole = true;
      state.removeBg = false;
    }
    await choose(0);
  } catch (err) {
    console.error(err);
    show('home');
    toast(err.message || 'Algo deu errado. Tenta outro print?');
  } finally {
    $('#file').value = '';
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
  show('result');
}

async function render() {
  const { frames, box, stillIndex, delay } = state.cut;
  const layout = layoutFor(box, state.outline);
  const animated = state.mode === 'anim' && frames.length > 1;
  if (animated) {
    setBusy('Montando a animação…', 0.94);
    await tick();
    const out = frames.map((f) => renderFrame(f, layout, state.outline));
    state.blob = encodeGif(out, delay);
  } else {
    state.blob = await canvasToBlob(renderFrame(frames[stillIndex], layout, state.outline));
  }
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = URL.createObjectURL(state.blob);
  $('#result-img').src = state.url;

  const kb = Math.max(1, Math.round(state.blob.size / 1024));
  $('#result-badge').textContent = animated ? `Animada · GIF · ${kb} KB` : `Pronta · PNG 512×512 · ${kb} KB`;
  $('#anim-mode').hidden = frames.length <= 1;
  $('#anim-note').hidden = !animated;
  $('#btn-copy').hidden = animated;
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

async function rerender() {
  const btns = document.querySelectorAll('#screen-result button, #opt-outline');
  btns.forEach((b) => (b.disabled = true));
  try {
    await render();
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}

async function save() {
  const blob = state.blob;
  if (!blob) return;
  const ext = blob.type === 'image/gif' ? 'gif' : 'png';
  const file = new File([blob], `figurinha-${Date.now()}.${ext}`, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('Figurinha baixada!');
}

async function copy() {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': state.blob })]);
    toast('Copiada! É só colar.');
  } catch {
    toast('Seu navegador não deixou copiar. Use Salvar.');
  }
}

$('#file').addEventListener('change', (e) => handleFile(e.target.files[0]));
$('#btn-save').addEventListener('click', save);
$('#btn-copy').addEventListener('click', copy);
$('#btn-new').addEventListener('click', () => show('home'));
$('#opt-outline').addEventListener('change', (e) => {
  state.outline = e.target.checked;
  rerender();
});
// Mudanças que pedem um novo recorte (mantendo animada/parada).
async function recut() {
  const mode = state.mode;
  await choose(state.candIndex);
  if (mode !== state.mode && state.cut.frames.length > 1) {
    state.mode = mode;
    await render();
  }
}
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
    rerender();
  });
}

// Arrastar e soltar (no computador).
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (screens.home.hidden) return;
  handleFile(e.dataTransfer.files[0]);
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
