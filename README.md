# opengym-site

Landningssidan för [OpenGym](https://github.com/peyyadotdev/opengym), ett AI-first affärssystem för boxar inom CrossFit, HYROX och funktionell träning i Sverige. En enda `index.html` utan byggsteg, med ett formulär som samlar intresseanmälningar från pilotgym.

## Filer

| Fil | Innehåll |
|---|---|
| `index.html` | Hela sidan: markup, CSS och det lilla skript som sköter scroll reveal och formuläret |
| `leads/Code.gs` | Google Apps Script som tar emot anmälningarna och skriver dem i ett Google Sheet, med stegen för att publicera den |
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
