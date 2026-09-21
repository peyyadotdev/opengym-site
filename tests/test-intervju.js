// End-to-end-test av intervjusidan i Chromium mot en låtsad /intervju-tur och /intervju-block.
// Körs med: npm install && npx playwright install chromium && node tests/test-intervju.js
// Servern ligger i repot opengym. Här testas bara sidan, mot protokollet i
// opengym/docs/undersokning/intervjusidan-protokoll.md. Låtsasservern kontrollerar också att
// sidans anrop följer protokollet, och varje avvikelse fäller testet på slutet.
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
const MOCK_BLOCK = '/mock/intervju-block';   // sidan byter intervju-tur mot intervju-block i adressen
const UNDERLAG = { v: 1, rid: RID, svar: FALL.bas, skapad: '2026-09-21T10:00:00.000Z' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Samtyckestexten ur byggplanen, ordagrant. Daniels att ändra, och då här också.
const SAMTYCKE = [
  'Säger du ja sparas det du bekräftar på korten, ämnen du vill ta upp i slutet och svaret om pilotgym, ihop med dina enkätsvar. Det sparas i OpenGyms databas i EU, sammanställs anonymt till Boxrapporten 2026 och raderas senast den 30 juni 2027. Ditt namn och din e-post behövs inte, och assistenten skriver aldrig in namn på medlemmar eller coacher. Samtalet behandlas av Claude från Anthropic i USA, som inte tränar sina modeller på det och raderar det inom 30 dagar. För att stoppa missbruk räknar servern anrop per dygn, med din nätverksadress som kontrollsumma. Vill du att vi tar bort det som sparats, mejla daniel@opengym.se med koden du får när samtalet är klart.',
  'Säger du nej kan du prata ändå, men ingenting sparas.',
];

// Korten i protokollets form. Värdena är protokollets exempel och inget mer.
const KORT_PENGAR = {
  typ: 'kort', id: 'toolu_01A', block: 'pengarna', rubrik: 'Pengarna',
  rader: [
    { etikett: 'Betalsätt', varde: ['Autogiro', 'Swish'], kalla: 'enkät' },
    { etikett: 'En avgift på betalningarna i stället för licens', varde: 'Negativ', kalla: 'samtal' },
  ],
  varden: { betalsatt: ['autogiro', 'swish'], nuvarande_system: 'Zoezi' },
  kallor: { betalsatt: 'enkät', nuvarande_system: 'enkät' },
};
const VALKORT = { typ: 'kort', id: 'toolu_01B', block: 'pilot', rubrik: 'Pilotgym', val: [{ nyckel: 'ja', etikett: 'Ja' }, { nyckel: 'nej', etikett: 'Nej' }] };
const PARKERAT = { typ: 'parkerat', nummer: 1, amne: 'Coachernas scheman', vad_personen_sa: 'Schemat för coacherna är ett eget kapitel.' };
const kopia = (kort, andring) => Object.assign(JSON.parse(JSON.stringify(kort)), andring);
// Ägarens meddelande i historiken när ett kort besvarats: en lista med block, som sidan skickar tillbaka orörd.
const kortsvarBlock = (id, innehall) => [{ type: 'tool_result', tool_use_id: id, content: innehall }];

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

// Svar i serverns form: textdelar och sist klar med meddelandena som läggs i historiken.
// Ett parkerat ämne kommer mitt i texten. Parkerade assistenten innan den skrev sitt svar ger det
// två meddelanden till i klar. Med parkeratSist slutar i stället assistentens sista meddelande med
// parkeringen, och då kommer inget kort. Ett kort kommer efter klar, och assistentens sista
// meddelande slutar då med kortets block. Tom text ger inga textdelar.
function svar(text, fraga = '(start)', { kort = null, parkerat = [], parkeratSist = false, slut = false } = {}) {
  const delar = text ? text.split(/(?<= )/).map(delta => ({ typ: 'text', delta })) : [];
  const handelser = [...delar.slice(0, 1), ...parkerat, ...delar.slice(1)];
  const tillagg = [{ role: 'user', content: fraga }];
  const parkering = p => ({ type: 'tool_use', id: 'toolu_p' + p.nummer, name: 'parkera', input: {} });
  if (!parkeratSist) parkerat.forEach(p => tillagg.push(
    { role: 'assistant', content: [parkering(p)] },
    { role: 'user', content: kortsvarBlock('toolu_p' + p.nummer, 'ok') },
  ));
  const sista = [{ type: 'thinking', thinking: '', signature: 'sig-' + text.length }];
  if (text) sista.push({ type: 'text', text });
  if (parkeratSist) parkerat.forEach(p => sista.push(parkering(p)));
  if (kort) sista.push({ type: 'tool_use', id: kort.id, name: 'kort', input: {} });
  tillagg.push({ role: 'assistant', content: sista });
  handelser.push({ typ: 'klar', tillagg });
  if (kort) handelser.push(kort);
  if (slut) handelser.push({ typ: 'slut' });
  return { handelser };
}

// Låtsasserverns kontroll av protokollet. Varje avvikelse hamnar i brott.
const brott = [];
function kollaTur(b) {
  const fel = [];
  if (!b || typeof b !== 'object' || !Array.isArray(b.historik)) { brott.push('tur: kroppen har fel form'); return; }
  if (typeof b.samtycke !== 'boolean') fel.push('samtycke saknas');
  if ((b.start === true) !== (b.historik.length === 0)) fel.push('start stämmer inte med historiken');
  const sista = b.historik[b.historik.length - 1];
  const kortBlock = sista && sista.role === 'assistant' && Array.isArray(sista.content) ? sista.content.find(x => x && x.type === 'tool_use' && x.name === 'kort') : null;
  if (kortBlock) {
    const k = b.kortsvar;
    if (!k || k.id !== kortBlock.id) fel.push('kortsvar saknas eller har fel id');
    else if (['stammer', 'rattning', 'val'].filter(x => x in k).length !== 1) fel.push('kortsvar ska ha exakt ett svar');
    else if ('stammer' in k && k.stammer !== true) fel.push('stammer ska vara true');
    else if ('rattning' in k && (typeof k.rattning !== 'string' || !k.rattning || k.rattning !== k.rattning.trim())) fel.push('rättningen är tom eller oputsad');
    if (b.text !== null) fel.push('text ska vara null med kortsvar');
  } else {
    if ('kortsvar' in b) fel.push('kortsvar utan väntande kort');
    if (!b.start && (typeof b.text !== 'string' || !b.text)) fel.push('tom tur');
  }
  fel.forEach(f => brott.push('tur: ' + f));
}
function kollaBlock(b) {
  const fel = [];
  const obj = x => x && typeof x === 'object' && !Array.isArray(x);
  if (!obj(b)) { brott.push('block: kroppen har fel form'); return; }
  if (!b.underlag || b.underlag.rid !== RID || !obj(b.underlag.svar)) fel.push('underlag saknas');
  if (!UUID.test(String(b.samtal))) fel.push('samtal är inget uuid');
  if (b.samtycke !== true) fel.push('sparande utan samtycke');
  if (b.typ === 'block') {
    if (typeof b.block !== 'string' || !obj(b.varden) || !obj(b.kallor) || 'sidospar' in b) fel.push('block har fel form');
  } else if (b.typ === 'sidospar') {
    const s = b.sidospar;
    if (!obj(s) || typeof s.nummer !== 'number' || typeof s.amne !== 'string' || typeof s.vad_personen_sa !== 'string' || 'block' in b || 'typ' in s) fel.push('sidospar har fel form');
  } else fel.push('okänd typ');
  fel.forEach(f => brott.push('block: ' + f));
}
const vantaTills = async (villkor, ms = 5000) => {
  const t0 = Date.now();
  while (!villkor()) { if (Date.now() - t0 > ms) throw new Error('väntade för länge'); await new Promise(r => setTimeout(r, 20)); }
};

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
    check('källa: ingen innerHTML alls, allt byggs med createElement och textContent', !/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(scripts));
    const style = (raw.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
    check('källa: inga skuggor utom fältets inre fokusram', [...style.matchAll(/box-shadow:\s*([^;}]+)/g)].every(m => /^inset\b/.test(m[1].trim())));
    const limeBruk = [...style.matchAll(/([\w-]+):\s*var\(--accent\)/g)].map(m => m[1]);
    check('källa: neon-lime bara som fyllning', limeBruk.length > 0 && limeBruk.every(p => p === 'background'));
    check('källa: pilen → är den enda pilglyfen', !/[←↑↓↔⇒⇐➔➜➝➞]|->/.test(src));
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
  const anrop = [];          // kropparna till /intervju-tur
  const scenario = [];       // nästa svar från /intervju-tur
  const blockAnrop = [];     // kropparna till /intervju-block
  const blockScenario = [];  // nästa svar från /intervju-block, annars sparat enligt samtycket
  const ordning = [];        // vilken väg som anropades, i tur och ordning

  async function newPage(viewport, { underlag = UNDERLAG, samtal = null } = {}) {
    // Minskad rörelse, som sidan stöder, så att skärmbilderna inte fångar en knapp mitt i en övergång.
    const ctx = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    await ctx.route(/posthog\.com/, r => r.abort());
    if (underlag) await ctx.addInitScript(u => localStorage.setItem('opengym_intervju_underlag_v1', JSON.stringify(u)), underlag);
    // Ett sparat samtal läggs bara in första gången, så att sidans egna ändringar överlever en omladdning.
    if (samtal) await ctx.addInitScript(s => { if (!sessionStorage.getItem('lagt')) { localStorage.setItem('opengym_intervju_samtal_v1', JSON.stringify(s)); sessionStorage.setItem('lagt', '1'); } }, samtal);
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error' && !/net::ERR_|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    await page.route(u => new URL(String(u.href || u)).pathname === MOCK, route => {
      const req = route.request();
      const kropp = JSON.parse(req.postData() || 'null');
      anrop.push(kropp);
      ordning.push('tur');
      kollaTur(kropp);
      const nasta = scenario.shift() || { handelser: [{ typ: 'fel', kod: 'tekniskt' }] };
      if (nasta.status) return route.fulfill({ status: nasta.status, contentType: 'application/json', body: JSON.stringify(nasta.json) });
      return route.fulfill({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: nasta.handelser.map(h => `data: ${JSON.stringify(h)}\n\n`).join('') });
    });
    await page.route(u => new URL(String(u.href || u)).pathname === MOCK_BLOCK, route => {
      const kropp = JSON.parse(route.request().postData() || 'null');
      blockAnrop.push(kropp);
      ordning.push('block');
      kollaBlock(kropp);
      const nasta = blockScenario.shift() || { status: 200, json: { ok: true, sparat: !!kropp && kropp.samtycke === true } };
      return route.fulfill({ status: nasta.status, contentType: 'application/json', body: JSON.stringify(nasta.json) });
    });
    return { ctx, page };
  }
  const turer = page => page.$$eval('#logg .tur', els => els.map(e => ({ vem: e.classList.contains('tur-ai') ? 'ai' : 'du', text: e.querySelector('.tur-text').textContent })));
  // Allt i loggen i ordning, för att jämföra före och efter en omladdning.
  const loggen = page => page.$$eval('#logg > *', els => els.map(e => e.className + ' | ' + e.textContent + ' | ' + e.querySelectorAll('button:not([disabled])').length));
  // Klart när assistentens tur finns och fältet går att skriva i igen, alltså när hela svaret kommit.
  const vantaPaSvar = (page, n) => page.waitForFunction(k => document.querySelectorAll('#logg .tur-ai').length === k && !document.getElementById('text').disabled, n);
  // Samma sak för ett svar som slutar med ett kort, och kanske saknar text.
  const vantaPaKort = (page, n) => page.waitForFunction(k => document.querySelectorAll('#logg .kort').length === k && !document.getElementById('text').disabled, n);
  const sparat = page => page.evaluate(() => JSON.parse(localStorage.getItem('opengym_intervju_samtal_v1') || 'null'));
  const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  // PostHog laddas aldrig i testet, så händelserna ligger kvar i sidans kö.
  const matt = page => page.evaluate(() => phQueue.map(([namn, egenskaper]) => ({ namn, egenskaper })));
  // Bara namn och räknare: varje egenskap är ett tal eller en kort kod, aldrig text ur samtalet.
  const baraKoder = h => h.every(x => Object.values(x.egenskaper).every(v => typeof v === 'number' || /^[a-z_]{1,24}$/.test(v)));

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
    check('intro med startknapparna', await page.isVisible('#btn-ja') && await page.isVisible('#btn-nej') && !(await page.isVisible('#btn-fortsatt')));
    check('intro: knapparna heter som i planen', (await page.textContent('#btn-ja')) === 'Starta och spara det jag bekräftar' && (await page.textContent('#btn-nej')) === 'Starta utan att spara'
      && await page.$eval('#btn-ja', b => b.className === 'btn-primary') && await page.$eval('#btn-nej', b => b.className === 'btn-ghost'));
    check('intro: samtyckestexten står ordagrant som i planen', JSON.stringify(await page.$$eval('#samtycke p', ps => ps.map(p => p.textContent))) === JSON.stringify(SAMTYCKE));
    check('intro: punkt 03 säger att du bestämmer', (await page.textContent('.facts li:nth-child(3) div')) === 'Du bestämmer om något sparas. Utan ja sparas ingenting.');
    check('intro: ingen rad om provversion kvar', !/provversion/i.test(await page.textContent('body')));
    await page.screenshot({ path: `${OUT}/intervju-intro.png`, fullPage: true });

    scenario.push(svar('Hej. Jag är OpenGyms AI-assistent. Du svarade att det mest irriterande är autogirot. Berätta om senaste gången.'));
    await page.click('#btn-ja');
    await vantaPaSvar(page, 1);
    const f = anrop[0];
    check('start: skickar start, ingen text och tom historik', f.start === true && f.text === null && Array.isArray(f.historik) && f.historik.length === 0);
    check('samtycke ja: samtycke true i första anropet', f.samtycke === true);
    const s1 = await sparat(page);
    check('tillstånd: v 2 med samtal, samtycke, historik och visning', s1.v === 2 && s1.rid === RID && UUID.test(s1.samtal) && s1.samtycke === true && s1.historik.length === 2 && s1.slut === false
      && JSON.stringify(s1.visning) === JSON.stringify([{ vem: 'ai', text: 'Hej. Jag är OpenGyms AI-assistent. Du svarade att det mest irriterande är autogirot. Berätta om senaste gången.' }]));
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
    check('samtycke ja: samtycke true i varje anrop', anrop.slice(0, 5).every(a => a.samtycke === true));
    const s2 = await sparat(page);
    check('tillstånd: samma samtal genom hela samtalet', s2.samtal === s1.samtal);
    await page.screenshot({ path: `${OUT}/intervju-samtal.png`, fullPage: true });

    const fore = await turer(page);
    await page.reload({ waitUntil: 'load' });
    check('efter omladdning: fortsätt eller börja om', await page.isVisible('#btn-fortsatt') && await page.isVisible('#btn-omstart'));
    check('efter omladdning: samtycket frågas inte igen', !(await page.isVisible('#btn-ja')) && !(await page.isVisible('#samtycke')));
    await page.click('#btn-fortsatt');
    check('fortsätt: samtalet ritas upp igen', JSON.stringify((await turer(page)).map(t => t.vem)) === '["ai","du","ai","du","ai"]');
    check('fortsätt: samma turer med samma text', JSON.stringify(await turer(page)) === JSON.stringify(fore));
    scenario.push(svar('Noterat.', 'En sak till.'));
    await page.fill('#text', 'En sak till.');
    await page.click('#btn-skicka');
    await vantaPaSvar(page, 4);
    check('fortsätt: samtycket följer med efter omladdningen', anrop[5].samtycke === true && anrop[5].historik.length === 6);

    await page.click('#btn-avsluta');
    check('avsluta: tacksidan visas', await page.isVisible('#klart'));
    check('avsluta: samtalet glöms i webbläsaren', (await page.evaluate(() => localStorage.getItem('opengym_intervju_samtal_v1'))) === null);
    await ctx.close();
  }

  // ---------- Samtycket nej, sparat v 1, och börja om ----------
  {
    const { ctx, page } = await newPage({ width: 1280, height: 900 });
    await page.goto(BASE + '?api=' + MOCK, { waitUntil: 'load' });
    const t0 = anrop.length;
    scenario.push(svar('Hej. Berätta om en vanlig tisdag.'));
    await page.click('#btn-nej');
    await vantaPaSvar(page, 1);
    scenario.push(svar('Och på kvällen?', 'Morgonpass och lunch.'));
    await page.fill('#text', 'Morgonpass och lunch.');
    await page.click('#btn-skicka');
    await vantaPaSvar(page, 2);
    check('samtycke nej: samtycke false i varje anrop', anrop.length === t0 + 2 && anrop.slice(t0).every(a => a.samtycke === false));
    check('samtycke nej: sparas som false', (await sparat(page)).samtycke === false);
    await page.click('#btn-avsluta');
    check('klart utan samtycke: ingenting sparades och ingen kod', (await page.textContent('#klart .lede:not([hidden])')) === 'Ingenting sparades.' && !(await page.isVisible('#klart-kod')));
    await ctx.close();

    // Ett samtal sparat av steg 1 saknar samtal-id och samtycke, och sidan börjar om.
    const v1 = { v: 1, rid: RID, historik: svar('Hej.').handelser.pop().tillagg, slut: false };
    const gammal = await newPage({ width: 1280, height: 900 }, { samtal: v1 });
    await gammal.page.goto(BASE + '?api=' + MOCK, { waitUntil: 'load' });
    check('sparad v 1: räknas som inget påbörjat samtal', await gammal.page.isVisible('#btn-ja') && !(await gammal.page.isVisible('#btn-fortsatt')));
    const t1 = anrop.length;
    scenario.push(svar('Hej. Nytt samtal.'));
    await gammal.page.click('#btn-ja');
    await vantaPaSvar(gammal.page, 1);
    check('sparad v 1: det nya samtalet startar från början', anrop[t1].start === true && anrop[t1].historik.length === 0 && (await sparat(gammal.page)).v === 2);
    await gammal.ctx.close();

    // Börja om frågar om samtycket igen.
    const v2 = { v: 2, rid: RID, samtal: '9b1e4c2a-1111-4222-8333-444455556666', samtycke: true, historik: svar('Hej.').handelser.pop().tillagg, visning: [{ vem: 'ai', text: 'Hej.' }], slut: false };
    const om = await newPage({ width: 1280, height: 900 }, { samtal: v2 });
    await om.page.goto(BASE + '?api=' + MOCK, { waitUntil: 'load' });
    check('sparad v 2: fortsätt eller börja om', await om.page.isVisible('#btn-fortsatt'));
    await om.page.click('#btn-omstart');
    check('börja om: samtycket och båda knapparna visas igen', await om.page.isVisible('#samtycke') && await om.page.isVisible('#btn-ja') && await om.page.isVisible('#btn-nej') && !(await om.page.isVisible('#btn-fortsatt')));
    check('börja om: det gamla samtalet glöms', (await sparat(om.page)) === null);
    const t2 = anrop.length;
    scenario.push(svar('Hej igen.'));
    await om.page.click('#btn-nej');
    await vantaPaSvar(om.page, 1);
    const s = await sparat(om.page);
    check('börja om: nytt samtal-id och det nya valet', s.samtal !== v2.samtal && UUID.test(s.samtal) && s.samtycke === false && anrop[t2].samtycke === false);
    await om.ctx.close();
  }

  // ---------- Assistenten avslutar samtalet ----------
  {
    const { ctx, page } = await newPage({ width: 1280, height: 900 });
    await page.goto(BASE + '?api=' + MOCK, { waitUntil: 'load' });
    scenario.push(svar('Är det något mer du vill berätta?'));
    await page.click('#btn-ja');
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

  // ---------- Korten med samtycke ----------
  {
    const { ctx, page } = await newPage({ width: 1280, height: 900 });
    await page.goto(BASE + '?api=' + MOCK, { waitUntil: 'load' });
    const t0 = anrop.length, b0 = blockAnrop.length;
    // Kortet nummer i (från noll) av de som matchar sel.
    const kortet = (sel, i = 0) => page.$$eval(sel, (els, i) => { const el = els[i]; return {
      klass: el.className,
      rubrik: el.querySelector('.kort-rubrik').textContent,
      bock: !!el.querySelector('.kort-bock'),
      rader: [...el.querySelectorAll('.kort-rad')].map(r => ({
        etikett: r.querySelector('dt').textContent,
        taggar: [...r.querySelectorAll('.tag')].map(t => t.textContent),
        kalla: r.querySelector('.kalla') ? r.querySelector('.kalla').textContent : null,
        varde: r.querySelector('dd').textContent,
      })),
      knappar: [...el.querySelectorAll('button')].map(b => ({ text: b.textContent, klass: b.className, av: b.disabled })),
      fel: el.querySelector('.kort-fel').hidden ? null : el.querySelector('.kort-fel').textContent,
    }; }, i);

    scenario.push(svar('Hej. Så här har jag uppfattat pengarna. Stämmer det?', '(start)', { kort: KORT_PENGAR }));
    await page.click('#btn-ja');
    await vantaPaKort(page, 1);
    const k1 = await kortet('#logg .kort');
    check('kort: ritas efter assistentens tur', await page.$eval('#logg .kort', el => el.previousElementSibling && el.previousElementSibling.classList.contains('tur-ai')));
    check('kort: rubriken och en rad per post i rader', k1.rubrik === 'Pengarna' && k1.rader.length === 2 && k1.rader[0].etikett === 'Betalsätt' && k1.rader[1].etikett === 'En avgift på betalningarna i stället för licens');
    check('kort: listor visas som taggar, text som text', JSON.stringify(k1.rader[0].taggar) === '["Autogiro","Swish"]' && k1.rader[1].taggar.length === 0 && k1.rader[1].varde === 'Negativ');
    check('kort: värden ur enkäten har markeringen enkät, andra inte', k1.rader[0].kalla === 'enkät' && k1.rader[1].kalla === null);
    check('kort: Stämmer som primär och Ändra som ghost', JSON.stringify(k1.knappar.map(b => b.text + ':' + b.klass)) === '["Stämmer:btn-primary kort-stammer","Ändra:btn-ghost kort-andra"]');
    check('kort: platshållaren ber om ändringen medan kortet väntar', (await page.getAttribute('#text', 'placeholder')) === 'Skriv vad som ska ändras');
    check('kort: sparas i visning som väntande', JSON.stringify((await sparat(page)).visning.pop()) === JSON.stringify({ kort: Object.fromEntries(Object.entries(KORT_PENGAR).filter(([n]) => n !== 'typ')), status: 'vantar' }));
    await page.screenshot({ path: `${OUT}/intervju-kort.png`, fullPage: true });

    const fore = await loggen(page);
    await page.reload({ waitUntil: 'load' });
    await page.click('#btn-fortsatt');
    check('återupptaget: samma turer och kort, och kortet går att svara på', JSON.stringify(await loggen(page)) === JSON.stringify(fore) && (await page.$$('.kort-aktiv .kort-stammer')).length === 1);
    check('återupptaget: platshållaren ber fortfarande om ändringen', (await page.getAttribute('#text', 'placeholder')) === 'Skriv vad som ska ändras');

    // Sparandet misslyckas: felet på kortet, inget anrop till /intervju-tur, knapparna går att trycka igen.
    blockScenario.push({ status: 500, json: { ok: false, fel: 'tekniskt' } });
    await page.click('.kort-aktiv .kort-stammer');
    await page.waitForSelector('.kort-aktiv .kort-fel:not([hidden])');
    const kf = await kortet('.kort-aktiv');
    check('sparfel: "Kunde inte spara. Tryck igen." på kortet', kf.fel === 'Kunde inte spara. Tryck igen.' && !/kort-bekraftat/.test(kf.klass));
    check('sparfel: inget anrop till /intervju-tur', anrop.length === t0 + 1 && blockAnrop.length === b0 + 1);
    check('sparfel: knapparna och fältet går att använda igen', kf.knappar.every(b => !b.av) && !(await page.isDisabled('#text')));

    scenario.push(svar('Bra. Hur ofta byter medlemmarna betalsätt?', kortsvarBlock(KORT_PENGAR.id, 'Stämmer.')));
    await page.click('.kort-aktiv .kort-stammer');
    await vantaPaSvar(page, 2);
    const blk = blockAnrop[b0 + 1];
    check('stämmer: ett nytt tryck försöker spara igen', blockAnrop.length === b0 + 2);
    check('stämmer: /intervju-block med blocket, varden och kallor orörda', blk.typ === 'block' && blk.block === 'pengarna' && blk.samtycke === true && blk.underlag.rid === RID
      && JSON.stringify(blk.varden) === JSON.stringify(KORT_PENGAR.varden) && JSON.stringify(blk.kallor) === JSON.stringify(KORT_PENGAR.kallor));
    check('stämmer: först /intervju-block och sedan /intervju-tur', ordning.slice(-2).join() === 'block,tur');
    const ts = anrop[t0 + 1];
    check('stämmer: kortsvar med stammer och text null', JSON.stringify(ts.kortsvar) === JSON.stringify({ id: KORT_PENGAR.id, stammer: true }) && ts.text === null && ts.samtycke === true && ts.start === false);
    const k2 = await kortet('#logg .kort');
    check('stämmer: kortet är bekräftat med bocken och utan knappar', /kort-bekraftat/.test(k2.klass) && k2.bock && k2.knappar.length === 0);
    check('stämmer: ingen tur från ägaren för ett kortsvar', JSON.stringify((await turer(page)).map(t => t.vem)) === '["ai","ai"]');
    check('stämmer: platshållaren är tillbaka', (await page.getAttribute('#text', 'placeholder')) === 'Skriv ditt svar');
    await page.screenshot({ path: `${OUT}/intervju-kort-bekraftat.png`, fullPage: true });

    // Ett svar med bara ett kort.
    const KORT_C = kopia(KORT_PENGAR, { id: 'toolu_01C', rader: [{ etikett: 'Betalsätt', varde: ['Autogiro', 'Swish', 'Kort'], kalla: 'samtal' }, KORT_PENGAR.rader[1]] });
    scenario.push(svar('', 'Nästan aldrig. Kort tar vi också.', { kort: KORT_C }));
    await page.fill('#text', 'Nästan aldrig. Kort tar vi också.');
    await page.click('#btn-skicka');
    await vantaPaKort(page, 2);
    check('bara ett kort: ingen tom tur', (await page.$$('#logg .tur-ai')).length === 2 && (await turer(page)).every(t => t.text.trim() !== ''));
    check('bara ett kort: kortet ritas direkt efter ägarens tur', await page.$eval('.kort-aktiv', el => el.previousElementSibling.classList.contains('tur-du')));

    // Ändra lägger markören i fältet, och det som skickas är en rättning.
    await page.click('.kort-aktiv .kort-andra');
    check('ändra: markören i skrivfältet', (await page.evaluate(() => document.activeElement.id)) === 'text');
    const KORT_D = kopia(KORT_C, { id: 'toolu_01D' });
    scenario.push(svar('Då rättar jag det.', kortsvarBlock(KORT_C.id, 'Kort bara för drop-in.'), { kort: KORT_D }));
    const b1 = blockAnrop.length;
    await page.fill('#text', '  Kort bara för drop-in.  ');
    await page.click('#btn-skicka');
    await vantaPaKort(page, 3);
    const tr = anrop[anrop.length - 1];
    check('ändra: kortsvar med rättningen och text null', JSON.stringify(tr.kortsvar) === JSON.stringify({ id: KORT_C.id, rattning: 'Kort bara för drop-in.' }) && tr.text === null);
    check('ändra: ingen /intervju-block för en rättning', blockAnrop.length === b1);
    const kc = await kortet('#logg .kort', 1);
    check('ändra: det gamla kortet tonas ned och knapparna försvinner', /kort-andrat/.test(kc.klass) && kc.knappar.length === 0 && !kc.bock);
    check('ändra: rättningen visas som ägarens tur', (await turer(page)).filter(t => t.vem === 'du').pop().text === 'Kort bara för drop-in.');
    check('ändra: det nya kortet väntar', (await page.$$('.kort-aktiv')).length === 1 && (await kortet('.kort-aktiv')).rader[0].taggar.length === 3);

    // Sparat, men svaret når inte assistenten: kortet väntar igen och nästa tryck sparar om.
    scenario.push({ handelser: [{ typ: 'fel', kod: 'tekniskt' }] });
    await page.click('.kort-aktiv .kort-stammer');
    await page.waitForSelector('#fel:not([hidden])');
    check('fel efter sparat: kortet väntar igen med knapparna', (await page.$$('.kort-aktiv .kort-stammer:not([disabled])')).length === 1 && !(await page.$('.kort-aktiv.kort-bekraftat')));
    check('fel efter sparat: felet visas under samtalet', (await page.textContent('#fel')) === 'Något gick fel. Försök igen om en stund.');
    scenario.push(svar('Sista frågan. Vill du vara ett av pilotgymmen?', kortsvarBlock(KORT_D.id, 'Stämmer.'), { kort: VALKORT }));
    await page.click('.kort-aktiv .kort-stammer');
    await vantaPaKort(page, 4);
    check('fel efter sparat: nytt tryck sparar igen och skickar', blockAnrop.length === b1 + 2 && JSON.stringify(anrop[anrop.length - 1].kortsvar) === JSON.stringify({ id: KORT_D.id, stammer: true }));

    // Valkortet.
    const val = await page.$$eval('.kort-aktiv .opt', els => els.map(e => ({ text: e.textContent, av: e.disabled })));
    check('valkort: en rad att trycka på per val', JSON.stringify(val) === JSON.stringify([{ text: 'Ja', av: false }, { text: 'Nej', av: false }]) && (await page.textContent('.kort-aktiv .kort-rubrik')) === 'Pilotgym');
    check('valkort: inga Stämmer och Ändra', (await page.$$('.kort-aktiv .kort-stammer, .kort-aktiv .kort-andra')).length === 0);
    await page.screenshot({ path: `${OUT}/intervju-valkort.png`, fullPage: true });
    scenario.push(svar('Tack. Då hör jag av mig om piloten. Det var allt.', kortsvarBlock(VALKORT.id, 'ja'), { slut: true }));
    await page.click('.kort-aktiv .opt:nth-child(1)');
    await page.waitForSelector('#avslutat:not([hidden])');
    const bp = blockAnrop[blockAnrop.length - 1];
    check('valkort: sparar pilotintresse', bp.typ === 'block' && bp.block === 'pilot' && JSON.stringify(bp.varden) === '{"pilotintresse":"ja"}' && JSON.stringify(bp.kallor) === '{"pilotintresse":"samtal"}');
    check('valkort: skickar val', JSON.stringify(anrop[anrop.length - 1].kortsvar) === JSON.stringify({ id: VALKORT.id, val: 'ja' }) && anrop[anrop.length - 1].text === null && ordning.slice(-2).join() === 'block,tur');
    check('valkort: det valda är markerat och kortet bekräftat', (await page.textContent('.kort-bekraftat .opt.vald')) === 'Ja' && (await page.$$('#logg .kort:last-child .opt:not([disabled])')).length === 0);
    const idn = [...new Set(blockAnrop.slice(b0).map(b => b.samtal))];
    check('samtal: samma id i varje anrop till /intervju-block', idn.length === 1 && UUID.test(idn[0]));

    await page.click('#btn-stang');
    check('klart med samtycke: det du bekräftade är sparat', (await page.textContent('#klart .lede:not([hidden])')) === 'Det du bekräftade är sparat. Tack.' && !(await page.isVisible('#klart-inget')));
    check('klart med samtycke: koden är de första åtta tecknen i samtal', (await page.textContent('#kod')) === idn[0].slice(0, 8) && (await page.textContent('#klart-kod')).includes('daniel@opengym.se'));
    await page.screenshot({ path: `${OUT}/intervju-klart.png`, fullPage: true });
    const m = await matt(page);
    const namn = m.map(x => x.namn);
    check('mätning: korten räknas med blocket', ['intervju_kort_visat', 'intervju_kort_stammer', 'intervju_kort_andra'].every(n => m.some(x => x.namn === n && x.egenskaper.block === 'pengarna')));
    check('mätning: valet räknas utan värdet', m.some(x => x.namn === 'intervju_kort_val' && JSON.stringify(x.egenskaper) === '{"block":"pilot"}'));
    check('mätning: misslyckat sparande räknas', namn.includes('intervju_sparfel'));
    check('mätning: bara namn och räknare, aldrig innehåll', baraKoder(m));
    await ctx.close();
  }

  // ---------- Korten utan samtycke ----------
  {
    const { ctx, page } = await newPage({ width: 1280, height: 900 });
    await page.goto(BASE + '?api=' + MOCK, { waitUntil: 'load' });
    const t0 = anrop.length, b0 = blockAnrop.length;
    scenario.push(svar('Hej. Så här har jag uppfattat pengarna.', '(start)', { kort: KORT_PENGAR }));
    await page.click('#btn-nej');
    await vantaPaKort(page, 1);
    scenario.push(svar('Vill du vara ett av pilotgymmen?', kortsvarBlock(KORT_PENGAR.id, 'Stämmer.'), { kort: VALKORT }));
    await page.click('.kort-aktiv .kort-stammer');
    await vantaPaKort(page, 2);
    check('utan samtycke: Stämmer går bara till /intervju-tur', blockAnrop.length === b0 && JSON.stringify(anrop[t0 + 1].kortsvar) === JSON.stringify({ id: KORT_PENGAR.id, stammer: true }) && anrop[t0 + 1].samtycke === false);
    check('utan samtycke: kortet märks bekräftat ändå', (await page.$$('#logg .kort-bekraftat')).length === 1);
    scenario.push(svar('Tack för samtalet.', kortsvarBlock(VALKORT.id, 'nej'), { slut: true }));
    await page.click('.kort-aktiv .opt:nth-child(2)');
    await page.waitForSelector('#avslutat:not([hidden])');
    check('utan samtycke: valet går bara till /intervju-tur', blockAnrop.length === b0 && JSON.stringify(anrop[t0 + 2].kortsvar) === JSON.stringify({ id: VALKORT.id, val: 'nej' }));
    await page.click('#btn-stang');
    check('utan samtycke: klart säger att ingenting sparades', (await page.textContent('#klart .lede:not([hidden])')) === 'Ingenting sparades.' && !(await page.isVisible('#klart-kod')));
    await ctx.close();
  }

  // ---------- Parkerade ämnen ----------
  {
    const { ctx, page } = await newPage({ width: 1280, height: 900 });
    await page.goto(BASE + '?api=' + MOCK, { waitUntil: 'load' });
    const t0 = anrop.length, b0 = blockAnrop.length;
    scenario.push(svar('Hej. Berätta om pengarna.'));
    await page.click('#btn-ja');
    await vantaPaSvar(page, 1);

    // Assistenten parkerade innan den skrev sitt svar: fyra meddelanden i klar.
    const s4 = svar('Det tar vi i slutet. Hur betalar medlemmarna?', 'Schemat för coacherna är ett eget kapitel.', { parkerat: [PARKERAT] });
    scenario.push(s4);
    await page.fill('#text', 'Schemat för coacherna är ett eget kapitel.');
    await page.click('#btn-skicka');
    await vantaPaSvar(page, 2);
    check('parkerat: raden "Tas upp i slutet: …" under assistentens tur', await page.$eval('#logg .parkerat', el => el.textContent === 'Tas upp i slutet: Coachernas scheman' && el.previousElementSibling.classList.contains('tur-ai')));
    await vantaTills(() => blockAnrop.length === b0 + 1);
    const sp = blockAnrop[b0];
    check('parkerat: sparas med /intervju-block och sidospar exakt som i händelsen', sp.typ === 'sidospar' && sp.samtycke === true && UUID.test(sp.samtal)
      && JSON.stringify(sp.sidospar) === JSON.stringify({ nummer: 1, amne: 'Coachernas scheman', vad_personen_sa: 'Schemat för coacherna är ett eget kapitel.' }));
    check('parkerat: ligger i visning efter turen', JSON.stringify((await sparat(page)).visning.slice(-2)) === JSON.stringify([{ vem: 'ai', text: 'Det tar vi i slutet. Hur betalar medlemmarna?' }, { parkerat: 'Coachernas scheman' }]));
    check('parkerat: inget kort väntar', (await page.getAttribute('#text', 'placeholder')) === 'Skriv ditt svar');

    scenario.push(svar('Autogiro, alltså. Och bokningen?', 'Autogiro.'));
    await page.fill('#text', 'Autogiro.');
    await page.click('#btn-skicka');
    await vantaPaSvar(page, 3);
    const h4 = anrop[anrop.length - 1].historik;
    check('stycken: alla fyra meddelanden ur klar ligger i historiken, orörda', h4.length === 6 && JSON.stringify(h4.slice(2)) === JSON.stringify(s4.handelser.find(h => h.typ === 'klar').tillagg));

    // Historiken slutar med parkeringen och inget kort kom: nästa tur är vanlig text.
    const P2 = { typ: 'parkerat', nummer: 2, amne: 'Bokningen', vad_personen_sa: 'Bokningen strular varje måndag.' };
    scenario.push(svar('Den tar vi också i slutet.', 'Bokningen strular varje måndag.', { parkerat: [P2], parkeratSist: true }));
    await page.fill('#text', 'Bokningen strular varje måndag.');
    await page.click('#btn-skicka');
    await vantaPaSvar(page, 4);
    await vantaTills(() => blockAnrop.length === b0 + 2);
    check('parkerat sist: historiken slutar med parkeringen', (await sparat(page)).historik.slice(-1)[0].content.slice(-1)[0].type === 'tool_use');
    scenario.push(svar('Noterat. Hur många coacher har du?', kortsvarBlock('toolu_p2', 'ok').concat({ type: 'text', text: 'Fyra.' })));
    await page.fill('#text', 'Fyra.');
    await page.click('#btn-skicka');
    await vantaPaSvar(page, 5);
    const efter = anrop[anrop.length - 1];
    check('parkerat sist: nästa anrop har text och inget kortsvar', efter.text === 'Fyra.' && !('kortsvar' in efter));
    check('parkerat sist: ägarens meddelande som lista med block följer med orört', JSON.stringify((await sparat(page)).historik.slice(-2)[0].content) === JSON.stringify(kortsvarBlock('toolu_p2', 'ok').concat({ type: 'text', text: 'Fyra.' })));

    // Ett avbrutet svar med ett parkerat ämne: raden försvinner och ingenting sparas.
    const b1 = blockAnrop.length;
    scenario.push({ handelser: [{ typ: 'text', delta: 'Det ' }, { typ: 'parkerat', nummer: 3, amne: 'Lokalen', vad_personen_sa: 'Hyran går upp.' }, { typ: 'fel', kod: 'upptagen' }] });
    await page.fill('#text', 'Hyran går upp.');
    await page.click('#btn-skicka');
    await page.waitForSelector('#fel:not([hidden])');
    await page.waitForTimeout(300);
    check('parkerat i avbrutet svar: raden tas bort och ingenting sparas', (await page.$$('#logg .parkerat')).length === 2 && blockAnrop.length === b1);

    const fore = await loggen(page);
    await page.reload({ waitUntil: 'load' });
    await page.click('#btn-fortsatt');
    check('parkerat: raderna ritas upp igen efter omladdning', JSON.stringify(await loggen(page)) === JSON.stringify(fore));
    await ctx.close();
  }
  {
    // Utan samtycke visas raden, men ingenting sparas.
    const { ctx, page } = await newPage({ width: 1280, height: 900 });
    await page.goto(BASE + '?api=' + MOCK, { waitUntil: 'load' });
    const b0 = blockAnrop.length;
    scenario.push(svar('Det tar vi i slutet. Hur betalar medlemmarna?', '(start)', { parkerat: [PARKERAT] }));
    await page.click('#btn-nej');
    await vantaPaSvar(page, 1);
    await page.waitForTimeout(300);
    check('parkerat utan samtycke: raden visas men sparas inte', (await page.textContent('#logg .parkerat')) === 'Tas upp i slutet: Coachernas scheman' && blockAnrop.length === b0);
    await ctx.close();
  }
  {
    // Sparandet misslyckas två gånger: ett nytt försök, sedan inte fler, och samtalet går vidare.
    const { ctx, page } = await newPage({ width: 1280, height: 900 });
    await page.goto(BASE + '?api=' + MOCK, { waitUntil: 'load' });
    scenario.push(svar('Hej. Berätta om pengarna.'));
    await page.click('#btn-ja');
    await vantaPaSvar(page, 1);
    const b0 = blockAnrop.length;
    blockScenario.push({ status: 500, json: { ok: false, fel: 'tekniskt' } }, { status: 200, json: { ok: false, fel: 'block_form' } });
    scenario.push(svar('Det tar vi i slutet. Hur betalar medlemmarna?', 'Coacherna.', { parkerat: [PARKERAT] }));
    await page.fill('#text', 'Coacherna.');
    await page.click('#btn-skicka');
    await vantaPaSvar(page, 2);
    check('parkerat sparfel: samtalet väntar inte på sparandet', !(await page.isDisabled('#text')) && !(await page.isVisible('#fel')) && (await page.$$('.kort-fel:not([hidden])')).length === 0);
    await vantaTills(() => blockAnrop.length === b0 + 2);
    await page.waitForTimeout(1500);
    check('parkerat sparfel: ett nytt försök och sedan inte fler', blockAnrop.length === b0 + 2 && blockAnrop.slice(b0).every(b => b.typ === 'sidospar'));
    scenario.push(svar('Autogiro, alltså.', 'Autogiro.'));
    await page.fill('#text', 'Autogiro.');
    await page.click('#btn-skicka');
    await vantaPaSvar(page, 3);
    check('parkerat sparfel: nästa tur går som vanligt', (await turer(page)).pop().text === 'Autogiro, alltså.');
    const m = await matt(page);
    check('mätning: parkerat ämne och misslyckat sparande räknas, utan ämnet', m.some(x => x.namn === 'intervju_parkerat') && m.some(x => x.namn === 'intervju_sparfel' && x.egenskaper.typ === 'sidospar') && baraKoder(m));
    await ctx.close();
  }

  // ---------- Skärmbilder på mobil ----------
  {
    const { ctx, page } = await newPage({ width: 375, height: 740 });
    await page.goto(BASE + '?api=' + MOCK, { waitUntil: 'load' });
    check('mobil: introt med samtycket utan sidledes rullning', await page.isVisible('#samtycke') && (await overflow(page)) === 0);
    await page.screenshot({ path: `${OUT}/intervju-intro-mobil.png`, fullPage: true });
    scenario.push(svar('Hej. Så här har jag uppfattat pengarna. Stämmer det?', '(start)', { kort: KORT_PENGAR }));
    await page.click('#btn-ja');
    await vantaPaKort(page, 1);
    check('mobil: avstämningskortet utan sidledes rullning', (await overflow(page)) === 0);
    await page.screenshot({ path: `${OUT}/intervju-kort-mobil.png`, fullPage: true });
    scenario.push(svar('Bra. Hur ofta byter medlemmarna betalsätt?', kortsvarBlock(KORT_PENGAR.id, 'Stämmer.')));
    await page.click('.kort-aktiv .kort-stammer');
    await vantaPaSvar(page, 2);
    check('mobil: bekräftat kort utan sidledes rullning', (await overflow(page)) === 0 && (await page.$$('.kort-bekraftat')).length === 1);
    await page.screenshot({ path: `${OUT}/intervju-kort-bekraftat-mobil.png`, fullPage: true });
    scenario.push(svar('Sista frågan. Vill du vara ett av pilotgymmen?', 'Nästan aldrig.', { kort: VALKORT }));
    await page.fill('#text', 'Nästan aldrig.');
    await page.click('#btn-skicka');
    await vantaPaKort(page, 2);
    check('mobil: valkortet utan sidledes rullning', (await overflow(page)) === 0);
    await page.screenshot({ path: `${OUT}/intervju-valkort-mobil.png`, fullPage: true });
    scenario.push(svar('Tack. Det var allt.', kortsvarBlock(VALKORT.id, 'ja'), { slut: true }));
    await page.click('.kort-aktiv .opt:nth-child(1)');
    await page.waitForSelector('#avslutat:not([hidden])');
    await page.click('#btn-stang');
    check('mobil: klart-skärmen utan sidledes rullning', await page.isVisible('#klart-kod') && (await overflow(page)) === 0);
    await page.screenshot({ path: `${OUT}/intervju-klart-mobil.png`, fullPage: true });
    const m = await matt(page);
    check('mätning: samtycket räknas som ja eller nej', m.some(x => x.namn === 'intervju_samtycke' && JSON.stringify(x.egenskaper) === '{"svar":"ja"}') && baraKoder(m));
    await ctx.close();
  }

  // ---------- Mobil, och slutkoder ----------
  {
    const { ctx, page } = await newPage({ width: 375, height: 740 });
    await page.goto(BASE + '?api=' + MOCK, { waitUntil: 'load' });
    scenario.push(svar('Hej. Berätta om en vanlig tisdag.'));
    await page.click('#btn-ja');
    await vantaPaSvar(page, 1);
    check('mobil: ingen sidledes rullning', (await overflow(page)) === 0);
    await page.screenshot({ path: `${OUT}/intervju-mobil.png`, fullPage: true });
    scenario.push({ status: 429, json: { ok: false, fel: 'for_manga_anrop' } });
    await page.fill('#text', 'Mest morgonpass.');
    await page.click('#btn-skicka');
    await page.waitForSelector('#fel:not([hidden])');
    check('för många anrop: eget meddelande', (await page.textContent('#fel')) === 'Du har skickat många svar på kort tid. Vänta en stund och försök igen.');
    check('för många anrop: samtalet fortsätter och texten ligger kvar', !(await page.isDisabled('#btn-skicka')) && !(await page.isDisabled('#text')) && (await page.inputValue('#text')) === 'Mest morgonpass.');
    scenario.push({ status: 400, json: { ok: false, fel: 'for_manga_turer' } });
    await page.fill('#text', 'En till.');
    await page.click('#btn-skicka');
    await page.waitForSelector('#fel:not([hidden])');
    check('för många turer: skicka stängs', await page.isDisabled('#btn-skicka') && (await page.textContent('#fel')).includes('så långt det kan bli'));
    await ctx.close();
  }

  await browser.close();
  server.close();
  check('låtsasservern: sidans anrop följer protokollet' + (brott.length ? ' (' + brott.join('; ') + ')' : ''), brott.length === 0);
  console.log('\nanrop till låtsasservern:', anrop.length, 'till /intervju-tur,', blockAnrop.length, 'till /intervju-block');
  console.log('console errors:', errors.length ? errors : 'none');
  if (errors.length) process.exit(1);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
