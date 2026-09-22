/**
 * Utskick.gs — skickar enkätmejlet och påminnelsen till boxägarna, ett mejl i taget.
 *
 * Klistras in som en EXTRA fil i samma Apps Script-projekt som Leads.gs, bundet till
 * samma kalkylark ("OpenGym leads"). Rör aldrig namnen doGet, doPost, saveLead,
 * saveSurvey, getOrCreateSheet, ensureHeaders, findRowByKey, upsertRow,
 * insertUniqueShuffled, clip, normEmail, isoDate, respond eller konstanterna
 * SHEET_LEADS, SHEET_SURVEY, SHEET_PILOT, SHEET_REPORT, LEADS_HEADER,
 * SURVEY_META, SURVEY_QUESTIONS, PILOT_HEADER, REPORT_HEADER, EMAIL_RE: de hör till
 * Leads.gs, som är webbappens skarpa, publicerade mottagningsslut för
 * leads/index.html och enkat/index.html. Allt i den här filen har därför
 * prefixet Utskick eller utskick för att garanterat inte krocka. Att lägga till
 * eller ändra en fil i projektet rör inte den redan distribuerade webbappen,
 * det kräver ett eget steg (Distribuera > Hantera distributioner > Ny version),
 * se kommentaren i Leads.gs. onOpen och menyfunktionerna nedan körs bara när
 * någon med redigeringsåtkomst öppnar kalkylarket i webbläsaren, aldrig som en
 * del av webbappens doPost/doGet.
 *
 * Flik "Mottagare": en rad per box. Rubrikrad med minst boxnamn (eller namn,
 * som i CSV-filerna) och e-post (eller epost). Kolumnnamn tolkas oberoende av
 * bindestreck, mellanslag och VERSALER. Kolumnerna skickat, paminnelse och
 * svarat läggs till automatiskt om de saknas.
 *
 * En valfri kolumn "förnamn" ger en personlig hälsning: "Hej Anna," med
 * kommat, annars bara "Hej" utan komma. En valfri kolumn "hoppa_over" (eller
 * "avregistrerad" eller "stryk") hoppar över raden helt, både i utskicket och
 * i påminnelsen.
 *
 * Mejlen skickas som HTML med en textversion som reserv, för att kunna göra
 * enkätlänken visuellt tydlig. Signaturen hämtas live, en gång per körning,
 * från Gmails egna inställningar för avsändaradressen (samma signatur som
 * "Skicka e-post som" i Gmail) via Gmails avancerade tjänst. Det kräver ett
 * engångssteg: i Apps Script-editorn, Tjänster (+) > Gmail API > Lägg till.
 * Första körningen efteråt ber om ett nytt godkännande för den utökade
 * behörigheten. Är tjänsten inte påslagen, eller saknas en signatur för
 * adressen, används en enkel reservsignatur i stället, utan telefonnummer.
 */

const UTSKICK_AVSANDARE = 'daniel@opengym.se';
const UTSKICK_AVSANDARNAMN = 'Daniel Dahlström';
const UTSKICK_ENKAT_URL = 'https://opengym.se/enkat/';
const UTSKICK_FLIK = 'Mottagare';

// Domänen är ny och ska värmas upp, se docs/undersokning/utskick/README.md i
// opengym: 30 till 50 mejl per dag i två till tre dagar. Kör menyvalet en
// gång om dagen i stället för att höja den här siffran.
const UTSKICK_MAX_PER_KORNING = 40;

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Utskick')
    .addItem('Skicka testmejl till ' + UTSKICK_AVSANDARE, 'utskickTest')
    .addSeparator()
    .addItem('Skicka enkäten (nästa omgång, max ' + UTSKICK_MAX_PER_KORNING + ')', 'utskickEnkat')
    .addItem('Skicka påminnelse (till obesvarade, max ' + UTSKICK_MAX_PER_KORNING + ')', 'utskickPaminnelse')
    .addToUi();
}

function utskickTest() {
  if (!utskickAvsandareOk_()) return;
  const till = UTSKICK_AVSANDARE;
  const signatur = utskickHamtaSignatur_();
  const mall = utskickMallEnkat_({ boxnamn: 'Testboxen', fornamn: 'Test' }, 0, signatur);
  GmailApp.sendEmail(till, mall.amne, mall.text, { from: UTSKICK_AVSANDARE, name: UTSKICK_AVSANDARNAMN, htmlBody: mall.html });
  SpreadsheetApp.getUi().alert('Testmejl skickat till ' + till + '. Kontrollera avsändare, ämnesrad, länken och signaturen innan du kör ett riktigt utskick.');
}

