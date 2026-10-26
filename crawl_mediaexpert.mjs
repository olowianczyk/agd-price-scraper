import { PlaywrightCrawler, Dataset } from 'crawlee';
import * as fs from 'fs';

const crawler = new PlaywrightCrawler({
  // Launch browser with stealth mode
  launchContext: {
    launchOptions: {
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    },
  },

  async requestHandler({ request, page, pushData }) {
    console.log(`Processing: ${request.url}`);

    // Wait for content
    await page.waitForLoadState('networkidle').catch(() => {});

    // Debug: save full page text
    const pageText = await page.evaluate(() => document.body.innerText);
    console.log('PAGE TEXT LENGTH:', pageText.length);

    // Save to file for inspection
    await fs.promises.writeFile('/tmp/page_text_debug.txt', pageText);
    console.log('✓ Page text saved to /tmp/page_text_debug.txt');

    // Extract products from rendered page
    const products = await page.evaluate(() => {
      const items = [];
      const text = document.body.innerText;

      // DEBUG: log first 500 chars
      console.log('PAGE TEXT (first 500 chars):', text.substring(0, 500));

      // Find all product elements (various selectors to be safe)
      const productEls = Array.from(
        document.querySelectorAll('[class*="product"], [data-testid*="product"], article, .item')
      );

      console.log('Found product elements:', productEls.length);

      // Split by product titles "Pralka [BRAND]"
      const productMatches = text.matchAll(/Pralka\s+(HISENSE|ELECTROLUX|BOSCH|SAMSUNG|LG|CANDY|BEKO|WHIRLPOOL|INDESIT)[^\n]*\n([\s\S]*?)(?=Pralka\s+(?:HISENSE|ELECTROLUX|BOSCH|SAMSUNG|LG|CANDY|BEKO|WHIRLPOOL|INDESIT)|$)/gi);

      for (const match of productMatches) {
        const fullText = match[0];
        if (fullText.length < 50) continue;

        const brand = match[1];

        // Extract code "Kod: 2087062"
        const codeMatch = fullText.match(/Kod:\s*(\d+)/);
        const code = codeMatch ? codeMatch[1] : null;

        // Extract price "2 799\n99\nzł" or "2999,99 zł"
        const priceMatch = fullText.match(/(\d+)\s*\n\s*(\d+)\s*\n\s*zł|(\d+\s*\d+)\s*,(\d+)\s*zł/);
        let price_pln = null;
        if (priceMatch) {
          if (priceMatch[1] && priceMatch[2]) {
            const whole = priceMatch[1].replace(/\s/g, '');
            const decimal = priceMatch[2];
            price_pln = parseFloat(`${whole}.${decimal}`);
          } else if (priceMatch[3] && priceMatch[4]) {
            const whole = priceMatch[3].replace(/\s/g, '');
            const decimal = priceMatch[4];
            price_pln = parseFloat(`${whole}.${decimal}`);
          }
        }

        // Get model from first line
        const firstLine = fullText.split('\n')[0];
        const model = firstLine.substring(0, 100);

        if (price_pln) {
          items.push({
            brand,
            model,
            code,
            price_pln,
          });
        }
      }

      return items;
    });

    console.log(`Found ${products.length} products`);

    // Push to dataset
    for (const product of products) {
      await pushData(product);
    }
  },

  // Max requests and retry policy
  maxRequestRetries: 2,
  maxRequestsPerCrawl: 1,
});

// Run crawler
console.log('[1] Starting crawler...');
await crawler.addRequests([
  {
    url: 'https://www.mediaexpert.pl/agd/pralki-i-suszarki/pralki',
    label: 'STARTING_URL',
  },
]);

await crawler.run();

// Get results
console.log('[2] Retrieving results...');
const dataset = await Dataset.open();
const allItems = await dataset.getData();

console.log(`\n[3] Found ${allItems.items.length} products total\n`);

// Generate HTML report
const products = allItems.items.filter(p => p.price_pln).sort((a, b) => a.price_pln - b.price_pln);

let html = `<!DOCTYPE html>
<html lang="pl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Raport cen pralek - Media Expert</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 20px; background: #f5f5f5; }
        .container { max-width: 1000px; margin: 0 auto; }
        h1 { margin-bottom: 10px; }
        .meta { color: #666; font-size: 14px; margin-bottom: 20px; }
        .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-bottom: 30px; }
        .stat { background: white; padding: 15px; border-radius: 8px; border-left: 4px solid #FFD700; text-align: center; }
        .stat-value { font-size: 20px; font-weight: bold; color: #d9534f; }
        .stat-label { font-size: 12px; color: #666; text-transform: uppercase; margin-top: 5px; }
        table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; }
        th { background: #FFD700; padding: 12px; text-align: left; font-weight: bold; }
        td { padding: 12px; border-bottom: 1px solid #eee; }
        tr:hover { background: #f9f9f9; }
        .price { color: #d9534f; font-weight: bold; }
    </style>
</head>
<body>
    <div class="container">
        <h1>📊 Raport cen pralek - Media Expert</h1>
        <div class="meta">Data: ${new Date().toLocaleString('pl-PL')} | Produkty: ${products.length}</div>

        <div class="stats">
            <div class="stat">
                <div class="stat-value">${products.length}</div>
                <div class="stat-label">Produkty</div>
            </div>
            <div class="stat">
                <div class="stat-value">${(products.reduce((s, p) => s + p.price_pln, 0) / products.length).toFixed(0)} zł</div>
                <div class="stat-label">Średnia</div>
            </div>
            <div class="stat">
                <div class="stat-value">${Math.min(...products.map(p => p.price_pln)).toFixed(0)} zł</div>
                <div class="stat-label">Min</div>
            </div>
            <div class="stat">
                <div class="stat-value">${Math.max(...products.map(p => p.price_pln)).toFixed(0)} zł</div>
                <div class="stat-label">Max</div>
            </div>
        </div>

        <table>
            <thead>
                <tr>
                    <th>Marka</th>
                    <th>Model</th>
                    <th>Cena</th>
                </tr>
            </thead>
            <tbody>
`;

for (const p of products) {
  html += `
                <tr>
                    <td><strong>${p.brand}</strong></td>
                    <td>${p.model}</td>
                    <td class="price">${p.price_pln.toFixed(2)} zł</td>
                </tr>
`;
}

html += `
            </tbody>
        </table>
    </div>
</body>
</html>
`;

const reportFile = `/tmp/agd_price_report_${new Date().toISOString().split('T')[0]}.html`;
fs.writeFileSync(reportFile, html);

console.log(`✓ Raport: ${reportFile}`);
console.log(`✓ Zapisano: ${products.length} produktów`);
