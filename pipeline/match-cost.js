// Matches recipe ingredients to Chef's Warehouse priced items and computes cost-to-make per recipe.
// Names never line up exactly (recipe "AP Flour (AP Harina)" vs CW "FLOUR AP ORGANIC"), so this
// scores candidates and emits an approval table for a human to confirm/correct. A manual overrides
// file (recipe ingredient → CW item code) always wins.
const fs = require('fs');
const path = require('path');
const { pullRecipes } = require('./recipes');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_DIR = path.join(DATA_DIR, 'pipeline');
const PRICES_FILE = path.join(OUT_DIR, 'chefs-warehouse-prices.json');
const OVERRIDES_FILE = path.join(OUT_DIR, 'ingredient-overrides.json'); // { "<recipe ingredient>": "<CW item code>" }

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

// Cost one recipe. Each line: matched CW item, $/kg, line cost, and a flag if unmatched/non-weight.
const costRecipe = (recipe, cwList, overrides) => {
  const byCode = new Map(cwList.map((c) => [c.itemCode, c]));
  const lines = recipe.ingredients.map((ing) => {
    const override = overrides[ing.name] || overrides[englishPart(ing.name).toLowerCase()];
    let match, confidence, alternates = [];
    if (override && byCode.has(override)) { match = byCode.get(override); confidence = 'override'; }
    else {
      const ranked = rankCandidates(ing.name, cwList);
      match = ranked[0]?.cw;
      confidence = confidenceOf(ranked);
      alternates = ranked.slice(1, 3).map((r) => r.cw.description);
    }
    const pricePerKg = match?.pricePerKg ?? null;
    const lineCost = pricePerKg != null ? ing.kg * pricePerKg : null;
    const flag = !match ? 'no-match' : pricePerKg == null ? 'non-weight' : confidence === 'low' ? 'low-confidence' : '';
    return {
      ingredient: ing.name, kg: ing.kg,
      matchedTo: match?.description ?? null, itemCode: match?.itemCode ?? null,
      pricePerKg, lineCost, confidence, flag, alternates,
    };
  });
  const costed = lines.filter((l) => l.lineCost != null);
  return {
    recipe: recipe.recipe, sheet: recipe.sheet, totalKg: recipe.totalKg,
    cost: costed.reduce((s, l) => s + l.lineCost, 0),
    linesCosted: costed.length, linesTotal: lines.length,
    unresolved: lines.filter((l) => l.flag && l.flag !== 'low-confidence').map((l) => l.ingredient),
    lines,
  };
};

const buildCostReport = async (folderName = 'Recipe LSB') => {
  const prices = load(PRICES_FILE, null);
  if (!prices) throw new Error('Run `node pipeline/chefs-warehouse.js` first to build the price list.');
  const overrides = load(OVERRIDES_FILE, {});
  const { recipes, skipped } = await pullRecipes(folderName);
  const costed = recipes.map((r) => costRecipe(r, prices.ingredients, overrides));
  return { generatedAt: new Date().toISOString(), folder: folderName, priceListDate: prices.generatedAt, skipped, recipes: costed };
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
