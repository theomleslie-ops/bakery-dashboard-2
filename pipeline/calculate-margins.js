// Automated margin calculation pipeline with bakery-specific costing logic:
// 1. Read ingredient costs from a Google Sheet in "Recipe LSB" folder
// 2. Pull recipes from Google Sheets in the same folder
// 3. Handle base doughs, pre-ferments, compound recipes per bakery methodology
// 4. Cost recipes by matching ingredients
// 5. Combine with Square sales data to calculate margins

const fs = require('fs');
const path = require('path');
const sheetsOAuth = require('./sheets-oauth');
const recipes = require('./recipes');
const costing = require('./costing');

const OUT_DIR = path.join(__dirname, '..', 'data', 'pipeline');

const load = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return fallback; }
};

// Read pre-ferment formulas from "Pre-Ferments" sheet in Recipe LSB folder
const readPreFermentFormulas = async (drive, sheets, folderId) => {
  const sheetsList = await sheetsOAuth.listSheetsInFolder(drive, folderId);

  const pfSheet = sheetsList.find(s => /pre-ferment/i.test(s.name));
  if (!pfSheet) {
    console.warn('⚠️  No "Pre-Ferments" sheet found. Recipes with pre-ferment ingredients will fail to cost.');
    return {};
  }

  try {
    let tabs;
    if (pfSheet.isExcel) {
      const parsed = await sheetsOAuth.downloadAndParseExcel(drive, pfSheet.id, pfSheet.name);
      const firstTab = Object.values(parsed.tabs)[0];
      tabs = firstTab ? firstTab.rows : [];
    } else {
      const parsed = await sheetsOAuth.pullSpreadsheet(sheets, pfSheet.id);
      const firstTab = Object.values(parsed.tabs)[0];
      tabs = firstTab ? firstTab.rows : [];
    }

    const formulas = {};
    let currentPF = null;

    for (let i = 0; i < tabs.length; i++) {
      const row = tabs[i] || [];
      const col0 = String(row[0] || '').trim().toLowerCase();

      // Look for pre-ferment name (e.g., "Levain", "Poolish")
      if (col0 && !/ingredient|component|ratio|%|total/.test(col0) && row[1] === undefined && row[2] === undefined) {
        currentPF = col0.replace(/[^a-z]/g, '');
        formulas[currentPF] = {};
      } else if (currentPF && col0 && /ingredient|component/i.test(col0)) {
        // Start of ingredient list for this pre-ferment
        continue;
      } else if (currentPF && col0 && col0 !== '') {
        // Read ingredient and ratio
        const ratio = parseFloat(String(row[1] || '').replace(/[^\d.]/g, ''));
        if (Number.isFinite(ratio) && ratio > 0 && ratio <= 1) {
          formulas[currentPF][col0] = ratio;
        }
      }
    }

    return formulas;
  } catch (e) {
    console.warn(`⚠️  Failed to read pre-ferment formulas from "${pfSheet.name}": ${e.message}`);
    return {};
  }
};

// ============ BAKERY-SPECIFIC COSTING LOGIC ============

// Product → Base Dough Mapping (hardcoded business logic)
// Format: product name → { baseDough: recipe name, portionKg }
const PRODUCT_BASE_DOUGH_MAP = {
  'Country Round': { baseDough: 'Country dough', portionKg: 1.0 },
  'Country PC': { baseDough: 'Country dough', portionKg: 0.28 },
  'Baguette': { baseDough: 'Country dough', portionKg: 0.75 },
  'Epi': { baseDough: 'Country dough', portionKg: 0.75 },
  'Long Braid': { baseDough: 'Challah dough', portionKg: 1.02 },
};

// Base dough recipe names to recognize and cost separately
const BASE_DOUGH_RECIPES = new Set([
  'country dough',
  'challah dough',
  'pain de mie dough',
]);

