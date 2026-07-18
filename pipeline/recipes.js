// Parses bakery recipe sheets (the "RECIPE SHEET" format) into a clean
// { recipe, ingredients: [{ name, kg }], totalKg } shape. Recipes come from either the shared Drive
// folder (pullRecipes) or a local folder of exported .xlsx/.xls files (pullRecipesFromDir) — the
// "Basic recipe" column is the kilograms of each ingredient for one batch.
const fs = require('fs');
const path = require('path');
const sheetsClient = require('./sheets');

const norm = (v) => (v == null ? '' : String(v)).trim();
const toNum = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : NaN; };

const UNIT = 'cookie|scone|muffin|piece|pan|cake|unit|pcs?|loaf|bun|roll|slice|bar|tart';
// Pull the finished weight of one sold unit out of a recipe's PROCESS notes, so batch cost can be
// turned into cost-per-unit. Handles the phrasings the sheets actually use.
const parsePortion = (text) => {
  if (!text) return null;
  const t = String(text).replace(/(\d),(\d)/g, '$1.$2'); // "1,4kg" → "1.4kg" (comma decimal)
  let m;
  // "Weight 235gr per cookie" / "1865g per pan" / "175 g / piece"
  m = t.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*g(?:r|ram)?s?\\s*(?:per|/)\\s*(${UNIT})`, 'i'));
  if (m) return { portionKg: parseFloat(m[1]) / 1000, basis: `${m[1]}g per ${m[2].toLowerCase()}` };
  // "1 muffin = 135gr of batter"
  m = t.match(new RegExp(`1\\s+(${UNIT})\\s*=\\s*(\\d+(?:\\.\\d+)?)\\s*g`, 'i'));
  if (m) return { portionKg: parseFloat(m[2]) / 1000, basis: `1 ${m[1].toLowerCase()} = ${m[2]}g` };
  // "Scale doughs of 1.4kg and detail in 8 pcs"
  m = t.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*kg[^.]*?(?:detail\\s+in\\s+|into\\s+|in\\s+)(\\d+)\\s*(?:${UNIT})`, 'i'));
  if (m) return { portionKg: parseFloat(m[1]) / parseInt(m[2], 10), basis: `${m[1]}kg ÷ ${m[2]} pcs` };
  // "...of 1400g ... detail in 8 pcs"
  m = t.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*g[^.]*?(?:detail\\s+in\\s+|into\\s+)(\\d+)\\s*(?:${UNIT})`, 'i'));
  if (m) return { portionKg: parseFloat(m[1]) / 1000 / parseInt(m[2], 10), basis: `${m[1]}g ÷ ${m[2]} pcs` };
  // "SHAPING: 160g normal/60g catering" → the normal portion
  m = t.match(/(\d+(?:\.\d+)?)\s*g\s*normal/i);
  if (m) return { portionKg: parseFloat(m[1]) / 1000, basis: `${m[1]}g normal` };
  // "WEIGHT PER LOAF : 1020gr" / "weight per unit: 200 g"
  m = t.match(/weight\s+per\s+(?:loaf|unit|piece)\s*:?\s*(\d+(?:\.\d+)?)\s*(kg|gr?|g)\b/i);
  if (m) return { portionKg: /kg/i.test(m[2]) ? parseFloat(m[1]) : parseFloat(m[1]) / 1000, basis: `weight per unit ${m[1]}${m[2]}` };
  // "1kg/boule" | "500gr/baguette" | "1,45kg/round"
  m = t.match(/(\d+(?:\.\d+)?)\s*kg\s*\/\s*(baguette|boule|round|loaf|roll|bun)/i);
  if (m) return { portionKg: parseFloat(m[1]), basis: `${m[1]}kg/${m[2].toLowerCase()}` };
  m = t.match(/(\d+(?:\.\d+)?)\s*(?:gr?|g)\s*\/\s*(baguette|boule|round|loaf|roll|bun)/i);
  if (m) return { portionKg: parseFloat(m[1]) / 1000, basis: `${m[1]}g/${m[2].toLowerCase()}` };
  return null;
};

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

  // Capture the PROCESS notes and parse the per-unit weight (yield) from them.
  const pIdx = flat.findIndex((r) => /^process$/i.test((r[0] || '').trim()));
  const process = pIdx >= 0
    ? rows.slice(pIdx + 1).map((r) => (r || []).map((c) => String(c)).join(' ')).join(' ').trim()
    : (flat.flat().find((c) => c.length > 60) || '');
  const portion = parsePortion(process);
  const totalKg = ingredients.reduce((s, x) => s + x.kg, 0);

  return {
    recipe: name.trim(), sheet: title.trim(), ingredients, totalKg,
    portionKg: portion ? portion.portionKg : null,
    portionBasis: portion ? portion.basis : null,
    unitsPerBatch: portion ? totalKg / portion.portionKg : null,
  };
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
