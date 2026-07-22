// Orchestrate the full Product Margins pipeline:
// 1. Fetch and parse invoices from 3 vendors (Chef's Warehouse, Greenleaf, Alan Brothers)
// 2. Parse recipe sheets from Google Drive
// 3. Cost each recipe by matching ingredients to vendor prices
// 4. Write artifacts: recipe-costs.json, coverage.json, vendor-prices.json

const fs = require('fs');
const path = require('path');
const vendorPrices = require('./vendor-prices');
const recipes = require('./recipes');
const costing = require('./costing');

const OUT_DIR = path.join(__dirname, '..', 'data', 'pipeline');
const YIELD_OVERRIDES_FILE = path.join(OUT_DIR, 'yield-overrides.json');
const INGREDIENT_OVERRIDES_FILE = path.join(OUT_DIR, 'ingredient-overrides.json');
const PRICE_OVERRIDES_FILE = path.join(OUT_DIR, 'ingredient-price-overrides.json');
const EXCLUSIONS_FILE = path.join(OUT_DIR, 'recipe-exclusions.json');

const load = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return fallback; } };

const main = async ({ weeks = 12 } = {}) => {
  console.log('Building Product Margins pipeline…\n');

  // Step 1: Fetch vendor prices
  console.log('Step 1: Fetching ingredient prices from 3 vendors…');
  let priceListData;
  try {
    priceListData = await vendorPrices.buildPriceList({
      weeks,
      onProgress: (vendor, n, total) => process.stdout.write(`  ${vendor}: ${n}/${total}\r`),
    });
    console.log(`\n  ✓ ${priceListData.ingredientCount} ingredients from all vendors`);
  } catch (e) {
    console.error(`\n  ✗ Failed to fetch vendor prices: ${e.message}`);
    if (e.code === 'QB_NOT_CONNECTED') {
      console.error('    Connect QuickBooks first via the app: /api/quickbooks/connect');
    }
    throw e;
  }

  const priceList = priceListData.ingredients;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'vendor-prices.json'), JSON.stringify(priceListData, null, 2));

  // Step 2: Parse recipes from Google Sheets
  console.log('\nStep 2: Parsing recipe sheets from Google Drive…');
  const yieldOverrides = load(YIELD_OVERRIDES_FILE, {});
  let recipeData;
  try {
    recipeData = await recipes.pullRecipes('Recipe LSB', { yieldOverrides });
    console.log(`  ✓ Parsed ${recipeData.recipes.length} recipes`);
    if (recipeData.skipped.length > 0) {
      console.log(`  ⊘ Skipped ${recipeData.skipped.length}: ${recipeData.skipped.slice(0, 3).join(', ')}${recipeData.skipped.length > 3 ? '…' : ''}`);
    }
  } catch (e) {
    console.error(`  ✗ Failed to parse recipes: ${e.message}`);
    if (e.code === 'GOOGLE_NOT_CONNECTED') {
      console.error('    Connect Google Drive first via the app: /api/google/connect');
    }
    throw e;
  }

  // Step 3: Cost each recipe
  console.log('\nStep 3: Costing recipes…');
  const ingredientOverrides = load(INGREDIENT_OVERRIDES_FILE, {});
  const priceOverrides = load(PRICE_OVERRIDES_FILE, {});
  const exclusions = load(EXCLUSIONS_FILE, []);

  const { costs, coverage } = await costing.costAllRecipes(recipeData.recipes, priceList, {
    ingredientOverrides,
    priceOverrides,
    exclusions,
  });

  console.log(`  ✓ Costed: ${coverage.costed.length} recipes`);
  console.log(`  ⚠ Needs attention: ${coverage.needsAttention.length} recipes`);
  if (coverage.excluded.length > 0) {
    console.log(`  ⊘ Excluded: ${coverage.excluded.length} recipes`);
  }

  // Step 4: Write artifacts
  console.log('\nStep 4: Writing artifacts…');
  const recipeCosts = {
    generatedAt: new Date().toISOString(),
    recipeCount: coverage.costed.length,
    recipes: coverage.costed.map((r) => ({
      recipe: r.recipe,
      sheet: r.sheet,
      costPerUnit: r.costPerUnit,
      unitsPerBatch: r.unitsPerBatch,
      totalBatchKg: r.totalBatchKg,
    })),
  };

  fs.writeFileSync(path.join(OUT_DIR, 'recipe-costs.json'), JSON.stringify(recipeCosts, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'coverage.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    recipeCount: recipeData.recipes.length,
    coverage,
  }, null, 2));

  console.log(`  ✓ Wrote data/pipeline/recipe-costs.json`);
  console.log(`  ✓ Wrote data/pipeline/coverage.json`);
  console.log(`  ✓ Wrote data/pipeline/vendor-prices.json`);

  console.log('\n✓ Build complete!');
  return { recipeCosts, coverage };
};

// CLI: node pipeline/build-margins.js [weeks]
if (require.main === module) {
  const weeks = parseInt(process.argv[2], 10) || 12;
  main({ weeks })
    .catch((e) => {
      console.error('Build failed:', e.message);
      process.exit(1);
    });
}

module.exports = { main };
