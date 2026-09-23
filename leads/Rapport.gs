/**
 * Rapport.gs — läget i Boxrapporten 2026, för dem som svarat på enkäten.
 *
 * Klistras in som en EXTRA fil i Apps Script-projektet OpenGym Collect, bredvid Leads.gs och
 * Utskick.gs. Alla namn här har prefixet RAPPORT_ eller rapport, eftersom filerna delar samma
 * globala scope (se kommentaren i Leads.gs).
 *
 * Två saker:
 *  1. rapportLage() räknar ihop fem siffror ur fliken Enkät. Leads.gs doGet svarar med dem på
 *     ?action=lage, och sidan opengym.se/enkat/lage/ visar dem. Bara summor lämnar arket, aldrig
 *     rader, svars-id eller fritext.
 *  2. rapportSkickaLage() mejlar dem på Rapportlista när 20 och 40 boxar har svarat. Körs från
 *     menyn Utskick i kalkylarket, aldrig av sig själv.
 *
 * Siffrorna uppdateras i steg, inte för varje svar (Daniel, 2026-09-23): de räknas på de 10,
 * 20 eller 40 första inskickade svaren, i den ordning de skickades in. Ett nytt svar ändrar
 * alltså ingenting förrän nästa steg är nått, och då har många svar tillkommit på en gång. Så
 * går det inte att se vad en enskild box svarat genom att jämföra sidan före och efter. Efter
 * 40 står siffrorna still tills hela rapporten är klar.
 *
 * Reglerna från docs/undersokning/boxrapporten-2026.md gäller: siffrorna skrivs som "x av y",
 * och ett vanligaste svar visas bara när minst fem boxar gett det.
 *
 * Efter en ändring här eller i Leads.gs: Distribuera > Hantera distributioner > pennan >
 * Version: Ny version > Distribuera. Aldrig "Ny distribution", då byts adressen.
 */

const RAPPORT_STEG = [10, 20, 40];
const RAPPORT_MEJLSTEG = [20, 40];
const RAPPORT_MIN_GRUPP = 5;
const RAPPORT_SIDA = 'https://opengym.se/enkat/lage/';
const RAPPORT_MAX_PER_KORNING = 40;

/** Siffrorna för sidan. steg är 0 tills tio boxar svarat, och då följer inga siffror med. */
function rapportLage() {
  const svar = rapportInskickade_();
  const steg = RAPPORT_STEG.filter(function (s) { return s <= svar.length; }).pop() || 0;
  const nasta = RAPPORT_STEG.filter(function (s) { return s > steg; })[0] || null;
  if (!steg) return { ok: true, steg: 0, nasta: nasta };

  const urval = svar.slice(0, steg);
  const falt = function (kod) { return urval.map(function (r) { return String(r[kod] || '').trim(); }).filter(Boolean); };
  const andel = function (varden, villkor) { return { antal: varden.filter(villkor).length, av: varden.length }; };

  return {
    ok: true,
    steg: steg,
    nasta: nasta,
    fasta_grupper: andel(falt('q10_modell'), function (v) { return /^(Fasta grupper|Både och)/.test(v); }),
    systemkostnad: rapportVanligast_(falt('q08_kostnad')),
    medlemspris: rapportVanligast_(falt('q13_pris')),
    betalkostnad_okand: andel(falt('q18_betalkostnad'), function (v) { return v === 'Nej'; }),
    retention_okand: andel(falt('q23_retention'), function (v) { return v === 'Vet inte'; }),
  };
}

/**
 * Det vanligaste svaret, utan "Vet inte". Visas bara om minst RAPPORT_MIN_GRUPP boxar gett det
 * och inget annat svar är lika vanligt. Annars är vanligast null.
 */
function rapportVanligast_(varden) {
  const vetInte = varden.filter(function (v) { return v === 'Vet inte'; }).length;
  const kanda = varden.filter(function (v) { return v !== 'Vet inte'; });
  const antal = {};
  kanda.forEach(function (v) { antal[v] = (antal[v] || 0) + 1; });
  const ordning = Object.keys(antal).sort(function (a, b) { return antal[b] - antal[a]; });
  const topp = ordning[0];
  const delad = ordning.length > 1 && antal[ordning[1]] === antal[topp];
  const visas = topp && !delad && antal[topp] >= RAPPORT_MIN_GRUPP;
  return { vanligast: visas ? topp : null, antal: visas ? antal[topp] : null, av: kanda.length, vet_inte: vetInte };
}

