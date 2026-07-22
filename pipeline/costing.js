// Recipe costing engine: match each recipe's ingredients to vendor prices, compute per-unit cost.
// Iterative fixed-point resolution (up to 6 passes) so sub-recipes resolve after their own batch
// cost is known. Outputs: recipe-costs.json (API consumes) + coverage.json (diagnostic).

const fs = require('fs');
const path = require('path');
const matcher = require('./matcher');

const OUT_DIR = path.join(__dirname, '..', 'data', 'pipeline');
const OVERRIDES_FILE = path.join(OUT_DIR, 'ingredient-overrides.json');
const PRICE_OVERRIDES_FILE = path.join(OUT_DIR, 'ingredient-price-overrides.json');
const EXCLUSIONS_FILE = path.join(OUT_DIR, 'recipe-exclusions.json');

const load = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return fallback; } };
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

// Cost one recipe against a vendor price list. Optionally uses sub-recipe prices (resolved in prior passes).
const costRecipe = (recipe, vendorPrices, { ingredientOverrides = {}, priceOverrides = {}, subRecipePrices = {} } = {}) => {
  if (!recipe.portionKg) return { recipe: recipe.recipe, status: 'needs-yield', reason: 'no yield' };
  if (!recipe.ingredients.length) return { recipe: recipe.recipe, status: 'no-ingredients' };

  const costByIngredient = [];
  const unpricedIngredients = [];
  let totalBatchCost = 0;
  let anyIngredientCostFailed = false;

  for (const ing of recipe.ingredients) {
    const ingName = ing.name.trim();

    // Check if this ingredient is actually a sub-recipe (already costed in a prior pass)
    if (subRecipePrices[ingName] != null) {
      const subCost = subRecipePrices[ingName] * ing.kg;
      totalBatchCost += subCost;
      costByIngredient.push({
        ingredient: ingName,
        kg: ing.kg,
        source: 'sub-recipe',
        pricePerKg: subRecipePrices[ingName],
        cost: round2(subCost),
      });
      continue;
    }

    // Check manual overrides (ingredient name → price per kg)
    if (priceOverrides[ingName] != null) {
      const pricePerKg = parseFloat(priceOverrides[ingName]);
      if (Number.isFinite(pricePerKg) && pricePerKg > 0) {
        const cost = pricePerKg * ing.kg;
        totalBatchCost += cost;
        costByIngredient.push({
          ingredient: ingName,
          kg: ing.kg,
          source: 'price-override',
          pricePerKg,
          cost: round2(cost),
        });
        continue;
      }
    }

    // Look up vendor item via override (ingredient name → vendor item code/description)
    let vendorItem = null;
    if (ingredientOverrides[ingName]) {
      const code = ingredientOverrides[ingName];
      vendorItem = vendorPrices.find((v) => (v.itemCode === code || v.description === code));
    }

    // Or match via token overlap (if not overridden)
    if (!vendorItem) {
      const matched = matcher.findBestMatch(ingName, vendorPrices);
      if (matched && matched.confidence !== 'none') {
        vendorItem = matched.match;
      }
    }

    if (!vendorItem || !Number.isFinite(vendorItem.pricePerKg)) {
      unpricedIngredients.push(ingName);
      anyIngredientCostFailed = true;
      continue;
    }

    const cost = vendorItem.pricePerKg * ing.kg;
    totalBatchCost += cost;
    costByIngredient.push({
      ingredient: ingName,
      kg: ing.kg,
      vendor: vendorItem.vendor,
      vendorDescription: vendorItem.description,
      pricePerKg: round2(vendorItem.pricePerKg),
      cost: round2(cost),
    });
  }

  if (anyIngredientCostFailed) {
    return {
      recipe: recipe.recipe,
      status: 'needs-attention',
      reason: `${unpricedIngredients.length} ingredient(s) unpriced: ${unpricedIngredients.join(', ')}`,
    };
  }

  const costPerUnit = round2(totalBatchCost / recipe.unitsPerBatch);
  return {
    recipe: recipe.recipe,
    sheet: recipe.sheet,
    status: 'costed',
    totalBatchKg: recipe.totalKg,
    unitsPerBatch: recipe.unitsPerBatch,
    costPerUnit,
    costByIngredient,
  };
};

// Iteratively cost recipes, resolving sub-recipes after their own cost is known.
const costAllRecipes = async (recipes, vendorPrices, { ingredientOverrides = {}, priceOverrides = {}, exclusions = [] } = {}) => {
  const costs = {};
  const coverage = { costed: [], needsAttention: [], excluded: [] };
  const exclusionSet = new Set(exclusions.map((r) => r.toLowerCase()));

  let changed = true;
  let pass = 0;
  const MAX_PASSES = 6;

  while (changed && pass < MAX_PASSES) {
    changed = false;
    pass += 1;

    for (const recipe of recipes) {
      const recipeKey = recipe.recipe.toLowerCase();
      if (costs[recipeKey]) continue; // Already costed
      if (exclusionSet.has(recipeKey)) {
        coverage.excluded.push({ recipe: recipe.recipe, reason: 'in exclusion list' });
        continue;
      }

      const result = costRecipe(recipe, vendorPrices, {
        ingredientOverrides,
        priceOverrides,
        subRecipePrices: costs,
      });

      if (result.status === 'costed') {
        costs[recipeKey] = result.costPerUnit;
        coverage.costed.push(result);
        changed = true;
      } else if (result.status === 'needs-attention') {
        // May resolve in a later pass if an ingredient becomes a sub-recipe
        coverage.needsAttention.push(result);
      } else {
        coverage.needsAttention.push(result);
      }
    }
  }

  // Move recipes that never got costed to the needs-attention bucket
  const costedRecipes = new Set(coverage.costed.map((r) => r.recipe.toLowerCase()));
  const movedToNeedsAttention = [];
  for (const result of coverage.needsAttention) {
    if (!costedRecipes.has(result.recipe.toLowerCase())) {
      movedToNeedsAttention.push(result);
    }
  }
  coverage.needsAttention = movedToNeedsAttention;

  return { costs, coverage };
};

module.exports = { costRecipe, costAllRecipes };
