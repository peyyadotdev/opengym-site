// Kör leads/Leads.gs, leads/Rapport.gs och leads/Utskick.gs i SAMMA Node-kontext mot ett
// mock-kalkylark, i bokstavsordning som Apps Script. Kontrollerar läget i Boxrapporten:
// siffrorna i steg om 10, 20 och 40, att bara summor lämnar arket, och mejlet vid 20 och 40.
// Körs med: node tests/test-rapport.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const sheets = {};
class Range {
  constructor(s, r, c, nr, nc) { Object.assign(this, { s, r, c, nr, nc }); }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = this.s.rows[this.r - 1 + i] || [];
      const vals = [];
      for (let j = 0; j < this.nc; j++) vals.push(row[this.c - 1 + j] === undefined ? '' : row[this.c - 1 + j]);
      out.push(vals);
    }
    return out;
  }
  setValues(v) {
    for (let i = 0; i < v.length; i++) {
      const ri = this.r - 1 + i;
      while (this.s.rows.length <= ri) this.s.rows.push([]);
      const row = this.s.rows[ri];
      for (let j = 0; j < v[i].length; j++) {
        while (row.length < this.c - 1 + j) row.push('');
        row[this.c - 1 + j] = v[i][j];
      }
    }
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  createTextFinder(text) {
    const self = this;
    return {
      matchEntireCell() { return this; },
      findNext() {
        for (let i = 0; i < self.nr; i++) {
          const row = self.s.rows[self.r - 1 + i] || [];
          for (let j = 0; j < self.nc; j++) {
            if (String(row[self.c - 1 + j] ?? '') === String(text)) { const rr = self.r + i; return { getRow() { return rr; } }; }
          }
        }
        return null;
      },
    };
  }
}
class Sheet {
  constructor(n) { this.name = n; this.rows = []; this.frozen = 0; }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
  appendRow(v) { this.rows.push(v.slice()); }
  insertRowBefore(pos) { this.rows.splice(pos - 1, 0, []); }
  setFrozenRows(n) { this.frozen = n; }
}
const spreadsheet = { getSheetByName(n) { return sheets[n] || null; }, insertSheet(n) { sheets[n] = new Sheet(n); return sheets[n]; } };
global.SpreadsheetApp = { getActiveSpreadsheet() { return spreadsheet; }, getUi() { return mockUi; } };
global.LockService = { getScriptLock() { return { tryLock() { return true; }, releaseLock() {} }; } };
global.ContentService = { MimeType: { JSON: 'json' }, createTextOutput(t) { return { text: t, setMimeType() { return this; } }; } };
const sentMail = [];
global.GmailApp = { sendEmail(to, subject, body, opts) { sentMail.push({ to, subject, body, opts }); }, getAliases() { return ['daniel@opengym.se']; } };
global.Session = { getActiveUser() { return { getEmail() { return 'daniel@peyya.dev'; } }; } };
global.Utilities = { sleep() {} };
const alerts = [];
let svarPaFragan = 'YES';
const mockUi = {
  ButtonSet: { OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO' },
  Button: { YES: 'YES', NO: 'NO', OK: 'OK', CANCEL: 'CANCEL' },
  alert(a, b, knappar) { alerts.push(b === undefined ? a : a + ': ' + b); return knappar ? svarPaFragan : 'OK'; },
  prompt() { return { getSelectedButton() { return 'CANCEL'; }, getResponseText() { return ''; } }; },
};

for (const f of ['Leads.gs', 'Rapport.gs', 'Utskick.gs']) {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'leads', f), 'utf8'), { filename: f });
}
const post = (parameter) => JSON.parse(doPost({ parameter }).text);
const lage = () => JSON.parse(doGet({ parameter: { action: 'lage' } }).text);
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('  ok', name); };

// Ett inskickat svar. Värdena väljs per nummer, så att de tio första skiljer sig från resten.
let nr = 0;
function svara(val, { klar = true, rapport = null } = {}) {
  nr++;
  const rid = 'rid-prov-' + String(nr).padStart(4, '0');
  const answers = Object.assign({ q01_lan: 'Skåne', q09_irriterande: 'Hemlig fritext ' + nr }, val);
  if (rapport) answers.q30_rapport = 'Ja, skicka till min e-post';
  const r = post({ action: 'survey', rid, step: '7', completed: klar ? '1' : '0', answers: JSON.stringify(answers), report_email: rapport || '' });
  assert.equal(r.ok, true);
  return rid;
}
const TIDIG = (i) => ({
  q10_modell: i < 6 ? 'Både och' : 'Bara öppen passbokning',
  q08_kostnad: i < 5 ? '2 500–5 000 kr' : i < 8 ? '1 000–2 500 kr' : 'Vet inte',
  q13_pris: i < 4 ? '900–1 100 kr' : i < 8 ? '700–900 kr' : 'Under 700 kr',
  q18_betalkostnad: i < 7 ? 'Nej' : '1–2 %',
  q23_retention: i < 3 ? 'Vet inte' : '65–80 %',
});
const SEN = { q10_modell: 'Fasta grupper där samma medlemmar tränar samma tider med samma coach', q08_kostnad: 'Över 10 000 kr', q13_pris: 'Över 1 300 kr', q18_betalkostnad: 'Över 3 %', q23_retention: 'Vet inte' };

ok('före första svaret: inget steg, nästa är 10', () => assert.deepEqual(lage(), { ok: true, steg: 0, nasta: 10 }));
ok('health utan action är som förut', () => { const r = JSON.parse(doGet().text); assert.equal(r.service, 'opengym-leads'); assert.equal(r.version, 2); });

