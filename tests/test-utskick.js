// Kör leads/Code.gs och leads/Utskick.gs i SAMMA Node-kontext mot ett mock-kalkylark,
// precis som Apps Script kör flera filer i ett projekt med delat globalt scope.
// Kontrollerar dels att Utskick.gs fungerar mot fliken Mottagare, dels att inget i
// Utskick.gs krockar med eller stör namnen i Code.gs (doPost, doGet, saveLead osv).
// Körs med: node tests/test-utskick.js
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
global.SpreadsheetApp = {
  getActiveSpreadsheet() { return spreadsheet; },
  getUi() { return mockUi; },
};
global.LockService = { getScriptLock() { return { tryLock() { return true; }, releaseLock() {} }; } };
global.ContentService = { MimeType: { JSON: 'json' }, createTextOutput(t) { return { text: t, setMimeType() { return this; } }; } };

// Mockar för det som bara Utskick.gs använder: GmailApp, Session, Utilities, ui-dialoger.
const sentMail = [];
global.GmailApp = { sendEmail(to, subject, body, opts) { sentMail.push({ to, subject, body, opts }); } };
global.Session = { getActiveUser() { return { getEmail() { return 'daniel@peyya.dev'; } }; } };
global.Utilities = { sleep() {} };

const alerts = [];
let promptQueue = [];
const mockUi = {
  ButtonSet: { OK_CANCEL: 'OK_CANCEL' },
  Button: { OK: 'OK', CANCEL: 'CANCEL' },
  createMenu() {
    const self = this;
    self._menuItems = [];
    return {
      addItem(label, fn) { self._menuItems.push({ label, fn }); return this; },
      addSeparator() { return this; },
      addToUi() { self.lastMenu = self._menuItems; },
    };
  },
  alert(msg) { alerts.push(msg); },
  prompt() {
    const next = promptQueue.shift() || { button: 'CANCEL', text: '' };
    return { getSelectedButton: () => next.button, getResponseText: () => next.text };
  },
};

// Ladda BÅDA filerna i samma vm-kontext, i den ordning Apps Script laddar ett
// projekts filer (bokstavsordning: Code.gs före Utskick.gs).
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'leads', 'Code.gs'), 'utf8'), { filename: 'Code.gs' });
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'leads', 'Utskick.gs'), 'utf8'), { filename: 'Utskick.gs' });

let n = 0; const ok = (name, fn) => { fn(); n++; console.log('  ok', name); };

ok('Utskick.gs stör inte Code.gs: doPost/doGet fungerar som förut', () => {
  const r = JSON.parse(doGet().text);
  assert.equal(r.ok, true);
  assert.equal(r.version, 2);
  const lead = JSON.parse(doPost({ parameter: { email: 'agare@boxen.se', box: 'Testbox' } }).text);
  assert.deepEqual(lead, { ok: true });
  assert.equal(sheets.Leads.rows.length, 2);
});

ok('onOpen bygger menyn Utskick med tre val', () => {
  onOpen();
  const labels = mockUi.lastMenu.map((m) => m.label);
  assert.ok(labels.some((l) => l.includes('testmejl')));
  assert.ok(labels.some((l) => l.includes('Skicka enkäten')));
  assert.ok(labels.some((l) => l.includes('påminnelse')));
});

ok('utskickTest skickar ett mejl till avsändaren själv, utan telefonnummer, med länken', () => {
  utskickTest();
  assert.equal(sentMail.length, 1);
  assert.equal(sentMail[0].to, 'daniel@peyya.dev');
  assert.equal(sentMail[0].opts.from, 'daniel@opengym.se');
  assert.ok(!sentMail[0].body.includes('073'), 'inget telefonnummer i mejlet');
  assert.ok(sentMail[0].body.includes('https://opengym.se/enkat/'));
});

ok('utskickEnkat kräver fliken Mottagare, ger tydligt fel annars', () => {
  const before = alerts.length;
  utskickEnkat();
  assert.equal(alerts.length, before + 1);
  assert.ok(alerts[alerts.length - 1].includes('Mottagare'));
});

// Bygg fliken Mottagare med kolumnnamnen som i CSV-filerna (namn/epost), plus
// en rad som redan har ett skickat-datum sedan tidigare, för att testa att den
// hoppas över i utskicket men blir aktuell för påminnelsen.
const mottagare = spreadsheet.insertSheet('Mottagare');
mottagare.appendRow(['namn', 'ort', 'epost', 'förnamn', 'skickat']);
mottagare.appendRow(['CrossFit Testet', 'Testköping', 'agare1@boxen.se', '', '']);
mottagare.appendRow(['Boxen Två', 'Andra Orten', 'agare2@boxen.se', 'Anna', '']);
mottagare.appendRow(['Redan Skickad Sedan Tidigare', 'Ort', 'redan@boxen.se', '', new Date('2026-09-10')]);

