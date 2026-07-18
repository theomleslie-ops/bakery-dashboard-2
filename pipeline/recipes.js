// Parses bakery recipe sheets (the "RECIPE SHEET" format) into a clean
// { recipe, ingredients: [{ name, kg }], totalKg } shape. Recipes come from either the shared Drive
// folder (pullRecipes) or a local folder of exported .xlsx/.xls files (pullRecipesFromDir) — the
// "Basic recipe" column is the kilograms of each ingredient for one batch.
const fs = require('fs');
const path = require('path');
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

// ---- Local files (Google Sheets exported as .xlsx/.xls, e.g. a downloaded Drive folder) ----
const parseRecipeFile = (filePath) => {
  const XLSX = require('xlsx'); // lazy so the Drive path doesn't require xlsx installed
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  return parseRecipeTab(path.basename(filePath).replace(/\.(xlsx|xls)$/i, ''), rows);
};

const walkRecipeFiles = (dir) => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkRecipeFiles(p));
    else if (/\.(xlsx|xls)$/i.test(e.name) && !e.name.startsWith('~$')) out.push(p);
  }
  return out;
};

// Parse every .xlsx/.xls recipe under a local folder (recursively). Returns { recipes, skipped }.
const pullRecipesFromDir = (dir) => {
  const recipes = [];
  const skipped = [];
  for (const f of walkRecipeFiles(dir)) {
    try { const r = parseRecipeFile(f); if (r) recipes.push(r); else skipped.push(path.basename(f)); }
    catch (e) { skipped.push(`${path.basename(f)} [${e.message}]`); }
  }
  return { recipes, skipped };
};

module.exports = { parseRecipeTab, pullRecipes, parseRecipeFile, pullRecipesFromDir };