// Expand pre-ferment references into raw ingredients
const expandPreFerment = (ingredientName, kg, preFermentFormulas = {}) => {
  const nameLC = ingredientName.toLowerCase().trim();
  const formula = preFermentFormulas[nameLC] || preFermentFormulas[nameLC.replace(/[^a-z]/g, '')];

  if (!formula) return null;

  return Object.entries(formula).map(([component, ratio]) => ({
    name: component,
    kg: kg * ratio,
  }));
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

// Expand pre-ferments in recipe ingredients before costing
const expandPreFermentsInRecipe = (recipe, preFermentFormulas = {}) => {
  const expanded = { ...recipe };
  const newIngredients = [];

  for (const ing of recipe.ingredients) {
    const expanded_ing = expandPreFerment(ing.name, ing.kg, preFermentFormulas);
    if (expanded_ing) {
      newIngredients.push(...expanded_ing);
    } else {
      newIngredients.push(ing);
    }
  }

  expanded.ingredients = newIngredients;
  return expanded;
};

// Handle Breakfast Bar compound recipe (multiple layers = one product)
// Recognizes "Breakfast Bar Bottom", "Breakfast Bar Middle", "Breakfast Bar Top" and combines them
const combineBreakfastBarLayers = (costedRecipes) => {
  const result = [];
  const bbLayers = {};

  for (const recipe of costedRecipes) {
    const nameLC = recipe.recipe.toLowerCase();
    const isBreakfastBar = /breakfast.?bar/i.test(recipe.recipe);

    if (isBreakfastBar) {
      // Collect all layers
      if (!bbLayers['total_cost']) bbLayers['total_cost'] = 0;
      bbLayers['total_cost'] += recipe.costPerUnit || 0;

      // Mark as handled
      bbLayers[nameLC] = true;
    } else {
      result.push(recipe);
    }
  }

  // If we found Breakfast Bar layers, create a combined entry (cost / 32 units)
  if (bbLayers['total_cost'] > 0) {
    result.push({
      recipe: 'Breakfast Bar',
      sheet: 'Breakfast Bar (compound)',
      status: 'costed',
      costPerUnit: Math.round((bbLayers['total_cost'] / 32) * 100) / 100,
      unitsPerBatch: 32,
      totalBatchKg: null,
      costByIngredient: [],
    });
  }

  return result;
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

  // Step 3: Read ingredient costs from QuickBooks bills (preferred) or Google Sheet (fallback)
  console.log('Step 1: Reading ingredient prices…');
  let ingredientCosts = {};

  // Try QB bills first
  const qbBillExtractor = require('./qb-bill-extractor');
  try {
    console.log('  Attempting to pull from QuickBooks bills (Chef\'s Warehouse, Green Leaf, Allen Brothers)…');
    const billResult = await qbBillExtractor.extractBills({ weeks: 52 }); // Last year of bills

    // Convert bill extractor output to ingredient cost format
    for (const ing of billResult.ingredients) {
      ingredientCosts[ing.ingredient] = ing.mostRecentCost;
    }
    console.log(`  ✓ Loaded ${billResult.ingredients.length} ingredients from QB bills\n`);
  } catch (e) {
    console.warn(`  ⚠️  QB bill extraction failed (${e.code || e.message}), falling back to Google Sheet…`);
    ingredientCosts = await readIngredientsSheet(drive, sheets, folder.id);
    console.log(`  ✓ Loaded ${Object.keys(ingredientCosts).length} ingredient prices from Google Sheet\n`);
  }

  // Step 4: Pull recipes from Recipe LSB
  console.log('Step 2: Parsing recipe sheets from Recipe LSB…');
  let recipeData;
  try {
    recipeData = await recipes.pullRecipes('Recipe LSB');
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

  // Step 4b: Read pre-ferment formulas from Google Sheets
  console.log('Step 2b: Reading pre-ferment formulas from Recipe LSB…');
  const preFermentFormulas = await readPreFermentFormulas(drive, sheets, folder.id);
  const pfCount = Object.keys(preFermentFormulas).length;
  console.log(`  ✓ Loaded ${pfCount} pre-ferment formulas from Google Sheets\n`);

  // Step 5: Apply bakery-specific preprocessing
  console.log('Step 3: Applying bakery costing logic…');

  // Expand pre-ferments in all recipes
  const expandedRecipes = recipeData.recipes.map(r => expandPreFermentsInRecipe(r, preFermentFormulas));
  console.log(`  ✓ Expanded pre-ferment references to component ingredients`);

  // Separate base doughs from regular recipes
  const baseDoughRecipes = [];
  const productRecipes = [];

  for (const recipe of expandedRecipes) {
    const recipeLC = recipe.recipe.toLowerCase();
    if (BASE_DOUGH_RECIPES.has(recipeLC)) {
      baseDoughRecipes.push(recipe);
    } else {
      productRecipes.push(recipe);
    }
  }

  console.log(`  ✓ Identified ${baseDoughRecipes.length} base doughs, ${productRecipes.length} products\n`);

  // Step 6: Cost all recipes
  console.log('Step 4: Costing recipes…');
  const ingredientOverrides = load(path.join(OUT_DIR, 'ingredient-overrides.json'), {});
  const priceOverrides = load(path.join(OUT_DIR, 'ingredient-price-overrides.json'), {});
  const exclusions = load(path.join(OUT_DIR, 'recipe-exclusions.json'), []);

  // Convert ingredient costs dictionary to vendor prices array format
  const vendorPricesArray = Object.entries(ingredientCosts).map(([name, price]) => ({
    itemCode: name,
    description: name,
    vendor: 'google-sheet',
    pricePerKg: price,
  }));

  // Cost base doughs first
  const { costs: baseDoughCosts, coverage: baseCoverage } = await costing.costAllRecipes(
    baseDoughRecipes,
    vendorPricesArray,
    { ingredientOverrides, priceOverrides, exclusions }
  );

  console.log(`  Base doughs: ${baseCoverage.costed.length} costed, ${baseCoverage.needsAttention.length} need attention`);

  // Build base dough cost lookup (cost per kg)
  const baseDoughCostPerKg = {};
  for (const recipe of baseCoverage.costed) {
    baseDoughCostPerKg[recipe.recipe.toLowerCase()] = recipe.costPerUnit / recipe.unitsPerBatch;
  }

  // Cost product recipes
  const { costs: productCosts, coverage: productCoverage } = await costing.costAllRecipes(
    productRecipes,
    vendorPricesArray,
    { ingredientOverrides, priceOverrides, exclusions }
  );

  console.log(`  Products: ${productCoverage.costed.length} costed, ${productCoverage.needsAttention.length} need attention\n`);

  // Step 7: Combine Breakfast Bar layers (bottom + middle + top / 32 units)
  const combinedProductRecipes = combineBreakfastBarLayers(productCoverage.costed);
  const bbCombined = combinedProductRecipes.length < productCoverage.costed.length;
  if (bbCombined) {
    console.log(`  ✓ Combined Breakfast Bar layers into single product cost\n`);
  }

  // Step 8: Build recipe cost lookup with base dough mappings
  const recipeCostMap = {};

  // Add costed product recipes (may include combined Breakfast Bar)
  for (const recipe of combinedProductRecipes) {
    recipeCostMap[recipe.recipe] = recipe.costPerUnit;
  }

  // Override with base dough products (cost = baseDough cost/kg × portion weight)
  for (const [productName, mapping] of Object.entries(PRODUCT_BASE_DOUGH_MAP)) {
    const baseDoughLC = mapping.baseDough.toLowerCase();
    const baseDoughCost = baseDoughCostPerKg[baseDoughLC];

    if (baseDoughCost != null) {
      recipeCostMap[productName] = baseDoughCost * mapping.portionKg;
    } else {
      console.warn(`  ⚠️  Base dough "${mapping.baseDough}" not costed, can't calculate ${productName}`);
    }
  }

  // Step 9: Calculate margins with Square sales data
  console.log('Step 6: Calculating margins from Square sales data…');
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
      baseDoughs: baseCoverage.costed.length,
      products: productCoverage.costed.length,
      needsAttention: productCoverage.needsAttention.length + baseCoverage.needsAttention.length,
      excluded: productCoverage.excluded.length + baseCoverage.excluded.length,
    },
  };

  console.log(`\n✅ Margin calculation complete`);
  console.log(`   Base doughs costed: ${baseCoverage.costed.length}`);
  console.log(`   Products costed: ${productCoverage.costed.length}`);
  console.log(`   Total Revenue: $${result.summary.total_revenue.toLocaleString()}`);
  console.log(`   Total COGS: $${result.summary.total_cogs.toLocaleString()}`);
  console.log(`   Blended Margin: ${result.summary.blended_margin_pct}%`);

  return result;
};

module.exports = { main, parseIngredientSheet };
