import { PlaywrightCrawler, Dataset } from 'crawlee';
import * as fs from 'fs';

const CATEGORIES = [
  { name: 'pralki', url: 'https://www.mediaexpert.pl/agd/pralki-i-suszarki/pralki' },
  { name: 'zmywarki', url: 'https://www.mediaexpert.pl/agd/zmywarki/zmywarki' },
  { name: 'lodowki', url: 'https://www.mediaexpert.pl/agd/lodowki/lodowki' },
  { name: 'kuchnie', url: 'https://www.mediaexpert.pl/agd/kuchnie/kuchnie' },
  { name: 'mikrofale', url: 'https://www.mediaexpert.pl/agd/mikrofale/mikrofale' },
  { name: 'okapy', url: 'https://www.mediaexpert.pl/agd/okapy/okapy' },
  { name: 'suszarki', url: 'https://www.mediaexpert.pl/agd/suszarki/suszarki' },
];

const PRODUCT_PREFIX = {
  pralki: 'Pralka',
  zmywarki: 'Zmywarka',
  lodowki: 'Lodówka',
  kuchnie: 'Kuchnia',
  mikrofale: 'Mikrofala',
  okapy: 'Okap',
  suszarki: 'Suszarka',
};

const crawler = new PlaywrightCrawler({
  launchContext: {
    launchOptions: {
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    },
  },

  async requestHandler({ request, page, pushData }) {
    const category = request.userData.category;
    console.log(`[${category}] Processing: ${request.url}`);

    await page.waitForLoadState('networkidle').catch(() => {});

    const products = await page.evaluate((categoryName, prefix) => {
      const items = [];
      const text = document.body.innerText;

      const productMatches = text.matchAll(
        new RegExp(
          `${prefix}\\s+(HISENSE|ELECTROLUX|BOSCH|SAMSUNG|LG|CANDY|BEKO|WHIRLPOOL|INDESIT|SIEMENS)[^\\n]*\\n([\\s\\S]*?)(?=${prefix}\\s+(?:HISENSE|ELECTROLUX|BOSCH|SAMSUNG|LG|CANDY|BEKO|WHIRLPOOL|INDESIT|SIEMENS)|$)`,
          'gi'
        )
      );

      for (const match of productMatches) {
        const fullText = match[0];
        if (fullText.length < 50) continue;

        const brand = match[1];
        const codeMatch = fullText.match(/Kod:\\s*(\\d+)/);
        const code = codeMatch ? codeMatch[1] : null;

        const priceMatch = fullText.match(/(\\d+)\\s*\\n\\s*(\\d+)\\s*\\n\\s*zł|(\\d+\\s*\\d+)\\s*,(\\d+)\\s*zł/);
        let price_pln = null;
        if (priceMatch) {
          if (priceMatch[1] && priceMatch[2]) {
            const whole = priceMatch[1].replace(/\\s/g, '');
            const decimal = priceMatch[2];
            price_pln = parseFloat(`${whole}.${decimal}`);
          } else if (priceMatch[3] && priceMatch[4]) {
            const whole = priceMatch[3].replace(/\\s/g, '');
            const decimal = priceMatch[4];
            price_pln = parseFloat(`${whole}.${decimal}`);
          }
        }

        const firstLine = fullText.split('\\n')[0];
        const model = firstLine.substring(0, 100);

        if (price_pln) {
          items.push({
            category: categoryName,
            brand,
            model,
            code,
            price_pln,
            shop: 'mediaexpert.pl',
          });
        }
      }

      return items;
    }, category, PRODUCT_PREFIX[category]);

    console.log(`[${category}] Found ${products.length} products`);
    for (const product of products) {
      await pushData(product);
    }
  },

  maxRequestRetries: 2,
  maxRequestsPerCrawl: CATEGORIES.length,
});

console.log('[START] Scraping all AGD categories from mediaexpert.pl\n');

await crawler.addRequests(
  CATEGORIES.map(cat => ({
    url: cat.url,
    userData: { category: cat.name },
  }))
);

