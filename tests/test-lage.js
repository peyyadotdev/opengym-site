// Läget i Boxrapporten (enkat/lage/) i Chromium mot en mockad Apps Script-endpoint.
// Körs med: node tests/test-lage.js
const { chromium } = require('playwright');
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'screenshots');
const ENDPOINT_PREFIX = 'https://script.google.com/macros/s/';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

function serve() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.normalize(path.join(ROOT, p));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const TIO = {
  ok: true, steg: 10, nasta: 20,
  fasta_grupper: { antal: 6, av: 10 },
  systemkostnad: { vanligast: '2 500–5 000 kr', antal: 5, av: 8, vet_inte: 2 },
  medlemspris: { vanligast: null, antal: null, av: 10, vet_inte: 0 },
  betalkostnad_okand: { antal: 7, av: 10 },
  retention_okand: { antal: 3, av: 10 },
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve();
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const errors = [];
  const anrop = [];
  const check = (name, cond) => { assert.ok(cond, name); console.log('  ok', name); };
  const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const text = (page, sel) => page.$eval(sel, el => el.textContent.trim());

  // svar: ett objekt som JSON, eller { status } för ett fel från servern.
  async function oppna(svar, viewport = { width: 1280, height: 900 }) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error' && !/net::ERR_|status of 500/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    await page.route(u => String(u.href || u).startsWith(ENDPOINT_PREFIX), route => {
      anrop.push({ url: route.request().url(), method: route.request().method() });
      if (svar.status) return route.fulfill({ status: svar.status, body: 'fel' });
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(svar) });
    });
    // Andra externa adresser (typsnitt) stängs av, så att testet inte beror på nätet.
    await page.route(u => !String(u.href || u).startsWith(BASE) && !String(u.href || u).startsWith(ENDPOINT_PREFIX), r => r.abort());
    await page.goto(BASE + '/enkat/lage/', { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('ingress').textContent !== 'Hämtar siffrorna…' || !document.getElementById('nasta').hidden);
    return { ctx, page };
  }

  // ---------- före tio svar ----------
  {
    const { ctx, page } = await oppna({ ok: true, steg: 0, nasta: 10 });
    check('före tio svar: sidan säger när siffrorna kommer', /när minst 10 boxar har svarat/.test(await text(page, '#ingress')));
    check('före tio svar: inga siffror visas', !(await page.isVisible('#siffror')));
    check('före tio svar: stegen förklaras', await page.isVisible('#fot'));
    check('sidan indexeras inte', (await page.$eval('meta[name=robots]', m => m.content)).includes('noindex'));
    check('anropet: GET med action=lage', anrop.at(-1).method === 'GET' && new URL(anrop.at(-1).url).searchParams.get('action') === 'lage');
    await ctx.close();
  }
  {
    const { ctx, page } = await oppna({ ok: true, service: 'opengym-leads', version: 2, actions: ['lead', 'survey'] });
    check('gammal deployment utan läget: samma som före tio svar, inget fel', /när minst 10 boxar har svarat/.test(await text(page, '#ingress')) && !(await page.isVisible('#nasta')));
    await ctx.close();
  }

  // ---------- efter tio svar ----------
  {
    const { ctx, page } = await oppna(TIO);
    check('steg 10: ingressen säger hur många svar siffrorna gäller', (await text(page, '#ingress')) === 'Så här ser det ut efter de första 10 svaren.');
    check('fasta grupper som x av y', (await text(page, '#tal-fasta')) === '6 av 10');
    check('systemkostnad: vanligast, med antal och vet inte', (await text(page, '#tal-kostnad')) === '2 500–5 000 kr' && (await text(page, '#extra-kostnad')) === '5 av 8 som svarat, 2 vet inte');
    check('medlemspris: för få svar när inget svar har fem', (await text(page, '#tal-pris')) === 'För få svar än' && (await text(page, '#extra-pris')) === '');
    check('betalkostnad och retention som x av y', (await text(page, '#tal-betal')) === '7 av 10' && (await text(page, '#tal-retention')) === '3 av 10');
    check('nästa uppdatering vid 20', (await text(page, '#nasta')) === 'Nästa uppdatering när 20 boxar har svarat.');
    check('inga procent på sidan', !/%/.test(await page.$eval('#siffror', el => el.textContent)));
    await page.screenshot({ path: `${OUT}/lage.png`, fullPage: true });
    await ctx.close();
  }
  {
    const { ctx, page } = await oppna(TIO, { width: 375, height: 812 });
    check('mobil: ingen sidledes rullning', (await overflow(page)) <= 0);
    await page.screenshot({ path: `${OUT}/lage-mobil.png`, fullPage: true });
    await ctx.close();
  }
  {
    const { ctx, page } = await oppna(Object.assign({}, TIO, { steg: 40, nasta: null }));
    check('steg 40: sista uppdateringen', /sista uppdateringen/.test(await text(page, '#nasta')));
    await ctx.close();
  }
  {
    const elak = Object.assign({}, TIO, { systemkostnad: { vanligast: '<img src=x onerror="window.__x=1">', antal: 5, av: 5, vet_inte: 0 } });
    const { ctx, page } = await oppna(elak);
    check('text från servern blir text, aldrig HTML', (await page.$$('#siffror img')).length === 0 && (await text(page, '#tal-kostnad')).startsWith('<img'));
    await ctx.close();
  }

  // ---------- fel ----------
  for (const [namn, svar] of [['serverfel', { status: 500 }], ['ok false', { ok: false, error: 'tekniskt' }]]) {
    const { ctx, page } = await oppna(svar);
    check(`${namn}: sidan säger att siffrorna inte gick att hämta`, /gick inte att hämta/.test(await text(page, '#nasta')) && !(await page.isVisible('#siffror')));
    await ctx.close();
  }

  // ---------- länkarna från enkäten ----------
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.route(u => !String(u.href || u).startsWith(BASE), r => r.abort());
    await page.goto(BASE + '/enkat/', { waitUntil: 'load' });
    check('tacksidan länkar till läget', (await page.$eval('#done #lage-lank', a => a.getAttribute('href'))) === '/enkat/lage/');
    await page.evaluate(() => localStorage.setItem('opengym_enkat_v1', JSON.stringify({ v: 1, rid: 'x1234567', completedAt: new Date().toISOString() })));
    await page.reload({ waitUntil: 'load' });
    check('startsidan för den som redan svarat länkar till läget', (await page.$eval('#intro-lage', a => a.getAttribute('href'))) === '/enkat/lage/');
    await ctx.close();
  }

  check('adresser: bara Apps Script-web appen anropades', anrop.every(a => a.url.startsWith(ENDPOINT_PREFIX)));
  console.log('console errors: ' + (errors.length ? errors.join('\n') : 'none'));
  assert.equal(errors.length, 0);
  await browser.close();
  server.close();
})().catch(e => { console.error(e); process.exit(1); });
