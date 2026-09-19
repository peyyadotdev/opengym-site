# opengym-site

Landningssidan för [OpenGym](https://github.com/peyyadotdev/opengym), ett AI-first affärssystem för boxar inom CrossFit, HYROX och funktionell träning i Sverige. En enda `index.html` utan byggsteg, med ett formulär som samlar intresseanmälningar från pilotgym.

## Filer

| Fil | Innehåll |
|---|---|
| `index.html` | Hela sidan: markup, CSS och det lilla skript som sköter scroll reveal och formuläret |
| `enkat/index.html` | Enkäten ”Så driver du din box 2026”: sju delar, en per skärm, autospar efter varje del, återupptagning i samma webbläsare |
| `leads/Code.gs` | Google Apps Script som tar emot både anmälningar och enkätsvar och skriver dem i ett Google Sheet, med stegen för att publicera den |
| `.nojekyll` | Får GitHub Pages att servera sidan som den är |

## Förhandsgranska lokalt

```
python3 -m http.server 8000
```

Öppna sedan `http://localhost:8000`.

## Publicera

GitHub Pages: Settings → Pages → Source: *Deploy from a branch*, branch `main`, mapp `/ (root)`. Sidan hamnar på `https://peyyadotdev.github.io/opengym-site/` tills en egen domän är kopplad. För opengym.se: lägg en `CNAME`-fil med domänen i repots rot och peka DNS enligt GitHubs guide.

## Koppla formuläret

Anmälningarna skickas formulärkodat till en Apps Script-webbapp, utan CORS-preflight. Publicera `leads/Code.gs` som webbapp enligt kommentaren överst i filen (cirka fem minuter) och klistra in webbappens URL som `SIGNUP_ENDPOINT` i `index.html`. Tills dess visar formuläret ett felmeddelande vid försök att skicka.

Fälten som skickas är `email`, `box` (valfritt boxnamn), `source` och `timestamp`. Ett dolt honeypot-fält stoppar de enklaste robotarna utan att något skickas.

## Enkäten

`enkat/index.html` är enkäten till boxägare, på `opengym.se/enkat/`. Länka med `?k=mail`, `?k=ig` och så vidare för att se i arket var svaren kom ifrån.

- **Frågorna** ligger som en datastruktur (`STEPS`) överst i skriptet, med koder som blir kolumner i arket (`q01_lan` … `q30_rapport`). Hopplogiken är funktioner på frågorna (`showIf`). Ändra text eller alternativ där, inget annat behöver röras.
- **Sparning.** Efter varje del skickas hela svaret till samma Apps Script-webbapp som leadformuläret (`action=survey`) med ett slumpat svars-id, så raden i fliken *Enkät* uppdateras i stället för att dubbleras. Svaren ligger också i webbläsarens `localStorage`, så en avbruten enkät kan återupptas i samma webbläsare.
- **E-post separat.** Svarsraden innehåller aldrig e-post. Pilotintresse (fråga 29) hamnar i fliken *Pilotintresse* med svars-id, eftersom ni behöver veta vilken box svaren gäller. E-post för Boxrapporten hamnar i fliken *Rapportlista* med bara datum, på slumpad rad, utan koppling till svaren.
- **Mätning.** PostHog utan kakor (`persistence: 'memory'`). Klistra in projektets nyckel som `POSTHOG_KEY` i `enkat/index.html`, EU-värden är förvald. Händelser: `enkat_start`, `enkat_steg`, `enkat_validering`, `enkat_fortsatt`, `enkat_omstart`, `enkat_klar`, `enkat_fel`, `enkat_delad`. Tom nyckel = ingen mätning. Stäng gärna av lagring av IP-adress i PostHog-projektets inställningar.
- **Efter ändring i `leads/Code.gs`:** Distribuera → Hantera distributioner → redigera → Ny version → Distribuera. Annars kör webbappen den gamla koden. Kontrollera med webbappens URL i webbläsaren: svaret ska innehålla `"version":2`.