await crawler.run();

console.log('\n[RESULTS] Processing data...');
const dataset = await Dataset.open();
const result = await dataset.getData();
const products = result.items.filter(p => p.price_pln).sort((a, b) => a.price_pln - b.price_pln);

console.log(`\n✓ Total products found: ${products.length}`);
products.forEach(p => {
  console.log(`  [${p.category}] ${p.brand} - ${p.price_pln.toFixed(2)} zł (${p.code || '-'})`);
});

// Generate HTML report
const stats = {};
CATEGORIES.forEach(cat => {
  const catProducts = products.filter(p => p.category === cat.name);
  stats[cat.name] = {
    count: catProducts.length,
    avg: catProducts.length > 0 ? catProducts.reduce((s, p) => s + p.price_pln, 0) / catProducts.length : 0,
    min: catProducts.length > 0 ? Math.min(...catProducts.map(p => p.price_pln)) : 0,
    max: catProducts.length > 0 ? Math.max(...catProducts.map(p => p.price_pln)) : 0,
  };
});

let html = `<!DOCTYPE html>
<html lang="pl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Raport cen AGD - Media Expert</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 20px; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; }
        h1 { color: #1a1a1a; margin-bottom: 10px; }
        .meta { color: #666; font-size: 14px; margin-bottom: 30px; }
        .categories { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 40px; }
        .cat-card { background: white; padding: 15px; border-radius: 8px; border-left: 4px solid #FFD700; }
        .cat-name { font-weight: bold; font-size: 14px; color: #333; }
        .cat-count { font-size: 24px; font-weight: bold; color: #d9534f; margin: 10px 0; }
        .cat-stats { font-size: 12px; color: #666; line-height: 1.6; }
        table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; margin-top: 20px; }
        th { background: #FFD700; padding: 12px; text-align: left; font-weight: bold; }
        td { padding: 12px; border-bottom: 1px solid #eee; }
        tr:hover { background: #f9f9f9; }
        .price { color: #d9534f; font-weight: bold; }
        .category-label { font-size: 11px; background: #f0f0f0; padding: 4px 8px; border-radius: 4px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>📊 Raport cen AGD - Media Expert</h1>
        <div class="meta">Wygenerowano: ${new Date().toLocaleString('pl-PL')} | Produkty: ${products.length}</div>

        <h2>Podsumowanie kategorii</h2>
        <div class="categories">
`;

CATEGORIES.forEach(cat => {
  const s = stats[cat.name];
  html += `
            <div class="cat-card">
                <div class="cat-name">${PRODUCT_PREFIX[cat.name]}y</div>
                <div class="cat-count">${s.count}</div>
                <div class="cat-stats">
                    <div>Śr: ${s.avg.toFixed(0)} zł</div>
                    <div>Min: ${s.min.toFixed(0)} zł</div>
                    <div>Max: ${s.max.toFixed(0)} zł</div>
                </div>
            </div>
`;
});

html += `
        </div>

        <h2>Wszystkie produkty (sortowane po cenie)</h2>
        <table>
            <thead>
                <tr>
                    <th>Kategoria</th>
                    <th>Marka</th>
                    <th>Model</th>
                    <th>Cena (zł)</th>
                    <th>Kod</th>
                </tr>
            </thead>
            <tbody>
`;

products.forEach(p => {
  html += `
                <tr>
                    <td><span class="category-label">${p.category}</span></td>
                    <td><strong>${p.brand}</strong></td>
                    <td>${p.model.substring(0, 60)}</td>
                    <td class="price">${p.price_pln.toFixed(2)}</td>
                    <td>${p.code || '-'}</td>
                </tr>
`;
});

html += `
            </tbody>
        </table>
    </div>
</body>
</html>
`;

const reportFile = `/tmp/agd_report_${new Date().toISOString().split('T')[0]}.html`;
fs.writeFileSync(reportFile, html);

console.log(`\n✓ Raport: ${reportFile}`);
