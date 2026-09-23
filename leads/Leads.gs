/**
 * OpenGym: mottagare för leadformuläret på landningssidan (index.html) och
 * för enkäten "Så driver du din box 2026" (enkat/index.html).
 *
 * Kör som Google Apps Script kopplat till ett Google Sheet. Flikar:
 *
 *   Leads          en rad per intresseanmälan från landningssidan
 *   Enkät          en rad per enkätsvar (svars-id, status, svaren), ingen e-post
 *   Pilotintresse  svars-id, e-post och box för dem som vill bli pilotgym.
 *                  Kopplas till raden i Enkät via svars-id, eftersom ni behöver
 *                  veta vilken box svaren gäller
 *   Rapportlista   bara e-post och datum för dem som vill ha Boxrapporten.
 *                  Inget svars-id, bara datum (inte klockslag) och raden läggs
 *                  in på slumpad plats, så att listan inte går att para ihop
 *                  med svaren
 *
 * Så här sätter du upp det (cirka fem minuter):
 *
 *  1. Skapa ett nytt Google Sheet, till exempel "OpenGym leads".
 *  2. Tillägg > Apps Script. Döp projektet till "OpenGym Collect". Byt namn på Code.gs
 *     till Leads.gs och ersätt innehållet med den här filen. Spara.
 *  3. Distribuera > Ny distribution > Typ: Webbapp.
 *       Kör som:            Jag (ditt konto)
 *       Vem har åtkomst:    Alla
 *     Godkänn behörigheterna när du blir tillfrågad.
 *  4. Kopiera webbappens URL (slutar på /exec) och klistra in den som
 *     SIGNUP_ENDPOINT i index.html och i enkat/index.html.
 *  5. Testa: öppna URL:en i webbläsaren, du ska få {"ok":true,"service":"opengym-leads",...}.
 *
 * Alla .gs-filer i ett Apps Script-projekt delar samma globala scope. En annan fil i
 * projektet får därför inte deklarera något som redan finns här, till exempel doPost,
 * doGet, respond, clip eller SHEET_LEADS. Ett dubbelt const-namn stoppar hela projektet,
 * och då tar web appen inte emot några anmälningar eller enkätsvar.
 *
 * Ändrar du koden senare: Distribuera > Hantera distributioner > redigera (pennan)
 * > Version: Ny version > Distribuera. URL:en behålls då. Glöm inte det här steget,
 * annars kör webbappen fortfarande den gamla koden.
 *
 * Formulären skickar formulärkodat (application/x-www-form-urlencoded) utan
 * egna headers, så requesten räknas som "simple request" och Apps Script svarar utan
 * CORS-preflight.
 *
 * Fält från landningssidan (action saknas eller = lead):
 *   email, box, source, timestamp, website (honeypot, ska vara tomt)
 *
 * Fält från enkäten (action = survey):
 *   rid           svars-id som webbläsaren slumpar fram, samma vid varje sparning
 *   step          senast avklarad del (1–7)
 *   completed     1 när svaren skickats in, annars 0
 *   started_at    när enkäten startades (ISO-tid från webbläsaren)
 *   duration_sec  total tid i sekunder, skickas vid inskick
 *   source        varifrån länken kom (mail, ig, web ...)
 *   answers       JSON-objekt med alla svar, nyckel = frågekod (q01_lan ...)
 *   pilot_email, pilot_box, report_email   bara vid inskick, sparas separat
 *   website       honeypot, ska vara tomt
 */

const SHEET_LEADS = 'Leads';
const SHEET_SURVEY = 'Enkät';
const SHEET_PILOT = 'Pilotintresse';
const SHEET_REPORT = 'Rapportlista';

