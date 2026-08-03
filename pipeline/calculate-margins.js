// Automated margin calculation pipeline:
// 1. Read ingredient costs from a Google Sheet in "Recipe LSB" folder
// 2. Pull recipes from Google Sheets in the same folder
// 3. Cost recipes by matching ingredients
// 4. Combine with Square sales data to calculate margins
// 5. Return full margin analysis

const fs = require('fs');
const path = require('path');
const sheetsOAuth = require('./sheets-oauth');
const recipes = require('./recipes');
const costing = require('./costing');

const OUT_DIR = path.join(__dirname, '..', 'data', 'pipeline');

const load = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return fallback; }
};

// Parse ingredient costs from a Google Sheet (assumed format: Name | Price/kg)
const parseIngredientSheet = (rows) => {
  const costs = {};
  if (!rows || !rows.length) return costs;

  // Skip header rows, find the first row with data
  let startIdx = 0;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const row = rows[i];
    if (row && row[0] && row[1]) {
      const col0 = String(row[0]).toLowerCase();
      const col1 = String(row[1]).toLowerCase();
      if ((col0.includes('ingredient') || col0.includes('name')) &&
          (col1.includes('price') || col1.includes('cost') || col1.includes('/kg'))) {
        startIdx = i + 1;
        break;
      }
    }
  }

  // Parse each row: [ingredient name, price per kg]
  for (let i = startIdx; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[0]) continue;
    const name = String(row[0]).trim();
    const price = parseFloat(String(row[1] || '').replace(/[^\d.]/g, ''));
    if (name && Number.isFinite(price) && price > 0) {
      costs[name] = price;
    }
  }

  return costs;
};

// Find and read ingredient costs sheet from a folder
const readIngredientsSheet = async (drive, sheets, folderId) => {
  const sheetsList = await sheetsOAuth.listSheetsInFolder(drive, folderId);

  // Look for a sheet named "Ingredients", "Ingredient Costs", "Ingredient Prices", etc.
  const ingSheet = sheetsList.find(s =>
    /ingredient|price|cost/i.test(s.name) && !/recipe/i.test(s.name)
  );

  if (!ingSheet) {
    console.warn('⚠️  No ingredient pricing sheet found in Recipe LSB folder. Using empty price list.');
    return {};
  }

  try {
    let tabs;
    if (ingSheet.isExcel) {
      const parsed = await sheetsOAuth.downloadAndParseExcel(drive, ingSheet.id, ingSheet.name);
      const firstTab = Object.values(parsed.tabs)[0];
      tabs = firstTab ? firstTab.rows : [];
    } else {
      const parsed = await sheetsOAuth.pullSpreadsheet(sheets, ingSheet.id);
      const firstTab = Object.values(parsed.tabs)[0];
      tabs = firstTab ? firstTab.rows : [];
    }

    return parseIngredientSheet(tabs);
  } catch (e) {
    console.warn(`⚠️  Failed to read ingredient sheet "${ingSheet.name}": ${e.message}`);
    return {};
  }
};

