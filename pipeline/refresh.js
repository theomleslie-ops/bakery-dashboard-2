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

const pullSheets = async () => {
  if (!sheetsClient.hasCredentials()) {
    console.log('  Sheets → skipped (no data/google-service-account.json yet)');
    return { skipped: 'no credentials' };
  }
  if (!config.googleSheets.length) {
    console.log('  Sheets → skipped (no sheets listed in pipeline/config.js)');
    return { skipped: 'no sheets configured' };
  }
  const client = await sheetsClient.getSheetsClient();
  const spreadsheets = {};
  for (const s of config.googleSheets) {
    process.stdout.write(`  Sheets → ${s.label || s.id}… `);
    try {
      const data = await sheetsClient.pullSpreadsheet(client, s.id);
      spreadsheets[s.id] = data;
      console.log(`ok — "${data.title}", ${Object.keys(data.tabs).length} tabs`);
    } catch (e) {
      const detail = e.errors?.[0]?.message || e.message;
      console.log(`FAILED — ${detail}`);
      spreadsheets[s.id] = { id: s.id, error: detail };
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

const refresh = async ({ qbOnly = false, sheetsOnly = false } = {}) => {
  const result = { generatedAt: new Date().toISOString(), sources: { quickbooks: null, googleSheets: null } };
  if (!sheetsOnly) result.sources.quickbooks = await pullQuickBooks();
  if (!qbOnly) result.sources.googleSheets = await pullSheets();
  writeOutputs(result);
  return result;
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const opts = { qbOnly: args.includes('--qb-only'), sheetsOnly: args.includes('--sheets-only') };
  console.log('Refreshing data pipeline…');
  refresh(opts)
    .then((r) => {
      const qbCount = Object.keys(r.sources.quickbooks?.reports || {}).length;
      const shCount = Object.values(r.sources.googleSheets?.spreadsheets || {}).reduce((n, sp) => n + Object.keys(sp.tabs || {}).length, 0);
      console.log(`\nDone. QuickBooks reports: ${qbCount} · Sheet tabs: ${shCount}`);
      console.log(`Wrote → ${path.relative(process.cwd(), path.join(LATEST_DIR, 'consolidated.json'))} (+ CSVs)`);
    })
    .catch((e) => { console.error('Pipeline failed:', e.message); process.exit(1); });
}

module.exports = { refresh };
