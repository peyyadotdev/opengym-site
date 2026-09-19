// Kör leads/Code.gs i Node mot ett låtsas-kalkylark och kontrollerar beteendet.
// Körs med: node tests/test-codegs.js
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
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
  appendRow(v) { this.rows.push(v.slice()); }
  insertRowBefore(pos) { this.rows.splice(pos - 1, 0, []); }
  setFrozenRows(n) { this.frozen = n; }
}
global.SpreadsheetApp = { getActiveSpreadsheet() { return { getSheetByName(n) { return sheets[n] || null; }, insertSheet(n) { sheets[n] = new Sheet(n); return sheets[n]; } }; } };
global.LockService = { getScriptLock() { return { tryLock() { return true; }, releaseLock() {} }; } };
global.ContentService = { MimeType: { JSON: 'json' }, createTextOutput(t) { return { text: t, setMimeType() { return this; } }; } };

vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'leads', 'Code.gs'), 'utf8'), { filename: 'Code.gs' });
const post = (parameter) => JSON.parse(doPost({ parameter }).text);
const get = () => JSON.parse(doGet().text);
const col = (sheet, name) => sheet.rows[0].indexOf(name);
const cell = (sheet, rowIdx, name) => sheet.rows[rowIdx][col(sheet, name)];

let n = 0; const ok = (name, fn) => { fn(); n++; console.log('  ok', name); };

ok('doGet health', () => { const r = get(); assert.equal(r.ok, true); assert.equal(r.version, 2); });

ok('lead: valid', () => {
  const r = post({ email: 'Agare@Boxen.SE', box: 'Testbox', source: 'opengym_landing', timestamp: '2026-09-19T10:00:00Z' });
  assert.deepEqual(r, { ok: true });
  assert.equal(sheets.Leads.rows.length, 2);
  assert.deepEqual(sheets.Leads.rows[0], ['Mottaget', 'E-post', 'Box', 'Källa', 'Skickat från sidan']);
  assert.equal(sheets.Leads.rows[1][1], 'agare@boxen.se');
});
ok('lead: invalid email rejected', () => { assert.deepEqual(post({ email: 'nope' }), { ok: false, error: 'invalid_email' }); assert.equal(sheets.Leads.rows.length, 2); });
ok('honeypot: pretend success, store nothing', () => { assert.deepEqual(post({ email: 'bot@x.se', website: 'http://spam' }), { ok: true }); assert.equal(sheets.Leads.rows.length, 2); });

