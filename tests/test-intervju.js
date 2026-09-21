// End-to-end-test av intervjusidan i Chromium mot en låtsad /intervju-tur.
// Körs med: npm install && npx playwright install chromium && node tests/test-intervju.js
// Servern ligger i repot opengym. Här testas bara sidan, mot protokollet i
// opengym/docs/undersokning/intervjusidan-protokoll.md.
const { chromium } = require('playwright');
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'screenshots');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const FALL = JSON.parse(fs.readFileSync(path.join(__dirname, 'fall-typkund.json'), 'utf8'));
const RID = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';
const MOCK = '/mock/intervju-tur';
const UNDERLAG = { v: 1, rid: RID, svar: FALL.bas, skapad: '2026-09-21T10:00:00.000Z' };

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

const check = (name, cond) => { assert.ok(cond, name); console.log('  ok', name); };

// Svar i serverns form: textdelar och sist klar med de två meddelandena som läggs i historiken.
function svar(text, fraga = '(start)') {
  return { handelser: [
    ...text.split(/(?<= )/).map(delta => ({ typ: 'text', delta })),
    { typ: 'klar', tillagg: [{ role: 'user', content: fraga }, { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig-' + text.length }, { type: 'text', text }] }] },
  ] };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const raw = fs.readFileSync(path.join(ROOT, 'intervju', 'index.html'), 'utf8');

  // ---------- Källkod ----------
  {
    const scripts = [...raw.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
    const literals = [...scripts.matchAll(/'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)].map(m => m[1] || m[2] || '').join('\n');
    const textNodes = raw.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
    const src = textNodes + '\n' + literals;
    check('källa: ordet "hen/hens" förekommer inte', !/\bhens?\b/i.test(src));
    const banned = ['affärssystem', 'retention', 'churn', '(?<![-\\w:])leads?(?![-\\w:])', '(?<![-\\w:])data(?![-\\w:])', 'systemlicens', 'plattform', 'träningslager', 'migrering'];
    const hits = banned.filter(w => new RegExp(w, 'i').test(src));
    check('källa: ingen systemjargong i copyn' + (hits.length ? ' (träffar: ' + hits.join(', ') + ')' : ''), hits.length === 0);
    check('källa: inga skogsgröna färger', !/#22a447|#14732f/i.test(raw));
    check('källa: ingen emoji', !/\p{Extended_Pictographic}/u.test(src.replace(/[✓©]/g, '')));
    check('källa: noindex', /<meta name="robots" content="noindex">/.test(raw));
    check('källa: adressen är tom eller Supabase-funktionen', /const TUR_ENDPOINT = '(|https:\/\/arbncxjhzjdoabqmxpla\.supabase\.co\/functions\/v1\/intervju-tur)';/.test(raw));
    check('källa: ingen HTML från servern', !/innerHTML\s*=\s*[^'"\s]/.test(scripts.replace(/knappar\.innerHTML = '/g, '')));
  }

  // ---------- Strömmen i bitar ----------
  {
    const kod = raw.slice(raw.indexOf('// HANDELSER START'), raw.indexOf('// HANDELSER SLUT'));
    const sb = {};
    vm.runInNewContext(kod + '\nthis.delaHandelser = delaHandelser;', sb);
    const a = sb.delaHandelser('data: {"typ":"text","delta":"Hej. "}\n\ndata: {"typ":"text","del');
    check('ström: hel händelse läses, halv blir rest', a.handelser.length === 1 && a.handelser[0].delta === 'Hej. ' && a.rest === 'data: {"typ":"text","del');
    const b = sb.delaHandelser(a.rest + 'ta":"Du."}\n\ndata: {"typ":"klar","tillagg":[]}\n\n');
    check('ström: resten fogas ihop med nästa bit', b.handelser.length === 2 && b.handelser[0].delta === 'Du.' && b.handelser[1].typ === 'klar' && b.rest === '');
    const c = sb.delaHandelser(': kommentar\n\ndata: inte json\n\ndata: {"typ":"text","delta":"x"}\n\n');
    check('ström: kommentarer och trasiga rader hoppas över', c.handelser.length === 1 && c.handelser[0].delta === 'x');
  }

  const server = await serve();
  const BASE = `http://127.0.0.1:${server.address().port}/intervju/`;
  const browser = await chromium.launch();
  const errors = [];
  const anrop = [];
  const scenario = [];

  async function newPage(viewport, { underlag = UNDERLAG } = {}) {
    const ctx = await browser.newContext({ viewport });
    await ctx.route(/posthog\.com/, r => r.abort());
    if (underlag) await ctx.addInitScript(u => localStorage.setItem('opengym_intervju_underlag_v1', JSON.stringify(u)), underlag);
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error' && !/net::ERR_|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    await page.route(u => new URL(String(u.href || u)).pathname === MOCK, route => {
      const req = route.request();
      anrop.push(JSON.parse(req.postData() || 'null'));
      const nasta = scenario.shift() || { handelser: [{ typ: 'fel', kod: 'tekniskt' }] };
      if (nasta.status) return route.fulfill({ status: nasta.status, contentType: 'application/json', body: JSON.stringify(nasta.json) });
      return route.fulfill({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: nasta.handelser.map(h => `data: ${JSON.stringify(h)}\n\n`).join('') });
    });
    return { ctx, page };
  }
  const turer = page => page.$$eval('#logg .tur', els => els.map(e => ({ vem: e.classList.contains('tur-ai') ? 'ai' : 'du', text: e.querySelector('.tur-text').textContent })));
  // Klart när assistentens tur finns och fältet går att skriva i igen, alltså när hela svaret kommit.
  const vantaPaSvar = (page, n) => page.waitForFunction(k => document.querySelectorAll('#logg .tur-ai').length === k && !document.getElementById('text').disabled, n);
  const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  // ---------- Stängt och utan enkätsvar ----------
  {
    const { ctx, page } = await newPage({ width: 1280, height: 900 });
    // Stängt oavsett vad adressen står på i källan.
    await page.route(u => u.pathname === '/intervju/', async route => {
      const r = await route.fetch();
      await route.fulfill({ response: r, body: (await r.text()).replace(/const TUR_ENDPOINT = '[^']*';/, "const TUR_ENDPOINT = '';") });
    });
    await page.goto(BASE, { waitUntil: 'load' });
    check('utan adress: samtalet är stängt', await page.isVisible('#stangd') && !(await page.isVisible('#intro')));
    await ctx.close();
    const u = await newPage({ width: 1280, height: 900 }, { underlag: null });
    await u.page.goto(BASE + '?api=' + MOCK, { waitUntil: 'load' });
    check('utan enkätsvar: hänvisar till enkäten', await u.page.isVisible('#saknas') && (await u.page.getAttribute('#saknas a.btn-primary', 'href')) === '/enkat/');
    check('utan enkätsvar: inget anrop', anrop.length === 0);
    await u.ctx.close();
  }

  // ---------- Hela samtalet på desktop ----------
  {
    const { ctx, page } = await newPage({ width: 1280, height: 900 });
    await page.goto(BASE + '?api=' + MOCK, { waitUntil: 'load' });
    check('intro med startknapp', await page.isVisible('#btn-start'));
    await page.screenshot({ path: `${OUT}/intervju-intro.png` });

    scenario.push(svar('Hej. Jag är OpenGyms AI-assistent. Du svarade att det mest irriterande är autogirot. Berätta om senaste gången.'));
    await page.click('#btn-start');
    await vantaPaSvar(page, 1);
    const f = anrop[0];
    check('start: skickar start, ingen text och tom historik', f.start === true && f.text === null && Array.isArray(f.historik) && f.historik.length === 0);
    check('start: skickar enkätsvaren med svars-id', f.underlag.rid === RID && f.underlag.svar.q03_medlemmar === '150–250');
    check('start: inga kontaktfält i det som skickas', !Object.keys(f.underlag.svar).some(k => k.startsWith('c_')) && !JSON.stringify(f).includes('@'));
    check('start: assistentens svar visas', (await turer(page))[0].text.startsWith('Hej. Jag är OpenGyms AI-assistent.'));

    scenario.push(svar('Tre timmar i månaden, alltså. Vad gör du när en dragning inte går igenom?', 'Senast i fredags.'));
    await page.fill('#text', '  Senast i fredags.  ');
    await page.click('#btn-skicka');
    await vantaPaSvar(page, 2);
    const a = anrop[1];
    check('tur 2: texten putsas och startflaggan är av', a.start === false && a.text === 'Senast i fredags.');
    check('tur 2: historiken skickas tillbaka orörd, med block sidan inte visar', a.historik.length === 2 && a.historik[1].content[0].type === 'thinking' && a.historik[1].content[0].signature.startsWith('sig-'));
    check('tur 2: ägarens tur visas', JSON.stringify((await turer(page)).map(t => t.vem)) === '["ai","du","ai"]' && (await turer(page))[1].text === 'Senast i fredags.');
    check('tur 2: fältet är tömt', (await page.inputValue('#text')) === '');

    scenario.push({ handelser: [{ typ: 'text', delta: 'Halv' }, { typ: 'fel', kod: 'upptagen' }] });
    await page.fill('#text', 'Tre timmar.');
    await page.press('#text', 'Control+Enter');
    await page.waitForSelector('#fel:not([hidden])');
    check('upptaget: felet visas', (await page.textContent('#fel')).includes('upptagen'));
    check('upptaget: det halva svaret och ägarens tur tas bort', (await turer(page)).length === 3);
    check('upptaget: texten ligger kvar i fältet', (await page.inputValue('#text')) === 'Tre timmar.');
    check('upptaget: historiken är oförändrad', anrop.length === 3 && anrop[2].historik.length === 4);

    scenario.push({ status: 400, json: { ok: false, fel: 'for_lang_tur' } });
    await page.click('#btn-skicka');
    await page.waitForFunction(() => document.getElementById('fel').textContent.includes('för långt'));
    check('för lång tur: eget meddelande och texten kvar', (await page.inputValue('#text')) === 'Tre timmar.' && !(await page.isDisabled('#btn-skicka')));

    scenario.push(svar('<img src=x onerror="window.__xss=1"> Tack.', 'Tre timmar.'));
    await page.click('#btn-skicka');
    await vantaPaSvar(page, 3);
    check('svaret sätts som text, aldrig som HTML', (await page.evaluate(() => window.__xss)) === undefined && (await turer(page))[4].text.includes('<img'));
    check('felet döljs efter ett lyckat svar', !(await page.isVisible('#fel')));
    await page.screenshot({ path: `${OUT}/intervju-samtal.png`, fullPage: true });

    await page.reload({ waitUntil: 'load' });
    check('efter omladdning: fortsätt eller börja om', await page.isVisible('#btn-fortsatt') && await page.isVisible('#btn-omstart'));
    await page.click('#btn-fortsatt');
    check('fortsätt: samtalet ritas upp igen', JSON.stringify((await turer(page)).map(t => t.vem)) === '["ai","du","ai","du","ai"]');

    await page.click('#btn-avsluta');
    check('avsluta: tacksidan visas', await page.isVisible('#klart'));
    check('avsluta: samtalet glöms i webbläsaren', (await page.evaluate(() => localStorage.getItem('opengym_intervju_samtal_v1'))) === null);
    await ctx.close();
  }

  // ---------- Assistenten avslutar samtalet ----------
  {
    const { ctx, page } = await newPage({ width: 1280, height: 900 });
    await page.goto(BASE + '?api=' + MOCK, { waitUntil: 'load' });
    scenario.push(svar('Är det något mer du vill berätta?'));
    await page.click('#btn-start');
    await vantaPaSvar(page, 1);
    const sista = svar('Tack för samtalet. Då är vi klara.', 'Nej.');
    sista.handelser.push({ typ: 'slut' });
    scenario.push(sista);
    await page.fill('#text', 'Nej.');
    await page.click('#btn-skicka');
    await page.waitForSelector('#avslutat:not([hidden])');
    check('slut: skrivfältet försvinner', !(await page.isVisible('#skriv')));
    check('slut: raden om att samtalet är klart visas', (await page.textContent('#avslutat')).includes('Samtalet är klart'));
    check('slut: sista svaret visas', (await turer(page)).pop().text === 'Tack för samtalet. Då är vi klara.');
    await page.screenshot({ path: `${OUT}/intervju-slut.png`, fullPage: true });
    await page.reload({ waitUntil: 'load' });
    await page.click('#btn-fortsatt');
    check('slut: efter omladdning är samtalet fortfarande avslutat', await page.isVisible('#avslutat') && !(await page.isVisible('#skriv')));
    await page.click('#btn-stang');
    check('slut: stäng visar tacksidan och glömmer samtalet', await page.isVisible('#klart') && (await page.evaluate(() => localStorage.getItem('opengym_intervju_samtal_v1'))) === null);
    await ctx.close();
  }

  // ---------- Mobil, och slutkoder ----------
  {
    const { ctx, page } = await newPage({ width: 375, height: 740 });
    await page.goto(BASE + '?api=' + MOCK, { waitUntil: 'load' });
    scenario.push(svar('Hej. Berätta om en vanlig tisdag.'));
    await page.click('#btn-start');
    await vantaPaSvar(page, 1);
    check('mobil: ingen sidledes rullning', (await overflow(page)) === 0);
    await page.screenshot({ path: `${OUT}/intervju-mobil.png`, fullPage: true });
    scenario.push({ status: 400, json: { ok: false, fel: 'for_manga_turer' } });
    await page.fill('#text', 'En till.');
    await page.click('#btn-skicka');
    await page.waitForSelector('#fel:not([hidden])');
    check('för många turer: skicka stängs', await page.isDisabled('#btn-skicka') && (await page.textContent('#fel')).includes('så långt det kan bli'));
    await ctx.close();
  }

  await browser.close();
  server.close();
  console.log('\nanrop till låtsasservern:', anrop.length);
  console.log('console errors:', errors.length ? errors : 'none');
  if (errors.length) process.exit(1);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
