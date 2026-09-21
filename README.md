# opengym-site

Landningssidan för [OpenGym](https://github.com/peyyadotdev/opengym), ett AI-first affärssystem för boxar inom CrossFit, HYROX och funktionell träning i Sverige. En enda `index.html` utan byggsteg, med ett formulär som samlar intresseanmälningar från pilotgym.

Designen görs i Claude Design-projektet ”OpenGym landningssida granskning” (`OpenGym Landningssida.dc.html`) tillsammans med OpenGym Design System. `index.html` är en handskriven implementation av den: designens inline-stilar är översatta till klasser med designsystemets tokens som CSS-variabler, `sc-for`-listor till statisk markup och formuläret kopplat till den riktiga endpointen. Regler för design och copy står i [`CLAUDE.md`](CLAUDE.md).

## Filer

| Fil | Innehåll |
|---|---|
| `index.html` | Landningssidan: åtta sektioner (varav ”Vår story” om Jessica och ReShape), priskalkylator, pilotanmälan. Markup, CSS och skript i samma fil |
| `assets/logo.svg` | Logotypmärket: viktskiva på gummigolv med limeprick |
| `assets/og/` | Delningsbilderna som visas när sidorna delas (`og:image`), 1200 × 630, med mallarna och skriptet som bygger dem |
| `enkat/index.html` | Enkäten ”Så driver du din box 2026”: sju delar, en per skärm, autospar efter varje del, återupptagning i samma webbläsare |
| `intervju/index.html` | Intervjusidan: samtal med OpenGyms AI-assistent för boxägare som enkäten visar är typkund. Erbjuds på enkätens tacksida. Servern ligger i det privata repot opengym |
| `tests/fall-typkund.json` | Testfallen för typkundsregeln, likadana som i repot opengym |
| `leads/Code.gs` | Google Apps Script som tar emot både anmälningar och enkätsvar och skriver dem i ett Google Sheet, med stegen för att publicera den |
| `.nojekyll` | Får GitHub Pages att servera sidan som den är |
| `tests/` | Testerna, se nedan |

## Förhandsgranska lokalt

```
python3 -m http.server 8000
```

Öppna sedan `http://localhost:8000`.

## Testa

```
npm install
npx playwright install chromium
npm test
```

- `tests/test-codegs.js` kör `leads/Code.gs` i Node mot ett mock-ark. Ingen Google-inloggning behövs.
- `tests/test-landing.js` kör landningssidan i Chromium: copyregler (inget ”hen”, ingen systemjargong, inga skogsgröna färger), hero-variant, platta på betonade ord, kalkylatorn, formuläret mot en mockad endpoint, overflow på mobil.
- `tests/test-enkat.js` startar en egen lokal server, kör hela enkäten i Chromium på desktop och mobil mot en mockad endpoint (validering, hopplogik, inskick, paus och återupptagning, overflow) och sparar skärmdumpar i `tests/screenshots/`.
- `tests/test-intervju.js` kör intervjusidan i Chromium på desktop och mobil mot en mockad server: copyregler, stängt läge, utan enkätsvar, start, turer, fel, text i stället för HTML, återupptagning och avslut. Rösten körs med fejkad mikrofon och MediaRecorder: feature flag, inspelning, renskriven text i fältet, originaltexten och felen.
- Manuellt: `npm run serve` och öppna `http://localhost:8000/enkat/`. Sidan skickar då på riktigt till webbappen, så testsvar hamnar i arket. Ta bort dem efteråt, eller sätt `SIGNUP_ENDPOINT` tillfälligt till `''` för att klicka runt utan att skicka.
- Intervjun lokalt: starta den lokala servern i repot opengym med `npm run dev:intervju`, kör `npm run serve` här, och öppna `http://127.0.0.1:8000/intervju/?api=http://127.0.0.1:8787/functions/v1/intervju-tur`. Lägg till `&rost=1` för Prata-knappen. I drift syns den bara med `?rost=1` eller med PostHog-flaggan `intervju-rost`. Enkätsvaren läggs i webbläsaren av enkätens tacksida när intervjun är öppen.

## Publicera

GitHub Pages: Settings → Pages → Source: *Deploy from a branch*, branch `main`, mapp `/ (root)`. Sidan hamnar på `https://peyyadotdev.github.io/opengym-site/` tills en egen domän är kopplad. För opengym.se: lägg en `CNAME`-fil med domänen i repots rot och peka DNS enligt GitHubs guide.

## Delningsbild

Bilden som visas när en länk delas (Facebook, LinkedIn, X, WhatsApp, iMessage, Slack) är en egen bild, inte en skärmdump: `assets/og/landing.png` för landningssidan och `assets/og/enkat.png` för enkäten. De byggs från `assets/og/landing.html` och `assets/og/enkat.html` med `npm run og`, som renderar mallarna i Chromium till 1200 × 630 och stoppar om en bild blir större än 300 kB (gränsen för att WhatsApp ska visa stor förhandsvisning). Ändra i mallen, bygg om och committa PNG:en.

Plattformarna cachar bilden per URL. Efter en ändring: kör sidan genom [Facebooks Sharing Debugger](https://developers.facebook.com/tools/debug/) och [LinkedIns Post Inspector](https://www.linkedin.com/post-inspector/), eller byt filnamn och uppdatera taggarna.

## Koppla formuläret

Anmälningarna skickas formulärkodat till en Apps Script-webbapp, utan CORS-preflight. Publicera `leads/Code.gs` som webbapp enligt kommentaren överst i filen (cirka fem minuter) och klistra in webbappens URL som `SIGNUP_ENDPOINT` i `index.html`. Tills dess visar formuläret ett felmeddelande vid försök att skicka.

Fälten som skickas är `email`, `box` (valfritt boxnamn), `source` och `timestamp`. Ett dolt honeypot-fält stoppar de enklaste robotarna utan att något skickas.

## Enkäten

`enkat/index.html` är enkäten till boxägare, på `opengym.se/enkat/`. Länka med `?k=mail`, `?k=ig` och så vidare för att se i arket var svaren kom ifrån.

- **Frågorna** ligger som en datastruktur (`STEPS`) överst i skriptet, med koder som blir kolumner i arket (`q01_lan` … `q30_rapport`). Hopplogiken är funktioner på frågorna (`showIf`). Ändra text eller alternativ där, inget annat behöver röras.
- **Sparning.** Efter varje del skickas hela svaret till samma Apps Script-webbapp som leadformuläret (`action=survey`) med ett slumpat svars-id, så raden i fliken *Enkät* uppdateras i stället för att dubbleras. Svaren ligger också i webbläsarens `localStorage`, så en avbruten enkät kan återupptas i samma webbläsare.
- **E-post separat.** Svarsraden innehåller aldrig e-post. Pilotintresse (fråga 29) hamnar i fliken *Pilotintresse* med svars-id, eftersom ni behöver veta vilken box svaren gäller. E-post för Boxrapporten hamnar i fliken *Rapportlista* med bara datum, på slumpad rad, utan koppling till svaren.
- **Mätning.** PostHog utan cookies (`persistence: 'memory'`). Klistra in projektets nyckel som `POSTHOG_KEY` i `enkat/index.html`, EU-värden är förvald. Events: `enkat_start`, `enkat_steg`, `enkat_validering`, `enkat_fortsatt`, `enkat_omstart`, `enkat_klar`, `enkat_fel`, `enkat_delad`. Tom nyckel = ingen mätning. Stäng gärna av lagring av IP-adress i PostHog-projektets inställningar.
- **Efter ändring i `leads/Code.gs`:** Distribuera → Hantera distributioner → redigera → Ny version → Distribuera. Annars kör webbappen den gamla koden. Kontrollera med webbappens URL i webbläsaren: svaret ska innehålla `"version":2`.
