// End-to-end-test av landningssidan i Chromium mot en mockad Apps Script-endpoint.
// Körs med: npm install && npx playwright install chromium && node tests/test-landing.js
const { chromium } = require('playwright');
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'screenshots');
const ENDPOINT_PREFIX = 'https://script.google.com/macros/s/';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };

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

const digits = s => String(s).replace(/[^\d]/g, '');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve();
  const URL = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const posts = [];
  const errors = [];
  let n = 0;
  const check = (name, cond) => { assert.ok(cond, name); n++; console.log('  ok', name); };

  async function newPage(viewport) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error' && !/net::ERR_/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    await page.route(u => String(u.href || u).startsWith(ENDPOINT_PREFIX), route => {
      posts.push(Object.fromEntries(new URLSearchParams(route.request().postData() || '')));
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    return { ctx, page };
  }
  const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  // ---------- Källkod: inga skogsgröna toner, inga förbjudna ord ----------
  {
    const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    check('inga skogs- eller mossgröna färger kvar i källan', !/#22a447|#14732f|#177a34|#116a2b/i.test(src));
    const text = src.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
    check('ordet "hen/hens" förekommer inte', !/\bhens?\b/i.test(text));
    const banned = ['systemlicens', 'dras i flödet', 'ligger hos en människa', 'plattform', 'träningslager', 'retention'];
    const hits = banned.filter(w => new RegExp(w, 'i').test(text));
    check('ingen systemjargong i copyn (' + banned.join(', ') + ')', hits.length === 0);
  }

  // ---------- Desktop ----------
  {
    const { ctx, page } = await newPage({ width: 1280, height: 900 });
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    check('titel', (await page.title()) === 'OpenGym – Fler som stannar. Färre adminkvällar.');
    check('hero-variant E', (await page.textContent('h1')).includes('Ingen startar en box för att jaga') && (await page.textContent('h1 em')).trim() === 'nya');
    const plate = await page.$eval('h1 em', el => getComputedStyle(el).backgroundImage);
    check('betonat ord får lime-platta', plate.includes('linear-gradient'));
    const darkEm = await page.$eval('#sa-funkar-det h2 em', el => [getComputedStyle(el).color, getComputedStyle(el).backgroundImage]);
    check('mörk sektion: em i ljus lime utan platta', darkEm[0] === 'rgb(201, 255, 92)' && darkEm[1] === 'none');
    check('nav är sticky', (await page.$eval('.nav', el => getComputedStyle(el).position)) === 'sticky');
    check('sju sektioner i rätt ordning', (await page.$$eval('section', els => els.map(e => e.id).join(','))) === 'fasta-grupper,appen,sa-funkar-det,vad-ingar,pris,bytet,pilot');
    check('sex rutor i Vad ingår, åtta prispunkter, sex frågor', (await page.locator('.tile').count()) === 6 && (await page.locator('.price-points li').count()) === 8 && (await page.locator('.faq-item').count()) === 6);
    check('desktop utan overflow', (await overflow(page)) === 0);

    // Kalkylatorn
    check('kalkylator: standardvärden', digits(await page.textContent('#volume-out')) === '142500' && digits(await page.textContent('#fee-out')) === '1763' && digits(await page.textContent('#fee-big')) === '1763');
    check('kalkylator: nollnoten dold som standard', await page.$eval('#calc-zero', el => el.hidden));
    await page.$eval('#members', el => { el.value = '30'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.$eval('#price', el => { el.value = '400'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    check('kalkylator: liten box ger noll', digits(await page.textContent('#volume-out')) === '12000' && digits(await page.textContent('#fee-big')) === '0' && !(await page.$eval('#calc-zero', el => el.hidden)));
    await page.$eval('#members', el => { el.value = '500'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.$eval('#price', el => { el.value = '1500'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    check('kalkylator: stor box', digits(await page.textContent('#volume-out')) === '750000' && digits(await page.textContent('#fee-big')) === '10875');

    // Formuläret
    await page.locator('#pilot').scrollIntoViewIfNeeded();
    await page.click('#signup-button');
    check('tom e-post ger fel', (await page.textContent('#signup-error')).includes('Skriv in din e-postadress'));
    await page.fill('#signup-email', 'inte-en-adress');
    await page.click('#signup-button');
    check('ogiltig e-post ger fel', (await page.textContent('#signup-error')).includes('giltig'));
    check('inget POST vid valideringsfel', posts.length === 0);
    await page.fill('#signup-email', 'Agare@Boxen.SE');
    await page.fill('#signup-box', 'CrossFit Testet');
    await page.screenshot({ path: `${OUT}/landing-pilot.png`, fullPage: false });
    await page.click('#signup-button');
    await page.waitForSelector('#signup-success:not([hidden])');
    check('POST med rätt fält', posts.length === 1 && posts[0].email === 'agare@boxen.se' && posts[0].box === 'CrossFit Testet' && posts[0].source === 'opengym_landing' && !!posts[0].timestamp);
    check('bekräftelsen nämner boxen', (await page.textContent('#signup-done-detail')).includes('CrossFit Testet är noterad'));
    check('formuläret göms efter inskick', !(await page.isVisible('#signup-form')));

    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.querySelectorAll('[style*="animation"]').forEach(() => {}));
    await page.waitForTimeout(1800);
    await page.screenshot({ path: `${OUT}/landing-desktop.png`, fullPage: true });
    await ctx.close();
  }

  // ---------- Utan boxnamn + honeypot ----------
  {
    const { ctx, page } = await newPage({ width: 1280, height: 900 });
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.fill('#signup-email', 'agare@boxen.se');
    await page.click('#signup-button');
    await page.waitForSelector('#signup-success:not([hidden])');
    check('utan boxnamn: skräppost-rad', (await page.textContent('#signup-done-detail')).includes('Kolla skräpposten'));
    await ctx.close();

    const before = posts.length;
    const p2 = await newPage({ width: 1280, height: 900 });
    await p2.page.goto(URL, { waitUntil: 'networkidle' });
    await p2.page.fill('#signup-email', 'bot@example.com');
    await p2.page.evaluate(() => { document.getElementById('signup-website').value = 'http://spam.example'; });
    await p2.page.click('#signup-button');
    await p2.page.waitForSelector('#signup-success:not([hidden])');
    check('honeypot: bekräftelse utan POST', posts.length === before);
    await p2.ctx.close();
  }

  // ---------- Mobil ----------
  for (const width of [390, 360]) {
    const { ctx, page } = await newPage({ width, height: 844 });
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    check(`mobil ${width} utan overflow`, (await overflow(page)) === 0);
    check(`mobil ${width}: bara CTA i menyn`, (await page.$$eval('.nav-links a', els => els.filter(e => getComputedStyle(e).display !== 'none').length)) === 1);
    if (width === 390) await page.screenshot({ path: `${OUT}/landing-mobil.png`, fullPage: true });
    await ctx.close();
  }

  await browser.close();
  server.close();
  console.log(`\n${n} checks passed · POSTs captured: ${posts.length}`);
  console.log('console errors:', errors.length ? errors : 'none');
  if (errors.length) process.exit(1);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