const rid = 'a1b2c3d4-e5f6-7890';
ok('survey: partial save creates row with headers', () => {
  const r = post({ action: 'survey', rid, step: '1', completed: '0', started_at: '2026-09-19T10:00:00Z', source: 'mail',
    answers: JSON.stringify({ q01_lan: 'Skåne', q02_typ: ['CrossFit-affiliate', 'Annat'], q02_annat: 'Bootcamp', q03_medlemmar: '80–150' }) });
  assert.deepEqual(r, { ok: true, rid, completed: false });
  const s = sheets['Enkät'];
  assert.equal(s.rows.length, 2);
  assert.deepEqual(s.rows[0].slice(0, 8), ['rid', 'startad', 'uppdaterad', 'klar', 'steg', 'tid_sek', 'kalla', 'q01_lan']);
  assert.equal(cell(s, 1, 'q02_typ'), 'CrossFit-affiliate | Annat');
  assert.equal(cell(s, 1, 'q02_annat'), 'Bootcamp');
  assert.equal(cell(s, 1, 'klar'), 'nej');
  assert.equal(cell(s, 1, 'kalla'), 'mail');
  assert.equal(s.frozen, 1);
});
ok('survey: second save same rid updates in place and keeps fields not resent', () => {
  post({ action: 'survey', rid, step: '3', completed: '0', started_at: '2026-09-19T10:00:00Z', source: 'mail', answers: JSON.stringify({ q13_pris: '900–1 100 kr' }) });
  const s = sheets['Enkät'];
  assert.equal(s.rows.length, 2);
  assert.equal(cell(s, 1, 'steg'), '3');
  assert.equal(cell(s, 1, 'q01_lan'), 'Skåne');
  assert.equal(cell(s, 1, 'q13_pris'), '900–1 100 kr');
});
ok('survey: completion stores emails separately, none in the answers row', () => {
  const r = post({ action: 'survey', rid, step: '7', completed: '1', started_at: '2026-09-19T10:00:00Z', duration_sec: '312', source: 'mail',
    answers: JSON.stringify({ q29_pilot: 'Ja', q30_rapport: 'Ja, skicka till min e-post', q28_gratis: 'Lika' }),
    pilot_email: 'Anna@Boxen.se', pilot_box: 'CrossFit Testet', report_email: 'anna@boxen.se' });
  assert.deepEqual(r, { ok: true, rid, completed: true });
  const s = sheets['Enkät'];
  assert.equal(cell(s, 1, 'klar'), 'ja');
  assert.equal(cell(s, 1, 'tid_sek'), '312');
  assert.ok(!s.rows.flat().some(v => String(v).includes('@')), 'no email in Enkät');
  const p = sheets['Pilotintresse'];
  assert.deepEqual(p.rows[0], ['rid', 'tidpunkt', 'e_post', 'box', 'svar']);
  assert.equal(p.rows.length, 2);
  assert.equal(cell(p, 1, 'rid'), rid);
  assert.equal(cell(p, 1, 'e_post'), 'anna@boxen.se');
  assert.equal(cell(p, 1, 'svar'), 'Ja');
  const rp = sheets['Rapportlista'];
  assert.deepEqual(rp.rows[0], ['datum', 'e_post']);
  assert.equal(rp.rows.length, 2);
  assert.match(String(cell(rp, 1, 'datum')), /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!rp.rows[0].includes('rid'));
});
ok('survey: re-submit does not duplicate pilot or report rows', () => {
  post({ action: 'survey', rid, step: '7', completed: '1', started_at: 'x', source: 'mail',
    answers: JSON.stringify({ q29_pilot: 'Kanske, berätta mer', q30_rapport: 'Ja, skicka till min e-post' }),
    pilot_email: 'anna@boxen.se', pilot_box: 'CrossFit Testet', report_email: 'anna@boxen.se' });
  assert.equal(sheets['Pilotintresse'].rows.length, 2);
  assert.equal(cell(sheets['Pilotintresse'], 1, 'svar'), 'Kanske, berätta mer');
  assert.equal(sheets['Rapportlista'].rows.length, 2);
});
ok('survey: pilot "Nej" and report "Nej tack" store no emails even if sent', () => {
  const rid2 = 'zzzz-2222-yyyy';
  post({ action: 'survey', rid: rid2, step: '7', completed: '1', started_at: 'x', source: 'ig',
    answers: JSON.stringify({ q29_pilot: 'Nej', q30_rapport: 'Nej tack' }), pilot_email: 'x@y.se', report_email: 'x@y.se' });
  assert.equal(sheets['Pilotintresse'].rows.length, 2);
  assert.equal(sheets['Rapportlista'].rows.length, 2);
  assert.equal(sheets['Enkät'].rows.length, 3);
});
ok('survey: report list grows with unique emails at shuffled positions', () => {
  for (let i = 0; i < 12; i++) {
    post({ action: 'survey', rid: 'rid-report-' + i + '-xx', step: '7', completed: '1', started_at: 'x', source: 'mail',
      answers: JSON.stringify({ q30_rapport: 'Ja, skicka till min e-post' }), report_email: `agare${i}@box.se` });
  }
  const rp = sheets['Rapportlista'];
  assert.equal(rp.rows.length, 14);
  const emails = rp.rows.slice(1).map(r => r[1]);
  assert.equal(new Set(emails).size, 13);
  assert.ok(rp.rows.slice(1).every(r => r.length === 2));
});
ok('survey: unknown question key gets appended as a new column; bad keys ignored', () => {
  post({ action: 'survey', rid, step: '7', completed: '0', started_at: 'x', source: 'mail', answers: JSON.stringify({ q31_ny: 'hej', evil: 'x', 'q01_lan': 'Skåne' }) });
  const s = sheets['Enkät'];
  assert.equal(s.rows[0][s.rows[0].length - 1], 'q31_ny');
  assert.equal(cell(s, 1, 'q31_ny'), 'hej');
  assert.equal(s.rows[0].indexOf('evil'), -1);
});
ok('survey: invalid rid / invalid JSON / oversize rejected', () => {
  assert.equal(post({ action: 'survey', rid: 'short', answers: '{}' }).error, 'invalid_rid');
  assert.equal(post({ action: 'survey', rid, answers: '{nope' }).error, 'invalid_answers');
  assert.equal(post({ action: 'survey', rid, answers: 'x'.repeat(30001) }).error, 'too_large');
});
ok('survey: long values clipped to 2000 chars', () => {
  post({ action: 'survey', rid, step: '2', completed: '0', started_at: 'x', source: 'mail', answers: JSON.stringify({ q09_irriterande: 'a'.repeat(5000) }) });
  assert.equal(cell(sheets['Enkät'], 1, 'q09_irriterande').length, 2000);
});

console.log(`\n${n} checks passed`);
