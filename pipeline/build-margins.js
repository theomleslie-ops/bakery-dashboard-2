// One command to refresh the whole Product Margins cost side: pull the latest Chef's Warehouse
// prices from QuickBooks, pull + cost every recipe from Google Sheets, and write the artifacts the
// /api/product-margins endpoint reads. Square sales are joined live at request time, not here.
//
//   npm run margins                 # refresh prices + recost everything
//   node pipeline/build-margins.js --folder "Recipe LSB" --weeks 12
//   node pipeline/build-margins.js --no-price-refresh   # reuse cached CW prices, just recost
require('dotenv').config();
const { buildCostReport, writeArtifacts } = require('./match-cost');

const argAfter = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; };

(async () => {
  const folderName = argAfter('--folder') || process.env.RECIPE_FOLDER || 'Recipe LSB';
  const priceWeeks = parseInt(argAfter('--weeks'), 10) || 12;
  const refreshPrices = !process.argv.includes('--no-price-refresh');

  console.log(`Building product-margin costs (folder="${folderName}", price window=${priceWeeks}w, refreshPrices=${refreshPrices})…`);
  const report = await buildCostReport({ folderName, refreshPrices, priceWeeks });
  writeArtifacts(report);
  const t = report.totals;
  console.log(`\nDone. Recipes ${t.recipes} → costed ${t.costed}, needs-yield ${t.needsYield}, unpriced-ingredient ${t.unpricedIngredient}, sheet-skipped ${t.sheetSkipped}.`);
  console.log('Artifacts in data/pipeline/: recipe-costs.json, coverage.json, ingredient-match-approval.csv, chefs-warehouse-prices.json');
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
