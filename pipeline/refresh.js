// ============================================================================
// The one function you call to refresh everything: refresh().
// Pulls QuickBooks reports + Google Sheets, consolidates into one JSON, and
// writes JSON + per-dataset CSVs to data/pipeline/. No manual uploads.
//
//   node pipeline/refresh.js              # both sources
//   node pipeline/refresh.js --qb-only    # QuickBooks only
//   node pipeline/refresh.js --sheets-only
//
// Programmatic:  const { refresh } = require('./pipeline/refresh'); await refresh();
// ============================================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const qb = require('./quickbooks');
const sheetsClient = require('./sheets');
const config = require('./config');
const { flattenQBReport, qbTableToCSV, rowsToCSV, slug } = require('./transform');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_DIR = path.join(DATA_DIR, 'pipeline');
const LATEST_DIR = path.join(OUT_DIR, 'latest');
const SNAP_DIR = path.join(OUT_DIR, 'snapshots');

const isoDay = (d) => d.toISOString().slice(0, 10);

// Resolve a `range` shortcut into QuickBooks date params.
const resolveRange = (range) => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  switch (range) {
    case 'ytd':
    case 'thisYear': return { start_date: `${y}-01-01`, end_date: isoDay(now) };
    case 'lastYear': return { start_date: `${y - 1}-01-01`, end_date: `${y - 1}-12-31` };
    case 'thisMonth': return { start_date: `${y}-${m}-01`, end_date: isoDay(now) };
    case 'asOfToday': return { end_date: isoDay(now) }; // point-in-time (balance sheet, aging)
    default: return {};
  }
};

const pullQuickBooks = async () => {
  const reports = {};
  for (const spec of config.quickbooksReports) {
    const params = { ...resolveRange(spec.range), ...(spec.params || {}) };
    process.stdout.write(`  QB     → ${spec.key} (${spec.report})… `);
    try {
      const raw = await qb.fetchReport(spec.report, params);
      const table = flattenQBReport(raw);
      reports[spec.key] = { report: spec.report, params, fetchedAt: new Date().toISOString(), table, raw };
      console.log(`ok — ${table.records.length} rows, ${table.columns.length} cols`);
    } catch (e) {
      const detail = e.response?.data?.Fault?.Error?.[0]?.Detail || e.message;
      console.log(`FAILED — ${detail}`);
      reports[spec.key] = { report: spec.report, params, error: detail };
    }
  }
  const tokens = qb.loadTokens();
  return { realmId: tokens?.realmId || null, reports };
};

// entries: array of { id } and/or { name } (name is resolved via Drive). Defaults to config.
const pullSheets = async (entries = config.googleSheets) => {
  if (!sheetsClient.hasCredentials()) {
    console.log('  Sheets → skipped (no data/google-service-account.json yet)');
    return { skipped: 'no credentials' };
  }
  if (!entries.length) {
    console.log('  Sheets → skipped (no sheets listed in pipeline/config.js)');
    return { skipped: 'no sheets configured' };
  }
  const { sheets, drive } = await sheetsClient.getClients();

  // Expand any { folder: '...' } entries into the sheets they contain.
  const expanded = [];
  for (const s of entries) {
    if (s.folder) {
      try {
        const folder = await sheetsClient.resolveFolderByName(drive, s.folder);
        const inFolder = await sheetsClient.listSheetsInFolder(drive, folder.id);
        console.log(`  Folder "${folder.name}" → ${inFolder.length} sheet${inFolder.length === 1 ? '' : 's'}`);
        inFolder.forEach((f) => expanded.push({ id: f.id, name: f.name }));
      } catch (e) {
        console.log(`  Folder "${s.folder}" → FAILED — ${e.errors?.[0]?.message || e.message}`);
      }
    } else {
      expanded.push(s);
    }
  }

  const spreadsheets = {};
  for (const s of expanded) {
    const ref = s.name || s.label || s.id;
    process.stdout.write(`  Sheets → ${ref}… `);
    try {
      // Resolve a name to an id via Drive; an explicit id is used as-is.
      const id = s.id || (await sheetsClient.resolveByName(drive, s.name)).id;
      const data = await sheetsClient.pullSpreadsheet(sheets, id);
      spreadsheets[id] = data;
      console.log(`ok — "${data.title}", ${Object.keys(data.tabs).length} tabs`);
    } catch (e) {
      const detail = e.errors?.[0]?.message || e.message;
      console.log(`FAILED — ${detail}`);
      spreadsheets[s.id || s.name] = { ref, error: detail };
    }
  }
  return { spreadsheets };
};

