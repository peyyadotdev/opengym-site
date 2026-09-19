/**
 * OpenGym: mottagare för leadformuläret på landningssidan (index.html).
 *
 * Kör som Google Apps Script kopplat till ett Google Sheet. Varje anmälan
 * blir en rad i fliken "Leads". Samma upplägg som Peyyas landningssida.
 *
 * Så här sätter du upp det (cirka fem minuter):
 *
 *  1. Skapa ett nytt Google Sheet, till exempel "OpenGym leads".
 *  2. Tillägg > Apps Script. Ersätt innehållet i Code.gs med den här filen. Spara.
 *  3. Distribuera > Ny distribution > Typ: Webbapp.
 *       Kör som:            Jag (ditt konto)
 *       Vem har åtkomst:    Alla
 *     Godkänn behörigheterna när du blir tillfrågad.
 *  4. Kopiera webbappens URL (slutar på /exec) och klistra in den som
 *     SIGNUP_ENDPOINT i index.html.
 *  5. Testa: öppna URL:en i webbläsaren, du ska få {"ok":true,"service":"opengym-leads"}.
 *     Skicka sedan en anmälan från sidan och kontrollera att raden dyker upp.
 *
 * Ändrar du koden senare: Distribuera > Hantera distributioner > redigera > Ny version.
 * URL:en behålls då. En ny distribution ger en ny URL.
 *
 * Formuläret skickar formulärkodat (application/x-www-form-urlencoded) utan
 * egna headers, så förfrågan räknas som "enkel" och Apps Script svarar utan
 * CORS-preflight. Fälten är: email, box, source, timestamp.
 */

const SHEET_NAME = 'Leads';
const HEADER = ['Mottaget', 'E-post', 'Box', 'Källa', 'Skickat från sidan'];

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    const params = (e && e.parameter) || {};
    const email = String(params.email || '').trim().toLowerCase().slice(0, 254);
    const box = String(params.box || '').trim().slice(0, 120);
    const source = String(params.source || '').trim().slice(0, 60);
    const sentAt = String(params.timestamp || '').trim().slice(0, 40);

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return respond({ ok: false, error: 'invalid_email' });
    }

    const sheet = getSheet();
    sheet.appendRow([new Date(), email, box, source, sentAt]);

    return respond({ ok: true });
  } catch (err) {
    return respond({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// Gör det enkelt att kontrollera att webbappen är publicerad.
function doGet() {
  return respond({ ok: true, service: 'opengym-leads' });
}

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADER);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function respond(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