function utskickEnkat() {
  utskickKor_({
    skrivKolumn: 'skickat',
    filter: (rad, kol) => !utskickVarde_(rad, kol, 'skickat') && !utskickHoppaOver_(rad, kol),
    byggMall: utskickMallEnkat_,
  });
}

function utskickPaminnelse() {
  const ui = SpreadsheetApp.getUi();
  const antalSvar = ui.prompt('Påminnelse', 'Hur många boxar har svarat hittills? (siffra till ämnesraden)', ui.ButtonSet.OK_CANCEL);
  if (antalSvar.getSelectedButton() !== ui.Button.OK) return;
  const krokSvar = ui.prompt('Påminnelse', 'En siffra från de första svaren som krok, t.ex. "fyra av tio kör fasta grupper i någon form":', ui.ButtonSet.OK_CANCEL);
  if (krokSvar.getSelectedButton() !== ui.Button.OK) return;
  const datumSvar = ui.prompt('Påminnelse', 'Datum enkäten stänger, t.ex. "3 oktober":', ui.ButtonSet.OK_CANCEL);
  if (datumSvar.getSelectedButton() !== ui.Button.OK) return;

  const params = { antal: antalSvar.getResponseText().trim(), krok: krokSvar.getResponseText().trim(), stangerDatum: datumSvar.getResponseText().trim() };

  utskickKor_({
    skrivKolumn: 'paminnelse',
    filter: (rad, kol) => utskickVarde_(rad, kol, 'skickat') && !utskickVarde_(rad, kol, 'paminnelse') && !utskickVarde_(rad, kol, 'svarat') && !utskickHoppaOver_(rad, kol),
    byggMall: (data, index, signatur) => utskickMallPaminnelse_(data, index, params, signatur),
  });
}

/**
 * GmailApp skickar tyst från kontots huvudadress (daniel@peyya.dev) om from-adressen
 * inte finns bland kontots alias. Stoppa hellre än att skicka från fel adress.
 */
function utskickAvsandareOk_() {
  const alias = GmailApp.getAliases().map(a => a.toLowerCase());
  if (alias.indexOf(UTSKICK_AVSANDARE.toLowerCase()) !== -1) return true;
  SpreadsheetApp.getUi().alert(
    UTSKICK_AVSANDARE + ' är inte tillagd som avsändaradress i det här Gmail-kontot, så mejlen skulle gå från ' +
    Session.getActiveUser().getEmail() + '. Inget har skickats.\n\n' +
    'Lägg till den i Gmail > Inställningar > Konton > Skicka e-post som, och kör sedan igen.');
  return false;
}

/** Läser fliken Mottagare, filtrerar rader, skickar upp till UTSKICK_MAX_PER_KORNING och skriver dagens datum i skrivKolumn. */
function utskickKor_({ skrivKolumn, filter, byggMall }) {
  if (!utskickAvsandareOk_()) return;
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(UTSKICK_FLIK);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('Fliken "' + UTSKICK_FLIK + '" saknas. Skapa den och importera mottagarlistan, se kommentaren högst upp i Utskick.gs.');
    return;
  }
  const kol = utskickKolumner_(sheet);
  const sistaRad = sheet.getLastRow();
  if (sistaRad < 2) {
    SpreadsheetApp.getUi().alert('Inga rader att skicka till.');
    return;
  }
  const rader = sheet.getRange(2, 1, sistaRad - 1, sheet.getLastColumn()).getValues();
  const signatur = utskickHamtaSignatur_(); // en gång per körning, inte per mottagare

  let skickade = 0;
  const fel = [];
  for (let i = 0; i < rader.length && skickade < UTSKICK_MAX_PER_KORNING; i++) {
    const rad = rader[i];
    if (!filter(rad, kol)) continue;
    const epost = String(utskickVarde_(rad, kol, 'epost') || '').trim();
    if (!epost) continue;

    const data = { boxnamn: utskickVarde_(rad, kol, 'boxnamn') || 'er box', fornamn: utskickVarde_(rad, kol, 'fornamn') };
    const mall = byggMall(data, i, signatur);
    try {
      GmailApp.sendEmail(epost, mall.amne, mall.text, { from: UTSKICK_AVSANDARE, name: UTSKICK_AVSANDARNAMN, htmlBody: mall.html });
      sheet.getRange(i + 2, kol[skrivKolumn] + 1).setValue(new Date());
      skickade++;
      Utilities.sleep(2000); // en paus mellan varje mejl, ingen brådska
    } catch (e) {
      fel.push(epost + ': ' + e.message);
    }
  }

  let meddelande = skickade + ' mejl skickade.';
  if (fel.length) meddelande += '\n\nFel på ' + fel.length + ' rader:\n' + fel.join('\n');
  SpreadsheetApp.getUi().alert(meddelande);
}