const rids = [];
for (let i = 0; i < 9; i++) rids.push(svara(TIDIG(i), { rapport: `agare${i}@box.se` }));
for (let i = 0; i < 3; i++) svara(SEN, { klar: false });
ok('nio inskickade och tre påbörjade: fortfarande inget steg', () => assert.deepEqual(lage(), { ok: true, steg: 0, nasta: 10 }));

rids.push(svara(TIDIG(9), { rapport: 'agare9@box.se' }));
for (let i = 0; i < 7; i++) svara(SEN);
const tio = lage();
ok('17 inskickade: siffrorna gäller de tio första, nästa är 20', () => { assert.equal(tio.steg, 10); assert.equal(tio.nasta, 20); });
ok('fasta grupper: Både och räknas, bara öppen bokning inte', () => assert.deepEqual(tio.fasta_grupper, { antal: 6, av: 10 }));
ok('systemkostnad: vanligast bara när minst fem gett det, utan vet inte', () =>
  assert.deepEqual(tio.systemkostnad, { vanligast: '2 500–5 000 kr', antal: 5, av: 8, vet_inte: 2 }));
ok('medlemspris: delad topp under fem visas inte', () => assert.deepEqual(tio.medlemspris, { vanligast: null, antal: null, av: 10, vet_inte: 0 }));
ok('betalkostnad och retention som x av y', () => {
  assert.deepEqual(tio.betalkostnad_okand, { antal: 7, av: 10 });
  assert.deepEqual(tio.retention_okand, { antal: 3, av: 10 });
});
ok('bara summor lämnar arket: inga svars-id, ingen fritext, inga e-postadresser', () => {
  const text = JSON.stringify(tio);
  assert.ok(!/rid-prov|Hemlig|@box\.se|Skåne/.test(text), text);
  assert.deepEqual(Object.keys(tio).sort(), ['betalkostnad_okand', 'fasta_grupper', 'medlemspris', 'nasta', 'ok', 'retention_okand', 'steg', 'systemkostnad']);
});
ok('ett nytt svar ändrar inget förrän nästa steg', () => { svara(SEN); assert.deepEqual(lage(), tio); });

ok('ordningen är när svaret skickades in, inte raden i arket', () => {
  const s = sheets['Enkät'];
  const kol = s.rows[0].indexOf('uppdaterad');
  const rad = s.rows.findIndex(r => r[0] === rids[0]);
  const fore = s.rows[rad][kol];
  s.rows[rad][kol] = new Date(Date.now() + 86400000);
  assert.deepEqual(lage().fasta_grupper, { antal: 6, av: 10 });   // första svaret ersätts av ett sent med fasta grupper, som också räknas
  assert.equal(lage().retention_okand.antal, 3);                    // ett tidigt vet inte byts mot ett sent vet inte
  assert.equal(lage().betalkostnad_okand.antal, 6);                 // det tidiga Nej är borta ur de tio första
  s.rows[rad][kol] = fore;
});

ok('mejlet: inget vid steg 10', () => {
  rapportSkickaLage();
  assert.equal(sentMail.length, 0);
  assert.match(alerts.pop(), /20 och 40/);
});

while (lage().steg < 20) svara(SEN);
ok('steg 20: nästa är 40', () => assert.deepEqual([lage().steg, lage().nasta], [20, 40]));
ok('mejlet: Nej i frågan skickar inget', () => { svarPaFragan = 'NO'; rapportSkickaLage(); svarPaFragan = 'YES'; assert.equal(sentMail.length, 0); });
ok('mejlet vid 20: till alla på Rapportlista, med länken och en siffra', () => {
  rapportSkickaLage();
  assert.equal(sentMail.length, 10);
  const m = sentMail[0];
  assert.equal(m.subject, 'Boxrapporten 2026: 20 boxar har svarat');
  assert.match(m.body, /https:\/\/opengym\.se\/enkat\/lage\//);
  assert.match(m.body, /\d+ av 20 kör fasta grupper/);
  assert.match(m.body, /när 40 boxar har svarat/);
  assert.equal(m.opts.from, 'daniel@opengym.se');
  assert.match(m.opts.htmlBody, /enkat\/lage/);
  assert.deepEqual(sentMail.map(x => x.to).sort(), Array.from({ length: 10 }, (_, i) => `agare${i}@box.se`).sort());
});
ok('mejlet vid 20: datum i lage_20, och en ny körning skickar inget', () => {
  const s = sheets['Rapportlista'];
  const k = s.rows[0].indexOf('lage_20');
  assert.ok(k > 0 && s.rows.slice(1).every(r => r[k] instanceof Date));
  rapportSkickaLage();
  assert.equal(sentMail.length, 10);
  assert.match(alerts.pop(), /redan fått/);
});

while (lage().steg < 40) svara(SEN);
ok('steg 40: sista steget, inget nästa', () => assert.deepEqual([lage().steg, lage().nasta], [40, null]));
ok('mejlet vid 40: sista uppdateringen', () => {
  rapportSkickaLage();
  assert.equal(sentMail.length, 20);
  assert.match(sentMail[19].body, /sista uppdateringen/);
});
ok('efter 40 står siffrorna still', () => { const fore = lage(); for (let i = 0; i < 5; i++) svara(TIDIG(0)); assert.deepEqual(lage(), fore); });

ok('fel i uträkningen: ok false, utan felets text', () => {
  const spara = sheets['Enkät'].getRange;
  sheets['Enkät'].getRange = () => { throw new Error('hemligt fel'); };
  assert.deepEqual(lage(), { ok: false, error: 'tekniskt' });
  sheets['Enkät'].getRange = spara;
});

console.log(`\n${n} checks passed`);