// Main calculation function
const main = async ({ squareSalesData = [] } = {}) => {
  console.log('🔄 Calculating bakery margins from Google Sheets…\n');

  // Step 1: Connect to Google
  let clients;
  try {
    clients = await sheetsOAuth.getClients();
  } catch (e) {
    const err = new Error('Google not connected. Visit /api/google/connect to authorize.');
    err.code = e.code || 'GOOGLE_NOT_CONNECTED';
    throw err;
  }

  const { sheets, drive } = clients;

  // Step 2: Find Recipe LSB folder
  let folder;
  try {
    folder = await sheetsOAuth.resolveFolderByName(drive, 'Recipe LSB');
    console.log(`✓ Found folder: ${folder.name}\n`);
  } catch (e) {
    const err = new Error(`Recipe LSB folder not found. Available folders must be checked manually.`);
    err.code = e.code;
    throw err;
  }

  // Step 3: Read ingredient costs from Recipe LSB
  console.log('Step 1: Reading ingredient prices from Recipe LSB…');
  const ingredientCosts = await readIngredientsSheet(drive, sheets, folder.id);
  console.log(`✓ Loaded ${Object.keys(ingredientCosts).length} ingredient prices\n`);

  // Step 4: Pull recipes from Recipe LSB
  console.log('Step 2: Parsing recipe sheets from Recipe LSB…');
  const yieldOverrides = load(path.join(OUT_DIR, 'yield-overrides.json'), {});
  let recipeData;
  try {
    recipeData = await recipes.pullRecipes('Recipe LSB', { yieldOverrides });
    console.log(`✓ Parsed ${recipeData.recipes.length} recipes`);
    if (recipeData.skipped.length > 0) {
      console.log(`⊘ Skipped ${recipeData.skipped.length}: ${recipeData.skipped.slice(0, 3).join(', ')}${recipeData.skipped.length > 3 ? '…' : ''}`);
    }
  } catch (e) {
    const err = new Error(`Failed to parse recipes: ${e.message}`);
    err.code = e.code;
    throw err;
  }
  console.log();

  // Step 5: Cost recipes
  console.log('Step 3: Costing recipes…');
  const ingredientOverrides = load(path.join(OUT_DIR, 'ingredient-overrides.json'), {});
  const priceOverrides = load(path.join(OUT_DIR, 'ingredient-price-overrides.json'), {});
  const exclusions = load(path.join(OUT_DIR, 'recipe-exclusions.json'), []);

  // Convert ingredient costs dictionary to vendor prices array format (costing module expects this shape)
  const vendorPricesArray = Object.entries(ingredientCosts).map(([name, price]) => ({
    itemCode: name,
    description: name,
    vendor: 'google-sheet',
    pricePerKg: price,
  }));

  const { costs, coverage } = await costing.costAllRecipes(recipeData.recipes, vendorPricesArray, {
    ingredientOverrides,
    priceOverrides,
    exclusions,
  });

  console.log(`✓ Costed: ${coverage.costed.length} recipes`);
  console.log(`⚠️  Needs attention: ${coverage.needsAttention.length} recipes`);
  if (coverage.excluded.length > 0) {
    console.log(`⊘ Excluded: ${coverage.excluded.length} recipes`);
  }
  console.log();

  // Step 6: Build recipe cost lookup
  const recipeCostMap = {};
  for (const recipe of coverage.costed) {
    recipeCostMap[recipe.recipe] = recipe.costPerUnit;
  }

  // Step 7: Calculate margins with Square sales data
  console.log('Step 4: Calculating margins from Square sales data…');
  let totalRevenue = 0;
  let totalCogs = 0;
  let totalUnits = 0;

  const products = (squareSalesData || []).map(item => {
    const units = item.units || 0;
    const price = item.price || 0;
    const cost = recipeCostMap[item.product] || item.cost || 0;

    const revenue = units * price;
    const cogs = units * cost;
    const profit = revenue - cogs;
    const marginPct = revenue > 0 ? (profit / revenue * 100) : 0;

    totalRevenue += revenue;
    totalCogs += cogs;
    totalUnits += units;

    return {
      product: item.product,
      units,
      sale_price: price,
      cost_per_unit: cost,
      revenue: Math.round(revenue * 100) / 100,
      cogs: Math.round(cogs * 100) / 100,
      profit: Math.round(profit * 100) / 100,
      margin_pct: Math.round(marginPct * 10) / 10,
    };
  });

  const blendedMargin = totalRevenue > 0 ? ((totalRevenue - totalCogs) / totalRevenue * 100) : 0;

  const result = {
    generated_at: new Date().toISOString(),
    summary: {
      total_units: totalUnits,
      total_revenue: Math.round(totalRevenue * 100) / 100,
      total_cogs: Math.round(totalCogs * 100) / 100,
      total_profit: Math.round((totalRevenue - totalCogs) * 100) / 100,
      blended_margin_pct: Math.round(blendedMargin * 10) / 10,
    },
    products,
    coverage: {
      costed: coverage.costed.length,
      needsAttention: coverage.needsAttention.length,
      excluded: coverage.excluded.length,
    },
  };

  console.log(`\n✅ Margin calculation complete`);
  console.log(`   Total Revenue: $${result.summary.total_revenue.toLocaleString()}`);
  console.log(`   Total COGS: $${result.summary.total_cogs.toLocaleString()}`);
  console.log(`   Blended Margin: ${result.summary.blended_margin_pct}%`);

  return result;
};

module.exports = { main, parseIngredientSheet };
