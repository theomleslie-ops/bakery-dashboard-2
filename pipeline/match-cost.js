// Costs every recipe by matching its ingredients to Chef's Warehouse priced items, then divides the
// batch cost by the per-unit yield to get a cost per sold unit. Ingredient names never line up
// exactly ("AP Flour (AP Harina)" vs CW "FLOUR AP ORGANIC"), so candidates are scored by token
// overlap and the best one is used; a manual overrides file (ingredient → CW item code) always wins.
//
// Writes three artifacts:
//   recipe-costs.json            — the costed recipes the API consumes
//   coverage.json                — every recipe bucketed by why it can/can't be costed (the point)
//   ingredient-match-approval.csv — a human-reviewable table of every ingredient match + alternates
const fs = require('fs');
const path = require('path');
const { pullRecipes } = require('./recipes');
const { buildPriceList } = require('./chefs-warehouse');

const OUT_DIR = path.join(__dirname, '..', 'data', 'pipeline');
const PRICES_FILE = path.join(OUT_DIR, 'chefs-warehouse-prices.json');
const OVERRIDES_FILE = path.join(OUT_DIR, 'ingredient-overrides.json'); // { "<recipe ingredient>": "<CW item code>" }
const YIELD_OVERRIDES_FILE = path.join(OUT_DIR, 'yield-overrides.json'); // { "<recipe>": <grams per unit> }

const load = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return fallback; } };
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

// ---- name matching ----
const STOP = new Set(['for', 'of', 'the', 'and', 'a', 'pinch', 'to', 'with', 'in', 'raw', 'fresh']);
// Recipe ingredient names are bilingual ("White Sugar/Azucar", "AP Flour (AP Harina)") — keep the
// English part before a slash or parenthesis.
const englishPart = (n) => String(n).split('/')[0].split('(')[0].trim();
const tokenize = (s) => englishPart(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t && !STOP.has(t));
const cwTokens = (d) => String(d).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
const normName = (n) => englishPart(n).toLowerCase().replace(/\s+/g, ' ').trim();

const scoreCandidate = (rTok, cw) => {
  const ct = cwTokens(cw.description);
  const cset = new Set(ct);
  const overlap = rTok.filter((t) => cset.has(t));
  if (!overlap.length) return null;
  const head = rTok[rTok.length - 1]; // English head noun ("white sugar" → sugar)
  let score = overlap.length / rTok.length;
  if (ct[0] === head) score += 0.4;          // CW description leads with the head noun
  if (cset.has(head)) score += 0.1;
  score -= ct.length * 0.02;                 // prefer shorter / more generic descriptions
  if (cw.pricePerKg != null) score += 0.05;  // prefer weight-priced items
  return { cw, score, overlap: overlap.length };
};

const rankCandidates = (name, cwList) => {
  const rTok = tokenize(name);
  if (!rTok.length) return [];
  return cwList.map((cw) => scoreCandidate(rTok, cw)).filter(Boolean).sort((a, b) => b.score - a.score);
};

const confidenceOf = (ranked) => {
  if (!ranked.length) return 'none';
  const top = ranked[0].score;
  const gap = top - (ranked[1]?.score ?? 0);
  if (top >= 1.2 && gap >= 0.25) return 'high';
  if (top >= 0.8) return 'medium';
  return 'low';
};

// ---- costing one recipe ----
// subRecipePrices maps a normalized recipe name → its $/kg, so an ingredient that is itself one of
// our recipes (Levain, Frangipane, a glaze) is priced from that recipe instead of Chef's Warehouse.
const costRecipe = (recipe, cwList, overrides, subRecipePrices = {}) => {
  const byCode = new Map(cwList.map((c) => [c.itemCode, c]));
  const lines = recipe.ingredients.map((ing) => {
    const norm = normName(ing.name);
    const override = overrides[ing.name] || overrides[norm];
    let matchedTo = null, itemCode = null, pricePerKg = null, confidence = 'none', alternates = [];

    if (norm === 'water' || norm === 'ice') {
      matchedTo = '(water — no cost)'; pricePerKg = 0; confidence = 'water';
    } else if (norm === 'mother' || norm === 'starter' || norm === 'levain build') {
      matchedTo = '(starter — negligible)'; pricePerKg = 0; confidence = 'starter';
    } else if (override && byCode.has(override)) {
      const m = byCode.get(override); matchedTo = m.description; itemCode = m.itemCode; pricePerKg = m.pricePerKg ?? null; confidence = 'override';
    } else if (subRecipePrices[norm] != null) {
      matchedTo = `(sub-recipe: ${ing.name.trim()})`; pricePerKg = subRecipePrices[norm]; confidence = 'sub-recipe';
    } else {
      const ranked = rankCandidates(ing.name, cwList);
      const m = ranked[0]?.cw;
      matchedTo = m?.description ?? null; itemCode = m?.itemCode ?? null; pricePerKg = m?.pricePerKg ?? null;
      confidence = confidenceOf(ranked); alternates = ranked.slice(1, 3).map((r) => r.cw.description);
    }
    const lineCost = pricePerKg != null ? ing.kg * pricePerKg : null;
    const flag = lineCost != null ? (confidence === 'low' ? 'low-confidence' : '') : (matchedTo ? 'non-weight' : 'no-match');
    return { ingredient: ing.name, kg: ing.kg, matchedTo, itemCode, pricePerKg, lineCost, confidence, flag, alternates };
  });

  const allPriced = lines.every((l) => l.lineCost != null);
  const batchCost = lines.reduce((s, l) => s + (l.lineCost || 0), 0);
  // Cost of one sold unit = ($/kg of batch) × the unit's finished weight — only meaningful when
  // every ingredient is priced AND we know the per-unit yield.
  const costPerUnit = (allPriced && recipe.portionKg) ? (batchCost / recipe.totalKg) * recipe.portionKg : null;

  return {
    recipe: recipe.recipe, sheet: recipe.sheet, totalKg: recipe.totalKg,
    portionKg: recipe.portionKg ?? null, portionBasis: recipe.portionBasis ?? null, unitsPerBatch: recipe.unitsPerBatch ?? null,
    batchCost: round2(batchCost), costPerUnit: round2(costPerUnit),
    allPriced,
    linesCosted: lines.filter((l) => l.lineCost != null).length, linesTotal: lines.length,
    unpricedIngredients: lines.filter((l) => l.lineCost == null).map((l) => l.ingredient.trim()),
    lines,
  };
};

