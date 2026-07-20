// Parses the bakery's "RECIPE SHEET" Google Sheets into a clean, costable shape:
//   { recipe, sheet, ingredients: [{ name, kg }], totalKg, portionKg, portionBasis, unitsPerBatch }
//
// These are BATCH recipes — the ingredient column is kilograms for a whole batch, not one unit.
// To get a cost per SOLD unit we also need the finished weight of one unit (portionKg / "yield").
// Yield is resolved in priority order so coverage can climb toward 100% without brittle guessing:
//   1. a structured yield cell in the sheet ("grams per unit" / "units per batch")  ← most reliable
//   2. data/pipeline/yield-overrides.json  ({ "<recipe>": <grams per unit> })        ← we maintain
//   3. best-effort parse of the freeform PROCESS notes                                ← last resort
// A recipe with no yield from any source is still returned (portionKg = null) so it surfaces in the
// coverage report as "needs-yield" rather than being silently dropped.
const path = require('path');
const fs = require('fs');
// Read recipe sheets via whichever Google client is available. Prefer the service account (headless,
// no consent screen, no 7-day token expiry) when its key is present; otherwise fall back to user
// OAuth. Both modules expose the same getClients / resolveFolderByName / listSheetsInFolder /
// pullSpreadsheet interface, so the rest of this file doesn't care which one is used.
const SA_KEY = path.join(__dirname, '..', 'data', 'google-service-account.json');
const sheetsClient = fs.existsSync(SA_KEY) ? require('./sheets') : require('./sheets-oauth');

const norm = (v) => (v == null ? '' : String(v)).trim();
const toNum = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : NaN; };

