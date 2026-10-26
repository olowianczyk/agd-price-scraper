import { PlaywrightCrawler, Dataset } from 'crawlee';
import * as fs from 'fs';

const SHOPS = [
  { name: 'mediaexpert.pl', baseUrl: 'https://www.mediaexpert.pl/agd' },
  { name: 'mediamarkt.pl', baseUrl: 'https://www.mediamarkt.pl/pl/assortment' },
  { name: 'euro.com.pl', baseUrl: 'https://www.euro.com.pl/agd' },
];

const CATEGORIES = [
  { name: 'pralki', slug: 'pralki-i-suszarki/pralki' },
  { name: 'zmywarki', slug: 'zmywarki/zmywarki' },
  { name: 'lodowki', slug: 'lodowki/lodowki' },
  { name: 'kuchnie', slug: 'kuchnie/kuchnie' },
  { name: 'mikrofale', slug: 'mikrofale/mikrofale' },
  { name: 'okapy', slug: 'okapy/okapy' },
  { name: 'suszarki', slug: 'suszarki/suszarki' },
];

const BRANDS_TO_TRACK = ['BOSCH', 'SIEMENS', 'ELECTROLUX', 'SAMSUNG', 'LG'];

const PRODUCT_PREFIX = {
  pralki: 'Pralka',
  zmywarki: 'Zmywarka',
  lodowki: 'Lodówka',
  kuchnie: 'Kuchnia',
  mikrofale: 'Mikrofala',
  okapy: 'Okap',
  suszarki: 'Suszarka',
};

function buildShopUrls() {
  const urls = [];

  // MediaExpert URLs
  CATEGORIES.forEach(cat => {
    urls.push({
      url: `https://www.mediaexpert.pl/agd/${cat.slug}`,
      userData: { category: cat.name, shop: 'mediaexpert.pl' }
    });
  });

  // MediaMarkt URLs (simplified category URLs)
  CATEGORIES.forEach(cat => {
    const mmCategory = cat.name.replace('lodowki', 'lodówki').replace('okapy', 'okapy');
    urls.push({
      url: `https://www.mediamarkt.pl/pl/assortment/${mmCategory}`,
      userData: { category: cat.name, shop: 'mediamarkt.pl' }
    });
  });

  // Euro URLs
  CATEGORIES.forEach(cat => {
    urls.push({
      url: `https://www.euro.com.pl/agd/${cat.slug}`,
      userData: { category: cat.name, shop: 'euro.com.pl' }
    });
  });

  return urls;
}

const crawler = new PlaywrightCrawler({
  launchContext: {
    launchOptions: {
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    },
  },
  maxConcurrency: 3,

  async requestHandler({ request, page, pushData }) {
    const category = request.userData.category;
    const shop = request.userData.shop;
    console.log(`[${shop}/${category}] Processing: ${request.url}`);

    await page.waitForLoadState('networkidle').catch(() => {});

    const products = await page.evaluate((categoryName, prefix, brands) => {
      const items = [];
      const text = document.body.innerText;
      const brandPattern = brands.join('|');

      const productMatches = text.matchAll(
        new RegExp(
          `${prefix}\\s+(${brandPattern})[^\\n]*\\n([\\s\\S]*?)(?=${prefix}\\s+(?:${brandPattern})|$)`,
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
          });
        }
      }

      return items;
    }, category, PRODUCT_PREFIX[category], BRANDS_TO_TRACK);

    console.log(`[${shop}/${category}] Found ${products.length} products`);
    for (const product of products) {
      await pushData({ ...product, shop });
    }
  },

  maxRequestRetries: 2,
  maxRequestsPerCrawl: Infinity,
});

console.log('[START] Scraping AGD from 3 shops (mediaexpert, mediamarkt, euro)\n');

const urls = buildShopUrls();
await crawler.addRequests(urls);

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
    <title>Konkurencja BOSCH/SIEMENS - Raport cen AGD</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 20px; background: #f5f5f5; }
        .container { max-width: 1400px; margin: 0 auto; }
        h1 { color: #1a1a1a; margin-bottom: 10px; }
        .meta { color: #666; font-size: 14px; margin-bottom: 30px; }
        .brands { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
        .brand-badge { background: white; padding: 8px 12px; border-radius: 4px; border-left: 3px solid #FFD700; font-size: 12px; }
        .categories { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin-bottom: 40px; }
        .cat-card { background: white; padding: 15px; border-radius: 8px; border-left: 4px solid #FFD700; }
        .cat-name { font-weight: bold; font-size: 14px; color: #333; }
        .cat-count { font-size: 24px; font-weight: bold; color: #d9534f; margin: 10px 0; }
        .cat-stats { font-size: 12px; color: #666; line-height: 1.6; }
        table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; margin-top: 20px; font-size: 13px; }
        th { background: #FFD700; padding: 10px; text-align: left; font-weight: bold; }
        td { padding: 10px; border-bottom: 1px solid #eee; }
        tr:hover { background: #f9f9f9; }
        .price { color: #d9534f; font-weight: bold; }
        .shop-label { font-size: 10px; background: #f0f0f0; padding: 3px 6px; border-radius: 3px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🏭 Konkurencja BOSCH/SIEMENS - Raport cen AGD</h1>
        <div class="meta">Wygenerowano: ${new Date().toLocaleString('pl-PL')} | Produkty: ${products.length} | Sklepy: mediaexpert.pl, mediamarkt.pl, euro.com.pl</div>

        <div class="brands">
          ${BRANDS_TO_TRACK.map(b => `<div class="brand-badge"><strong>${b}</strong></div>`).join('')}
        </div>

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
                    <th>Sklep</th>
                    <th>Kategoria</th>
                    <th>Marka</th>
                    <th>Model</th>
                    <th>Cena (zł)</th>
                </tr>
            </thead>
            <tbody>
`;

products.forEach(p => {
  html += `
                <tr>
                    <td><span class="shop-label">${p.shop}</span></td>
                    <td><span class="shop-label">${p.category}</span></td>
                    <td><strong>${p.brand}</strong></td>
                    <td>${p.model.substring(0, 50)}</td>
                    <td class="price">${p.price_pln.toFixed(2)}</td>
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