/** "Hej Anna," med komma när förnamnet finns, annars bara "Hej" utan komma. */
function utskickHalsning_(fornamn) {
  return fornamn ? 'Hej ' + fornamn + ',' : 'Hej';
}

function utskickMallEnkat_(data, index, signatur) {
  const halsning = utskickHalsning_(data.fornamn);
  const amne = 'Hur driver ni ' + data.boxnamn + '? – 5 min enkät + Boxrapporten 2026';

  const stycken = [
    'Jag heter Daniel Dahlström. Min sambo Jessica grundade och drev ReShape CrossFit, där jag ansvarade för bland annat teknik, bokningssystem, prismodeller och hemsida. Nu bygger vi OpenGym – ett affärssystem för boxar inom CrossFit, HYROX och funktionell träning.',
    'Innan vi bygger klart vill vi förstå hur svenska boxar faktiskt arbetar idag: vilka system ni använder och vad de kostar, hur medlemmarna betalar, hur ni organiserar träningen, vad ni tar betalt och vad som får medlemmarna att stanna.',
    'Enkäten tar cirka fem minuter att svara på. Svaren sammanställs anonymt, och alla som deltar får tillbaka Boxrapporten 2026 – en sammanställning av bland annat systemkostnader, medlemspriser, betalningssätt, träningsupplägg och retention bland svenska boxar.',
  ];
  const efterLanken = [
    'I slutet av enkäten kan du också anmäla intresse för att bli en av tre pilotboxar. Pilotboxarna får använda OpenGym utan kostnad under pilotperioden och får vara med och påverka vad vi bygger.',
    'Tack för att du tar dig tid.',
    'Om du inte vill höra från oss igen, svara bara ”stryk” på det här mejlet så tar vi bort adressen.',
  ];

  const text = [
    halsning,
    '',
    stycken.join('\n\n'),
    '',
    UTSKICK_ENKAT_URL,
    '',
    efterLanken.join('\n\n'),
    '',
    'Mvh',
    'Daniel',
    '',
    utskickSignaturText_(signatur),
  ].join('\n');

  const html = utskickHtmlMejl_([
    utskickP_(utskickEsc_(halsning)),
    stycken.map((p) => utskickP_(utskickEsc_(p))).join(''),
    utskickLankBlock_(UTSKICK_ENKAT_URL),
    efterLanken.map((p) => utskickP_(utskickEsc_(p))).join(''),
    utskickP_('Mvh<br>Daniel'),
  ].join(''), signatur);

  return { amne, text, html };
}

function utskickMallPaminnelse_(data, index, params, signatur) {
  const amne = 'Påminnelse: fem minuter om ' + data.boxnamn + ', ' + params.antal + ' boxar har redan svarat';
  const stycken = [
    'Hej igen,',
    'För en vecka sedan skickade jag en enkät om hur svenska boxar drivs. ' + params.antal + ' boxar har svarat hittills, och redan nu syns till exempel att ' + params.krok + '.',
    'Vi stänger enkäten ' + params.stangerDatum + '. Fem minuter, och Boxrapporten 2026 kommer till dig när den är klar.',
  ];
  const efterLanken = [
    'Svara ”stryk” om du inte vill ha fler mejl från oss.',
  ];

  const text = [
    stycken.join('\n\n'),
    '',
    UTSKICK_ENKAT_URL,
    '',
    efterLanken.join('\n\n'),
    '',
    'Mvh',
    'Daniel',
    '',
    utskickSignaturText_(signatur),
  ].join('\n');

  const html = utskickHtmlMejl_([
    stycken.map((p) => utskickP_(utskickEsc_(p))).join(''),
    utskickLankBlock_(UTSKICK_ENKAT_URL),
    efterLanken.map((p) => utskickP_(utskickEsc_(p))).join(''),
    utskickP_('Mvh<br>Daniel'),
  ].join(''), signatur);

  return { amne, text, html };
}