/** De inskickade svaren som objekt, i den ordning de skickades in. */
function rapportInskickade_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SURVEY);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const varden = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  const rubriker = varden[0].map(String);
  const tid = function (v) { const t = v instanceof Date ? v.getTime() : new Date(v).getTime(); return isNaN(t) ? Infinity : t; };
  return varden.slice(1)
    .map(function (rad, i) {
      const r = { _rad: i };
      rubriker.forEach(function (h, j) { r[h] = rad[j]; });
      return r;
    })
    .filter(function (r) { return String(r.klar) === 'ja'; })
    // En inskickad rad sparas inte om, så uppdaterad är tiden den skickades in.
    .sort(function (a, b) { return (tid(a.uppdaterad) - tid(b.uppdaterad)) || (a._rad - b._rad); });
}

// ---------- Mejlet vid 20 och 40 svar ----------

/**
 * Mejlar läget till dem på Rapportlista, vid 20 och 40 svar. Skriver dagens datum i kolumnen
 * lage_20 eller lage_40 för varje mottagare, så att en ny körning bara når dem som inte fått det.
 */
function rapportSkickaLage() {
  const ui = SpreadsheetApp.getUi();
  const lage = rapportLage();
  const steg = RAPPORT_MEJLSTEG.filter(function (s) { return s <= lage.steg; }).pop();
  if (!steg) {
    ui.alert('Mejlet om läget skickas när 20 och 40 boxar har svarat. Siffrorna gäller nu ' + (lage.steg || 'färre än 10') + ' svar.');
    return;
  }
  const lista = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_REPORT);
  if (!lista || lista.getLastRow() < 2) { ui.alert('Rapportlista är tom. Ingen har bett om rapporten än.'); return; }

  const kolumn = 'lage_' + steg;
  const rubriker = ensureHeaders(lista, REPORT_HEADER.concat([kolumn]));
  const kE = rubriker.indexOf('e_post');
  const kS = rubriker.indexOf(kolumn);
  const rader = lista.getRange(2, 1, lista.getLastRow() - 1, rubriker.length).getValues();
  const kvar = [];
  rader.forEach(function (rad, i) {
    const epost = String(rad[kE] || '').trim();
    if (epost && !rad[kS]) kvar.push({ epost: epost, rad: i + 2 });
  });
  if (!kvar.length) { ui.alert('Alla på Rapportlista har redan fått mejlet om ' + steg + ' svar.'); return; }

  const antal = Math.min(kvar.length, RAPPORT_MAX_PER_KORNING);
  const svar = ui.alert('Skicka läget',
    antal + ' av ' + kvar.length + ' mottagare får mejlet om att ' + steg + ' boxar har svarat. Skicka nu?', ui.ButtonSet.YES_NO);
  if (svar !== ui.Button.YES) return;
  if (!utskickAvsandareOk_()) return;

  const signatur = utskickHamtaSignatur_();
  const mall = rapportMallLage_(lage, signatur);
  let skickade = 0;
  const fel = [];
  kvar.slice(0, antal).forEach(function (m) {
    try {
      GmailApp.sendEmail(m.epost, mall.amne, mall.text, { from: UTSKICK_AVSANDARE, name: UTSKICK_AVSANDARNAMN, htmlBody: mall.html });
      lista.getRange(m.rad, kS + 1).setValue(new Date());
      skickade++;
      Utilities.sleep(2000);
    } catch (e) {
      fel.push(m.epost + ': ' + e.message);
    }
  });
  let meddelande = skickade + ' mejl skickade.';
  if (kvar.length > antal) meddelande += ' ' + (kvar.length - antal) + ' återstår, kör igen för dem.';
  if (fel.length) meddelande += '\n\nFel på ' + fel.length + ' rader:\n' + fel.join('\n');
  ui.alert(meddelande);
}

function rapportMallLage_(lage, signatur) {
  const amne = 'Boxrapporten 2026: ' + lage.steg + ' boxar har svarat';
  const fasta = lage.fasta_grupper;
  const stycken = [
    'Hej,',
    'Tack igen för att du svarade på enkäten om hur boxar drivs. Nu har ' + lage.steg + ' boxar svarat, och du kan se läget i fem siffror, till exempel att ' +
      fasta.antal + ' av ' + fasta.av + ' kör fasta grupper i någon form.',
    lage.nasta
      ? 'Siffrorna uppdateras en gång till när ' + lage.nasta + ' boxar har svarat, och hela Boxrapporten 2026 kommer till dig när enkäten har stängt.'
      : 'Det här är sista uppdateringen. Hela Boxrapporten 2026 kommer till dig när enkäten har stängt.',
    'Sidan är bara för er som svarat. Dela gärna enkäten med andra boxägare, men inte den här länken.',
  ];
  const text = [stycken.join('\n\n'), '', RAPPORT_SIDA, '', 'Mvh', 'Daniel', '', utskickSignaturText_(signatur)].join('\n');
  const html = utskickHtmlMejl_([
    stycken.map(function (p) { return utskickP_(utskickEsc_(p)); }).join(''),
    utskickLankBlock_(RAPPORT_SIDA),
    utskickP_('Mvh<br>Daniel'),
  ].join(''), signatur);
  return { amne: amne, text: text, html: html };
}
