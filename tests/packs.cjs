// Teste dos pacotes, de ponta a ponta, simulando o app do iPhone.
//
// Uma "ponte nativa" falsa (window.webkit.messageHandlers.recorta) guarda os
// pacotes na memória e captura o JSON que iria para o WhatsApp. O JSON é
// conferido com as regras do repositório oficial WhatsApp/stickers.
//
// Uso: python3 tests/make_fixtures.py && node tests/packs.cjs [pasta-de-saida]

const { chromium, devices } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const OUT = process.argv[2];
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
      if (!p.startsWith(ROOT) || !fs.existsSync(p)) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    });
    srv.listen(0, () => resolve(srv));
  });
}

// Ponte nativa falsa (roda dentro da página).
function fakeBridge() {
  const packs = {};
  window.__sent = [];
  window.__shared = [];
  window.webkit = {
    messageHandlers: {
      recorta: {
        postMessage(msg) {
          switch (msg.cmd) {
            case 'info': return Promise.resolve({ platform: 'ios', whatsapp: true });
            case 'listPacks': return Promise.resolve(Object.values(packs));
            case 'savePack': packs[msg.id] = msg.json; return Promise.resolve(true);
            case 'deletePack': delete packs[msg.id]; return Promise.resolve(true);
            case 'sendToWhatsApp': window.__sent.push(msg.json); return Promise.resolve(true);
            case 'share': window.__shared.push(msg.files.length); return Promise.resolve(true);
            default: return Promise.reject(new Error('cmd ' + msg.cmd));
          }
        },
      },
    },
  };
}

const failures = [];
function check(name, cond, extra) {
  console.log(`${cond ? 'OK    ' : 'FALHOU'} ${name}`);
  if (!cond) {
    failures.push(name);
    if (extra !== undefined) console.log('       ', extra);
  }
}

function webpInfo(buf) {
  // RIFF....WEBP + primeiro bloco; VP8X traz as flags e o tamanho do quadro.
  const riff = buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  const first = buf.toString('ascii', 12, 16);
  let animated = false, w = 0, h = 0, frames = 0;
  if (first === 'VP8X') {
    animated = (buf[20] & 0x02) !== 0;
    w = 1 + buf.readUIntLE(24, 3);
    h = 1 + buf.readUIntLE(27, 3);
    for (let i = 12; i + 8 <= buf.length;) {
      const cc = buf.toString('ascii', i, i + 4);
      const size = buf.readUInt32LE(i + 4);
      if (cc === 'ANMF') frames++;
      i += 8 + size + (size & 1);
    }
  } else if (first === 'VP8 ') {
    w = buf.readUInt16LE(26) & 0x3fff;
    h = buf.readUInt16LE(28) & 0x3fff;
  } else if (first === 'VP8L') {
    const b = buf.readUInt32LE(21);
    w = 1 + (b & 0x3fff);
    h = 1 + ((b >> 14) & 0x3fff);
  }
  return { riff, animated, w, h, frames, size: buf.length };
}

function checkWhatsAppJson(label, json, expectAnimated, expectCount) {
  const j = JSON.parse(json);
  check(`${label}: campos obrigatórios`, j.identifier && j.name && j.publisher && j.tray_image && Array.isArray(j.stickers));
  check(`${label}: identificador válido`, /^[A-Za-z0-9_.-]+$/.test(j.identifier), j.identifier);
  check(`${label}: ${expectCount} figurinhas (3 a 30)`, j.stickers.length === expectCount && j.stickers.length >= 3 && j.stickers.length <= 30, j.stickers.length);
  check(`${label}: animated_sticker_pack = ${expectAnimated}`, !!j.animated_sticker_pack === expectAnimated);
  const tray = Buffer.from(j.tray_image, 'base64');
  const isPng = tray.toString('ascii', 1, 4) === 'PNG';
  check(`${label}: ícone PNG 96x96 <= 50 KB`, isPng && tray.readUInt32BE(16) === 96 && tray.readUInt32BE(20) === 96 && tray.length <= 50 * 1024, { isPng, size: tray.length });
  j.stickers.forEach((s, i) => {
    const b = Buffer.from(s.image_data, 'base64');
    const info = webpInfo(b);
    const limit = expectAnimated ? 500 * 1024 : 100 * 1024;
    const ok = info.riff && info.w === 512 && info.h === 512 && info.animated === expectAnimated && info.size <= limit &&
      (!expectAnimated || info.frames >= 2) && Array.isArray(s.emojis) && s.emojis.length >= 1 && s.emojis.length <= 3;
    check(`${label}: figurinha ${i + 1} (${Math.round(info.size / 1024)} KB${expectAnimated ? `, ${info.frames} quadros` : ''})`, ok, { ...info, emojis: s.emojis });
    if (OUT) fs.writeFileSync(path.join(OUT, `${label}-${i + 1}.webp`), b);
  });
  return j;
}