// ---- yield / portion parsing from freeform PROCESS notes (fallback only) ----
const UNIT = 'cookie|scone|muffin|piece|pan|cake|unit|pcs?|loaf|bun|roll|slice|bar|tart|croissant|danish';
const parsePortion = (text) => {
  if (!text) return null;
  const t = String(text).replace(/(\d),(\d)/g, '$1.$2'); // "1,4kg" → "1.4kg" (comma decimal)
  let m;
  m = t.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*g(?:r|ram)?s?\\s*(?:per|/)\\s*(${UNIT})`, 'i'));
  if (m) return { portionKg: parseFloat(m[1]) / 1000, basis: `${m[1]}g per ${m[2].toLowerCase()}` };
  m = t.match(new RegExp(`1\\s+(${UNIT})\\s*=\\s*(\\d+(?:\\.\\d+)?)\\s*g`, 'i'));
  if (m) return { portionKg: parseFloat(m[2]) / 1000, basis: `1 ${m[1].toLowerCase()} = ${m[2]}g` };
  m = t.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*kg[^.]*?(?:detail\\s+in\\s+|into\\s+|in\\s+)(\\d+)\\s*(?:${UNIT})`, 'i'));
  if (m) return { portionKg: parseFloat(m[1]) / parseInt(m[2], 10), basis: `${m[1]}kg ÷ ${m[2]} pcs` };
  m = t.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*g[^.]*?(?:detail\\s+in\\s+|into\\s+)(\\d+)\\s*(?:${UNIT})`, 'i'));
  if (m) return { portionKg: parseFloat(m[1]) / 1000 / parseInt(m[2], 10), basis: `${m[1]}g ÷ ${m[2]} pcs` };
  m = t.match(/(\d+(?:\.\d+)?)\s*g\s*normal/i);
  if (m) return { portionKg: parseFloat(m[1]) / 1000, basis: `${m[1]}g normal` };
  m = t.match(/weight\s+per\s+(?:loaf|unit|piece)\s*:?\s*(\d+(?:\.\d+)?)\s*(kg|gr?|g)\b/i);
  if (m) return { portionKg: /kg/i.test(m[2]) ? parseFloat(m[1]) : parseFloat(m[1]) / 1000, basis: `weight per unit ${m[1]}${m[2]}` };
  m = t.match(/(\d+(?:\.\d+)?)\s*kg\s*\/\s*(baguette|boule|round|loaf|roll|bun)/i);
  if (m) return { portionKg: parseFloat(m[1]), basis: `${m[1]}kg/${m[2].toLowerCase()}` };
  m = t.match(/(\d+(?:\.\d+)?)\s*(?:gr?|g)\s*\/\s*(baguette|boule|round|loaf|roll|bun)/i);
  if (m) return { portionKg: parseFloat(m[1]) / 1000, basis: `${m[1]}g/${m[2].toLowerCase()}` };
  return null;
};

// ---- structured yield cell (preferred) ----
// Scan the sheet for an explicit yield the bakery entered, e.g. a row labelled "grams per unit",
// "weight per unit", "portion", or "units per batch". Returns { portionKg, basis } or null.
const parseStructuredYield = (flat, totalKg) => {
  for (let i = 0; i < flat.length; i++) {
    for (let j = 0; j < flat[i].length; j++) {
      const label = flat[i][j].toLowerCase();
      const valNextCell = toNum(flat[i][j + 1]);
      const valBelow = toNum((flat[i + 1] || [])[j]);
      const val = Number.isFinite(valNextCell) ? valNextCell : valBelow;
      if (!Number.isFinite(val) || val <= 0) continue;
      if (/grams?\s*per\s*unit|weight\s*per\s*unit|portion\s*(?:weight|size|g)?/.test(label)) {
        return { portionKg: val / 1000, basis: `sheet: ${label.trim()} ${val}g` };
      }
      if (/units?\s*per\s*batch|yield\s*\(?units?\)?|makes/.test(label) && totalKg > 0) {
        return { portionKg: totalKg / val, basis: `sheet: ${val} units per batch` };
      }
    }
  }
  return null;
};

// Parse one recipe sheet's first tab. Returns null if it isn't a recognizable recipe sheet.
const parseRecipeTab = (title, rows, { yieldOverrides = {} } = {}) => {
  const flat = (rows || []).map((r) => (r || []).map(norm));

  const looksLikeRecipe = flat.some((r) => r.some((c) => /RECIPE SHEET/i.test(c)))
    || flat.some((r) => /^ingredients$/i.test(r[0] || '') && /basic recipe/i.test(r[1] || ''));
  if (!looksLikeRecipe) return null;

  // Recipe name: cell under a "NAME OF THE RECIPE" label, else the sheet title.
  let name = title.trim();
  for (let i = 0; i < flat.length - 1; i++) {
    const j = flat[i].findIndex((c) => /NAME OF THE RECIPE/i.test(c));
    if (j >= 0 && flat[i + 1][j]) { name = flat[i + 1][j]; break; }
  }

  // Ingredient table starts after the "Ingredients | Basic recipe" header row.
  const header = flat.findIndex((r) => /^ingredients$/i.test(r[0] || '') && /basic recipe/i.test(r[1] || ''));
  if (header < 0) return null;

  const ingredients = [];
  let totalFromSheet = null; // "Total brut" or "Total net" value from the sheet
  for (let i = header + 1; i < rows.length; i++) {
    const nm = norm(rows[i] && rows[i][0]);
    // Capture "Total brut" or "Total net" as the per-unit finished product weight
    if (/^total\s+(brut|net)$/i.test(nm)) {
      const val = toNum(rows[i][1]);
      if (val > 0) totalFromSheet = val;
      break;
    }
    if (/^process/i.test(nm) || /^sum$/i.test(nm)) break;
    if (!nm) continue;
    const kg = toNum(rows[i][1]);
    if (!(kg > 0)) continue;
    ingredients.push({ name: nm, kg });
  }
  if (!ingredients.length) return null;
  const totalKg = ingredients.reduce((s, x) => s + x.kg, 0);
  const recipeName = name.trim();

  // Yield: PROCESS-notes (most explicit) → structured cell → override file → "Total brut/net" (batch equiv when 1 unit).
  let portionKg = null;
  let portionBasis = null;

  // Try PROCESS notes first (e.g. "Weight 235gr per cookie" is explicit)
  const pIdx = flat.findIndex((r) => /^process$/i.test((r[0] || '').trim()));
  const process = pIdx >= 0
    ? rows.slice(pIdx + 1).map((r) => (r || []).map((c) => String(c)).join(' ')).join(' ').trim()
    : (flat.flat().find((c) => c.length > 60) || '');
  const portion = parsePortion(process);

  if (portion) {
    portionKg = portion.portionKg;
    portionBasis = portion.basis;
  } else {
    const structured = parseStructuredYield(flat, totalKg);
    if (structured) {
      ({ portionKg, basis: portionBasis } = structured);
    } else if (Number.isFinite(toNum(yieldOverrides[recipeName])) && toNum(yieldOverrides[recipeName]) > 0) {
      portionKg = toNum(yieldOverrides[recipeName]) / 1000;
      portionBasis = `override ${yieldOverrides[recipeName]}g`;
    } else if (totalFromSheet != null) {
      portionKg = totalFromSheet;
      portionBasis = 'sheet: Total brut/net';
    }
  }

  return {
    recipe: recipeName,
    sheet: title.trim(),
    ingredients,
    totalKg,
    portionKg,
    portionBasis,
    unitsPerBatch: portionKg ? totalKg / portionKg : null,
  };
};

// Pull and parse every recipe sheet in a Drive folder (read as the OAuth user).
// Returns { folder, recipes, skipped }.
const pullRecipes = async (folderName = 'Recipe LSB', { yieldOverrides = {} } = {}) => {
  const { sheets, drive } = await sheetsClient.getClients();
  const folder = await sheetsClient.resolveFolderByName(drive, folderName);
  const list = await sheetsClient.listSheetsInFolder(drive, folder.id);

  const recipes = [];
  const skipped = [];
  for (const s of list) {
    let sp;
    try {
      if (s.isExcel) {
        sp = await sheetsClient.downloadAndParseExcel(drive, s.id, s.name);
      } else {
        sp = await sheetsClient.pullSpreadsheet(sheets, s.id);
      }
    } catch (e) {
      skipped.push(`${s.name} (error: ${e.message})`);
      continue;
    }
    const firstTab = Object.values(sp.tabs)[0];
    const parsed = firstTab ? parseRecipeTab(sp.title, firstTab.rows, { yieldOverrides }) : null;
    if (parsed) recipes.push(parsed);
    else skipped.push(sp.title);
  }
  return { folder: folder.name, recipes, skipped };
};

module.exports = { parseRecipeTab, parsePortion, parseStructuredYield, pullRecipes };
