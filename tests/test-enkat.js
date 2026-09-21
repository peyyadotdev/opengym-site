// End-to-end-test av enkäten i Chromium mot en mockad Apps Script-endpoint.
// Körs med: npm install && npx playwright install chromium && node tests/test-enkat.js
// Startar en egen statisk server för repots rot, så ingen annan server behövs.
const { chromium } = require('playwright');
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'screenshots');
const ENDPOINT_PREFIX = 'https://script.google.com/macros/s/';
// Samma fall som i repot opengym, testade mot sidans kopia av typkundsregeln.
const FALL = JSON.parse(fs.readFileSync(path.join(__dirname, 'fall-typkund.json'), 'utf8'));
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

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve();
  const URL = `http://127.0.0.1:${server.address().port}/enkat/`;
  const browser = await chromium.launch();
  const posts = [];
  const errors = [];

  async function newPage(viewport) {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error' && !/net::ERR_/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    await page.route(u => String(u.href || u).startsWith(ENDPOINT_PREFIX), route => {
      const req = route.request();
      posts.push({ method: req.method(), body: Object.fromEntries(new URLSearchParams(req.postData() || '')) });
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });
    return { ctx, page };
  }
  const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const check = (name, cond) => { assert.ok(cond, name); console.log('  ok', name); };
  const lastPost = () => posts[posts.length - 1];
  const answersOf = p => JSON.parse(p.body.answers);
  // Sätter intervjuflaggan i enkätsidan för ett test, oavsett vad den står på i källan.
  async function intervjuFlagga(page, oppen) {
    const lage = { satt: false };
    await page.route(u => u.pathname === '/enkat/', async route => {
      const r = await route.fetch();
      const body = (await r.text()).replace(/const INTERVJU_OPPEN = (true|false);/, `const INTERVJU_OPPEN = ${oppen};`);
      lage.satt = body.includes(`const INTERVJU_OPPEN = ${oppen};`);
      await route.fulfill({ response: r, body });
    });
    return lage;
  }

  // ---------- Källkod: copyregler ----------
  {
    const raw = fs.readFileSync(path.join(ROOT, 'enkat', 'index.html'), 'utf8');
    // Copy = textnoder i HTML plus strängliteraler i skriptet (frågorna ligger där). Kod och attribut räknas inte.
    const scripts = [...raw.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
    const literals = [...scripts.matchAll(/'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)].map(m => m[1] || m[2] || '').join('\n');
    const textNodes = raw.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
    const src = (textNodes + '\n' + literals).replace(/q\d\d[a-z]?_[a-z0-9]+/g, '');   // kolumnkoder som q23_retention är inte copy
    check('enkäten: titeln är en fråga', /Hur driver du din box 2026\?/.test(raw));
    check('enkäten: ordet "hen/hens" förekommer inte', !/\bhens?\b/i.test(src));
    const banned = ['affärssystem', 'retention', '(?<![-\\w:])leads?(?![-\\w:])', '(?<![-\\w:])data(?![-\\w:])', 'systemlicens', 'plattform', 'träningslager', 'migrering'];
    const hits = banned.filter(w => new RegExp(w, 'i').test(src));
    check('enkäten: ingen systemjargong i copyn' + (hits.length ? ' (träffar: ' + hits.join(', ') + ')' : ''), hits.length === 0);
    check('enkäten: inga skogsgröna färger kvar', !/#22a447|#14732f/i.test(raw));
    check('enkäten: intervjuflaggan finns', /const INTERVJU_OPPEN = (true|false);/.test(raw));
    const typkundKod = raw.slice(raw.indexOf('// TYPKUND START'), raw.indexOf('// TYPKUND SLUT'));
    const sb = {};
    vm.runInNewContext(typkundKod + '\nthis.arTypkund = arTypkund;', sb);
    for (const f of FALL.fall) check(`enkäten: typkund, ${f.namn}`, sb.arTypkund({ ...FALL.bas, ...f.andringar }) === f.typkund);
    check('enkäten: og:image och twitter:image pekar på delningsbilden', /<meta property="og:image" content="https:\/\/opengym.se\/assets\/og\/enkat.png"/.test(raw) && /<meta name="twitter:image" content="https:\/\/opengym.se\/assets\/og\/enkat.png"/.test(raw));
    const png = fs.readFileSync(path.join(ROOT, 'assets', 'og', 'enkat.png'));
    check('enkäten: delningsbilden är en 1200 × 630 png under 300 kB', png.toString('latin1', 1, 4) === 'PNG' && png.readUInt32BE(16) === 1200 && png.readUInt32BE(20) === 630 && png.length < 300 * 1024);
  }

  // ---------- Flöde A: hela enkäten på desktop ----------
  {
    const { ctx, page } = await newPage({ width: 1280, height: 900 });
    const flaggaA = await intervjuFlagga(page, false);
    await page.goto(URL, { waitUntil: 'networkidle' });
    check('intro visas med startknapp', await page.isVisible('#btn-start'));
    await page.screenshot({ path: `${OUT}/enkat-intro.png` });

    await page.click('#btn-start');
    check('steg 1 visas', (await page.textContent('#step-title')).trim() === 'Din box');
    await page.click('#btn-next');
    const errCount = await page.locator('.q.has-error').count();
    check('tom del 1 ger fel på fem obligatoriska frågor', errCount === 5);
    check('inget POST vid valideringsfel', posts.length === 0);

    await page.selectOption('#q01_lan', 'Skåne');
    await page.check('input[name="q02_typ"][value="CrossFit-affiliate"]');
    await page.check('input[name="q02_typ"][value="Annat"]');
    check('Annat-fält dyker upp', await page.isVisible('#q02_annat'));
    await page.fill('#q02_annat', 'Bootcamp');
    await page.check('input[name="q03_medlemmar"][value="80–150"]');
    await page.check('input[name="q04_anlaggningar"][value="1"]');
    await page.check('input[name="q05_coacher"][value="Jag själv plus deltidscoacher"]');
    await page.click('#btn-next');
    await page.waitForFunction(() => document.getElementById('step-title').textContent.trim() === 'System i dag');
    await page.waitForFunction(() => /Sparat/.test(document.getElementById('save-status').textContent));
    check('POST efter del 1', posts.length === 1 && lastPost().body.action === 'survey' && lastPost().body.step === '1' && lastPost().body.completed === '0');
    let a = answersOf(lastPost());
    check('svaren i del 1 med i POST', a.q01_lan === 'Skåne' && a.q02_typ.join('|') === 'CrossFit-affiliate|Annat' && a.q02_annat === 'Bootcamp' && a.q03_medlemmar === '80–150');
    check('dolda frågor skickas tomma', a.q11_utebliven === '' && a.q17b_storst === '');
    check('rid ser ut som ett id', /^[A-Za-z0-9_-]{8,64}$/.test(lastPost().body.rid));
    const rid = lastPost().body.rid;

    // Del 2
    await page.check('input[name="q06_system"][value="Zoezi"]');
    await page.check('input[name="q07_logg"][value="SugarWOD"]');
    await page.fill('#q09_irriterande', 'Autogirofiler till banken varje månad.');
    await page.click('#btn-next');
    await page.waitForFunction(() => document.getElementById('step-title').textContent.trim() === 'Medlemskap och hur ni tränar');

    // Del 3: hopplogik och procentsumma
    check('q11 dold innan modell valts', !(await page.isVisible('#q-q11_utebliven')));
    await page.check('input[name="q10_modell"][value="Både och"]');
    check('q11 och q12 visas vid fasta grupper', await page.isVisible('#q-q11_utebliven') && await page.isVisible('#q-q12_fungerat'));
    await page.check('input[name="q11_utebliven"][value="Vi hör av oss"]');
    await page.check('input[name="q13_pris"][value="900–1 100 kr"]');
    await page.fill('#q15_3plus', '60'); await page.fill('#q15_1till2', '30'); await page.fill('#q15_sallan', '30');
    check('summan uppdateras live', (await page.textContent('#sum-q15')).includes('120'));
    await page.check('input[name="q16_opengym"][value="Ja, obemannat"]');
    await page.click('#btn-next');
    check('procentfel visas', (await page.textContent('#err-q15')).includes('120'));
    await page.fill('#q15_sallan', '10');
    await page.screenshot({ path: `${OUT}/enkat-del3.png`, fullPage: true });
    await page.click('#btn-next');
    await page.waitForFunction(() => document.getElementById('step-title').textContent.trim() === 'Betalningar');
    a = answersOf(lastPost());
    check('procent och fasta grupper med i POST', a.q15_3plus === '60' && a.q15_sallan === '10' && a.q11_utebliven.join() === 'Vi hör av oss');

    // Del 4: dynamiska alternativ
    check('q17b dold innan två betalsätt', !(await page.isVisible('#q-q17b_storst')));
    await page.check('input[name="q17_betalsatt"][value="Autogiro via banken"]');
    check('q17b dold med ett betalsätt', !(await page.isVisible('#q-q17b_storst')));
    await page.check('input[name="q17_betalsatt"][value="Swish"]');
    check('q17b visas med två betalsätt', await page.isVisible('#q-q17b_storst'));
    const q17bOpts = await page.$$eval('input[name="q17b_storst"]', els => els.map(e => e.value));
    check('q17b har bara de valda betalsätten', q17bOpts.join('|') === 'Autogiro via banken|Swish');
    await page.check('input[name="q17b_storst"][value="Swish"]');
    await page.check('input[name="q19_swish"][value="Ja"]');
    await page.check('input[name="q20_omregistrering"][value="70–90 %"]');
    await page.click('#btn-next');
    await page.waitForFunction(() => document.getElementById('step-title').textContent.trim() === 'Dörren och driften');

    // Del 5
    await page.check('input[name="q21_dorr"][value="Parakey"]');
    await page.click('#btn-next');
    await page.waitForFunction(() => document.getElementById('step-title').textContent.trim() === 'Medlemmar som stannar, och coacher');

    // Del 6: matris
    await page.check('input[name="q23_retention"][value="Vet inte"]');
    await page.check('input[name="q24_avhopp"][value="Coachen ser det på golvet"]');
    await page.check('input[name="q26_pass"][value="Kanske"]');
    await page.screenshot({ path: `${OUT}/enkat-del6.png`, fullPage: true });
    await page.click('#btn-next');
    await page.waitForFunction(() => document.getElementById('step-title').textContent.trim() === 'Byta system');

    // Del 7: max tre, kontaktfält, inskick
    const q27 = ['Lägre kostnad', 'Svensk support', 'Swish återkommande', 'Bättre app för medlemmarna'];
    for (const v of q27) await page.check(`input[name="q27_byta"][value="${v}"]`).catch(() => {});
    const q27Checked = await page.$$eval('input[name="q27_byta"]:checked', els => els.length);
    check('q27 stannar på högst tre', q27Checked === 3);
    check('fjärde alternativet är avstängt', await page.$eval('input[name="q27_byta"][value="Bättre app för medlemmarna"]', e => e.disabled));
    await page.check('input[name="q28_gratis"][value="Lika"]');
    check('pilotkontakt dold innan ja', !(await page.isVisible('#q-contact_pilot')));
    await page.check('input[name="q29_pilot"][value="Ja"]');
    check('pilotkontakt visas vid ja', await page.isVisible('#c_pilot_email'));
    await page.fill('#c_pilot_email', 'inte-en-adress');
    await page.click('#btn-next');
    check('ogiltig e-post stoppar inskick', (await page.textContent('#err-contact_pilot')).includes('giltig') && !lastPost().body.completed.includes('1'));
    await page.fill('#c_pilot_email', 'Anna@Boxen.se');
    await page.fill('#c_pilot_box', 'CrossFit Testet');
    await page.check('input[name="q30_rapport"][value="Ja, skicka till min e-post"]');
    check('rapport-e-post förifylld från pilot', (await page.inputValue('#c_report_email')) === 'Anna@Boxen.se');
    check('samtyckestext på sista delen', (await page.textContent('.consent')).includes('separat'));
    check('knappen heter Skicka svaren', (await page.textContent('#btn-next')).trim() === 'Skicka svaren');
    await page.screenshot({ path: `${OUT}/enkat-del7.png`, fullPage: true });
    await page.click('#btn-next');
    await page.waitForSelector('#done:not([hidden])');
    const fin = lastPost();
    check('sista POST är completed=1 med samma rid', fin.body.completed === '1' && fin.body.rid === rid && fin.body.step === '7');
    check('e-post skickas separat, inte i svaren', fin.body.pilot_email === 'Anna@Boxen.se' && fin.body.pilot_box === 'CrossFit Testet' && fin.body.report_email === 'Anna@Boxen.se' && !fin.body.answers.includes('@'));
    a = answersOf(fin);
    check('matris, max tre och tid med', a.q26_pass === 'Kanske' && a.q26_grupp === '' && a.q27_byta.length === 3 && Number(fin.body.duration_sec) >= 0);
    check('q17b explicit när två valda', a.q17b_storst === 'Swish');
    check('tacksidan listar rapport och pilot', (await page.textContent('#done-list')).includes('Boxrapporten') && (await page.textContent('#done-list')).includes('piloten'));
    check('stängd intervju: inget erbjudande på tacksidan', flaggaA.satt && !(await page.isVisible('#intervju-erbjudande')));
    check('stängd intervju: inga svar lämnas över', (await page.evaluate(() => localStorage.getItem('opengym_intervju_underlag_v1'))) === null);
    await page.screenshot({ path: `${OUT}/enkat-klar.png` });

    await page.reload({ waitUntil: 'networkidle' });
    check('efter inskick visar intro "svara igen"', await page.isVisible('#btn-again') && (await page.textContent('#intro-actions')).includes('skickade in'));
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('opengym_enkat_v1')));
    check('lagrat tillstånd efter inskick saknar svar', stored && stored.completedAt && !stored.answers);
    await ctx.close();
  }

  // ---------- Flöde B: mobil, paus och återupptagning, overflow ----------
  {
    const { ctx, page } = await newPage({ width: 390, height: 844 });
    await page.goto(URL, { waitUntil: 'networkidle' });
    check('mobil intro utan overflow', (await overflow(page)) === 0);
    await page.click('#btn-start');
    await page.selectOption('#q01_lan', 'Stockholm');
    await page.check('input[name="q02_typ"][value="HYROX-träningsklubb"]');
    await page.check('input[name="q03_medlemmar"][value="Under 80"]');
    await page.check('input[name="q04_anlaggningar"][value="2–3"]');
    await page.check('input[name="q05_coacher"][value="Anställda coacher"]');
    check('mobil del 1 utan overflow', (await overflow(page)) === 0);
    await page.screenshot({ path: `${OUT}/enkat-mobil-del1.png`, fullPage: true });
    await page.click('#btn-next');
    await page.waitForFunction(() => document.getElementById('step-title').textContent.trim() === 'System i dag');
    await page.fill('#q09_irriterande', 'halvvägs');
    await page.waitForTimeout(250);

    await page.reload({ waitUntil: 'networkidle' });
    check('intro erbjuder fortsätt efter paus', await page.isVisible('#btn-resume') && (await page.textContent('#intro-actions')).includes('1 av 7'));
    await page.click('#btn-resume');
    check('återupptar på del 2', (await page.textContent('#step-title')).trim() === 'System i dag');
    check('text i del 2 finns kvar', (await page.inputValue('#q09_irriterande')) === 'halvvägs');
    await page.click('#btn-back');
    check('tillbaka till del 1 med värden kvar', (await page.inputValue('#q01_lan')) === 'Stockholm' && await page.isChecked('input[name="q02_typ"][value="HYROX-träningsklubb"]'));

    // Hoppa till del 6 och 7 via lagrat tillstånd för att kontrollera layout på mobil
    for (const [idx, extra] of [[5, {}], [6, { q29_pilot: 'Ja', q30_rapport: 'Ja, skicka till min e-post' }]]) {
      await page.goto(URL, { waitUntil: 'networkidle' }); // intro: inget tillstånd i minnet som kan skriva över
      await page.evaluate(([i, ex]) => {
        const s = JSON.parse(localStorage.getItem('opengym_enkat_v1'));
        s.step = i; s.maxStep = i; Object.assign(s.answers, ex);
        localStorage.setItem('opengym_enkat_v1', JSON.stringify(s));
      }, [idx, extra]);
      await page.reload({ waitUntil: 'networkidle' });
      await page.click('#btn-resume');
      const title = (await page.textContent('#step-title')).trim();
      check(`mobil del ${idx + 1} (${title}) utan overflow`, (await overflow(page)) === 0);
      await page.screenshot({ path: `${OUT}/enkat-mobil-del${idx + 1}.png`, fullPage: true });
    }
    await ctx.close();
  }

  // ---------- Flöde C: erbjudandet om samtal, med intervjun öppen ----------
  for (const [namn, andring, vantat] of [['typkund', {}, true], ['inte typkund', { q03_medlemmar: 'Under 80' }, false]]) {
    const { ctx, page } = await newPage({ width: 1280, height: 900 });
    const flagga = await intervjuFlagga(page, true);
    await page.goto(URL, { waitUntil: 'networkidle' });
    const rid = 'test-rid-' + namn.replace(/ /g, '-');
    const svar = { ...FALL.bas, ...andring, q29_pilot: 'Nej', q30_rapport: 'Nej tack' };
    await page.evaluate(([r, a]) => localStorage.setItem('opengym_enkat_v1', JSON.stringify({ v: 1, rid: r, startedAt: new Date().toISOString(), step: 6, maxStep: 6, answers: a, contact: {}, source: 'test', completedAt: null })), [rid, svar]);
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('#btn-resume');
    await page.click('#btn-next');
    await page.waitForSelector('#done:not([hidden])');
    check(`öppen intervju, ${namn}: sidan kördes med intervjun öppen`, flagga.satt);
    check(`öppen intervju, ${namn}: erbjudandet ${vantat ? 'visas' : 'visas inte'}`, (await page.isVisible('#intervju-erbjudande')) === vantat);
    const lamnat = await page.evaluate(() => JSON.parse(localStorage.getItem('opengym_intervju_underlag_v1')));
    if (vantat) {
      check('öppen intervju, typkund: svaren lämnas över med svars-id', lamnat && lamnat.rid === rid && lamnat.svar.q03_medlemmar === '150–250' && lamnat.svar.q09_irriterande === FALL.bas.q09_irriterande);
      check('öppen intervju, typkund: inga kontaktfält och ingen e-post lämnas över', !Object.keys(lamnat.svar).some(k => k.startsWith('c_') || k.endsWith('_email')) && !JSON.stringify(lamnat).includes('@'));
      check('öppen intervju, typkund: länken går till intervjun', (await page.getAttribute('#intervju-lank', 'href')) === '/intervju/');
      await page.screenshot({ path: `${OUT}/enkat-klar-erbjudande.png`, fullPage: true });
    } else {
      check('öppen intervju, inte typkund: inga svar lämnas över', lamnat === null);
    }
    await ctx.close();
  }

  await browser.close();
  server.close();
  console.log('\nPOSTs captured:', posts.length);
  console.log('console errors:', errors.length ? errors : 'none');
  if (errors.length) process.exit(1);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
