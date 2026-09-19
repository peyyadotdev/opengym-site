// Bygger delningsbilderna (og:image) från mallarna i den här mappen.
// Körs med: npm run og   (första gången: npm install && npx playwright install chromium)
// Mallarna hämtar typsnitten från Google Fonts, så det behövs nät.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const DIR = __dirname;
const PAGES = [
  ['landing.html', 'landing.png'],
  ['enkat.html', 'enkat.png'],
];
const MAX_KB = 300; // WhatsApp visar bara en liten tumnagel för större bilder

(async () => {
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } : undefined;
  const browser = await chromium.launch({ proxy });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, ignoreHTTPSErrors: !!proxy });
  const page = await ctx.newPage();
  let failed = false;
  for (const [src, out] of PAGES) {
    // Google Fonts kan falla bort på ett enskilt anrop, så vi laddar om sidan upp till tre gånger.
    let missing = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      await page.goto('file://' + path.join(DIR, src), { waitUntil: 'load' });
      await page.evaluate(() => Promise.all([
        document.fonts.load('700 88px Anybody'),
        document.fonts.load('600 88px Anybody'),
        document.fonts.load('400 27px "Inter Tight"'),
        document.fonts.load('400 17px "JetBrains Mono"'),
      ]).then(() => document.fonts.ready));
      const families = await page.evaluate(() => [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family.replace(/"/g, '')));
      missing = ['Anybody', 'Inter Tight', 'JetBrains Mono'].filter(need => !families.includes(need));
      if (!missing.length) break;
      console.warn(`  försök ${attempt}: ${missing.join(', ')} laddades inte för ${src}, provar igen`);
    }
    if (missing.length) throw new Error(`Typsnitten ${missing.join(', ')} laddades inte för ${src}. Finns nät?`);
    await page.waitForTimeout(300);
    const file = path.join(DIR, out);
    await page.screenshot({ path: file, type: 'png', clip: { x: 0, y: 0, width: 1200, height: 630 } });
    const kb = Math.round(fs.statSync(file).size / 1024);
    console.log(`${out}: 1200 × 630, ${kb} kB`);
    if (kb > MAX_KB) { failed = true; console.error(`  för stor: över ${MAX_KB} kB`); }
  }
  await browser.close();
  if (failed) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
