// Matches recipe ingredients to Chef's Warehouse priced items and computes cost-to-make per recipe.
// Names never line up exactly (recipe "AP Flour (AP Harina)" vs CW "FLOUR AP ORGANIC"), so this
// scores candidates and emits an approval table for a human to confirm/correct. A manual overrides
// file (recipe ingredient → CW item code) always wins.
const fs = require('fs');
const path = require('path');
const { pullRecipes, pullRecipesFromDir } = require('./recipes');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_DIR = path.join(DATA_DIR, 'pipeline');
// If recipes were downloaded from Drive as a local folder of .xlsx files, use those; otherwise pull
// live from the shared Drive folder.
const LOCAL_RECIPE_DIR = path.join(DATA_DIR, 'recipe-files');
const PRICES_FILE = path.join(OUT_DIR, 'chefs-warehouse-prices.json');
const OVERRIDES_FILE = path.join(OUT_DIR, 'ingredient-overrides.json'); // { "<recipe ingredient>": "<CW item code>" }
const PORTION_OVERRIDES_FILE = path.join(OUT_DIR, 'portion-overrides.json'); // { "<recipe>": <grams per unit> }

const STOP = new Set(['for', 'of', 'the', 'and', 'a', 'pinch', 'to', 'with', 'in', 'raw']);
// Recipe names are bilingual ("White Sugar/Azucar", "AP Flour (AP Harina)") — take the English part.
const englishPart = (n) => String(n).split('/')[0].split('(')[0].trim();
const tokenize = (s) => englishPart(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t && !STOP.has(t));
const cwTokens = (d) => String(d).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);

const scoreCandidate = (rTok, cw) => {
  const ct = cwTokens(cw.description);
  const cset = new Set(ct);
  const overlap = rTok.filter((t) => cset.has(t));
  if (!overlap.length) return null;
  const head = rTok[rTok.length - 1]; // English head noun ("white sugar" → sugar)
  let score = overlap.length / rTok.length;
  if (ct[0] === head) score += 0.4;             // CW description leads with the head noun
  if (cset.has(head)) score += 0.1;
  score -= ct.length * 0.02;                    // prefer shorter / more generic descriptions
  if (cw.pricePerKg != null) score += 0.05;     // prefer weight-priced items
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

const load = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return fallback; } };

const normName = (n) => englishPart(n).toLowerCase().replace(/\s+/g, ' ').trim();

// Cost one recipe. Each line: matched CW item (or sub-recipe), $/kg, line cost, and a flag.
// subRecipePrices maps a normalized recipe name → its cost/kg, so an ingredient that is itself one
// of our recipes (Levain, Frangipane, a glaze) is priced from that recipe instead of Chef's Warehouse.
const costRecipe = (recipe, cwList, overrides, subRecipePrices = {}) => {
  const byCode = new Map(cwList.map((c) => [c.itemCode, c]));
  const lines = recipe.ingredients.map((ing) => {
    const norm = normName(ing.name);
    const override = overrides[ing.name] || overrides[norm];
    let matchedTo = null, itemCode = null, pricePerKg = null, confidence = 'none', alternates = [];

    if (norm === 'water' || norm === 'ice') {
      matchedTo = '(water — no cost)'; pricePerKg = 0; confidence = 'water';
    } else if (norm === 'mother' || norm === 'starter') {
      // Perpetual sourdough culture (maintained flour+water, used in tiny amounts) — negligible cost.
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
  const costed = lines.filter((l) => l.lineCost != null);
  const batchCost = costed.reduce((s, l) => s + l.lineCost, 0);
  const allPriced = costed.length === lines.length;
  // Cost of one sold unit = (batch cost per kg) × the unit's finished weight. Only meaningful when
  // every ingredient is priced AND we know the per-unit weight (yield).
  const costPerUnit = (allPriced && recipe.portionKg) ? (batchCost / recipe.totalKg) * recipe.portionKg : null;
  return {
    recipe: recipe.recipe, sheet: recipe.sheet, totalKg: recipe.totalKg,
    portionKg: recipe.portionKg ?? null, portionBasis: recipe.portionBasis ?? null, unitsPerBatch: recipe.unitsPerBatch ?? null,
    cost: batchCost, costPerUnit,
    linesCosted: costed.length, linesTotal: lines.length,
    unresolved: lines.filter((l) => l.flag && l.flag !== 'low-confidence').map((l) => l.ingredient),
    lines,
  };
};

const buildCostReport = async (folderName = 'Recipe LSB') => {
  const prices = load(PRICES_FILE, null);
  if (!prices) throw new Error('Run `node pipeline/chefs-warehouse.js` first to build the price list.');
  const overrides = load(OVERRIDES_FILE, {});
  const portionOverrides = load(PORTION_OVERRIDES_FILE, {});
  const { recipes, skipped } = fs.existsSync(LOCAL_RECIPE_DIR)
    ? pullRecipesFromDir(LOCAL_RECIPE_DIR)
    : await pullRecipes(folderName);
  // Fill in per-unit weight for recipes whose PROCESS notes didn't yield one.
  recipes.forEach((r) => {
    if (!r.portionKg && portionOverrides[r.recipe] != null) {
      r.portionKg = portionOverrides[r.recipe] / 1000;
      r.portionBasis = `override ${portionOverrides[r.recipe]}g`;
      r.unitsPerBatch = r.totalKg / r.portionKg;
    }
  });
  // Iterate: cost with CW prices, derive per-kg prices for any fully-costed recipe, then re-cost so
  // recipes that use those as sub-recipes (Levain → scones) resolve. Repeat until nothing new completes.
  const isComplete = (c) => c.lines.every((l) => l.lineCost != null);
  let costed = recipes.map((r) => costRecipe(r, prices.ingredients, overrides, {}));
  for (let i = 0; i < 6; i++) {
    const subPrices = {};
    costed.forEach((c) => { if (c.totalKg > 0 && isComplete(c)) subPrices[normName(c.recipe)] = c.cost / c.totalKg; });
    const next = recipes.map((r) => costRecipe(r, prices.ingredients, overrides, subPrices));
    const gained = next.filter(isComplete).length - costed.filter(isComplete).length;
    costed = next;
    if (gained <= 0) break;
  }
  const source = fs.existsSync(LOCAL_RECIPE_DIR) ? `local:${path.basename(LOCAL_RECIPE_DIR)}` : `drive:${folderName}`;
  return { generatedAt: new Date().toISOString(), source, priceListDate: prices.generatedAt, skipped, recipes: costed };
};

module.exports = { buildCostReport, costRecipe, rankCandidates };

// CLI: node pipeline/match-cost.js  → writes recipe-costs.json + ingredient-match-approval.csv
if (require.main === module) {
  require('dotenv').config();
  buildCostReport().then((report) => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'recipe-costs.json'), JSON.stringify(report, null, 2));
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
    console.log('Wrote data/pipeline/recipe-costs.json + ingredient-match-approval.csv');
  }).catch((e) => { console.error('Failed:', e.message); process.exit(1); });
}
