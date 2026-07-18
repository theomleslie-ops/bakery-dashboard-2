// Parses bakery recipe sheets (the "RECIPE SHEET" format) from a shared Drive folder into a clean
// { recipe, ingredients: [{ name, kg }], totalKg } shape. Each recipe is one spreadsheet; the
// "Basic recipe" column is the kilograms of each ingredient for one batch.
const sheetsClient = require('./sheets');

const norm = (v) => (v == null ? '' : String(v)).trim();
const toNum = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : NaN; };

// Parse one recipe sheet's first tab. Returns null if it isn't a recognizable recipe sheet.
const parseRecipeTab = (title, rows) => {
  const flat = (rows || []).map((r) => (r || []).map(norm));

  const looksLikeRecipe = flat.some((r) => r.some((c) => /RECIPE SHEET/i.test(c)))
    || flat.some((r) => /^ingredients$/i.test(r[0] || '') && /basic recipe/i.test(r[1] || ''));
  if (!looksLikeRecipe) return null;

  // Recipe name: the cell under the "NAME OF THE RECIPE" label, else the sheet title.
  let name = title.trim();
  for (let i = 0; i < flat.length - 1; i++) {
    const j = flat[i].findIndex((c) => /NAME OF THE RECIPE/i.test(c));
    if (j >= 0 && flat[i + 1][j]) { name = flat[i + 1][j]; break; }
  }

  // The ingredient table starts after the "Ingredients | Basic recipe" header row.
  const header = flat.findIndex((r) => /^ingredients$/i.test(r[0] || '') && /basic recipe/i.test(r[1] || ''));
  if (header < 0) return null;

  const ingredients = [];
  for (let i = header + 1; i < rows.length; i++) {
    const nm = norm(rows[i] && rows[i][0]);
    if (/^total/i.test(nm) || /^process/i.test(nm) || /^sum$/i.test(nm)) break;
    if (!nm) continue;                       // skip spacer rows
    const kg = toNum(rows[i][1]);
    if (!(kg > 0)) continue;                 // skip zero/blank quantity rows
    ingredients.push({ name: nm, kg });
  }
  if (!ingredients.length) return null;

  return { recipe: name.trim(), sheet: title.trim(), ingredients, totalKg: ingredients.reduce((s, x) => s + x.kg, 0) };
};

// Pull and parse every recipe sheet in a folder. Returns { recipes, skipped }.
const pullRecipes = async (folderName = 'Recipe LSB') => {
  const { sheets, drive } = await sheetsClient.getClients();
  const folder = await sheetsClient.resolveFolderByName(drive, folderName);
  const list = await sheetsClient.listSheetsInFolder(drive, folder.id);

  const recipes = [];
  const skipped = [];
  for (const s of list) {
    const sp = await sheetsClient.pullSpreadsheet(sheets, s.id);
    const firstTab = Object.values(sp.tabs)[0];
    const parsed = firstTab ? parseRecipeTab(sp.title, firstTab.rows) : null;
    if (parsed) recipes.push(parsed);
    else skipped.push(sp.title);
  }
  return { folder: folder.name, recipes, skipped };
};

module.exports = { parseRecipeTab, pullRecipes };
