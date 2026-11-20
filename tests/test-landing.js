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
    check('priset säger 3 % allt inräknat, inte 1,5 %', /cirka 3 % på det som går genom OpenGym Pay, allt inräknat/.test(text) && !/1,5 %/.test(text) && /SHARE = 0\.03;/.test(src));
    check('priset säger taket 4 500 kr', /Aldrig mer än 4 500 kr i månaden/.test(text) && /CAP_PER_MONTH = 4500;/.test(src));
    const og = src.match(/<meta property="og:image" content="([^"]+)"/);
    check('og:image och twitter:image pekar på delningsbilden', !!og && og[1] === 'https://opengym.se/assets/og/landing.png' && /<meta name="twitter:image" content="https:\/\/opengym.se\/assets\/og\/landing.png"/.test(src));
    const png = fs.readFileSync(path.join(ROOT, 'assets', 'og', 'landing.png'));
    check('delningsbilden är en 1200 × 630 png under 300 kB', png.toString('latin1', 1, 4) === 'PNG' && png.readUInt32BE(16) === 1200 && png.readUInt32BE(20) === 630 && png.length < 300 * 1024);

    // Sökmotorer och AI-sök: canonical, description, strukturerad data
    const canon = [...src.matchAll(/<link rel="canonical" href="([^"]+)"/g)].map(m => m[1]);
    check('en canonical, och den är https://opengym.se/', canon.length === 1 && canon[0] === 'https://opengym.se/');
    const desc = src.match(/<meta name="description" content="([^"]+)"/)[1];
    // 159 tecken mättes till 986 px och varnade i geo.new 2026-11-20. Under 150 tecken ryms i sökresultatet.
    check('description är 120–150 tecken (' + desc.length + ')', desc.length >= 120 && desc.length <= 150);
    const blocks = [...src.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]));
    const nodes = blocks.flatMap(b => b['@graph'] || [b]);
    const ofType = t => nodes.filter(nd => [].concat(nd['@type']).includes(t));
    const org = ofType('Organization')[0];
    check('JSON-LD: Organization med namn, url, logga och e-post', blocks.length === 1 && !!org && org.name === 'OpenGym' && org.url === 'https://opengym.se/' && fs.existsSync(path.join(ROOT, org.logo.replace('https://opengym.se/', ''))) && org.email === 'daniel@opengym.se');
    const site = ofType('WebSite')[0];
    check('JSON-LD: WebSite med namn och url', !!site && site.name === 'OpenGym' && site.url === 'https://opengym.se/');
    check('JSON-LD: en FAQPage med sex frågor', ofType('FAQPage').length === 1 && ofType('FAQPage')[0].mainEntity.length === 6);
    check('JSON-LD: inga profillänkar som inte är bekräftade', !('sameAs' in org));
  }

  // ---------- llms.txt: finns, länkar till sidan och säger samma pris som sidan ----------
  {
    const llms = fs.readFileSync(path.join(ROOT, 'llms.txt'), 'utf8');
    const lines = llms.split('\n').filter(l => l.trim());
    check('llms.txt: rubrik, minst fem rader och länk till sidan', /^# OpenGym$/.test(lines[0]) && lines.length >= 5 && /\]\(https:\/\/opengym\.se\/\)/.test(llms));
    const page = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const ids = [...llms.matchAll(/\]\(https:\/\/opengym\.se\/#([a-z0-9-]+)\)/g)].map(m => m[1]);
    check('llms.txt: ankarlänkarna finns på sidan (' + ids.join(', ') + ')', ids.length > 0 && ids.every(id => page.includes('id="' + id + '"')));
    const price = ['cirka 3 % på det som går genom OpenGym Pay, allt inräknat', '25 000 kr', '4 500 kr', '60 dagar', '97 %', '76 %', '80–500'];
    check('llms.txt: samma siffror som sidan', price.every(p => llms.includes(p) && page.replace(/&nbsp;/g, ' ').includes(p)));
    check('llms.txt: copyreglerna gäller här också', !/\bhens?\b/i.test(llms) && !/systemlicens|plattform|träningslager|retention|affärssystem/i.test(llms));
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
    check('åtta sektioner i rätt ordning', (await page.$$eval('section', els => els.map(e => e.id).join(','))) === 'fasta-grupper,var-story,appen,sa-funkar-det,vad-ingar,pris,bytet,pilot');
    check('sex rutor i Vad ingår, åtta prispunkter, sex frågor', (await page.locator('.tile').count()) === 6 && (await page.locator('.price-points li').count()) === 8 && (await page.locator('.faq-item').count()) === 6);
    check('desktop utan overflow', (await overflow(page)) === 0);

    // Strukturerad data säger samma sak som sidan visar
    const norm = s => String(s).replace(/\s+/g, ' ').trim();
    const ld = JSON.parse(await page.$eval('script[type="application/ld+json"]', el => el.textContent))['@graph'];
    const webpage = ld.find(nd => [].concat(nd['@type']).includes('FAQPage'));
    check('JSON-LD: sidans namn, rubrik och beskrivning är sidans egna', webpage.name === (await page.title()) && webpage.headline === norm(await page.textContent('h1')) && webpage.description === (await page.getAttribute('meta[name="description"]', 'content')));
    const visibleFaq = await page.$$eval('.faq-item', els => els.map(e => [e.querySelector('h3').textContent, e.querySelector('p').textContent]));
    check('JSON-LD: frågorna och svaren är ordagrant de som syns under Bytet', JSON.stringify(webpage.mainEntity.map(q => [q.name, q.acceptedAnswer.text])) === JSON.stringify(visibleFaq.map(([q, a]) => [norm(q), norm(a)])));

    // Tillgänglighet: skip-länk, etiketter, ankare
    check('skip-länken är sidans första länk och pekar på <main>', (await page.$eval('a', el => el.getAttribute('href'))) === '#main' && (await page.$eval('#main', el => el.tagName)) === 'MAIN');
    check('skip-länken ligger utanför skärmen tills den får fokus', (await page.$eval('.skip-link', el => el.getBoundingClientRect().bottom)) < 0);
    await page.keyboard.press('Tab');
    check('första Tab landar på skip-länken, och då syns den', await page.evaluate(() => document.activeElement.classList.contains('skip-link') && document.activeElement.getBoundingClientRect().top >= 0));
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    check('efter skip-länken fortsätter Tab inne i <main>, förbi menyn', await page.evaluate(() => !!document.activeElement.closest('main') && !document.activeElement.closest('nav')));
    check('alla fält har en etikett', await page.$$eval('input, select, textarea', els => els.every(el => el.getAttribute('aria-label') || el.closest('label') || (el.id && document.querySelector('label[for="' + el.id + '"]')))));
    check('alla ankarlänkar har ett mål på sidan', await page.$$eval('a[href^="#"]', els => els.every(a => document.getElementById(a.getAttribute('href').slice(1)))));
    check('sidfoten: Om oss till Vår story, och samma e-post som i JSON-LD', (await page.$eval('footer a[href="#var-story"]', el => el.textContent)) === 'Om oss' && (await page.$eval('footer a[href^="mailto:"]', el => el.getAttribute('href'))) === 'mailto:' + ld.find(nd => nd['@type'] === 'Organization').email);
    await page.evaluate(() => { window.scrollTo(0, 0); document.activeElement.blur(); });

    // Kalkylatorn
    check('kalkylator: standardvärden', digits(await page.textContent('#volume-out')) === '142500' && digits(await page.textContent('#fee-out')) === '3525' && digits(await page.textContent('#fee-big')) === '3525');
    check('kalkylator: nollnoten dold som standard', await page.$eval('#calc-zero', el => el.hidden));
    check('kalkylator: taket dolt som standard', await page.$eval('#calc-cap', el => el.hidden) && await page.$eval('#cap-line', el => el.hidden));
    await page.$eval('#members', el => { el.value = '30'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.$eval('#price', el => { el.value = '400'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    check('kalkylator: liten box ger noll', digits(await page.textContent('#volume-out')) === '12000' && digits(await page.textContent('#fee-big')) === '0' && !(await page.$eval('#calc-zero', el => el.hidden)));
    await page.$eval('#members', el => { el.value = '500'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.$eval('#price', el => { el.value = '1500'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    check('kalkylator: stor box slår i taket 4 500 kr', digits(await page.textContent('#volume-out')) === '750000' && digits(await page.textContent('#fee-out')) === '21750' && digits(await page.textContent('#fee-big')) === '4500' && !(await page.$eval('#cap-line', el => el.hidden)) && !(await page.$eval('#calc-cap', el => el.hidden)) && (await page.$eval('#fee-line', el => el.classList.contains('capped'))));
    await page.$eval('#members', el => { el.value = '180'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.$eval('#price', el => { el.value = '950'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    check('kalkylator: strax under taket visas procentbeloppet', digits(await page.textContent('#fee-big')) === '4380' && (await page.$eval('#cap-line', el => el.hidden)) && (await page.$eval('#calc-cap', el => el.hidden)));

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
    check('vår story: Jessica grundade och drev ReShape', /Jessica grundade ReShape CrossFit och drev boxen/.test(await page.textContent('#var-story')) && (await page.textContent('#var-story h2')).includes('Jessicas'));

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
    check(`mobil ${width}: rubrik och undertext före kortet i app-delen`, await page.$$eval('.shots figure', figs => figs.every(f => f.querySelector('figcaption').getBoundingClientRect().bottom <= f.querySelector('.shot').getBoundingClientRect().top)));
    if (width === 390) await page.screenshot({ path: `${OUT}/landing-mobil.png`, fullPage: true });
    await ctx.close();
  }

  await browser.close();
  server.close();
  console.log(`\n${n} checks passed · POSTs captured: ${posts.length}`);
  console.log('console errors:', errors.length ? errors : 'none');
  if (errors.length) process.exit(1);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
