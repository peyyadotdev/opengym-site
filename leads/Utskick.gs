/**
 * Utskick.gs — skickar enkätmejlet och påminnelsen till boxägarna, ett mejl i taget.
 *
 * Klistras in som en EXTRA fil i samma Apps Script-projekt som Code.gs, bundet till
 * samma kalkylark ("OpenGym leads"). Rör aldrig namnen doGet, doPost, saveLead,
 * saveSurvey, getOrCreateSheet, ensureHeaders, findRowByKey, upsertRow,
 * insertUniqueShuffled, clip, normEmail, isoDate, respond eller konstanterna
 * SHEET_LEADS, SHEET_SURVEY, SHEET_PILOT, SHEET_REPORT, LEADS_HEADER,
 * SURVEY_META, SURVEY_QUESTIONS, PILOT_HEADER, REPORT_HEADER, EMAIL_RE: de hör till
 * Code.gs, som är webbappens skarpa, publicerade mottagningsslut för
 * leads/index.html och enkat/index.html. Allt i den här filen har därför
 * prefixet Utskick eller utskick för att garanterat inte krocka. Att lägga till
 * eller ändra en fil i projektet rör inte den redan distribuerade webbappen,
 * det kräver ett eget steg (Distribuera > Hantera distributioner > Ny version),
 * se kommentaren i Code.gs. onOpen och menyfunktionerna nedan körs bara när
 * någon med redigeringsåtkomst öppnar kalkylarket i webbläsaren, aldrig som en
 * del av webbappens doPost/doGet.
 *
 * Flik "Mottagare": en rad per box. Rubrikrad med minst boxnamn (eller namn,
 * som i CSV-filerna) och e-post (eller epost). Kolumnnamn tolkas oberoende av
 * bindestreck, mellanslag och VERSALER. Kolumnerna skickat, paminnelse och
 * svarat läggs till automatiskt om de saknas.
 *
 * Bygg fliken en gång: skapa den, döp den till "Mottagare", och importera
 * docs/undersokning/mottagarlista-crossfit.csv och mottagarlista-hyrox.csv
 * (i det privata repot opengym) med Arkiv > Importera > Ladda upp > Lägg till
 * nya rader, en gång per fil. De två filerna har olika kolumner, det gör inget,
 * bara boxnamn/namn och e-post/epost måste finnas med.
 *
 * En valfri kolumn "förnamn" ger en personlig hälsning, annars blir det "Hej,".
 * En valfri kolumn "hoppa_over" (eller "avregistrerad" eller "stryk") hoppar
 * över raden helt, både i utskicket och i påminnelsen.
 */

const UTSKICK_AVSANDARE = 'daniel@opengym.se';
const UTSKICK_AVSANDARNAMN = 'Daniel Dahlström';
const UTSKICK_ENKAT_URL = 'https://opengym.se/enkat/';
const UTSKICK_FLIK = 'Mottagare';

// Domänen är ny och ska värmas upp, se docs/undersokning/utskick/README.md i
// opengym: 30 till 50 mejl per dag i två till tre dagar. Kör menyvalet en
// gång om dagen i stället för att höja den här siffran.
const UTSKICK_MAX_PER_KORNING = 40;

// Var tredje mottagare (index 0, 3, 6, …) får den alternativa ämnesraden när
// detta är satt till true, för ett enkelt A/B-test på en tredjedel av listan.
const UTSKICK_TESTA_ALT_AMNE = false;

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Utskick')
    .addItem('Skicka testmejl till mig', 'utskickTest')
    .addSeparator()
    .addItem('Skicka enkäten (nästa omgång, max ' + UTSKICK_MAX_PER_KORNING + ')', 'utskickEnkat')
    .addItem('Skicka påminnelse (till obesvarade, max ' + UTSKICK_MAX_PER_KORNING + ')', 'utskickPaminnelse')
    .addToUi();
}

function utskickTest() {
  const till = Session.getActiveUser().getEmail();
  const mall = utskickMallEnkat_({ boxnamn: 'Testboxen', fornamn: 'Test' }, 0);
  GmailApp.sendEmail(till, mall.amne, mall.text, { from: UTSKICK_AVSANDARE, name: UTSKICK_AVSANDARNAMN });
  SpreadsheetApp.getUi().alert('Testmejl skickat till ' + till + '. Kontrollera avsändare, ämnesrad och länk innan du kör ett riktigt utskick.');
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
    byggMall: (data, index) => utskickMallPaminnelse_(data, index, params),
  });
}