// ---------- HTML, länk och signatur ----------

function utskickEsc_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function utskickP_(innerHtml) {
  return '<p style="margin:0 0 16px;">' + innerHtml + '</p>';
}

/** Enkätlänken, utmärkande: egen rad, fetstil, större text, som en liten rubrik. */
function utskickLankBlock_(url) {
  return '<p style="margin:24px 0;"><a href="' + utskickEsc_(url) + '" style="font-size:19px;font-weight:700;color:#111111;text-decoration:underline;">' + utskickEsc_(url) + '</a></p>';
}

function utskickHtmlMejl_(innerHtml, signatur) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a1a1a;max-width:560px;">'
    + innerHtml
    + '<div style="margin-top:24px;border-top:1px solid #e5e5e5;padding-top:12px;">' + (signatur || UTSKICK_RESERVSIGNATUR_HTML) + '</div>'
    + '</div>';
}

// Reservsignatur om Gmails avancerade tjänst inte är påslagen eller adressen
// saknar en konfigurerad signatur. Ingen telefon, se docs/undersokning/utskick.
const UTSKICK_RESERVSIGNATUR_HTML =
  '<strong>Daniel Dahlström</strong><br>Grundare, OpenGym<br>'
  + '<a href="mailto:daniel@opengym.se" style="color:#111111;">daniel@opengym.se</a> · '
  + '<a href="https://opengym.se" style="color:#111111;">opengym.se</a>';

/**
 * Hämtar den signatur (rå HTML) som är konfigurerad för UTSKICK_AVSANDARE under
 * Gmail > Inställningar > Konton > Skicka e-post som. Kräver den avancerade
 * Gmail-tjänsten (Tjänster > Gmail API i Apps Script-editorn). Returnerar en
 * tom sträng, inte ett fel, om tjänsten saknas eller inget är konfigurerat:
 * utskickSignaturHtml_/utskickSignaturText_ faller då tillbaka på reserven i
 * stället för att avbryta utskicket.
 */
function utskickHamtaSignatur_() {
  try {
    const sendAs = Gmail.Users.Settings.SendAs.get('me', UTSKICK_AVSANDARE);
    return (sendAs && sendAs.signature) || '';
  } catch (e) {
    return '';
  }
}

/** Enkel text-till-textversion av signaturen, för mejlets textkropp (reserv för klienter utan HTML). */
function utskickSignaturText_(signatur) {
  const html = signatur || UTSKICK_RESERVSIGNATUR_HTML;
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- Fliken Mottagare: kolumner och filter ----------

/** Rubrikrad, normaliserad till gemener utan bindestreck/mellanslag, mappad till kolumnindex (0-baserat). */
function utskickKolumner_(sheet) {
  const rubriker = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const kol = {};
  rubriker.forEach((namn, i) => {
    kol[utskickNormalisera_(namn)] = i;
  });
  if (!('boxnamn' in kol) && 'namn' in kol) kol['boxnamn'] = kol['namn'];
  if (!('boxnamn' in kol) || !('epost' in kol)) {
    throw new Error('Kolumnen "boxnamn" (eller "namn") och "e-post" (eller "epost") måste finnas i rubrikraden på fliken ' + sheet.getName() + '.');
  }
  const kravda = { skickat: 0, paminnelse: 0, svarat: 0 };
  const rubrikRad = 1;
  Object.keys(kravda).forEach((namn) => {
    if (!(namn in kol)) {
      const nyKol = sheet.getLastColumn() + 1;
      sheet.getRange(rubrikRad, nyKol).setValue(namn);
      kol[namn] = nyKol - 1;
    }
  });
  return kol;
}

/** Rubriker jämförs utan skiftläge, tecken och å/ä/ö: "Förnamn", "förnamn" och "fornamn" är samma kolumn, liksom "E-post" och "epost". */
function utskickNormalisera_(s) {
  return String(s).toLowerCase().replace(/[åä]/g, 'a').replace(/ö/g, 'o').replace(/[^a-z0-9]/g, '');
}

function utskickVarde_(rad, kol, namn) {
  const i = kol[utskickNormalisera_(namn)];
  return i === undefined ? undefined : rad[i];
}

function utskickHoppaOver_(rad, kol) {
  return Boolean(utskickVarde_(rad, kol, 'hoppa_over') || utskickVarde_(rad, kol, 'avregistrerad') || utskickVarde_(rad, kol, 'stryk'));
}
