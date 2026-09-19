# opengym-site

Statisk sajt för opengym.se: landningssida (`index.html`), enkät (`enkat/index.html`), Apps Script-backend (`leads/Code.gs`), tester (`tests/`). Inga byggsteg. Kör `npm test` före push (första gången: `npm install && npx playwright install chromium`).

## Design

- Källan är Claude Design-projektet ”OpenGym landningssida granskning” (`OpenGym Landningssida.dc.html`) och OpenGym Design System. Tokens ligger inlinade i varje sidas `<style>` som CSS-variabler. Ändra där, inte med hårdkodade värden i markup.
- Accenten är neon-lime `#a6ff1f` och används bara som fyllning (knapp-hover via plattan, förloppsindikator, kryssrutor, logotypprick). Betonade ord och stora tal på ljus botten är ink `#131311` på en lime-platta `#e9ffc2`, målad som gradient (se `h1 em` i `index.html`). På mörka ytor (`.og-dark`) är betonad text `#c9ff5c` utan platta. Inga skogs- eller mossgröna toner, ingen grön text på ljus botten.
- Primärknapp: ink-fyllning, hover blir platta som fyllning med ink-text och ink-kant. Fokusram och länk-hover i ink. Inga skuggor. Radie 2 px på kontroller, 0 på kort och rutnät.
- Cellrutnät: behållaren har kant upptill och till vänster, varje cell till höger och nedtill.
- Typsnitt från Google Fonts: Anybody (display, bredd-axel), Inter Tight (brödtext), JetBrains Mono (etiketter). Betonade ord i rubriker: vikt 600, bredd 135 % (112 % under 600 px).

## Copy

- Svenska. Skriv aldrig ”hen” eller ”hens”. Skriv om meningen (den som …, medlemmen, personen, du).
- Som en boxägare pratar vid whiteboarden: korta meningar, golvets termer (WOD, PR, Rx/Scaled, On-Ramp, drop-in, Open Gym). Säg ”grupp/gruppen”, inte ”lag/laget”. ”Idrottslag” får användas en gång som jämförelse.
- Undvik systemjargong: brief, vy/vyer, flöde, ”går ut” (säg skickas), ”dras i flödet”, systemlicens, plattform, data, ”ligger hos en människa”, retention (säg att medlemmarna stannar), churn (medlemmar som slutar), leads (nya som hör av sig), migrering (flytta över), träningslager (WOD, resultat och gruppen), affärssystem (systemet).
- Lova inte funktioner som inte finns i första versionen. Listan ”På väg, inte i första versionen” i sektion 04 är stället för dem.
- Siffror: mellanslag före %, tankstreck i intervall (80–500), svenska citattecken ”…”, `→` som enda pilglyf. Aldrig emoji.

## Formulär och data

- Båda sidorna postar formulärkodat till Apps Script-webbappen (`SIGNUP_ENDPOINT`), utan egna headers, så att ingen CORS-preflight behövs. Sidorna läser JSON-svaret och visar fel om `ok` är false.
- Ändras `leads/Code.gs` måste en ny version distribueras i Apps Script (Distribuera → Hantera distributioner → Ny version), annars kör webbappen den gamla koden.
- Enkätens svarsrad innehåller aldrig e-post. Pilotintresse och rapportlista ligger i egna flikar.
