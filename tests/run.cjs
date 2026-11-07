// Testa o fluxo completo no Chromium: escolhe o arquivo, espera o resultado
// e confere se a figurinha certa foi achada e recortada.
//
// Uso: python3 tests/make_fixtures.py && node tests/run.cjs [pasta-de-screenshots]

const { chromium, devices } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const SHOTS = process.argv[2];

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

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

function containment(det, box) {
  const ix = Math.max(0, Math.min(det.x1, box[2]) - Math.max(det.x0, box[0]));
  const iy = Math.max(0, Math.min(det.y1, box[3]) - Math.max(det.y0, box[1]));
  const detArea = (det.x1 - det.x0) * (det.y1 - det.y0);
  const boxArea = (box[2] - box[0]) * (box[3] - box[1]);
  return { inside: (ix * iy) / detArea, cover: detArea / boxArea };
}

(async () => {
  const meta = JSON.parse(fs.readFileSync(path.join(FIX, 'fixtures.json'), 'utf8'));
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  let failed = 0;

  for (const [name, info] of Object.entries(meta)) {
    const ctx = await browser.newContext({ ...devices['iPhone 15'], deviceScaleFactor: 1 });
    if (info.animated) {
      // Simula o Safari do iPhone: cada "seeked" demora 2,5 s para chegar.
      await ctx.addInitScript(() => {
        window.__seeks = 0;
        const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
        Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
          get() { return desc.get.call(this); },
          set(v) { window.__seeks++; desc.set.call(this, v); },
        });
        const add = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function (type, fn, opts) {
          if (type === 'seeked' && this instanceof HTMLMediaElement) {
            return add.call(this, type, (e) => setTimeout(() => fn.call(this, e), 2500), opts);
          }
          return add.call(this, type, fn, opts);
        };
      });
    }
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url);
    const t0 = Date.now();
    await page.setInputFiles('#file', path.join(FIX, name));
    await page.waitForSelector('#screen-result:not([hidden])', { timeout: 120000 });
    await page.waitForFunction(() => document.querySelector('#result-img').complete);
    const ms = Date.now() - t0;

    const res = await page.evaluate(async () => {
      const s = window.__recorta;
      const c = s.analysis.candidates[0];
      const img = document.querySelector('#result-img');
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      const g = cv.getContext('2d');
      g.drawImage(img, 0, 0);
      const px = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data);
      return {
        cand: { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 },
        count: s.analysis.candidates.length,
        frames: s.cut.frames.length,
        type: s.blob.type,
        size: [cv.width, cv.height],
        corner: px(4, 4),
        center: px(cv.width / 2, cv.height / 2 + cv.height * 0.12),
        removeBg: s.removeBg,
        seeks: window.__seeks,
        // fração opaca dentro da área desenhada (buracos baixam isso)
        solid: (() => {
          const d = g.getImageData(0, 0, cv.width, cv.height).data;
          let x0 = cv.width, x1 = -1, y0 = cv.height, y1 = -1, op = 0;
          for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) if (d[(y * cv.width + x) * 4 + 3] > 10) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
          for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (d[(y * cv.width + x) * 4 + 3] > 200) op++;
          return op / ((x1 - x0 + 1) * (y1 - y0 + 1));
        })(),
      };
    });

    const { inside, cover } = containment(res.cand, info.box);
    const checks = info.photo ? {
      'foto mantém o fundo': res.removeBg === false,
      'sem buracos': res.solid > 0.97,
      '512x512': res.size[0] === 512 && res.size[1] === 512,
      'sem erros': errors.length === 0,
    } : {
      'achou a figurinha': inside > 0.9 && cover > 0.3,
      'canto transparente': res.corner[3] === 0,
      'centro laranja/opaco': res.center[3] === 255 && res.center[0] > 150,
      '512x512': res.size[0] === 512 && res.size[1] === 512,
      animada: info.animated ? res.frames > 10 && res.type === 'image/gif' : res.type === 'image/png',
      'vídeo rápido mesmo com seek lento (iPhone)': !info.animated || (ms < 30000 && res.seeks <= 6),
      'sem erros': errors.length === 0,
    };
    const ok = Object.values(checks).every(Boolean);
    if (!ok) failed++;
    console.log(`${ok ? 'OK  ' : 'FALHOU'} ${name}  (${ms} ms, ${res.count} candidatos, ${res.frames} quadros${info.animated ? `, ${res.seeks} pulos` : ''})`);
    for (const [k, v] of Object.entries(checks)) if (!v) console.log(`      x ${k}`, k === 'achou a figurinha' ? { det: res.cand, box: info.box, inside, cover } : k === 'sem erros' ? errors : res);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
    await ctx.close();
  }

  await browser.close();
  srv.close();
  process.exit(failed ? 1 : 0);
})();