const LEADS_HEADER = ['Mottaget', 'E-post', 'Box', 'Källa', 'Skickat från sidan'];
const SURVEY_META = ['rid', 'startad', 'uppdaterad', 'klar', 'steg', 'tid_sek', 'kalla'];
// Kolumnordningen i fliken Enkät. Nya frågekoder som dyker upp läggs till sist automatiskt.
const SURVEY_QUESTIONS = [
  'q01_lan', 'q02_typ', 'q02_annat', 'q03_medlemmar', 'q04_anlaggningar', 'q05_coacher',
  'q06_system', 'q06_annat', 'q07_logg', 'q07_annat', 'q08_kostnad', 'q09_irriterande',
  'q10_modell', 'q10_annat', 'q11_utebliven', 'q11_annat', 'q12_fungerat', 'q13_pris', 'q14_offpeak',
  'q15_3plus', 'q15_1till2', 'q15_sallan', 'q16_opengym',
  'q17_betalsatt', 'q17_annat', 'q17b_storst', 'q18_betalkostnad', 'q19_swish', 'q19b_varfor', 'q20_omregistrering',
  'q21_dorr', 'q21_annat', 'q22_automation',
  'q23_retention', 'q24_avhopp', 'q24_annat', 'q25_vikarie', 'q25b_hitta', 'q26_pass', 'q26_grupp',
  'q27_byta', 'q28_gratis', 'q28b_varfor', 'q29_pilot', 'q30_rapport'
];
const PILOT_HEADER = ['rid', 'tidpunkt', 'e_post', 'box', 'svar'];
const REPORT_HEADER = ['datum', 'e_post'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    const params = (e && e.parameter) || {};

    // Honeypot: en robot har fyllt i det dolda fältet. Låtsas lyckas, spara inget.
    if (clip(params.website, 10)) return respond({ ok: true });

    const action = clip(params.action, 20) || 'lead';
    if (action === 'survey') return respond(saveSurvey(params));
    return respond(saveLead(params));
  } catch (err) {
    return respond({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// Gör det enkelt att kontrollera att webbappen är publicerad och vilken version som kör.
// ?action=lage ger läget i Boxrapporten ur Rapport.gs: bara summor, aldrig rader.
function doGet(e) {
  const action = e && e.parameter ? clip(e.parameter.action, 20) : '';
  if (action === 'lage' && typeof rapportLage === 'function') {
    try { return respond(rapportLage()); } catch (err) { return respond({ ok: false, error: 'tekniskt' }); }
  }
  return respond({ ok: true, service: 'opengym-leads', version: 2, actions: ['lead', 'survey'] });
}

// ---------- Leads från landningssidan ----------

function saveLead(p) {
  const email = normEmail(p.email);
  if (!email) return { ok: false, error: 'invalid_email' };

  const sheet = getOrCreateSheet(SHEET_LEADS, LEADS_HEADER);
  sheet.appendRow([new Date(), email, clip(p.box, 120), clip(p.source, 60), clip(p.timestamp, 40)]);
  return { ok: true };
}

// ---------- Enkäten ----------

function saveSurvey(p) {
  const rid = clip(p.rid, 64);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(rid)) return { ok: false, error: 'invalid_rid' };

  const raw = String(p.answers || '');
  if (raw.length > 30000) return { ok: false, error: 'too_large' };
  let answers = {};
  if (raw) {
    try { answers = JSON.parse(raw); } catch (_) { return { ok: false, error: 'invalid_answers' }; }
  }
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) answers = {};

  const completed = String(p.completed) === '1';
  const row = {
    rid: rid,
    startad: clip(p.started_at, 40),
    uppdaterad: new Date(),
    klar: completed ? 'ja' : 'nej',
    steg: clip(p.step, 5),
    tid_sek: clip(p.duration_sec, 10),
    kalla: clip(p.source, 60)
  };
  Object.keys(answers).forEach(function (key) {
    if (!/^q\d{2}[a-z]?(_[a-z0-9]+)?$/.test(key)) return;
    const value = answers[key];
    row[key] = clip(Array.isArray(value) ? value.join(' | ') : value, 2000);
  });

  const survey = getOrCreateSheet(SHEET_SURVEY, SURVEY_META.concat(SURVEY_QUESTIONS));
  upsertRow(survey, 'rid', rid, row, SURVEY_META.concat(SURVEY_QUESTIONS));

  if (completed) {
    // E-post sparas aldrig i svarsraden. Pilotintresse länkas via rid, rapportlistan inte alls.
    const pilotAnswer = clip(answers.q29_pilot, 40);
    const pilotEmail = normEmail(p.pilot_email);
    if (/^(Ja|Kanske)/.test(pilotAnswer) && pilotEmail) {
      const pilot = getOrCreateSheet(SHEET_PILOT, PILOT_HEADER);
      upsertRow(pilot, 'rid', rid, {
        rid: rid, tidpunkt: new Date(), e_post: pilotEmail, box: clip(p.pilot_box, 120), svar: pilotAnswer
      }, PILOT_HEADER);
    }

    const reportEmail = normEmail(p.report_email);
    if (/^Ja/.test(clip(answers.q30_rapport, 40)) && reportEmail) {
      const report = getOrCreateSheet(SHEET_REPORT, REPORT_HEADER);
      insertUniqueShuffled(report, 'e_post', reportEmail, { datum: isoDate(new Date()), e_post: reportEmail }, REPORT_HEADER);
    }
  }

  return { ok: true, rid: rid, completed: completed };
}

// ---------- Hjälpfunktioner för arket ----------

function getOrCreateSheet(name, header) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Skriptet är inte kopplat till något kalkylark. Öppna det från arket via Tillägg > Apps Script.');
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  ensureHeaders(sheet, header);
  return sheet;
}