const writeOutputs = (result) => {
  fs.mkdirSync(LATEST_DIR, { recursive: true });

  // Consolidated JSON (full fidelity, incl. raw QB report trees).
  fs.writeFileSync(path.join(LATEST_DIR, 'consolidated.json'), JSON.stringify(result, null, 2));

  // Per-report / per-tab CSVs for quick spreadsheet-style poking.
  for (const [key, r] of Object.entries(result.sources.quickbooks?.reports || {})) {
    if (r.table) fs.writeFileSync(path.join(LATEST_DIR, `qb_${key}.csv`), qbTableToCSV(r.table));
  }
  for (const sp of Object.values(result.sources.googleSheets?.spreadsheets || {})) {
    if (!sp.tabs) continue;
    for (const [tab, t] of Object.entries(sp.tabs)) {
      fs.writeFileSync(path.join(LATEST_DIR, `sheet_${slug(sp.title)}__${slug(tab)}.csv`), rowsToCSV(t.rows));
    }
  }

  // Timestamped snapshot so history is preserved across refreshes.
  const snap = path.join(SNAP_DIR, result.generatedAt.replace(/[:.]/g, '-'));
  fs.mkdirSync(snap, { recursive: true });
  fs.writeFileSync(path.join(snap, 'consolidated.json'), JSON.stringify(result, null, 2));
};

// sheetsOverride: pull these entries ([{name}]/[{id}]) instead of config.googleSheets.
const refresh = async ({ qbOnly = false, sheetsOnly = false, sheetsOverride = null } = {}) => {
  const result = { generatedAt: new Date().toISOString(), sources: { quickbooks: null, googleSheets: null } };
  if (!sheetsOnly) result.sources.quickbooks = await pullQuickBooks();
  if (!qbOnly) result.sources.googleSheets = await pullSheets(sheetsOverride || config.googleSheets);
  writeOutputs(result);
  return result;
};

// Print every sheet the service account can see — the menu of names you can pull by.
const listAccessibleSheets = async () => {
  if (!sheetsClient.hasCredentials()) return console.log('No data/google-service-account.json yet — do the Google setup first.');
  const { drive } = await sheetsClient.getClients();
  const files = await sheetsClient.listSpreadsheets(drive);
  if (!files.length) return console.log('The service account can see 0 sheets. Share a sheet (or a folder of sheets) with its email.');
  console.log(`Sheets the service account can see (${files.length}):`);
  files.forEach((f) => console.log(`  • ${f.name}`));
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const valueOf = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

  const summarize = (r) => {
    const qbCount = Object.keys(r.sources.quickbooks?.reports || {}).length;
    const shCount = Object.values(r.sources.googleSheets?.spreadsheets || {}).reduce((n, sp) => n + Object.keys(sp.tabs || {}).length, 0);
    console.log(`\nDone. QuickBooks reports: ${qbCount} · Sheet tabs: ${shCount}`);
    console.log(`Wrote → ${path.relative(process.cwd(), path.join(LATEST_DIR, 'consolidated.json'))} (+ CSVs)`);
  };

  const run = async () => {
    if (flag('--list')) return listAccessibleSheets();

    const sheetName = valueOf('--sheet');
    if (sheetName) {
      console.log(`Pulling sheet "${sheetName}"…`);
      return summarize(await refresh({ sheetsOnly: true, sheetsOverride: [{ name: sheetName }] }));
    }

    const folderName = valueOf('--folder');
    if (folderName) {
      console.log(`Pulling every sheet in folder "${folderName}"…`);
      return summarize(await refresh({ sheetsOnly: true, sheetsOverride: [{ folder: folderName }] }));
    }

    console.log('Refreshing data pipeline…');
    summarize(await refresh({ qbOnly: flag('--qb-only'), sheetsOnly: flag('--sheets-only') }));
  };

  run().catch((e) => { console.error('Pipeline failed:', e.message); process.exit(1); });
}

module.exports = { refresh, pullSheets, listAccessibleSheets };