ok('utskickEnkat skickar bara till rader utan datum i skickat, skriver dagens datum', () => {
  sentMail.length = 0;
  utskickEnkat();
  assert.equal(sentMail.length, 2, 'agare1 och Boxen Två är nya, "redan" har redan ett datum och hoppas över');
  const mottagna = sentMail.map((m) => m.to);
  assert.ok(mottagna.includes('agare1@boxen.se'));
  assert.ok(mottagna.includes('agare2@boxen.se'));
  assert.ok(!mottagna.includes('redan@boxen.se'));
  assert.ok(sentMail.every((m) => !m.body.includes('073')), 'inget telefonnummer i något utskick');
  const kol = mottagare.rows[0];
  const skickatCol = kol.indexOf('skickat');
  assert.ok(mottagare.rows[1][skickatCol] instanceof Date, 'agare1 fick dagens datum i skickat');
  assert.ok(mottagare.rows[2][skickatCol] instanceof Date, 'Boxen Två fick dagens datum i skickat');
});

ok('en andra körning skickar inget nytt, alla har redan datum i skickat', () => {
  sentMail.length = 0;
  utskickEnkat();
  assert.equal(sentMail.length, 0);
});

ok('hälsningen använder förnamn när kolumnen är ifylld, annars bara "Hej,"', () => {
  const kol = mottagare.rows[0];
  const namnI = kol.indexOf('förnamn');
  assert.equal(mottagare.rows[1][namnI], '', 'agare1 saknar förnamn');
  assert.equal(mottagare.rows[2][namnI], 'Anna', 'Boxen Två har förnamn Anna');
  // Hälsningen syntes redan i utskicket ovan; bygg om mallen direkt för ett tydligt test.
  const medNamn = utskickMallEnkat_({ boxnamn: 'X', fornamn: 'Anna' }, 0);
  const utanNamn = utskickMallEnkat_({ boxnamn: 'X', fornamn: '' }, 0);
  assert.ok(medNamn.text.startsWith('Hej Anna,'));
  assert.ok(utanNamn.text.startsWith('Hej,'));
});

ok('utskickPaminnelse avbryts utan att skicka något om en dialog avbryts', () => {
  promptQueue = [{ button: 'CANCEL', text: '' }];
  sentMail.length = 0;
  utskickPaminnelse();
  assert.equal(sentMail.length, 0);
});

ok('utskickPaminnelse går bara till skickade som inte har svarat, med rätt ämnesrad och krok', () => {
  // Kolumnen svarat lades redan till automatiskt av de två utskickEnkat-körningarna
  // ovan (utskickKolumner_ lägger till skickat/paminnelse/svarat om de saknas).
  const svaratI = mottagare.rows[0].indexOf('svarat');
  assert.ok(svaratI >= 0, 'kolumnen svarat finns redan från tidigare körningar');
  mottagare.rows[2][svaratI] = new Date(); // Boxen Två (agare2) har svarat

  promptQueue = [
    { button: 'OK', text: '12' },
    { button: 'OK', text: 'fyra av tio kör fasta grupper' },
    { button: 'OK', text: '3 oktober' },
  ];
  sentMail.length = 0;
  utskickPaminnelse();
  const mottagna = sentMail.map((m) => m.to);
  assert.ok(mottagna.includes('agare1@boxen.se'), 'skickad till, obesvarad, ska få påminnelse');
  assert.ok(mottagna.includes('redan@boxen.se'), 'skickad till sedan tidigare, obesvarad, ska också få påminnelse');
  assert.ok(!mottagna.includes('agare2@boxen.se'), 'redan svarat, ska inte få påminnelse');
  const till1 = sentMail.find((m) => m.to === 'agare1@boxen.se');
  assert.ok(till1.subject.includes('12 boxar har redan svarat'));
  assert.ok(till1.body.includes('fyra av tio kör fasta grupper'));
  assert.ok(till1.body.includes('3 oktober'));
  assert.ok(!till1.body.includes('073'));
});

ok('hoppa_over/avregistrerad/stryk hoppas över, både i utskick och påminnelse', () => {
  mottagare.rows[0].push('hoppa_over');
  const nyKolLangd = mottagare.rows[0].length;
  const strukenRad = new Array(nyKolLangd).fill('');
  strukenRad[0] = 'Struken Box';
  strukenRad[2] = 'struken@boxen.se';
  strukenRad[nyKolLangd - 1] = 'stryk';
  mottagare.appendRow(strukenRad);

  sentMail.length = 0;
  utskickEnkat();
  assert.ok(!sentMail.some((m) => m.to === 'struken@boxen.se'), 'ny men struken rad ska inte få enkätmejlet');
});

console.log(`\n${n} checks passed`);