// Ser till att rubrikraden innehåller alla önskade kolumner, i befintlig ordning
// plus nya sist. Returnerar den kompletta rubriklistan.
function ensureHeaders(sheet, wanted) {
  const lastCol = sheet.getLastColumn();
  let headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
  while (headers.length && !headers[headers.length - 1]) headers.pop();
  const missing = wanted.filter(function (h) { return headers.indexOf(h) === -1; });
  if (missing.length) {
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
    headers = headers.concat(missing);
  }
  if (sheet.getLastRow() === 0 || headers.length) sheet.setFrozenRows(1);
  return headers;
}

function findRowByKey(sheet, headers, keyName, keyValue) {
  const keyCol = headers.indexOf(keyName) + 1;
  const lastRow = sheet.getLastRow();
  if (keyCol < 1 || lastRow < 2) return 0;
  const cell = sheet.getRange(2, keyCol, lastRow - 1, 1).createTextFinder(keyValue).matchEntireCell(true).findNext();
  return cell ? cell.getRow() : 0;
}

// Uppdaterar raden med samma nyckel om den finns, annars läggs en ny rad till.
// Bara fält som finns i rowObj skrivs, övriga celler lämnas orörda.
function upsertRow(sheet, keyName, keyValue, rowObj, baseHeaders) {
  const headers = ensureHeaders(sheet, baseHeaders.concat(Object.keys(rowObj)));
  const rowIndex = findRowByKey(sheet, headers, keyName, keyValue);
  if (rowIndex) {
    const range = sheet.getRange(rowIndex, 1, 1, headers.length);
    const values = range.getValues()[0];
    headers.forEach(function (h, i) { if (Object.prototype.hasOwnProperty.call(rowObj, h)) values[i] = rowObj[h]; });
    range.setValues([values]);
  } else {
    sheet.appendRow(headers.map(function (h) { return Object.prototype.hasOwnProperty.call(rowObj, h) ? rowObj[h] : ''; }));
  }
}

// Lägger till raden om nyckeln inte redan finns, på en slumpad plats bland
// de befintliga raderna så att ordningen inte avslöjar när svaret kom in.
function insertUniqueShuffled(sheet, keyName, keyValue, rowObj, baseHeaders) {
  const headers = ensureHeaders(sheet, baseHeaders.concat(Object.keys(rowObj)));
  if (findRowByKey(sheet, headers, keyName, keyValue)) return false;
  const values = headers.map(function (h) { return Object.prototype.hasOwnProperty.call(rowObj, h) ? rowObj[h] : ''; });
  const lastRow = sheet.getLastRow();
  const pos = 2 + Math.floor(Math.random() * Math.max(lastRow, 1)); // 2 .. lastRow+1
  if (lastRow < 2 || pos > lastRow) {
    sheet.appendRow(values);
  } else {
    sheet.insertRowBefore(pos);
    sheet.getRange(pos, 1, 1, values.length).setValues([values]);
  }
  return true;
}

// ---------- Små hjälpare ----------

function clip(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function normEmail(value) {
  const email = clip(value, 254).toLowerCase();
  return EMAIL_RE.test(email) ? email : '';
}

function isoDate(d) {
  const pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function respond(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