// ---- coverage buckets ----
// Sort every recipe by why it can / can't be costed, so gaps are visible and actionable.
const buildCoverage = (costed) => {
  const buckets = { costed: [], needsYield: [], unpricedIngredient: [], sheetSkipped: [] };
  costed.forEach((c) => {
    if (c.allPriced && c.costPerUnit != null) buckets.costed.push(c.recipe);
    else if (c.allPriced && !c.portionKg) buckets.needsYield.push({ recipe: c.recipe, batchCost: c.batchCost });
    else buckets.unpricedIngredient.push({ recipe: c.recipe, missing: c.unpricedIngredients });
  });
  return buckets;
};

// ---- orchestration ----
const buildCostReport = async ({ folderName = 'Recipe LSB', refreshPrices = false, priceWeeks = 12 } = {}) => {
  let prices = load(PRICES_FILE, null);
  if (!prices || refreshPrices) {
    prices = await buildPriceList({ weeks: priceWeeks });
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(PRICES_FILE, JSON.stringify(prices, null, 2));
  }
  const overrides = load(OVERRIDES_FILE, {});
  const yieldOverrides = load(YIELD_OVERRIDES_FILE, {});

  const { folder, recipes, skipped } = await pullRecipes(folderName, { yieldOverrides });

  // Iterate: cost with CW prices, then derive $/kg for any fully-costed recipe and re-cost so
  // recipes that use those as sub-recipes (Levain → scones) resolve. Repeat until nothing new completes.
  let costed = recipes.map((r) => costRecipe(r, prices.ingredients, overrides, {}));
  for (let i = 0; i < 6; i++) {
    const subPrices = {};
    costed.forEach((c) => { if (c.totalKg > 0 && c.allPriced) subPrices[normName(c.recipe)] = c.batchCost / c.totalKg; });
    const next = recipes.map((r) => costRecipe(r, prices.ingredients, overrides, subPrices));
    const gained = next.filter((c) => c.allPriced).length - costed.filter((c) => c.allPriced).length;
    costed = next;
    if (gained <= 0) break;
  }

  const coverage = buildCoverage(costed);
  coverage.sheetSkipped = skipped;

  return {
    generatedAt: new Date().toISOString(),
    source: `drive:${folder}`,
    priceListDate: prices.generatedAt,
    totals: {
      recipes: costed.length,
      costed: coverage.costed.length,
      needsYield: coverage.needsYield.length,
      unpricedIngredient: coverage.unpricedIngredient.length,
      sheetSkipped: skipped.length,
    },
    coverage,
    recipes: costed,
  };
};

// Write recipe-costs.json + coverage.json + the approval CSV from a report.
const writeArtifacts = (report) => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'recipe-costs.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'coverage.json'), JSON.stringify({ generatedAt: report.generatedAt, totals: report.totals, coverage: report.coverage }, null, 2));
  const csv = ['recipe,ingredient,kg,matched_cw_item,item_code,price_per_kg,line_cost,confidence,flag,alternate_1,alternate_2'];
  for (const r of report.recipes) {
    for (const l of r.lines) {
      csv.push([
        `"${r.recipe}"`, `"${l.ingredient}"`, l.kg, `"${l.matchedTo || ''}"`, l.itemCode || '',
        l.pricePerKg != null ? l.pricePerKg.toFixed(2) : '', l.lineCost != null ? l.lineCost.toFixed(2) : '',
        l.confidence, l.flag, `"${l.alternates[0] || ''}"`, `"${l.alternates[1] || ''}"`,
      ].join(','));
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'ingredient-match-approval.csv'), csv.join('\n'));
};

module.exports = { buildCostReport, writeArtifacts, costRecipe, rankCandidates, normName };

// CLI: node pipeline/match-cost.js [folderName]
if (require.main === module) {
  const folderName = process.argv[2] || 'Recipe LSB';
  buildCostReport({ folderName }).then((report) => {
    writeArtifacts(report);
    const t = report.totals;
    console.log(`Recipes: ${t.recipes} | costed: ${t.costed} | needs-yield: ${t.needsYield} | unpriced-ingredient: ${t.unpricedIngredient} | sheet-skipped: ${t.sheetSkipped}`);
    console.log('Wrote data/pipeline/recipe-costs.json + coverage.json + ingredient-match-approval.csv');
  }).catch((e) => { console.error('Failed:', e.message); process.exit(1); });
}