/** Läser fliken Mottagare, filtrerar rader, skickar upp till UTSKICK_MAX_PER_KORNING och skriver dagens datum i skrivKolumn. */
function utskickKor_({ skrivKolumn, filter, byggMall }) {
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

  let skickade = 0;
  const fel = [];
  for (let i = 0; i < rader.length && skickade < UTSKICK_MAX_PER_KORNING; i++) {
    const rad = rader[i];
    if (!filter(rad, kol)) continue;
    const epost = String(utskickVarde_(rad, kol, 'epost') || '').trim();
    if (!epost) continue;

    const data = { boxnamn: utskickVarde_(rad, kol, 'boxnamn') || 'din box', fornamn: utskickVarde_(rad, kol, 'fornamn') };
    const mall = byggMall(data, i);
    try {
      GmailApp.sendEmail(epost, mall.amne, mall.text, { from: UTSKICK_AVSANDARE, name: UTSKICK_AVSANDARNAMN });
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

function utskickMallEnkat_(data, index) {
  const halsning = data.fornamn ? 'Hej ' + data.fornamn + ',' : 'Hej,';
  const amne = (UTSKICK_TESTA_ALT_AMNE && index % 3 === 0)
    ? 'Vad betalar svenska boxar för sina system? Hjälp oss ta reda på det'
    : 'Fem minuter om hur ni driver ' + data.boxnamn + ', och branschsiffrorna tillbaka';
  const text = [
    halsning,
    '',
    'Jag heter Daniel Dahlström. Min sambo Jessica grundade och drev ReShape CrossFit, där jag skötte teknik, bokningssystem, prismodeller och hemsida, och jag bygger nu OpenGym, ett affärssystem för boxar inom CrossFit, HYROX och funktionell träning. Innan vi bygger klart vill vi veta hur svenska boxar faktiskt drivs: vilka system ni kör och vad de kostar, hur medlemmarna betalar, om ni kör fasta grupper, vad ni har på dörren och vad som får medlemmar att stanna.',
    '',
    'Enkäten tar fem till sju minuter. Svaren sammanställs anonymt, och alla som svarar får Boxrapporten 2026: vad boxar betalar för system, vilka medlemspriser som gäller, hur betalningarna fördelar sig, hur vanligt fasta grupper är och hur retention ser ut. Den bilden finns inte någon annanstans i dag.',
    '',
    UTSKICK_ENKAT_URL,
    '',
    'Sist i enkäten kan du anmäla intresse för att bli ett av tre pilotgym, med allt gratis under piloten och direkt inflytande över vad som byggs.',
    '',
    'Tack för din tid. Vill du inte höra av oss igen, svara "stryk" på det här mejlet så tar vi bort adressen.',
    '',
    'Daniel Dahlström',
    'OpenGym, opengym.se',
  ].join('\n');
  return { amne, text };
}

function utskickMallPaminnelse_(data, index, params) {
  const amne = 'Påminnelse: fem minuter om ' + data.boxnamn + ', ' + params.antal + ' boxar har redan svarat';
  const text = [
    'Hej igen,',
    '',
    'För en vecka sedan skickade jag en enkät om hur svenska boxar drivs. ' + params.antal + ' boxar har svarat hittills, och redan nu syns till exempel att ' + params.krok + '.',
    '',
    'Vi stänger enkäten ' + params.stangerDatum + '. Fem minuter, och Boxrapporten 2026 kommer till dig när den är klar: ' + UTSKICK_ENKAT_URL,
    '',
    'Svara "stryk" om du inte vill ha fler mejl från oss.',
    '',
    'Daniel Dahlström, OpenGym',
  ].join('\n');
  return { amne, text };
}

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

function utskickNormalisera_(s) {
  return String(s).toLowerCase().replace(/[^a-zåäö0-9]/g, '');
}

function utskickVarde_(rad, kol, namn) {
  const i = kol[utskickNormalisera_(namn)];
  return i === undefined ? undefined : rad[i];
}

function utskickHoppaOver_(rad, kol) {
  return Boolean(utskickVarde_(rad, kol, 'hoppa_over') || utskickVarde_(rad, kol, 'avregistrerad') || utskickVarde_(rad, kol, 'stryk'));
}