(async () => {
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 15'] });
  await ctx.addInitScript(fakeBridge);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  const sheetItem = (text) => page.locator('.sheet-item', { hasText: text }).first().click();
  const waitScreen = (id) => page.waitForSelector(`#screen-${id}:not([hidden])`, { timeout: 180000 });

  // 1) Pacote de figurinhas paradas: cria vazio, manda 3 prints de uma vez.
  await page.click('#btn-new-pack');
  await page.fill('#sheet-input', 'Prints do TikTok');
  await page.click('#sheet-ok');
  await waitScreen('pack');
  check('pacote vazio: botão do WhatsApp desligado', await page.isDisabled('#btn-whatsapp'));
  let t0 = Date.now();
  await page.setInputFiles('#pack-file', ['print-dark.png', 'print-light.jpg', 'print-dark.jpg'].map((f) => path.join(FIX, f)));
  await page.waitForFunction(() => document.querySelectorAll('#pack-grid .sticker').length === 3, null, { timeout: 180000 });
  await waitScreen('pack');
  console.log(`       (3 prints em lote: ${Date.now() - t0} ms)`);
  check('lote: 3 figurinhas no pacote', (await page.locator('#pack-grid .sticker').count()) === 3);
  check('lote: botão do WhatsApp ligado', !(await page.isDisabled('#btn-whatsapp')));
  if (OUT) await page.screenshot({ path: path.join(OUT, 'pacote-parado.png'), fullPage: true });
  await page.click('#btn-whatsapp');
  await page.waitForFunction(() => window.__sent.length === 1);
  checkWhatsAppJson('parado', await page.evaluate(() => window.__sent[0]), false, 3);

  // Trocar emoji e ícone.
  await page.locator('#pack-grid .sticker').nth(1).click();
  await sheetItem('Trocar emoji');
  await page.fill('#sheet-input', '🔥😎 kkk');
  await page.click('#sheet-ok');
  await page.locator('#pack-grid .sticker').nth(1).click();
  await sheetItem('Usar como ícone');
  await page.waitForTimeout(200);
  check('emoji trocado e ícone marcado', (await page.locator('#pack-grid .sticker').nth(1).getAttribute('class')).includes('tray') &&
    (await page.locator('#pack-grid .sticker-emoji').nth(1).textContent()) === '🔥😎');

  // 2) Pacote animado: grava tela → resultado → "Adicionar ao pacote" → novo.
  await page.click('#btn-back');
  await waitScreen('home');
  t0 = Date.now();
  await page.setInputFiles('#file', path.join(FIX, 'gravacao-dark.webm'));
  await waitScreen('result');
  console.log(`       (vídeo até o resultado: ${Date.now() - t0} ms)`);
  await page.click('#btn-add');
  await sheetItem('Novo pacote');
  await page.fill('#sheet-input', 'Animadas');
  await page.click('#sheet-ok');
  await waitScreen('pack');
  check('animado: 1 figurinha', (await page.locator('#pack-grid .sticker').count()) === 1);
  check('animado: pede mais figurinhas', (await page.textContent('#pack-hint')).includes('Faltam 2'), await page.textContent('#pack-hint'));
  // Prints entram no pacote animado (viram "animadas" de 2 quadros).
  await page.setInputFiles('#pack-file', ['print-light.png', 'story-foto.jpg'].map((f) => path.join(FIX, f)));
  await page.waitForFunction(() => document.querySelectorAll('#pack-grid .sticker').length === 3, null, { timeout: 180000 });
  await waitScreen('pack');
  if (OUT) await page.screenshot({ path: path.join(OUT, 'pacote-animado.png'), fullPage: true });
  await page.click('#btn-whatsapp');
  await page.waitForFunction(() => window.__sent.length === 2);
  checkWhatsAppJson('animado', await page.evaluate(() => window.__sent[1]), true, 3);

  // 3) Início lista os 2 pacotes; remover figurinha e excluir pacote.
  await page.click('#btn-back');
  await waitScreen('home');
  check('início: 2 pacotes', (await page.locator('.pack-card').count()) === 2);
  if (OUT) await page.screenshot({ path: path.join(OUT, 'inicio.png') });
  await page.locator('.pack-card', { hasText: 'Animadas' }).click();
  await page.locator('#pack-grid .sticker').first().click();
  await sheetItem('Remover');
  await page.waitForFunction(() => document.querySelectorAll('#pack-grid .sticker').length === 2);
  check('remover: botão do WhatsApp desligado com 2', await page.isDisabled('#btn-whatsapp'));
  await page.click('#btn-delete-pack');
  await sheetItem('Excluir pacote');
  await waitScreen('home');
  check('excluir: sobra 1 pacote', (await page.locator('.pack-card').count()) === 1);
  check('salvar todas usa o compartilhar do app', await page.evaluate(async () => {
    document.querySelector('.pack-card').click();
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector('#btn-save-all').click();
    await new Promise((r) => setTimeout(r, 300));
    return window.__shared[0] === 3;
  }));
  check('sem erros na página', errors.length === 0, errors);
  await ctx.close();

  // 4) No navegador (sem app): pacotes ficam salvos depois de recarregar.
  const web = await browser.newContext({ ...devices['iPhone 15'] });
  const wp = await web.newPage();
  await wp.goto(url);
  await wp.setInputFiles('#file', path.join(FIX, 'print-dark.png'));
  await wp.waitForSelector('#screen-result:not([hidden])', { timeout: 60000 });
  await wp.click('#btn-add');
  await wp.locator('.sheet-item', { hasText: 'Novo pacote' }).click();
  await wp.fill('#sheet-input', 'Web');
  await wp.click('#sheet-ok');
  await wp.waitForSelector('#screen-pack:not([hidden])');
  await wp.reload();
  await wp.waitForFunction(() => document.querySelectorAll('.pack-card').length === 1);
  check('navegador: pacote continua depois de recarregar', true);
  await web.close();

  await browser.close();
  srv.close();
  console.log(failures.length ? `\n${failures.length} falha(s)` : '\nTudo certo.');
  process.exit(failures.length ? 1 : 0);
})();
