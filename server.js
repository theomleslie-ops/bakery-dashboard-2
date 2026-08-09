const express = require('express');
const cors = require('cors');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const axios = require('axios');
const cron = require('node-cron');
require('dotenv').config();

const qbClient = require('./pipeline/qb-client');
const qbCache = require('./pipeline/qb-cache');
const claudeMCP = require('./pipeline/claude-mcp');
const marginSchedulerModule = require('./pipeline/margin-scheduler');
const ingredientSchedulerModule = require('./pipeline/ingredient-scheduler');
const { fetchProductionData } = require('./pipeline/google-drive-production');

let marginScheduler = null;
let ingredientScheduler = null;
let composioConnectors = null;

// Lazy-load composio (ES Module compatibility)
const loadComposio = async () => {
  if (!composioConnectors) {
    try {
      const mod = await import('./pipeline/composio-connectors.js');
      composioConnectors = mod.default || mod;
    } catch (e) {
      console.warn('⚠️ Composio unavailable:', e.message);
      composioConnectors = {
        getConnectionStatus: () => null,
        initComposio: async () => null,
        getSquareConnection: async () => null,
        getQuickBooksConnection: async () => null,
        disconnectSquare: async () => null,
        disconnectQuickBooks: async () => null,
      };
    }
  }
  return composioConnectors;
};

// Initialize composio on startup
loadComposio().catch(e => console.warn('Failed to load composio:', e.message));

// Safe lazy-load of initMargins
const initMargins = async () => {
  try {
    const { initMargins: fn } = require('./pipeline/init-margins');
    return await fn();
  } catch (e) {
    console.warn('initMargins unavailable:', e.message);
  }
};

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

// Data storage paths (use absolute path to work correctly on Railway)
const DATA_DIR = path.join(__dirname, 'data');
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  // Ignore errors - directory may already exist or be read-only
}

// If DATA_DIR is backed by a persistent volume (e.g. Railway), a fresh/empty volume shadows
// whatever git-tracked files used to live at this path in the image (data/monthly-financial.json
// is committed to git specifically so it survives redeploys, but a volume mount replaces the whole
// directory's content on first attach). Restore it from the repo-tracked seed copy if missing.
const MONTHLY_FINANCIAL_FILE = path.join(DATA_DIR, 'monthly-financial.json');
const MONTHLY_FINANCIAL_SEED = 'seed-data/monthly-financial.json';
if (!fs.existsSync(MONTHLY_FINANCIAL_FILE) && fs.existsSync(MONTHLY_FINANCIAL_SEED)) {
  try {
    fs.copyFileSync(MONTHLY_FINANCIAL_SEED, MONTHLY_FINANCIAL_FILE);
  } catch (e) {
    // Ignore errors - file may already exist or directory may be read-only
  }
}

const RECIPES_FILE = path.join(DATA_DIR, 'recipes.json');
const INGREDIENTS_FILE = path.join(DATA_DIR, 'ingredients.json');
const FINANCIAL_FILE = path.join(DATA_DIR, 'financial.json');
const PRODUCTION_FILE = path.join(DATA_DIR, 'production.json');

// Same volume-shadowing concern as MONTHLY_FINANCIAL_FILE above - restore from the repo-tracked
// seed copy if a fresh/empty data volume has shadowed it.
const PL_CHANNEL_FILE = path.join(DATA_DIR, 'pl-by-channel.json');
const PL_CHANNEL_SEED = 'seed-data/pl-by-channel.json';
if (!fs.existsSync(PL_CHANNEL_FILE) && fs.existsSync(PL_CHANNEL_SEED)) {
  try {
    fs.copyFileSync(PL_CHANNEL_SEED, PL_CHANNEL_FILE);
  } catch (e) {
    // Ignore errors - file may already exist or directory may be read-only
  }
}

// Maps the bakery's named channels (as used elsewhere in the dashboard, e.g. P&L by Channel)
// to Square location IDs, so uploaded production CSVs can be compared against Square's
// "amount sold" per item/day for the Waste tab. Verify these against Square Dashboard >
// Locations if a location's waste numbers look off.
const WASTE_STORE_LOCATIONS = [
  { name: 'ARC', squareLocationId: 'L41E1NSH9N1GC' },
  { name: 'LSK', squareLocationId: 'LVTS3K9QFN95F' },
  { name: 'State St', squareLocationId: 'L5J0D4FWK7FFY' },
  { name: 'Catering', squareLocationId: 'L2326PJNQ7KS9' },
  { name: 'Delivery 506', squareLocationId: 'LWSX9K7SC3V37' },
  { name: '506 Retail', squareLocationId: 'L91Q2PN8KATAB' },
];

// Every other currently-ACTIVE Square location (farmers markets, pop-ups, corporate-campus
// stands) - i.e. everything that isn't one of the storefronts above. Regenerate from Square's
// Locations API (list, filter status === 'ACTIVE') if new markets are added or old ones retired.
const WASTE_MARKET_LOCATIONS = [
  { name: '506 Retail', squareLocationId: 'L91Q2PN8KATAB' },
  { name: 'State St', squareLocationId: 'L5J0D4FWK7FFY' },
  { name: '25th AVE', squareLocationId: 'LGEFKKMZTYRJK' },
  { name: 'Alum Rock Village (Sun)', squareLocationId: 'LHFCY22W62WXD' },
  { name: 'Antioch SUN', squareLocationId: 'LZJJ8SPXW0J44' },
  { name: 'BELMONT SUN', squareLocationId: 'L2MSATCSX8819' },
  { name: 'BERRYESSA SAT', squareLocationId: 'LJ8NR5P1YJJWP' },
  { name: 'BLG SUN', squareLocationId: 'LDGMZQVT9M1M9' },
  { name: 'BLG-THURS', squareLocationId: 'L1NRS4WB4730D' },
  { name: 'CSM LSK', squareLocationId: 'LPVPE87DHSHEQ' },
  { name: 'CSM SAT', squareLocationId: 'L81H7NXQ9R8CN' },
  { name: 'Commons Popup', squareLocationId: 'LRA4DDBM82571' },
  { name: 'DALY CITY SAT', squareLocationId: 'LBZ9Y9CPYYMZ3' },
  { name: 'DALY CITY THU', squareLocationId: 'L6QV57HE8RCXV' },
  { name: 'DE ANZA SUN', squareLocationId: 'LKQE1MDV738GF' },
  { name: 'DIVISADERO SUN', squareLocationId: 'LK29JHHDMWP2E' },
  { name: 'EL CERRITO-TUES', squareLocationId: 'LCGCZZYTVWZM7' },
  { name: 'Emeryville-THURS', squareLocationId: 'LM4A2T6JCJSZ4' },
  { name: 'FILLMORE SAT', squareLocationId: 'LZG7H4XVCB8H4' },
  { name: 'FM SF SUN', squareLocationId: 'L77PQJ8BX5HKD' },
  { name: 'FOSTER CITY PJCC FRI', squareLocationId: 'L6401TR4NHAPH' },
  { name: 'FOSTER CITY TUE', squareLocationId: 'L57SXYMF4B4BD' },
  { name: 'INNER SUNSET SUN', squareLocationId: 'LVTMNASMHZZRS' },
  { name: 'KAISER SJ TUE', squareLocationId: 'LFXW7H937EBYR' },
  { name: 'Kaiser Pleasanton', squareLocationId: 'LYSJYK6EHRXJQ' },
  { name: 'Kitchen', squareLocationId: 'LA0W40J074TNE' },
  { name: 'LA Farmers THU', squareLocationId: 'L1MFVBMDMXE73' },
  { name: 'LH-SAT', squareLocationId: 'LSNQQ4C28KDYP' },
  { name: 'Livermore', squareLocationId: 'LGBG76BMZ52YT' },
  { name: 'MILPITAS SUN', squareLocationId: 'LWDZ9T8S25MQR' },
  { name: 'MP SUN', squareLocationId: 'LK43YN23G6RW7' },
  { name: 'MV LSK', squareLocationId: 'L9J4MWTNF0AF3' },
  { name: 'MV SUN', squareLocationId: 'L0MTGKJ88AZR1' },
  { name: 'Main Homebase', squareLocationId: 'LRQ7KSG6GZG28' },
  { name: 'Micron Popup', squareLocationId: 'LGDAFG4D5MB9X' },
  { name: 'PA SAT', squareLocationId: 'L0270W2T6H8X7' },
  { name: 'PV THU', squareLocationId: 'L59S2DFW8C8J1' },
  { name: 'Princeton Plaza SUN', squareLocationId: 'LK26FV6D18NEP' },
  { name: 'Princeton Plaza WED', squareLocationId: 'L78MSVC4MFJST' },
  { name: 'RIVIAN POP UP', squareLocationId: 'L934EX29KM5TS' },
  { name: 'Robinhood Popup', squareLocationId: 'LE8CK998J8CE0' },
  { name: 'SA SAT', squareLocationId: 'LV3G1XNKREQKJ' },
  { name: 'SA WED', squareLocationId: 'L9Y2PHNHMWJ0D' },
  { name: 'SANTA CLARA MED WED', squareLocationId: 'LBN76CE4AFEWJ' },
  { name: 'SANTANA WED', squareLocationId: 'L4PVF85BZGKCZ' },
  { name: 'SMA FRI', squareLocationId: 'L8RDK77VB1R5T' },
  { name: 'STANFORD FRI', squareLocationId: 'LTPRXKKB4QF8Z' },
  { name: 'STANFORD TUE', squareLocationId: 'L04P7NWEC60FT' },
  { name: 'UNION CITY SAT', squareLocationId: 'L23WK9D7PYR60' },
  { name: 'VISA HQ', squareLocationId: 'L8YRHJD7NVF4Q' },
  { name: 'WILLOW GLEN SAT', squareLocationId: 'LY2WJ3DKXHV97' },
  { name: 'Workday Popup', squareLocationId: 'LS5GSMM35XAAV' },
];

const WASTE_LOCATIONS = [...WASTE_STORE_LOCATIONS, ...WASTE_MARKET_LOCATIONS];

// ============= CACHE MANAGER =============
class CacheManager {
  constructor() {
    this.cache = new Map();
    this.timers = new Map();
  }

  set(key, value, ttlMs) {
    this.cache.set(key, { value, expiresAt: ttlMs === Infinity ? Infinity : Date.now() + ttlMs });
    if (this.timers.has(key)) clearTimeout(this.timers.get(key));
    if (ttlMs > 0 && ttlMs !== Infinity) {
      const timer = setTimeout(() => {
        this.cache.delete(key);
        this.timers.delete(key);
      }, ttlMs);
      this.timers.set(key, timer);
    }
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.timers.delete(key);
      return null;
    }
    return entry.value;
  }

  invalidate(key) {
    this.cache.delete(key);
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
      this.timers.delete(key);
    }
  }

  invalidatePrefix(prefix) {
    [...this.cache.keys()].filter((key) => key.startsWith(prefix)).forEach((key) => this.invalidate(key));
  }

  status() {
    const entries = [];
    this.cache.forEach((entry, key) => {
      const expiresAt = entry.expiresAt === Infinity ? 'never' : new Date(entry.expiresAt).toISOString();
      const expiresIn = entry.expiresAt === Infinity ? 'indefinite' : Math.ceil((entry.expiresAt - Date.now()) / 1000) + 's';
      entries.push({
        key,
        expiresAt,
        expiresIn,
      });
    });
    return entries;
  }
}

const cacheManager = new CacheManager();

// Helper: Load JSON file or return empty array
const loadData = (filepath) => {
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  } catch {
    return [];
  }
};

// Helper: Save JSON file
const saveData = (filepath, data) => {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
};

// Helper: Load production.json, keyed by location name -> array of {date, item, quantityProduced}
const loadProduction = () => {
  try {
    return JSON.parse(fs.readFileSync(PRODUCTION_FILE, 'utf-8'));
  } catch {
    return {};
  }
};

// Helper: Load pl-by-channel.json ({ channels, markets, revenueAllocation }, each populated
// independently by its own /api/upload/pl-channel/* endpoint)
const loadPLChannelData = () => {
  const data = loadData(PL_CHANNEL_FILE);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
};
const savePLChannelData = (data) => saveData(PL_CHANNEL_FILE, data);

// ============= UPLOAD ENDPOINTS =============

// Upload recipes CSV
app.post('/api/upload/recipes', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const recipes = [];
  Readable.from([req.file.buffer])
    .pipe(csv())
    .on('data', (row) => recipes.push(row))
    .on('end', () => {
      saveData(RECIPES_FILE, recipes);
      cacheManager.invalidate('recipes');
      res.json({ success: true, count: recipes.length, recipes });
    })
    .on('error', (err) => {
      res.status(400).json({ error: err.message });
    });
});

// Upload ingredients CSV
app.post('/api/upload/ingredients', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const ingredients = [];
  Readable.from([req.file.buffer])
    .pipe(csv())
    .on('data', (row) => ingredients.push(row))
    .on('end', () => {
      saveData(INGREDIENTS_FILE, ingredients);
      cacheManager.invalidate('ingredients');
      res.json({ success: true, count: ingredients.length, ingredients });
    })
    .on('error', (err) => {
      res.status(400).json({ error: err.message });
    });
});

// Upload production CSV for one location (columns: Date, Item, Quantity Produced, and an optional
// Ordered column - how many of that item were ordered from the kitchen, when tracked separately
// from what was actually produced/received).
// Merges into that location's existing rows in data/production.json by date: dates present in
// this upload replace whatever was on file for those dates (so re-uploading a corrected day is
// clean); other dates and other locations are left untouched. This lets weekly production sheets
// accumulate into a running log instead of each upload wiping out prior weeks.
app.post('/api/upload/production', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const location = req.body.location;
  if (!WASTE_LOCATIONS.some((l) => l.name === location)) {
    return res.status(400).json({ error: `Unknown location "${location}". Expected one of: ${WASTE_LOCATIONS.map((l) => l.name).join(', ')}` });
  }

  const rows = [];
  Readable.from([req.file.buffer])
    .pipe(csv())
    .on('data', (row) => {
      const date = (row['Date'] || '').trim();
      const item = (row['Item'] || '').trim();
      const quantityProduced = parseFloat(row['Quantity Produced']);
      const ordered = parseFloat(row['Ordered']);
      if (date && item && Number.isFinite(quantityProduced)) {
        rows.push({ date, item, quantityProduced, ordered: Number.isFinite(ordered) ? ordered : null });
      }
    })
    .on('end', () => {
      const production = loadProduction();
      const existing = production[location] || [];
      const newDates = new Set(rows.map((r) => r.date));
      production[location] = existing.filter((r) => !newDates.has(r.date)).concat(rows);
      saveData(PRODUCTION_FILE, production);
      cacheManager.invalidate(`waste_${location}`);
      res.json({ success: true, location, count: rows.length, totalRows: production[location].length });
    })
    .on('error', (err) => {
      res.status(400).json({ error: err.message });
    });
});

// Refresh production data from Google Drive (Little Sky Production folder)
app.post('/api/refresh-production-from-drive', async (req, res) => {
  try {
    const production = await fetchProductionData();

    // Merge with existing production data (don't overwrite other locations/dates)
    const existing = loadProduction();
    const merged = { ...existing };

    for (const location in production) {
      const existingRows = merged[location] || [];
      const newDates = new Set(production[location].map(r => r.date));
      // Replace dates from Drive, keep other dates
      merged[location] = existingRows.filter(r => !newDates.has(r.date)).concat(production[location]);
    }

    saveData(PRODUCTION_FILE, merged);

    // Invalidate cache for all locations
    for (const loc of WASTE_LOCATIONS) {
      cacheManager.invalidate(`waste_${loc.name}`);
    }

    const totalRows = Object.values(merged).reduce((sum, arr) => sum + arr.length, 0);
    res.json({ success: true, message: 'Production data refreshed from Google Drive', totalRows });
  } catch (err) {
    if (err.code === 'GOOGLE_NOT_CONNECTED') {
      return res.status(401).json({ error: 'Google Drive not connected. Authorize at /api/google/connect first.' });
    }
    res.status(400).json({ error: err.message });
  }
});

// ============= P&L BY CHANNEL UPLOADS =============
// Ingests three Google Sheet exports from the bakery's "Market Performance" workbook (Market
// Analysis, Non Market Channels, Revenue Allocation). Each sheet has its own fixed multi-row title/
// subtotal header - there's no single header line csv-parser can key off of - so rows are read
// positionally (headers: false) and sliced past the known preamble instead of matched by column
// name. Every number is stored exactly as the sheet reports it; nothing here is recomputed.
// Each upload fully replaces its own slice of data/pl-by-channel.json (these are point-in-time
// snapshots re-exported periodically, not append-by-date logs like production.json).

const parseMoney = (v) => {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const parsePct = (v) => {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[%,]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const parseNum = (v) => {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};

// The Non Market Channels / Revenue Allocation sheets name a few channels differently than the rest
// of the dashboard (WASTE_STORE_LOCATIONS, LOCATION_CHANNELS) - normalize to the shared names.
const PL_CHANNEL_NAME_ALIASES = {
  'Arc Institute': 'ARC',
  Arc: 'ARC',
  'State St.': 'State St',
  'LSB (506)': '506 Retail',
  'Retail 506': '506 Retail',
  Delivery: 'Delivery 506',
};
const normalizePLChannelName = (raw) => {
  const trimmed = (raw || '').trim();
  return PL_CHANNEL_NAME_ALIASES[trimmed] || trimmed;
};

// Read a CSV positionally (no header row) - returns an array of rows, each an array of cell strings.
const readCsvRowsPositional = (filePathOrBuffer) => new Promise((resolve, reject) => {
  const rows = [];
  const stream = typeof filePathOrBuffer === 'string'
    ? fs.createReadStream(filePathOrBuffer)
    : Readable.from([filePathOrBuffer]);
  stream
    .pipe(csv({ headers: false }))
    .on('data', (row) => rows.push(Object.keys(row).map((k) => row[k])))
    .on('end', () => resolve(rows))
    .on('error', reject);
});

// POST /api/upload/pl-channel/market-analysis
// "Market Analysis" sheet: per-market performance underlying the Markets channel - one row per
// farmers market/pop-up (e.g. "FM SF SUN"), kept separate rather than rolled up so each market's
// contribution can be inspected on its own. First 4 rows are title/subtotal/header text, not data.
app.post('/api/upload/pl-channel/market-analysis', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const rows = await readCsvRowsPositional(req.file.buffer);
    const markets = rows.slice(4)
      .filter((r) => (r[0] || '').trim())
      .map((r) => ({
        name: r[0].trim(),
        avgWeeklyRevenue: parseMoney(r[1]),
        avgTicket: parseMoney(r[2]),
        avgTickets: parseNum(r[3]),
        sellers: parseNum(r[4]),
        drivers: parseNum(r[5]),
        costs: {
          seller: parseMoney(r[6]),
          driver: parseMoney(r[7]),
          vehicle: parseMoney(r[8]),
          fees: parseMoney(r[9]),
          overhead: parseMoney(r[10]),
          total: parseMoney(r[11]),
        },
        contribution: parseMoney(r[12]),
        contributionPct: parsePct(r[13]),
        share: parsePct(r[15]),
        boLaborAllocated: parseMoney(r[16]),
        adjustedContribution: parseMoney(r[18]),
        adjustedContributionPct: parsePct(r[19]),
        annualized: parseMoney(r[21]),
        aspiration: parseMoney(r[23]),
        // The sheet's header row only labels 2 columns here ("Aspiration", "Upside/Downside") but
        // every data row carries 3 trailing values after Annualized - r[24] is a small round-dollar
        // figure (e.g. $500, $2,000) that reads as a per-market planned weekly increase, distinct
        // from both Aspiration (r[23]) and the large annualized Upside/Downside figure (r[25]).
        // Kept uninterpreted since the sheet never names it.
        weeklyIncreaseTarget: parseMoney(r[24]),
        upsideDownside: parseMoney(r[25]),
      }));

    const data = loadPLChannelData();
    data.markets = markets;
    data.marketsUpdatedAt = new Date().toISOString();
    savePLChannelData(data);
    res.json({ success: true, count: markets.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/upload/pl-channel/non-market
// "Non Market Channels" sheet: named channels other than the farmers markets (Arc, State St, LSK,
// Retail 506, Delivery, Catering), plus a Bakery/Other sub-split of LSK. First 4 rows are title/
// subtotal/header text, not data.
app.post('/api/upload/pl-channel/non-market', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const rows = await readCsvRowsPositional(req.file.buffer);
    const parseChannelRow = (r) => ({
      name: normalizePLChannelName(r[0]),
      avgWeeklyRevenue: parseMoney(r[1]),
      avgTicket: parseMoney(r[2]),
      avgTickets: parseNum(r[3]),
      sellers: parseNum(r[4]),
      drivers: parseNum(r[5]),
      costs: {
        seller: parseMoney(r[6]),
        driver: parseMoney(r[7]),
        vehicle: parseMoney(r[8]),
        fees: parseMoney(r[9]),
        prep: parseMoney(r[10]),
        overhead: parseMoney(r[11]),
        total: parseMoney(r[12]),
      },
      contribution: parseMoney(r[13]),
      contributionPct: parsePct(r[14]),
      boLaborAllocated: parseMoney(r[16]),
      adjustedContribution: parseMoney(r[18]),
      adjustedContributionPct: parsePct(r[19]),
      annualized: parseMoney(r[21]),
    });

    const dataRows = rows.slice(4).filter((r) => (r[0] || '').trim());
    const subSplitNames = ['LSK - Bakery', 'LSK - Other'];
    const channels = dataRows.filter((r) => !subSplitNames.includes(r[0].trim())).map(parseChannelRow);
    const lskSubChannels = dataRows
      .filter((r) => subSplitNames.includes(r[0].trim()))
      .map((r) => ({ ...parseChannelRow(r), name: r[0].trim() }));

    const lsk = channels.find((c) => c.name === 'LSK');
    if (lsk && lskSubChannels.length) lsk.subChannels = lskSubChannels;

    const data = loadPLChannelData();
    data.channels = channels;
    data.channelsUpdatedAt = new Date().toISOString();
    savePLChannelData(data);
    res.json({ success: true, count: channels.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/upload/pl-channel/revenue-allocation
// "Revenue Allocation" sheet: trailing-12-months revenue and % share by channel (Markets is the
// combined total of every row in the Market Analysis sheet), for the top-of-tab summary. No fixed
// header row - data rows are wherever column 1 (name) is populated with a parseable revenue figure
// in column 2 (excludes the sheet's "Last 12 Months" section-label row, which names a column but
// carries no value).
app.post('/api/upload/pl-channel/revenue-allocation', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const rows = await readCsvRowsPositional(req.file.buffer);
    const named = rows.filter((r) => (r[1] || '').trim() && parseMoney(r[2]) != null);
    const totalRow = named.find((r) => r[1].trim() === 'Total');
    const byChannel = named
      .filter((r) => r[1].trim() !== 'Total')
      .map((r) => ({
        name: normalizePLChannelName(r[1]),
        revenue: parseMoney(r[2]),
        pctShare: parsePct(r[3]),
        avgWeeklyRevenue: parseMoney(r[5]),
      }));

    const data = loadPLChannelData();
    data.revenueAllocation = {
      periodLabel: 'Last 12 Months',
      totalRevenue: totalRow ? parseMoney(totalRow[2]) : null,
      byChannel,
    };
    data.revenueAllocationUpdatedAt = new Date().toISOString();
    savePLChannelData(data);
    res.json({ success: true, count: byChannel.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============= DATA ENDPOINTS =============

// Get recipes (cached until new upload)
app.get('/api/recipes', (req, res) => {
  let recipes = cacheManager.get('recipes');
  if (!recipes) {
    recipes = loadData(RECIPES_FILE);
    cacheManager.set('recipes', recipes, Infinity); // Cache indefinitely (until invalidated by new upload)
  }
  res.json(recipes);
});

// Get ingredients (cached until new upload)
app.get('/api/ingredients', (req, res) => {
  let ingredients = cacheManager.get('ingredients');
  if (!ingredients) {
    ingredients = loadData(INGREDIENTS_FILE);
    cacheManager.set('ingredients', ingredients, Infinity); // Cache indefinitely (until invalidated by new upload)
  }
  res.json(ingredients);
});

// ============= SQUARE API ENDPOINTS (stubbed for now) =============

// Get revenue from Square
app.get('/api/square/revenue', async (req, res) => {
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token || token === 'your_square_token_here') {
    return res.json({ error: 'Square API credentials not configured', stub: true, data: [] });
  }

  try {
    // TODO: Implement actual Square API call
    // For now, return stub data
    res.json({ error: 'Not implemented yet', stub: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get payroll from Square
app.get('/api/square/payroll', async (req, res) => {
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token || token === 'your_square_token_here') {
    return res.json({ error: 'Square API credentials not configured', stub: true, data: [] });
  }

  try {
    // TODO: Implement actual Square API call
    res.json({ error: 'Not implemented yet', stub: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============= SQUARE OVERTIME REPORT =============
// Pulls closed timecards from Square Labor across all locations and computes
// California overtime (daily 8/12hr thresholds, weekly 40hr threshold, and the
// 7th-consecutive-workday rule), grouped by week and by job/function.

const SQUARE_API_BASE = 'https://connect.squareup.com/v2';
const SQUARE_API_VERSION = '2026-07-01';
const DOW_INDEX = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

const squareHeaders = () => {
  const token = process.env.SQUARE_ACCESS_TOKEN || '';
  return {
    Authorization: `Bearer ${token}`,
    'Square-Version': SQUARE_API_VERSION,
    'Content-Type': 'application/json',
  };
};

const addDays = (dateStr, n) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const getWeekStart = (dateStr, startDow) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const diff = (d.getUTCDay() - startDow + 7) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
};

const round2 = (n) => Math.round(n * 100) / 100;

// Earliest date the overtime report should show, per business preference.
const OVERTIME_HISTORY_START = '2025-01-01';

const OVERTIME_SNAPSHOT_FILE = path.join(DATA_DIR, 'overtime-snapshot.json');
const loadOvertimeSnapshot = () => {
  const data = loadData(OVERTIME_SNAPSHOT_FILE);
  return Array.isArray(data?.weeks) ? data : null;
};
const saveOvertimeSnapshot = (snapshot) => saveData(OVERTIME_SNAPSHOT_FILE, snapshot);

const fetchWorkweekStartDow = async () => {
  try {
    // Try Composio first if configured
    if (process.env.COMPOSIO_API_KEY) {
      const connStatus = composioConnectors.getConnectionStatus();
      if (connStatus.square) {
        // Use Composio to call Square
        const client = await composioConnectors.initComposio();
        const connectionId = await composioConnectors.getSquareConnection();
        const result = await client.executeAction({
          connectionId,
          action: 'square_get_labor_workweek_configs',
        });
        const config = result?.workweek_configs?.[0];
        return DOW_INDEX[config?.start_of_week] ?? 1;
      }
    }
    // Fallback to direct API
    const response = await axios.get(`${SQUARE_API_BASE}/labor/workweek-configs`, { headers: squareHeaders() });
    const config = response.data.workweek_configs?.[0];
    return DOW_INDEX[config?.start_of_week] ?? 1;
  } catch (err) {
    console.warn('Failed to fetch workweek config:', err.message);
    return 1; // default to Monday
  }
};

// Fetch every CLOSED timecard whose shift starts within [startDate, endDateExclusive) for one window
const fetchTimecardsWindow = async (startDate, endDateExclusive) => {
  const timecards = [];
  let cursor;
  let page = 0;
  do {
    try {
      // Try Composio first if configured
      let response;
      if (process.env.COMPOSIO_API_KEY) {
        const connStatus = composioConnectors.getConnectionStatus();
        if (connStatus.square) {
          const client = await composioConnectors.initComposio();
          const connectionId = await composioConnectors.getSquareConnection();
          response = { data: await client.executeAction({
            connectionId,
            action: 'square_search_timecards',
            parameters: {
              start_at: `${startDate}T00:00:00Z`,
              end_at: `${endDateExclusive}T00:00:00Z`,
              status: 'CLOSED',
              limit: 200,
              cursor,
            },
          }) };
        }
      }
      // Fallback to direct API
      if (!response) {
        response = await axios.post(
          `${SQUARE_API_BASE}/labor/timecards/search`,
          {
            query: {
              filter: {
                start: { start_at: `${startDate}T00:00:00Z`, end_at: `${endDateExclusive}T00:00:00Z` },
                status: 'CLOSED',
              },
            },
            limit: 200,
            cursor,
          },
          { headers: squareHeaders() }
        );
      }
      timecards.push(...(response.data.timecards || []));
      cursor = response.data.cursor;
      page += 1;
    } catch (err) {
      console.warn(`Timecard fetch failed on page ${page}:`, err.message);
      break;
    }
  } while (cursor && page < 500);
  return timecards;
};

// Fetch every CLOSED timecard whose shift starts within [startDate, endDateExclusive), all locations.
// Square returns timecards newest-first, and each window's search is itself capped at 50 pages
// (10,000 timecards) as a safety valve - with ~50 active locations, a multi-year range can exceed
// that in one shot and silently truncate before reaching the oldest requested dates. Splitting the
// range into 28-day windows (fetched with limited concurrency) keeps each window's own result set
// far below that cap regardless of how many locations or how wide the requested range is.
const fetchAllTimecards = async (startDate, endDateExclusive) => {
  const windows = [];
  let windowStart = startDate;
  while (windowStart < endDateExclusive) {
    const windowEnd = addDays(windowStart, 28) < endDateExclusive ? addDays(windowStart, 28) : endDateExclusive;
    windows.push([windowStart, windowEnd]);
    windowStart = windowEnd;
  }

  const CONCURRENCY = 5;
  const results = [];
  for (let i = 0; i < windows.length; i += CONCURRENCY) {
    const batch = windows.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(([s, e]) => fetchTimecardsWindow(s, e)));
    results.push(...batchResults);
  }
  return results.flat();
};

// Fetch team member id -> display name map
const fetchTeamMemberNames = async () => {
  const names = {};
  let cursor;
  let page = 0;
  do {
    try {
      let response;
      if (process.env.COMPOSIO_API_KEY) {
        const connStatus = composioConnectors.getConnectionStatus();
        if (connStatus.square) {
          const client = await composioConnectors.initComposio();
          const connectionId = await composioConnectors.getSquareConnection();
          response = { data: await client.executeAction({
            connectionId,
            action: 'square_search_team_members',
            parameters: { limit: 200, cursor },
          }) };
        }
      }
      if (!response) {
        response = await axios.post(
          `${SQUARE_API_BASE}/team-members/search`,
          { limit: 200, cursor },
          { headers: squareHeaders() }
        );
      }
      (response.data.team_members || []).forEach((tm) => {
        names[tm.id] = [tm.given_name, tm.family_name].filter(Boolean).join(' ') || tm.id;
      });
      cursor = response.data.cursor;
      page += 1;
    } catch (err) {
      console.warn(`Team member fetch failed on page ${page}:`, err.message);
      break;
    }
  } while (cursor && page < 500);
  return names;
};

// Normalize a raw Square timecard into an hours entry, net of unpaid breaks
const parseTimecardEntry = (tc) => {
  const startMs = new Date(tc.start_at).getTime();
  const endMs = new Date(tc.end_at).getTime();
  const unpaidBreakMs = (tc.breaks || [])
    .filter((b) => !b.is_paid && b.start_at && b.end_at)
    .reduce((sum, b) => sum + (new Date(b.end_at).getTime() - new Date(b.start_at).getTime()), 0);
  return {
    teamMemberId: tc.team_member_id,
    date: tc.start_at.slice(0, 10), // start_at carries the location-local offset already
    function: tc.wage?.title || 'Unknown',
    rate: (tc.wage?.hourly_rate?.amount || 0) / 100,
    hours: Math.max(0, (endMs - startMs - unpaidBreakMs) / 3600000),
  };
};

// Split one employee-day's total hours into CA regular/1.5x/2x hours.
// `isSeventhDay` overrides the daily 8/12hr split per the 7th-consecutive-day rule.
const splitDailyHours = (totalHours, isSeventhDay) => {
  if (isSeventhDay) {
    return { regular: 0, ot15: Math.min(totalHours, 8), ot2: Math.max(totalHours - 8, 0) };
  }
  return {
    regular: Math.min(totalHours, 8),
    ot15: Math.min(Math.max(totalHours - 8, 0), 4),
    ot2: Math.max(totalHours - 12, 0),
  };
};

// Build the weekly, by-function overtime report from raw timecards.
const buildOvertimeReport = (timecards, teamNames, startDow) => {
  const entries = timecards.filter((tc) => tc.start_at && tc.end_at).map(parseTimecardEntry);

  // Group into per-employee-per-day buckets (a Square Timecard already represents one workday)
  const dayBuckets = new Map();
  entries.forEach((e) => {
    const key = `${e.teamMemberId}__${e.date}`;
    if (!dayBuckets.has(key)) {
      dayBuckets.set(key, { teamMemberId: e.teamMemberId, date: e.date, totalHours: 0, byFunction: new Map() });
    }
    const bucket = dayBuckets.get(key);
    bucket.totalHours += e.hours;
    const fn = bucket.byFunction.get(e.function) || { hours: 0, rateHoursSum: 0 };
    fn.hours += e.hours;
    fn.rateHoursSum += e.hours * e.rate;
    bucket.byFunction.set(e.function, fn);
  });

  // Group day buckets into per-employee-per-week buckets
  const weekBuckets = new Map();
  dayBuckets.forEach((bucket) => {
    const weekStart = getWeekStart(bucket.date, startDow);
    const key = `${bucket.teamMemberId}__${weekStart}`;
    if (!weekBuckets.has(key)) weekBuckets.set(key, { teamMemberId: bucket.teamMemberId, weekStart, days: [] });
    weekBuckets.get(key).days.push(bucket);
  });

  // Compute CA OT per employee-week, then allocate to functions by each function's share of hours worked
  const weekFunctionTotals = new Map();
  weekBuckets.forEach((week) => {
    const daysWorked = new Set(week.days.map((d) => d.date));
    const allSevenWorked = [...Array(7)].every((_, i) => daysWorked.has(addDays(week.weekStart, i)));

    let weekRegular = 0, weekOt15 = 0, weekOt2 = 0;
    const weekFunctionHours = new Map();

    week.days.forEach((day) => {
      const isSeventhDay = allSevenWorked && day.date === addDays(week.weekStart, 6);
      const split = splitDailyHours(day.totalHours, isSeventhDay);
      weekRegular += split.regular;
      weekOt15 += split.ot15;
      weekOt2 += split.ot2;

      day.byFunction.forEach((fn, fnName) => {
        const acc = weekFunctionHours.get(fnName) || { hours: 0, rateHoursSum: 0 };
        acc.hours += fn.hours;
        acc.rateHoursSum += fn.rateHoursSum;
        weekFunctionHours.set(fnName, acc);
      });
    });

    // Weekly 40-hour threshold: excess regular hours become 1.5x weekly overtime
    if (weekRegular > 40) {
      weekOt15 += weekRegular - 40;
      weekRegular = 40;
    }

    const rawTotalHours = [...weekFunctionHours.values()].reduce((s, v) => s + v.hours, 0) || 1;

    weekFunctionHours.forEach((fnAgg, fnName) => {
      const share = fnAgg.hours / rawTotalHours;
      const avgRate = fnAgg.hours > 0 ? fnAgg.rateHoursSum / fnAgg.hours : 0;
      const allocOt15 = weekOt15 * share;
      const allocOt2 = weekOt2 * share;
      const otWage = allocOt15 * avgRate * 1.5 + allocOt2 * avgRate * 2;
      const regularWage = weekRegular * share * avgRate;

      const key = `${week.weekStart}__${fnName}`;
      const agg = weekFunctionTotals.get(key) || {
        weekStart: week.weekStart,
        function: fnName,
        regularHours: 0, ot15Hours: 0, ot2Hours: 0,
        regularWage: 0, otWage: 0,
        employees: new Map(),
      };
      agg.regularHours += weekRegular * share;
      agg.ot15Hours += allocOt15;
      agg.ot2Hours += allocOt2;
      agg.regularWage += regularWage;
      agg.otWage += otWage;

      if (allocOt15 + allocOt2 > 0.01) {
        const empName = teamNames[week.teamMemberId] || week.teamMemberId;
        const prev = agg.employees.get(empName) || { name: empName, ot15Hours: 0, ot2Hours: 0, otWage: 0 };
        prev.ot15Hours += allocOt15;
        prev.ot2Hours += allocOt2;
        prev.otWage += otWage;
        agg.employees.set(empName, prev);
      }

      weekFunctionTotals.set(key, agg);
    });
  });

  const weekStarts = [...new Set([...weekFunctionTotals.values()].map((a) => a.weekStart))].sort();
  return weekStarts.map((weekStart) => {
    const functions = [...weekFunctionTotals.values()]
      .filter((a) => a.weekStart === weekStart)
      .sort((a, b) => a.function.localeCompare(b.function))
      .map((a) => ({
        function: a.function,
        regularHours: round2(a.regularHours),
        otHours: round2(a.ot15Hours + a.ot2Hours),
        ot15Hours: round2(a.ot15Hours),
        ot2Hours: round2(a.ot2Hours),
        regularWage: round2(a.regularWage),
        otWage: round2(a.otWage),
        employees: [...a.employees.values()]
          .sort((x, y) => y.otWage - x.otWage)
          .map((e) => ({ name: e.name, otHours: round2(e.ot15Hours + e.ot2Hours), otWage: round2(e.otWage) })),
      }));
    return {
      weekStart,
      weekEnd: addDays(weekStart, 6),
      totalOtHours: round2(functions.reduce((s, f) => s + f.otHours, 0)),
      totalOtWage: round2(functions.reduce((s, f) => s + f.otWage, 0)),
      functions,
    };
  });
};

// Fetch + build one week-by-week overtime report straight from Square, no snapshot involved.
// The result is written to disk (data/overtime-snapshot.json, git-tracked) and kept indefinitely, so
// named per-employee wage detail is stripped here - unlike the live report, which keeps it so the
// dashboard can still surface "who's accumulating OT this week" for the current, unsnapshotted range.
const buildOvertimeSnapshot = async (startDate, endDateExclusive) => {
  const [startDow, timecards, teamNames] = await Promise.all([
    fetchWorkweekStartDow(),
    fetchAllTimecards(startDate, endDateExclusive),
    fetchTeamMemberNames(),
  ]);
  const weeks = buildOvertimeReport(timecards, teamNames, startDow).map((week) => ({
    ...week,
    functions: week.functions.map((fn) => ({ ...fn, employees: [] })),
  }));
  return {
    success: true,
    weeks,
    rangeStart: startDate,
    rangeEnd: endDateExclusive,
    generatedAt: new Date().toISOString(),
    employeeDetail: false,
  };
};

// POST /api/overtime/snapshot/rebuild?start=YYYY-MM-DD&end=YYYY-MM-DD
// Rebuilds the cached historical overtime snapshot (data/overtime-snapshot.json) from Square.
// `end` defaults to the first of the current month, so the snapshot only ever covers fully-closed
// months - /api/overtime layers the current, still-open month on top of it live at request time,
// instead of re-fetching years of Square timecards on every request.
app.post('/api/overtime/snapshot/rebuild', async (req, res) => {
  if (!process.env.COMPOSIO_API_KEY && !process.env.SQUARE_ACCESS_TOKEN) {
    return res.status(400).json({ error: 'Square API credentials not configured' });
  }

  const startDate = req.query.start || OVERTIME_HISTORY_START;
  const todayStr = new Date().toISOString().slice(0, 10);
  const endDateExclusive = req.query.end || `${todayStr.slice(0, 7)}-01`;

  try {
    const snapshot = await buildOvertimeSnapshot(startDate, endDateExclusive);
    saveOvertimeSnapshot(snapshot);
    cacheManager.invalidatePrefix('overtime_');
    res.json({ success: true, rangeStart: snapshot.rangeStart, rangeEnd: snapshot.rangeEnd, weekCount: snapshot.weeks.length });
  } catch (err) {
    res.status(500).json({ error: 'Square API error', message: err.response?.data?.errors?.[0]?.detail || err.message });
  }
});

// GET /api/overtime?weeks=8&end=YYYY-MM-DD
// `end` is the Monday (workweek start) of the most recent week to include; defaults to
// the most recently completed workweek. `weeks` is how many workweeks back to include.
// Weeks covered by the cached snapshot (data/overtime-snapshot.json) are served from disk;
// only the remaining, more recent slice is fetched live from Square. Cached for 24 hours per query.
app.get('/api/overtime', async (req, res) => {
  if (!process.env.COMPOSIO_API_KEY && !process.env.SQUARE_ACCESS_TOKEN) {
    return res.status(400).json({ error: 'Square API credentials not configured', weeks: [] });
  }

  const cacheKey = `overtime_${req.query.weeks || '8'}_${req.query.end || 'default'}`;
  let cached = cacheManager.get(cacheKey);
  if (cached) {
    return res.json({ ...cached, cached: true, cacheExpiresIn: '~24h' });
  }

  try {
    const startDow = await fetchWorkweekStartDow();

    const requestedWeeks = parseInt(req.query.weeks, 10);
    const weekCount = Number.isFinite(requestedWeeks) && requestedWeeks > 0 ? Math.min(requestedWeeks, 156) : 8;

    const todayStr = new Date().toISOString().slice(0, 10);
    const currentWeekStart = getWeekStart(todayStr, startDow);
    const defaultLastCompletedWeekStart = addDays(currentWeekStart, -7);
    const lastWeekStart = req.query.end || defaultLastCompletedWeekStart;

    let rangeStart = addDays(lastWeekStart, -7 * (weekCount - 1));
    if (rangeStart < OVERTIME_HISTORY_START) rangeStart = OVERTIME_HISTORY_START;
    const rangeEndExclusive = addDays(lastWeekStart, 7);

    const snapshot = loadOvertimeSnapshot();
    const weekByStart = new Map();
    if (snapshot) {
      snapshot.weeks.forEach((w) => {
        if (w.weekStart >= rangeStart && w.weekStart < rangeEndExclusive) weekByStart.set(w.weekStart, w);
      });
    }

    // Re-fetch the last cached week (plus one extra week of buffer) live rather than trusting the
    // snapshot's raw calendar-date boundary. Square's start_at filter matches on UTC instant, but
    // weeks are grouped by each timecard's location-local calendar date, so a shift starting just
    // after local midnight-Monday can still land on the "wrong" side of a same-instant UTC split -
    // getting fetched (and counted) by both the snapshot and the live query. Re-fetching a full extra
    // week and letting the live result overwrite the cached one for that key sidesteps that entirely.
    let liveFetchStart = rangeStart;
    if (snapshot?.rangeEnd && snapshot.rangeEnd > rangeStart) {
      liveFetchStart = addDays(getWeekStart(snapshot.rangeEnd, startDow), -7);
      if (liveFetchStart < rangeStart) liveFetchStart = rangeStart;
    }

    if (liveFetchStart < rangeEndExclusive) {
      const [timecards, teamNames] = await Promise.all([
        fetchAllTimecards(liveFetchStart, rangeEndExclusive),
        fetchTeamMemberNames(),
      ]);
      // The same UTC/local mismatch can leak a stray pre-liveFetchStart shift into this fetch too,
      // producing an incomplete entry for the week just before the intended live window. Only trust
      // weeks that started at or after liveFetchStart itself - anything earlier stays on the cache.
      buildOvertimeReport(timecards, teamNames, startDow)
        .filter((w) => w.weekStart >= liveFetchStart)
        .forEach((w) => weekByStart.set(w.weekStart, w));
    }

    const weeks = [...weekByStart.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
    const response = { success: true, weeks, rangeStart, rangeEnd: addDays(rangeEndExclusive, -1), employeeDetail: true };
    cacheManager.set(cacheKey, response, 24 * 60 * 60 * 1000); // Cache for 24 hours
    res.json(response);
  } catch (err) {
    res.status(500).json({
      error: 'Square API error',
      message: err.response?.data?.errors?.[0]?.detail || err.message,
      weeks: [],
    });
  }
});

// ============= QUICKBOOKS OAUTH 2.0 =============

const QB_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';

let qbRefreshJobsStarted = false;

// Start QB auto-refresh jobs (called on startup and after auth)
const startQBRefreshJobs = () => {
  if (qbRefreshJobsStarted) return; // Prevent duplicate jobs
  qbRefreshJobsStarted = true;
  console.log('🔄 Starting QB auto-refresh jobs...');

  // Refresh cache every 30 minutes (auto-rotates tokens)
  cron.schedule('*/30 * * * *', async () => {
    console.log('🔄 Scheduled QB cache refresh...');
    try {
      await qbCache.refreshAllQBData();
    } catch (err) {
      console.error('QB cache refresh failed:', err.message);
    }
  });

  // Check token health daily (proactive monitoring)
  cron.schedule('0 2 * * *', () => {
    const health = qbCache.checkTokenHealth();
    if (!health.healthy) {
      console.warn(`⚠️  QB token health issue: ${health.reason}`, health);
    } else {
      console.log('✅ QB token health check passed');
    }
  });
};

const getQBRedirectUri = () => {
  if (process.env.QUICKBOOKS_REDIRECT_URI) {
    return process.env.QUICKBOOKS_REDIRECT_URI;
  }
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/api/quickbooks/callback`;
  }
  return `http://localhost:${PORT}/api/quickbooks/callback`;
};

// Use qbClient for token loading (canonical source)
const getValidQBAccessToken = async () => {
  const composioStatus = composioConnectors.getConnectionStatus();
  try {
    return await qbClient.getValidTokens();
  } catch (err) {
    if (err.code === 'QB_NOT_CONNECTED') {
      let msg = 'QuickBooks not connected.';
      if (composioStatus.quickbooks) {
        msg += ' (Composio connected - use QB connector actions)';
      } else if (process.env.COMPOSIO_API_KEY) {
        msg += ' Authorize QB in your Composio workspace or visit /api/quickbooks/connect.';
      } else {
        msg += ' Visit /api/quickbooks/connect to authorize access.';
      }
      const authErr = new Error(msg);
      authErr.code = 'QB_NOT_CONNECTED';
      throw authErr;
    }
    throw err;
  }
};

// Step 1: redirect the user to Intuit's consent screen
app.get('/api/quickbooks/connect', (req, res) => {
  if (!process.env.QUICKBOOKS_CLIENT_ID || process.env.QUICKBOOKS_CLIENT_ID === 'your_client_id_here') {
    return res.status(400).send('Set QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET in .env first (create an app at https://developer.intuit.com/).');
  }
  const params = new URLSearchParams({
    client_id: process.env.QUICKBOOKS_CLIENT_ID,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: getQBRedirectUri(),
    state: 'connect', // Plain marker for direct connection flow
  });
  res.redirect(`${QB_AUTH_URL}?${params.toString()}`);
});

// Step 2: Intuit redirects back here with a code + realmId
app.get('/api/quickbooks/callback', async (req, res) => {
  const { code, realmId, error, state } = req.query;
  console.log('QB callback received:', { code: code ? '***' : null, realmId, error, state });

  if (error) return res.status(400).send(`QuickBooks authorization failed: ${error}`);
  if (!code || !realmId) return res.status(400).send('Missing code or realmId from QuickBooks');

  try {
    console.log('Exchanging code for tokens...');
    const tokens = await qbClient.exchangeCodeForTokens(code, realmId);

    console.log('✅ QB token exchange successful, tokens saved to persistent storage');

    // Also update env vars for this session
    process.env.QUICKBOOKS_REFRESH_TOKEN = tokens.refresh_token;
    process.env.QUICKBOOKS_REALM_ID = realmId;

    // Clear any previous token errors
    qbCache.clearTokenError();

    // Start auto-refresh jobs if not already started
    startQBRefreshJobs();

    // Redirect back to where user was (or dashboard if no state)
    let redirectTo = '/?qb=connected';
    if (state && state !== 'connect' && state !== 'dashboard') {
      try {
        // State is base64-encoded URL from auto-reauth flow
        console.log('Attempting to decode state:', state);
        redirectTo = Buffer.from(decodeURIComponent(state), 'base64').toString('utf-8');
        console.log('Decoded redirectTo:', redirectTo);
      } catch (e) {
        console.warn('Could not decode state parameter, using default redirect:', e.message);
      }
    }
    console.log('✓ Redirecting to:', redirectTo);
    res.redirect(redirectTo);
  } catch (err) {
    console.error('❌ QB token exchange failed:', {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message,
    });
    res.status(500).send(`Failed to connect QuickBooks: ${err.response?.data?.error_description || err.message}`);
  }
});

// Automatic re-auth: Triggered when tokens need refresh
// Checks token health and auto-initiates OAuth if needed
app.get('/api/quickbooks/auto-reauth', (req, res) => {
  const tokens = qbClient.loadTokens();
  const tokenError = qbCache.getTokenError();
  let redirectUrl = req.query.redirectUrl; // Where to redirect after re-auth

  console.log('🔄 Auto re-auth check initiated');

  // If there's a token error or no tokens, start OAuth flow
  if (tokenError || !tokens || !tokens.refresh_token) {
    console.log('❌ Token error detected, initiating OAuth flow...');
    const params = new URLSearchParams({
      client_id: process.env.QUICKBOOKS_CLIENT_ID,
      response_type: 'code',
      scope: 'com.intuit.quickbooks.accounting',
      redirect_uri: getQBRedirectUri(),
      state: redirectUrl || 'dashboard', // Pass through the redirectUrl as state
    });
    return res.redirect(`${QB_AUTH_URL}?${params.toString()}`);
  }

  // Tokens look good, clear any previous errors
  qbCache.clearTokenError();

  // Redirect back to original page or dashboard
  let returnUrl = '/';
  if (redirectUrl) {
    try {
      // redirectUrl is base64-encoded and URL-encoded
      returnUrl = Buffer.from(decodeURIComponent(redirectUrl), 'base64').toString('utf-8');
    } catch (e) {
      console.warn('Could not decode redirectUrl, using default:', e.message);
      returnUrl = '/';
    }
  }
  res.redirect(returnUrl);
});

// Connection status
app.get('/api/quickbooks/status', (req, res) => {
  const tokens = qbClient.loadTokens();
  const composioStatus = composioConnectors.getConnectionStatus();
  const cacheStatus = qbCache.isCachePopulated();
  const tokenError = qbCache.getTokenError();
  const realmId = process.env.QUICKBOOKS_REALM_ID || process.env.QB_REALM_ID;
  const hasRefreshToken = !!(process.env.QUICKBOOKS_REFRESH_TOKEN);

  let tokenHealth = 'unknown';
  let tokenExpiresIn = null;
  if (tokens && tokens.expires_at) {
    const msUntilExpiry = tokens.expires_at - Date.now();
    tokenExpiresIn = Math.floor(msUntilExpiry / 1000 / 60); // minutes
    if (msUntilExpiry > 24 * 60 * 60 * 1000) {
      tokenHealth = 'healthy';
    } else if (msUntilExpiry > 0) {
      tokenHealth = 'expiring_soon';
    } else {
      tokenHealth = 'expired';
    }
  }

  res.json({
    connected: !!(tokens && tokens.refresh_token) || composioStatus.quickbooks,
    connectedVia: composioStatus.quickbooks ? 'composio' : (tokens && tokens.refresh_token ? 'file_persistent' : null),
    realmId: tokens?.realmId || realmId || null,
    connectedAt: tokens?.connectedAt || null,
    envTokensSet: !!(hasRefreshToken && realmId),
    hasRefreshToken,
    tokenHealth,
    tokenExpiresInMinutes: tokenExpiresIn,
    lastRefreshed: tokens?.last_refreshed || null,
    hasTokenError: !!tokenError,
    tokenError: tokenError?.message || null,
    tokensSource: tokens?.source || null,
    tokensFile: 'data/quickbooks-tokens.json',
    cachePopulated: cacheStatus,
    cacheDir: 'data/qb-cache',
    persistenceEnabled: true,
  });
});

// Query QB for bills with line-item detail
app.get('/api/quickbooks/bills', async (req, res) => {
  try {
    const bills = await qbClient.query('SELECT * FROM Bill MAXRESULTS 100');
    res.json(bills);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Disconnect (forget stored tokens)
app.post('/api/quickbooks/disconnect', (req, res) => {
  qbClient.disconnect();
  res.json({ success: true });
});

// Disconnect Composio connectors
app.post('/api/square/disconnect', async (req, res) => {
  try {
    await composioConnectors.disconnectSquare();
    res.json({ success: true, message: 'Square connector disconnected' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to disconnect Square', message: err.message });
  }
});

app.post('/api/quickbooks/composio-disconnect', async (req, res) => {
  try {
    await composioConnectors.disconnectQuickBooks();
    res.json({ success: true, message: 'QuickBooks connector disconnected' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to disconnect QuickBooks', message: err.message });
  }
});

// Manual refresh of all QB data (P&L, accounts, expenses)
app.post('/api/quickbooks/refresh', async (req, res) => {
  try {
    const result = await qbCache.refreshAllQBData();
    res.json({
      success: true,
      ...result,
      message: 'QuickBooks data refreshed successfully',
    });
  } catch (err) {
    if (err.code === 'QB_NOT_CONNECTED') {
      return res.json({ error: err.message, connected: false });
    }
    res.status(500).json({
      error: 'QuickBooks refresh failed',
      message: err.response?.data?.fault?.detail?.[0]?.message || err.message,
    });
  }
});

// POST /api/admin/refresh-qb-weekly - Refresh the QB weekly P&L snapshot (used by Prime Cost dashboard)
app.post('/api/admin/refresh-qb-weekly', async (req, res) => {
  try {
    const isQBConnected = () => {
      try { const t = qbClient.loadTokens(); return !!(t && t.refresh_token); } catch { return false; }
    };

    if (!isQBConnected()) {
      return res.status(400).json({ error: 'QuickBooks not connected', message: 'Connect QuickBooks first to refresh weekly data' });
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const currentWeekStart = getWeekStart(todayStr, 0);
    const twoWeeksAgo = addDays(currentWeekStart, -14);

    const snapshot = loadQBWeeklySnapshot();
    const weeklyRows = await fetchQBWeeklyRows(twoWeeksAgo, addDays(currentWeekStart, 7));
    Object.assign(snapshot.weeks, weeklyRows);
    saveQBWeeklySnapshot(snapshot);

    res.json({
      success: true,
      message: 'QB weekly P&L snapshot refreshed successfully',
      refreshedRange: `${twoWeeksAgo} to ${currentWeekStart}`,
      cachedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Weekly QB snapshot refresh failed:', err.message);
    res.status(500).json({
      error: 'QB weekly refresh failed',
      message: err.message,
    });
  }
});

// ============= GOOGLE OAUTH 2.0 (recipe sheets) =============
// Authenticate as the bakery's own Google user so the pipeline can read the private recipe folder.
// Same shape as the QuickBooks flow above. Token handling lives in pipeline/sheets-oauth.js.
const googleSheets = require('./pipeline/sheets-oauth');

// Step 1: redirect the user to Google's consent screen
app.get('/api/google/connect', (req, res) => {
  if (!googleSheets.hasCredentials()) {
    return res.status(400).send('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first (create an OAuth client at https://console.cloud.google.com/apis/credentials).');
  }
  res.redirect(googleSheets.getAuthUrl());
});

// Step 2: Google redirects back here with a code
app.get('/api/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`Google authorization failed: ${error}`);
  if (!code) return res.status(400).send('Missing authorization code from Google');
  try {
    await googleSheets.exchangeCodeForTokens(code);
    const tokens = googleSheets.loadTokens();
    if (tokens?.refresh_token) {
      console.log('📌 Add to Railway environment for persistent backup:');
      console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
      process.env.GOOGLE_REFRESH_TOKEN = tokens.refresh_token;
    }
    res.redirect('/?google=connected');
  } catch (err) {
    res.status(500).send(`Failed to connect Google: ${err.message}`);
  }
});

// Connection status
app.get('/api/google/status', (req, res) => {
  res.json({
    configured: googleSheets.hasCredentials(),
    connected: googleSheets.isConnected(),
    connectedAt: googleSheets.loadTokens()?.connectedAt || null,
  });
});

// Disconnect (forget stored tokens)
app.post('/api/google/disconnect', (req, res) => {
  googleSheets.disconnect();
  res.json({ success: true });
});

// ============= QUICKBOOKS DATA ENDPOINTS =============

// Fetch a Profit & Loss report from QuickBooks, broken into periods (Week or Month) for a date range
const fetchQBProfitAndLoss = async (startDate, endDate, summarizeColumnBy = 'Month') => {
  try {
    // Try Composio first if configured
    if (process.env.COMPOSIO_API_KEY) {
      try {
        console.log('Attempting to fetch QB P&L via Composio...');
        const client = await composioConnectors.initComposio();
        const connectionId = await composioConnectors.getQuickBooksConnection();
        console.log('Got QB connection ID from Composio:', connectionId);

        // Try to use Composio's QB action
        try {
          const result = await client.executeAction({
            connectionId,
            action: 'quickbooks_get_profit_loss_report',
            parameters: {
              start_date: startDate,
              end_date: endDate,
              summarize_column_by: summarizeColumnBy,
            },
          });
          console.log('✅ Successfully fetched QB P&L via Composio');
          return result;
        } catch (err) {
          console.warn('Composio QB action failed:', err.message, '- trying direct API...');
        }
      } catch (err) {
        console.warn('Composio connection attempt failed:', err.message, '- falling back to legacy auth');
      }
    }
  } catch (err) {
    console.warn('Composio path failed:', err.message);
  }

  // Fallback to legacy token auth
  console.log('Attempting QB P&L fetch with legacy token auth...');
  const tokens = await getValidQBAccessToken();
  const response = await axios.get(
    `${qbClient.baseUrl()}/v3/company/${tokens.realmId}/reports/ProfitAndLoss`,
    {
      params: { start_date: startDate, end_date: endDate, summarize_column_by: summarizeColumnBy },
      headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
    }
  );
  return response.data;
};

const MONTH_SHORTS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Walk a QuickBooks report's row tree looking for a Summary row by group name
// (e.g. 'Income', 'COGS', 'Expenses', 'NetIncome')
const findQBSummaryRow = (rows, group) => {
  if (!rows) return null;
  for (const row of rows) {
    if (row.group === group && row.Summary) return row;
    if (row.Rows?.Row) {
      const found = findQBSummaryRow(row.Rows.Row, group);
      if (found) return found;
    }
  }
  return null;
};

// Walk a QuickBooks report's row tree looking for a row whose account name contains the given
// text (e.g. 'LABOR/PAYROLL EXPENSES' lives as a line item nested inside the Expenses group,
// not as its own top-level group, so it can't be found via findQBSummaryRow)
const findQBRowByLabel = (rows, labelSubstring) => {
  if (!rows) return null;
  const needle = labelSubstring.toUpperCase();
  for (const row of rows) {
    const label = row.Header?.ColData?.[0]?.value || row.ColData?.[0]?.value || '';
    if (label.toUpperCase().includes(needle)) return row;
    if (row.Rows?.Row) {
      const found = findQBRowByLabel(row.Rows.Row, labelSubstring);
      if (found) return found;
    }
  }
  return null;
};

const getQBRowVals = (row) => {
  const cols = row?.Summary?.ColData || row?.Header?.ColData;
  return cols?.map((c) => parseFloat(c.value) || 0) || [];
};

// Convert a QuickBooks ProfitAndLoss report (summarized by Week or Month) into per-period rows.
// Real dollar figures straight from the ledger for each period - never averaged or estimated
// from a different granularity.
const parseQBPeriodPL = (report) => {
  const columns = report.Columns?.Column || [];
  const periodCols = columns
    .map((c, i) => ({ index: i, title: c.ColTitle }))
    .filter((c) => c.title && c.title !== 'Total');

  const revenueVals = getQBRowVals(findQBSummaryRow(report.Rows?.Row, 'Income'));
  const cogsVals = getQBRowVals(findQBSummaryRow(report.Rows?.Row, 'COGS'));
  const opexVals = getQBRowVals(findQBSummaryRow(report.Rows?.Row, 'Expenses'));
  // Match the "Total for 6200 LABOR/PAYROLL EXPENSES" summary row - this ensures we get the
  // correct total including all sub-items (wages, taxes, workers comp) rather than individual line items
  const laborVals = getQBRowVals(findQBRowByLabel(report.Rows?.Row, 'Total for 6200 LABOR/PAYROLL')) || getQBRowVals(findQBRowByLabel(report.Rows?.Row, 'LABOR/PAYROLL'));
  const netVals = getQBRowVals(report.Rows?.Row?.find((r) => r.group === 'NetIncome'));

  return periodCols.map((col) => {
    const monthIdx = MONTH_NAMES.findIndex((name) => col.title.startsWith(name.slice(0, 3)));
    // Monthly columns are titled with the bare month name (e.g. "January"); weekly columns are
    // titled with a date range (e.g. "Jun 28 - Jul 4, 2026") - only rewrite the former.
    const isBareMonth = monthIdx >= 0 && /^[A-Za-z]+$/.test(col.title.trim());
    const shortLabelMatch = col.title.match(/^([A-Za-z]+ \d+)/);
    return {
      label: isBareMonth ? MONTH_SHORTS[monthIdx] : (shortLabelMatch ? shortLabelMatch[1] : col.title),
      fullLabel: isBareMonth ? MONTH_NAMES[monthIdx] : col.title,
      revenue: revenueVals[col.index] || 0,
      cogs: cogsVals[col.index] || 0,
      opex: opexVals[col.index] || 0,
      labor: laborVals[col.index] || 0,
      pl: netVals[col.index] || 0,
    };
  });
};

// Pair consecutive real weekly periods into 2-week totals - summed, never averaged. Any odd
// leftover week is kept as its own lone period at the oldest end of the range, so the most
// recent period is always a full, comparable 2-week pair.
const pairIntoBiweekly = (weeklyRowsWithDates) => {
  const periods = [];
  let i = 0;
  while (i < weeklyRowsWithDates.length) {
    const { row: a, date: dateA } = weeklyRowsWithDates[i];
    const nextItem = weeklyRowsWithDates[i + 1];

    // Check if next week exists and is exactly 7 days after this one (consecutive)
    if (nextItem && addDays(dateA, 7) === nextItem.date) {
      const { row: b, date: dateB } = nextItem;
      periods.push({
        label: a.label,
        fullLabel: `${a.fullLabel} + ${b.fullLabel}`,
        revenue: round2(a.revenue + b.revenue),
        cogs: round2(a.cogs + b.cogs),
        opex: round2(a.opex + b.opex),
        labor: round2(a.labor + b.labor),
        pl: round2(a.pl + b.pl),
        startDate: dateA,
      });
      i += 2;
    } else {
      // Gap detected or last week - keep as single period
      periods.push({ ...a, startDate: dateA });
      i += 1;
    }
  }
  return periods;
};

// ============= QUICKBOOKS WEEKLY P&L SNAPSHOT =============
// Persists real per-week QuickBooks totals to disk (data/qb-weekly-pl-snapshot.json), keyed by
// each week's Sunday start date, so a completed week is only ever fetched from QuickBooks once.
// Only the most recent 2 weeks (which can still be settling - late-posted expenses, corrections)
// are re-fetched live on every request; everything older is served straight from disk.

const QB_WEEKLY_SNAPSHOT_FILE = path.join(DATA_DIR, 'qb-weekly-pl-snapshot.json');
const loadQBWeeklySnapshot = () => {
  const data = loadData(QB_WEEKLY_SNAPSHOT_FILE);
  return data && data.weeks && typeof data.weeks === 'object' && !Array.isArray(data) ? data : { weeks: {} };
};
const saveQBWeeklySnapshot = (snapshot) => saveData(QB_WEEKLY_SNAPSHOT_FILE, snapshot);

// Fetch one QuickBooks weekly report and key each column by its real Sunday start date.
// `startDate` MUST be a Sunday and `endDateExclusive` MUST be `startDate` plus a whole number of
// weeks - QuickBooks only returns clean, unpadded weekly columns from a Sunday-aligned start, so
// the i-th column is reliably `startDate + 7*i` days without needing to parse its title text.
const fetchQBWeeklyRows = async (startDate, endDateExclusive) => {
  const report = await fetchQBProfitAndLoss(startDate, addDays(endDateExclusive, -1), 'Week');
  const parsed = parseQBPeriodPL(report);
  const rows = {};
  parsed.forEach((row, i) => { rows[addDays(startDate, 7 * i)] = row; });
  return rows;
};

// Get real per-week QuickBooks P&L totals for [rangeStart, rangeEndInclusive] (both Sundays),
// backfilling from QuickBooks into the on-disk snapshot only for weeks not already cached, and
// refreshing the most recent 2 weeks live if QB is connected. If QB is not connected, serves from cache.
// Returns array of {row, date} objects to preserve week correspondence for pairing.
const getQBWeeklyRows = async (rangeStart, rangeEndInclusive) => {
  const snapshot = loadQBWeeklySnapshot();
  const earliestCached = Object.keys(snapshot.weeks).sort()[0];

  // Only try to fetch from QB if connected
  const isQBConnected = () => {
    try { const t = qbClient.loadTokens(); return !!(t && t.refresh_token); } catch { return false; }
  };

  if (isQBConnected()) {
    if (!earliestCached || rangeStart < earliestCached) {
      const backfillEnd = earliestCached && earliestCached > rangeStart ? earliestCached : addDays(rangeEndInclusive, 7);
      Object.assign(snapshot.weeks, await fetchQBWeeklyRows(rangeStart, backfillEnd));
    }

    const liveStart = addDays(rangeEndInclusive, -7);
    Object.assign(snapshot.weeks, await fetchQBWeeklyRows(liveStart, addDays(rangeEndInclusive, 7)));

    saveQBWeeklySnapshot(snapshot);
  }

  const rows = [];
  for (let d = rangeStart; d <= rangeEndInclusive; d = addDays(d, 7)) {
    if (snapshot.weeks[d]) rows.push({ row: snapshot.weeks[d], date: d });
  }
  return rows;
};

// Get raw P/L Statement from QuickBooks (serves from persistent cache first)
app.get('/api/quickbooks/pl', async (req, res) => {
  try {
    // Try persistent disk cache first
    const cached = qbCache.loadCache('pl-30d');
    if (cached) {
      return res.json({
        success: true,
        data: cached.data,
        source: 'QuickBooks (persistent cache)',
        cachedAt: cached.cachedAt,
      });
    }

    // Fall back to live API fetch
    const today = new Date();
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const startDate = req.query.start_date || thirtyDaysAgo.toISOString().split('T')[0];
    const endDate = req.query.end_date || today.toISOString().split('T')[0];

    const data = await fetchQBProfitAndLoss(startDate, endDate);
    res.json({ success: true, data, note: 'P/L statement from QuickBooks (live)' });
  } catch (err) {
    console.error('QB P&L fetch error:', err.message);
    if (err.code === 'QB_NOT_CONNECTED') {
      // Try to serve from cache even if not connected
      const cached = qbCache.loadCache('pl-30d');
      if (cached) {
        return res.json({
          success: true,
          data: cached.data,
          source: 'QuickBooks (offline cache)',
          cachedAt: cached.cachedAt,
          note: 'Using cached data — QB not currently connected',
        });
      }
      return res.json({ error: err.message, connected: false, data: [] });
    }
    res.status(500).json({ error: 'QuickBooks API error', message: err.response?.data?.fault?.detail?.[0]?.message || err.message });
  }
});

// Get Account Balances from QuickBooks (serves from persistent cache first)
app.get('/api/quickbooks/accounts', async (req, res) => {
  try {
    // Try persistent disk cache first
    const cached = qbCache.loadCache('accounts');
    if (cached) {
      return res.json({
        success: true,
        data: cached.data,
        source: 'QuickBooks (persistent cache)',
        cachedAt: cached.cachedAt,
      });
    }

    // Fall back to live API fetch
    const data = await qbCache.fetchAccounts();
    res.json({ success: true, data, note: 'Account balances from QuickBooks (live)' });
  } catch (err) {
    if (err.code === 'QB_NOT_CONNECTED') {
      // Try to serve from cache even if not connected
      const cached = qbCache.loadCache('accounts');
      if (cached) {
        return res.json({
          success: true,
          data: cached.data,
          source: 'QuickBooks (offline cache)',
          cachedAt: cached.cachedAt,
          note: 'Using cached data — QB not currently connected',
        });
      }
      return res.json({ error: err.message, connected: false, data: [] });
    }
    res.status(500).json({ error: 'QuickBooks API error', message: err.response?.data?.fault?.detail?.[0]?.message || err.message });
  }
});

// Get Expenses from QuickBooks (filtered by category, serves from persistent cache first)
app.get('/api/quickbooks/expenses', async (req, res) => {
  try {
    // Try persistent disk cache first
    const cached = qbCache.loadCache('expenses');
    if (cached) {
      return res.json({
        success: true,
        data: cached.data,
        source: 'QuickBooks (persistent cache)',
        cachedAt: cached.cachedAt,
      });
    }

    // Fall back to live API fetch
    const data = await qbCache.fetchExpenses();
    res.json({ success: true, data, note: 'Expense accounts from QuickBooks (live)' });
  } catch (err) {
    if (err.code === 'QB_NOT_CONNECTED') {
      // Try to serve from cache even if not connected
      const cached = qbCache.loadCache('expenses');
      if (cached) {
        return res.json({
          success: true,
          data: cached.data,
          source: 'QuickBooks (offline cache)',
          cachedAt: cached.cachedAt,
          note: 'Using cached data — QB not currently connected',
        });
      }
      return res.json({ error: err.message, connected: false, data: [] });
    }
    res.status(500).json({ error: 'QuickBooks API error', message: err.response?.data?.fault?.detail?.[0]?.message || err.message });
  }
});

// ============= AGGREGATION ENDPOINT =============

// Get combined P/L data
app.get('/api/dashboard', async (req, res) => {
  try {
    const recipes = loadData(RECIPES_FILE);
    const ingredients = loadData(INGREDIENTS_FILE);
    const monthlyFinancial = loadData('data/monthly-financial.json') || {};

    // Build monthly data from uploaded files (handles year-month keys like "2026-Jun")
    const monthToNum = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
    let monthlyData = Object.entries(monthlyFinancial)
      .map(([key, data]) => ({
        ...data,
        sortKey: key,
      }))
      .sort((a, b) => {
        const aYear = a.year;
        const bYear = b.year;
        if (aYear !== bYear) return aYear - bYear;
        const aMonth = monthToNum[a.month] || 0;
        const bMonth = monthToNum[b.month] || 0;
        return aMonth - bMonth;
      })
      .filter(m => m.revenue > 0);

    // Calculate totals
    let totalRevenue = 0, totalCogs = 0, totalOpex = 0, totalLabor = 0;
    Object.values(monthlyFinancial).forEach(m => {
      totalRevenue += m.revenue || 0;
      totalCogs += m.cogs || 0;
      totalOpex += m.opex || 0;
      totalLabor += m.labor || 0;
    });

    const summary = totalRevenue > 0 ? {
      revenue: totalRevenue,
      cogs: totalCogs,
      opex: totalOpex,
      labor: totalLabor,
      pl: totalRevenue - totalCogs - totalOpex,
      source: 'Multi-month P/L Statements'
    } : { source: 'No financial data uploaded yet' };

    // 2-week period data comes from real per-week QuickBooks ledger totals summed in pairs, never
    // averaged or estimated - only available once QuickBooks has been connected. Periods instead
    // of raw weeks because labor/payroll posts roughly biweekly, so a single-week view is
    // dominated by whichever week payroll happened to land in. Completed weeks are served from a
    // disk-persisted snapshot (data/qb-weekly-pl-snapshot.json) instead of re-fetched every time -
    // only the most recent 2 weeks are ever pulled live.
    let periodData = [];
    let periodSource = 'QuickBooks not connected';
    try {
      const weeksBack = Math.min(parseInt(req.query.weeks, 10) || 16, 52);
      const offsetWeeks = parseInt(req.query.offset, 10) || 0;
      const todayStr = new Date().toISOString().slice(0, 10);
      const currentWeekStart = getWeekStart(todayStr, 0);
      const weekEndForOffset = addDays(currentWeekStart, -7 * offsetWeeks);
      const rangeStart = addDays(weekEndForOffset, -7 * weeksBack);
      const weeklyRows = await getQBWeeklyRows(rangeStart, weekEndForOffset);

      const pairedData = pairIntoBiweekly(weeklyRows);
      periodData = pairedData;

      periodSource = 'QuickBooks (cached + live, every 2 weeks)';
    } catch (err) {
      if (err.code !== 'QB_NOT_CONNECTED') {
        console.error('Weekly QuickBooks P&L fetch failed:', err.response?.data?.fault?.detail?.[0]?.message || err.message);
        periodSource = 'QuickBooks fetch failed';
      }
    }

    res.json({
      monthlyData,
      periodData,
      periodSource,
      summary,
      recipes: { count: recipes.length },
      ingredients: { count: ingredients.length },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pl-by-channel
// Combined channel + market + revenue-allocation P&L, built from the three sheets uploaded via
// /api/upload/pl-channel/*. Nothing here is computed/derived - every number is exactly what was in
// the uploaded sheet. A tab loads whichever of the three pieces has been uploaded so far.
app.get('/api/pl-by-channel', (req, res) => {
  const data = loadPLChannelData();
  res.json({
    channels: data.channels || [],
    markets: data.markets || [],
    revenueAllocation: data.revenueAllocation || null,
    updatedAt: {
      channels: data.channelsUpdatedAt || null,
      markets: data.marketsUpdatedAt || null,
      revenueAllocation: data.revenueAllocationUpdatedAt || null,
    },
  });
});

// ============= WASTE DASHBOARD =============
// Waste = produced (uploaded via CSV, per location) minus sold (pulled live from Square Orders,
// matched by item name + day). "Sold" quantity comes straight off each order's line items
// (line_items[].name / .quantity), not the catalog, since that's the name Square actually sold
// under that day - no catalog lookup or ID mapping required.

// Square's closed_at is UTC. Every one of these locations is in California, so a sale any time
// after ~5pm Pacific has a UTC instant that falls on the *next* calendar day - naively slicing the
// UTC string groups evening sales under the wrong business day, and for a market that runs into the
// evening (as opposed to a bakery that closes mid-afternoon) that can misattribute most of a day's
// sales. Convert to the location's actual local calendar date instead.
const squareDateInPacific = (isoString) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(isoString));

// Fetch every COMPLETED order at a location closed within [startDate, endDateExclusive) (Pacific
// calendar dates), and aggregate quantity sold per (day, lowercased item name), plus a per-item
// average unit price (gross sales / quantity, across the whole range) - there's no separate
// price/cost tracking anywhere in this app, so this is the only $ figure available, and it's used
// as a stand-in price for produced/wasted units too (which were never actually sold, so have no
// real transaction price of their own).
const fetchSoldQuantities = async (locationId, startDate, endDateExclusive) => {
  const sold = {}; // sold[date][itemNameLower] = quantity
  const priceTotals = {}; // priceTotals[itemNameLower] = { revenue, quantity }
  let cursor;
  let page = 0;
  // Pacific midnight doesn't line up with UTC midnight (up to ~8h offset depending on DST), so query
  // a UTC window padded a day on each side to guarantee full coverage, then filter back down to the
  // intended Pacific range after bucketing each order by its actual local date.
  const queryStart = addDays(startDate, -1);
  const queryEnd = addDays(endDateExclusive, 1);
  do {
    const response = await axios.post(
      `${SQUARE_API_BASE}/orders/search`,
      {
        location_ids: [locationId],
        query: {
          filter: {
            date_time_filter: { closed_at: { start_at: `${queryStart}T00:00:00Z`, end_at: `${queryEnd}T00:00:00Z` } },
            state_filter: { states: ['COMPLETED'] },
          },
          sort: { sort_field: 'CLOSED_AT' },
        },
        limit: 500,
        cursor,
      },
      { headers: squareHeaders() }
    );
    (response.data.orders || []).forEach((order) => {
      if (!order.closed_at) return;
      const date = squareDateInPacific(order.closed_at);
      if (date < startDate || date >= endDateExclusive) return;
      (order.line_items || []).forEach((li) => {
        const name = (li.name || '').trim().toLowerCase();
        const qty = parseFloat(li.quantity);
        if (!name || !Number.isFinite(qty)) return;
        sold[date] = sold[date] || {};
        sold[date][name] = (sold[date][name] || 0) + qty;

        const revenue = (li.gross_sales_money?.amount || 0) / 100;
        const acc = priceTotals[name] || { revenue: 0, quantity: 0 };
        acc.revenue += revenue;
        acc.quantity += qty;
        priceTotals[name] = acc;
      });
    });
    cursor = response.data.cursor;
    page += 1;
  } while (cursor && page < 500);

  const avgPrice = {};
  Object.entries(priceTotals).forEach(([name, { revenue, quantity }]) => {
    if (quantity > 0) avgPrice[name] = revenue / quantity;
  });

  return { sold, avgPrice };
};

// Location names for the Waste tab's location/market toggle, split the same way as WASTE_LOCATIONS.
app.get('/api/waste/locations', (req, res) => {
  res.json({
    stores: WASTE_STORE_LOCATIONS.map((l) => l.name),
    markets: WASTE_MARKET_LOCATIONS.map((l) => l.name),
  });
});

// ============= MARKET PERFORMANCE DASHBOARD =============

// Fetch gross sales revenue for one location, bucketed by workweek. Same pagination/date-window
// pattern as fetchSoldQuantities, but summing whole-order revenue instead of per-item quantity.
const fetchWeeklyRevenueForLocation = async (locationId, startDate, endDateExclusive, startDow) => {
  const revenueByWeek = {};
  let cursor;
  let page = 0;
  const queryStart = addDays(startDate, -1);
  const queryEnd = addDays(endDateExclusive, 1);
  do {
    const response = await axios.post(
      `${SQUARE_API_BASE}/orders/search`,
      {
        location_ids: [locationId],
        query: {
          filter: {
            date_time_filter: { closed_at: { start_at: `${queryStart}T00:00:00Z`, end_at: `${queryEnd}T00:00:00Z` } },
            state_filter: { states: ['COMPLETED'] },
          },
          sort: { sort_field: 'CLOSED_AT' },
        },
        limit: 500,
        cursor,
      },
      { headers: squareHeaders() }
    );
    (response.data.orders || []).forEach((order) => {
      if (!order.closed_at) return;
      const date = squareDateInPacific(order.closed_at);
      if (date < startDate || date >= endDateExclusive) return;
      const weekStart = getWeekStart(date, startDow);
      const orderRevenue = (order.line_items || []).reduce((sum, li) => sum + (li.gross_sales_money?.amount || 0), 0) / 100;
      revenueByWeek[weekStart] = (revenueByWeek[weekStart] || 0) + orderRevenue;
    });
    cursor = response.data.cursor;
    page += 1;
  } while (cursor && page < 500);
  return revenueByWeek;
};

// Run async tasks with bounded concurrency, so a ~50-location fetch doesn't fire 50 simultaneous
// requests at Square at once.
const mapWithConcurrency = async (items, limit, fn) => {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
};

// Persists weekly revenue per market to disk (data/market-performance-snapshot.json), so a
// completed week is only ever fetched from Square once instead of re-fetched across all ~50
// locations on every request. Only the most recent 2 weeks are ever pulled live (mirrors the
// QuickBooks weekly snapshot pattern above), which covers both the still-accumulating current
// week and any orders that settle a few days late.
const MARKET_PERF_SNAPSHOT_FILE = path.join(DATA_DIR, 'market-performance-snapshot.json');
const loadMarketPerfSnapshot = () => {
  const data = loadData(MARKET_PERF_SNAPSHOT_FILE);
  return data && data.revenueByMarket && typeof data.revenueByMarket === 'object' && !Array.isArray(data)
    ? data
    : { revenueByMarket: {}, backfilledFrom: null };
};
const saveMarketPerfSnapshot = (snapshot) => saveData(MARKET_PERF_SNAPSHOT_FILE, snapshot);

// Get real per-week revenue for every market location across [rangeStart, rangeEndInclusive]
// (both week-start dates), backfilling from Square into the on-disk snapshot only as far back as
// hasn't already been fetched, and always refreshing the most recent 2 weeks live.
const getMarketWeeklyRevenue = async (rangeStart, rangeEndInclusive, startDow) => {
  const snapshot = loadMarketPerfSnapshot();
  const rangeEndExclusive = addDays(rangeEndInclusive, 7);

  if (!snapshot.backfilledFrom || rangeStart < snapshot.backfilledFrom) {
    const backfillEnd = snapshot.backfilledFrom && snapshot.backfilledFrom > rangeStart ? snapshot.backfilledFrom : rangeEndExclusive;
    const backfillResults = await mapWithConcurrency(WASTE_MARKET_LOCATIONS, 6, async (loc) => {
      try {
        return {
          name: loc.name,
          revenueByWeek: await fetchWeeklyRevenueForLocation(loc.squareLocationId, rangeStart, backfillEnd, startDow),
        };
      } catch (err) {
        console.warn(`⚠️ Failed to backfill data for ${loc.name}:`, err.message);
        return { name: loc.name, revenueByWeek: {} };
      }
    });
    backfillResults.forEach(({ name, revenueByWeek }) => {
      snapshot.revenueByMarket[name] = { ...(snapshot.revenueByMarket[name] || {}), ...revenueByWeek };
    });
    snapshot.backfilledFrom = rangeStart;
  }

  const liveStart = addDays(rangeEndInclusive, -7);
  const liveResults = await mapWithConcurrency(WASTE_MARKET_LOCATIONS, 6, async (loc) => {
    try {
      return {
        name: loc.name,
        revenueByWeek: await fetchWeeklyRevenueForLocation(loc.squareLocationId, liveStart, rangeEndExclusive, startDow),
      };
    } catch (err) {
      console.warn(`⚠️ Failed to fetch live data for ${loc.name}:`, err.message);
      return { name: loc.name, revenueByWeek: {} };
    }
  });
  liveResults.forEach(({ name, revenueByWeek }) => {
    snapshot.revenueByMarket[name] = { ...(snapshot.revenueByMarket[name] || {}), ...revenueByWeek };
  });

  saveMarketPerfSnapshot(snapshot);
  return snapshot.revenueByMarket;
};

// GET /api/market-performance?weeks=156
// Weekly gross sales revenue per farmers-market/pop-up location, straight from Square orders -
// real per-week totals, not estimated or averaged. Range goes back up to 3 years (156 weeks).
// Completed weeks come from the on-disk snapshot; only the most recent 2 weeks are ever
// re-fetched live. A short in-memory cache on top smooths out rapid repeat page loads.
app.get('/api/market-performance', async (req, res) => {
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token || token === 'your_square_token_here') {
    return res.status(400).json({ error: 'Square API credentials not configured', weekStarts: [], markets: [] });
  }

  const weekCount = Math.min(Math.max(parseInt(req.query.weeks, 10) || 52, 1), 260);
  const cacheKey = `market_perf_${weekCount}`;
  const cached = cacheManager.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    // Add timeout to prevent hanging
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Request timeout')), 15000)
    );

    const startDow = await fetchWorkweekStartDow();
    const todayStr = new Date().toISOString().slice(0, 10);
    const currentWeekStart = getWeekStart(todayStr, startDow);
    // Limit to recent data to avoid server overload
    const effectiveWeekCount = Math.min(weekCount, 52);
    const rangeStart = addDays(currentWeekStart, -7 * (effectiveWeekCount - 1));

    const weekStarts = [];
    for (let d = rangeStart; d <= currentWeekStart; d = addDays(d, 7)) weekStarts.push(d);

    const revenueByMarket = await Promise.race([
      getMarketWeeklyRevenue(rangeStart, currentWeekStart, startDow),
      timeoutPromise
    ]);

    const markets = WASTE_MARKET_LOCATIONS
      .map((loc) => ({ name: loc.name, revenue: weekStarts.map((ws) => round2((revenueByMarket[loc.name] || {})[ws] || 0)) }))
      .filter((m) => m.revenue.some((v) => v > 0) || ['506 Retail', 'State St'].includes(m.name))
      .sort((a, b) => b.revenue.reduce((s, v) => s + v, 0) - a.revenue.reduce((s, v) => s + v, 0));

    const response = { success: true, weekStarts, markets, rangeStart, rangeEnd: currentWeekStart };
    cacheManager.set(cacheKey, response, 4 * 60 * 60 * 1000); // Cache for 4 hours
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: 'Square API error', message: err.response?.data?.errors?.[0]?.detail || err.message || 'Request timeout', weekStarts: [], markets: [] });
  }
});

// GET /api/store-locations-performance - Just 506 Retail and State St with all data
app.get('/api/store-locations-performance', async (req, res) => {
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token || token === 'your_square_token_here') {
    return res.status(400).json({ error: 'Square API credentials not configured', weekStarts: [], markets: [] });
  }

  const weekCount = Math.min(Math.max(parseInt(req.query.weeks, 10) || 52, 1), 260);
  const cacheKey = `store_perf_${weekCount}`;
  const cached = cacheManager.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    // Add timeout to prevent hanging
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Request timeout')), 15000)
    );

    const startDow = await fetchWorkweekStartDow();
    const todayStr = new Date().toISOString().slice(0, 10);
    const currentWeekStart = getWeekStart(todayStr, startDow);
    // Limit to recent data to avoid server overload
    const effectiveWeekCount = Math.min(weekCount, 52);
    const rangeStart = addDays(currentWeekStart, -7 * (effectiveWeekCount - 1));

    const weekStarts = [];
    for (let d = rangeStart; d <= currentWeekStart; d = addDays(d, 7)) weekStarts.push(d);

    const revenueByMarket = await Promise.race([
      getMarketWeeklyRevenue(rangeStart, currentWeekStart, startDow),
      timeoutPromise
    ]);

    const storeLocations = [
      { name: '506 Retail', squareLocationId: 'L91Q2PN8KATAB' },
      { name: 'State St', squareLocationId: 'L5J0D4FWK7FFY' }
    ];

    const markets = storeLocations
      .map((loc) => ({ name: loc.name, revenue: weekStarts.map((ws) => round2((revenueByMarket[loc.name] || {})[ws] || 0)) }))
      .sort((a, b) => b.revenue.reduce((s, v) => s + v, 0) - a.revenue.reduce((s, v) => s + v, 0));

    const response = { success: true, weekStarts, markets, rangeStart, rangeEnd: currentWeekStart };
    cacheManager.set(cacheKey, response, 4 * 60 * 60 * 1000); // Cache for 4 hours
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: 'Square API error', message: err.response?.data?.errors?.[0]?.detail || err.message || 'Request timeout', weekStarts: [], markets: [] });
  }
});

// Force backfill of market-performance data for all locations
app.get('/api/admin/backfill-market-performance', async (req, res) => {
  try {
    console.log('🔄 Forcing market-performance backfill for all locations...');
    // Clear the snapshot file to force complete rebuild
    if (fs.existsSync(MARKET_PERF_SNAPSHOT_FILE)) {
      fs.unlinkSync(MARKET_PERF_SNAPSHOT_FILE);
      console.log('📁 Cleared snapshot file');
    }

    const startDow = await fetchWorkweekStartDow();
    const todayStr = new Date().toISOString().slice(0, 10);
    const currentWeekStart = getWeekStart(todayStr, startDow);
    const rangeStart = addDays(currentWeekStart, -7 * 1040); // 20 years back to capture all historical data

    console.log(`📅 Backfilling from ${rangeStart} to ${currentWeekStart}`);
    await getMarketWeeklyRevenue(rangeStart, currentWeekStart, startDow);
    cacheManager.invalidatePrefix('market_perf_');
    cacheManager.invalidatePrefix('store_perf_');

    res.json({ success: true, message: 'Backfill complete (20 years back). Cache cleared.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/backfill-market-performance-range?startDate=2026-07-01&endDate=2026-08-31
// Backfill market performance data for a specific date range without clearing entire snapshot
app.get('/api/admin/backfill-market-performance-range', async (req, res) => {
  try {
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Missing startDate and/or endDate query parameters (format: YYYY-MM-DD)' });
    }

    console.log(`🔄 Backfilling market-performance for range ${startDate} to ${endDate}...`);

    const startDow = await fetchWorkweekStartDow();
    const snapshot = loadMarketPerfSnapshot();

    // Backfill the requested range
    const backfillResults = await mapWithConcurrency(WASTE_MARKET_LOCATIONS, 6, async (loc) => {
      try {
        return {
          name: loc.name,
          revenueByWeek: await fetchWeeklyRevenueForLocation(loc.squareLocationId, startDate, addDays(endDate, 1), startDow),
        };
      } catch (err) {
        console.warn(`⚠️ Failed to backfill data for ${loc.name}:`, err.message);
        return { name: loc.name, revenueByWeek: {} };
      }
    });

    backfillResults.forEach(({ name, revenueByWeek }) => {
      snapshot.revenueByMarket[name] = { ...(snapshot.revenueByMarket[name] || {}), ...revenueByWeek };
    });

    // If this range extends further back than current backfill, update the marker
    if (!snapshot.backfilledFrom || startDate < snapshot.backfilledFrom) {
      snapshot.backfilledFrom = startDate;
    }

    saveMarketPerfSnapshot(snapshot);
    cacheManager.invalidatePrefix('market_perf_');
    cacheManager.invalidatePrefix('store_perf_');

    res.json({ success: true, message: `Backfill complete for ${startDate} to ${endDate}. Cache cleared.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Backfill disabled due to server overload - just fetch recent data
app.get('/api/admin/backfill-store-locations', async (req, res) => {
  res.json({ message: 'Backfill disabled. Dashboards now show recent data only.' });
});

// GET /api/product-margins - Product pricing, COGS, and margin data
const PRODUCT_MARGINS = {
  products: [
    {name: "Long Braid", cogs: 2.77, squarePrice: 16, margin: 0.826875},
    {name: "Country Round", cogs: 0.68, squarePrice: 12, margin: 0.9433333333},
    {name: "Baguette", cogs: 0.51, squarePrice: 10, margin: 0.949},
    {name: "Epi", cogs: 0.51, squarePrice: 12, margin: 0.9575},
    {name: "Country PC", cogs: 0.31, squarePrice: 6, margin: 0.9483333333},
    {name: "Double Choc Cookie", cogs: 1.85, squarePrice: 6.5, margin: 0.7153846154},
    {name: "No Nut Cookie", cogs: 1.38, squarePrice: 6, margin: 0.77},
    {name: "Oatmeal Raisin Cookie", cogs: 0.98, squarePrice: 6, margin: 0.8366666667},
    {name: "PB Cookie", cogs: 0.88, squarePrice: 6, margin: 0.8533333333},
    {name: "Original Cookie", cogs: 1.58, squarePrice: 6.5, margin: 0.7569230769},
    {name: "Breakfast Bar", cogs: 1.61, squarePrice: 7.5, margin: 0.7853333333},
    {name: "WW Round", cogs: 0.86, squarePrice: 12, margin: 0.9283333333},
    {name: "WW PC", cogs: 0.3866666667, squarePrice: 6, margin: 0.9355555556},
    {name: "Mini Banana Bread", cogs: 0.45, squarePrice: 7, margin: 0.9357142857}
  ]
};

app.get('/api/product-margins', (req, res) => {
  res.json(PRODUCT_MARGINS);
});

// Raw uploaded production rows, for inspection. GET /api/production?location=ARC (omit for all locations).
app.get('/api/production', (req, res) => {
  const production = loadProduction();
  if (!req.query.location) return res.json(production);
  res.json({ location: req.query.location, rows: production[req.query.location] || [] });
});

// GET /api/waste?location=ARC&start=YYYY-MM-DD&end=YYYY-MM-DD
// start/end default to the min/max dates present in that location's uploaded production data.
// Cached 1 hour per location+range (Square order data changes as sales come in through the day).
app.get('/api/waste', async (req, res) => {
  const location = req.query.location;
  const locationConfig = WASTE_LOCATIONS.find((l) => l.name === location);
  if (!locationConfig) {
    return res.status(400).json({ error: `Unknown or missing location. Expected one of: ${WASTE_LOCATIONS.map((l) => l.name).join(', ')}`, rows: [] });
  }

  const production = loadProduction()[location] || [];
  if (production.length === 0) {
    return res.json({ location, rows: [], status: 'empty', message: 'No production data uploaded yet for this location.' });
  }

  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token || token === 'your_square_token_here') {
    return res.status(400).json({ error: 'Square API credentials not configured', rows: [] });
  }

  const dates = production.map((r) => r.date).sort();
  const start = req.query.start || dates[0];
  const end = req.query.end || dates[dates.length - 1];

  const cacheKey = `waste_${location}_${start}_${end}`;
  const cached = cacheManager.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const { sold, avgPrice } = await fetchSoldQuantities(locationConfig.squareLocationId, start, addDays(end, 1));

    const rows = production
      .filter((r) => r.date >= start && r.date <= end)
      .map((r) => {
        const quantitySold = (sold[r.date] && sold[r.date][r.item.toLowerCase()]) || 0;
        const ordered = Number.isFinite(r.ordered) ? r.ordered : null;
        const waste = Math.max(r.quantityProduced - quantitySold, 0);
        const price = avgPrice[r.item.toLowerCase()] ?? null;
        return {
          date: r.date,
          item: r.item,
          ordered: ordered !== null ? round2(ordered) : null,
          quantityProduced: round2(r.quantityProduced),
          quantitySold: round2(quantitySold),
          waste: round2(waste),
          oversold: quantitySold > r.quantityProduced,
          fulfillmentPct: ordered && ordered > 0 ? round2((r.quantityProduced / ordered) * 100) : null,
          price: price !== null ? round2(price) : null,
          producedValue: price !== null ? round2(r.quantityProduced * price) : null,
          soldValue: price !== null ? round2(quantitySold * price) : null,
          wasteValue: price !== null ? round2(waste * price) : null,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date) || a.item.localeCompare(b.item));

    // Square sales whose item name never matches a production row for this location - usually
    // means the CSV's item name and Square's point-of-sale name for that item have drifted apart
    // (e.g. catalog "Country RND" sells under the display name "Country Round"). Surfaced so the
    // waste numbers aren't silently inflated by an unmatched name.
    const producedNames = new Set(production.map((r) => r.item.toLowerCase()));
    const unmatchedTotals = {};
    Object.entries(sold).forEach(([date, items]) => {
      if (date < start || date > end) return;
      Object.entries(items).forEach(([nameLower, qty]) => {
        if (producedNames.has(nameLower)) return;
        unmatchedTotals[nameLower] = (unmatchedTotals[nameLower] || 0) + qty;
      });
    });
    const unmatchedSoldItems = Object.entries(unmatchedTotals)
      .map(([item, quantitySold]) => ({ item, quantitySold: round2(quantitySold) }))
      .sort((a, b) => b.quantitySold - a.quantitySold);

    const totals = rows.reduce(
      (acc, r) => ({
        quantityProduced: acc.quantityProduced + r.quantityProduced,
        quantitySold: acc.quantitySold + r.quantitySold,
        waste: acc.waste + r.waste,
        producedValue: acc.producedValue + (r.producedValue || 0),
        soldValue: acc.soldValue + (r.soldValue || 0),
        wasteValue: acc.wasteValue + (r.wasteValue || 0),
      }),
      { quantityProduced: 0, quantitySold: 0, waste: 0, producedValue: 0, soldValue: 0, wasteValue: 0 }
    );

    const response = {
      location,
      start,
      end,
      rows,
      totals: {
        quantityProduced: round2(totals.quantityProduced),
        quantitySold: round2(totals.quantitySold),
        waste: round2(totals.waste),
        wastePct: totals.quantityProduced > 0 ? round2((totals.waste / totals.quantityProduced) * 100) : 0,
        producedValue: round2(totals.producedValue),
        soldValue: round2(totals.soldValue),
        wasteValue: round2(totals.wasteValue),
      },
      unmatchedSoldItems,
      status: 'ready',
    };
    cacheManager.set(cacheKey, response, 60 * 60 * 1000); // 1 hour
    res.json(response);
  } catch (err) {
    res.status(500).json({
      error: 'Square API error',
      message: err.response?.data?.errors?.[0]?.detail || err.message,
      rows: [],
    });
  }
});

// ============= CACHE STATUS =============

// View all cached items and their expiry times
app.get('/api/cache/status', (req, res) => {
  const composioCacheStatus = composioCache.getCacheStatus();
  res.json({
    status: 'ok',
    composio: composioCacheStatus,
    cacheEntries: cacheManager.status(),
    totalCached: cacheManager.status().length,
    timestamp: new Date().toISOString(),
  });
});

// Clear all cache
app.post('/api/cache/clear', (req, res) => {
  cacheManager.cache.clear();
  cacheManager.timers.forEach(timer => clearTimeout(timer));
  cacheManager.timers.clear();
  composioCache.clearCache();

  // Clear Square sales cache
  try {
    if (fs.existsSync(SQUARE_SALES_CACHE_FILE)) {
      fs.unlinkSync(SQUARE_SALES_CACHE_FILE);
      console.log('Cleared Square sales cache');
    }
  } catch (e) {
    console.warn('Failed to clear Square sales cache:', e.message);
  }

  res.json({ success: true, message: 'All caches cleared', timestamp: new Date().toISOString() });
});

// Refresh Composio cache
app.post('/api/cache/refresh', async (req, res) => {
  try {
    const result = await composioCache.refreshAllData();
    res.json({ success: true, ...result, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: 'Cache refresh failed', message: err.message });
  }
});

// Rebuild product margins on demand
app.post('/api/rebuild-margins', async (req, res) => {
  try {
    console.log('🔄 Manual margin rebuild triggered...');
    const { main } = require('./pipeline/build-margins');
    const result = await main({ weeks: 12 });
    console.log(`✅ Margin rebuild complete: ${result.coverage.costed.length} recipes costed`);
    res.json({
      success: true,
      costed: result.coverage.costed.length,
      needsAttention: result.coverage.needsAttention.length,
      excluded: result.coverage.excluded.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('❌ Margin rebuild failed:', err.message);
    res.status(500).json({
      error: 'Margin rebuild failed',
      message: err.message,
      code: err.code,
    });
  }
});

// NO NUT Chocolate Chip Cookie Gross Margin Calculation
// 1. Get recipe & ingredients from Google Sheets (COOKIE NO NUT)
// 2. Get ingredient costs from QB Chef's Warehouse invoices
// 3. Get revenue from Square
// 4. Calculate: Gross Margin % = (Price - COGS) / Price
app.get('/api/no-nut-cookie-margin', async (req, res) => {
  try {
    console.log('📊 Calculating NO NUT Cookie gross margin...');

    // Step 1: Find Chef's Warehouse vendor in QB
    console.log('  Step 1: Finding Chef\'s Warehouse vendor...');
    const vendor = await qbClient.findVendorByName("Warehouse");
    if (!vendor || !vendor.Id) {
      return res.status(400).json({ error: 'Chef\'s Warehouse vendor not found in QB' });
    }
    console.log(`  ✓ Found vendor ID: ${vendor.Id}`);

    // Step 2: Get recipe from Google Sheets
    console.log('  Step 2: Fetching recipe from Google Sheets...');
    if (!googleSheets.isConnected()) {
      return res.status(401).json({ error: 'Google Sheets not connected. Authorize at /api/google/connect first.' });
    }

    const { drive, sheets } = await googleSheets.getClients();
    const recipeFolder = await googleSheets.resolveFolderByName(drive, 'Recipe LSB');
    if (!recipeFolder) {
      return res.status(400).json({ error: 'Recipe LSB folder not found in Google Drive' });
    }

    const recipesInFolder = await googleSheets.listSheetsInFolder(drive, recipeFolder.id);
    const recipeName = 'COOKIES no nuts.xlsx';
    const recipeSheet = recipesInFolder.find(s => s.name.toLowerCase() === recipeName.toLowerCase());
    if (!recipeSheet) {
      return res.status(400).json({
        error: 'Recipe sheet not found',
        looking_for: recipeName,
        found_recipes: recipesInFolder.slice(0, 10).map(s => s.name)
      });
    }

    const recipeExcel = await googleSheets.downloadAndParseExcel(drive, recipeSheet.id, recipeSheet.name);
    console.log(`  ✓ Found recipe: ${recipeSheet.name}`);

    // Get the first sheet from tabs
    const sheetName = Object.keys(recipeExcel.tabs)[0];
    const recipeData = recipeExcel.tabs[sheetName].rows;
    console.log(`  Recipe data rows: ${recipeData.length}`);
    console.log(`  Row 5: ${JSON.stringify(recipeData[5]?.slice(0, 2))}`);
    console.log(`  Row 6: ${JSON.stringify(recipeData[6]?.slice(0, 2))}`);
    console.log(`  Row 7: ${JSON.stringify(recipeData[7]?.slice(0, 2))}`);

    // Extract ingredients from rows 8+ (Column A: name, Column B: Basic recipe qty in kg)
    const ingredients = [];
    if (recipeData && recipeData.length > 0) {
      for (let i = 8; i < recipeData.length; i++) {
        const row = recipeData[i];
        if (!row || !row[0]) break; // Stop at empty row
        const name = String(row[0]).trim();
        const qty = parseFloat(row[1]);
        if (name && !isNaN(qty) && name.toLowerCase() !== 'total brut' && name.toLowerCase() !== 'total net') {
          ingredients.push({ name, kgPerUnit: qty });
        }
      }
    }
    console.log(`  ✓ Extracted ${ingredients.length} ingredients`);
    const recipe = { name: recipeSheet.name, ingredients };

    // Step 3: Get ingredient costs from QB Chef's Warehouse bills
    console.log('  Step 3: Fetching Chef\'s Warehouse bills...');
    const sinceDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]; // 90 days ago
    const billSummaries = await qbClient.listBills(vendor.Id, sinceDate);
    console.log(`  ✓ Found ${billSummaries.length} bills`);

    // Extract ingredient prices from bills
    const ingredientPrices = {}; // ingredient name → {prices: [], unitCost: avg}
    recipe.ingredients.forEach(ing => {
      ingredientPrices[ing.name.toLowerCase()] = { prices: [] };
    });

    // Fetch PDFs from bills and extract itemized ingredient costs
    const { extractLineItemsFromPdf } = require('./pipeline/pdf-invoice-parser');
    const fetchBillsWithDetails = async () => {
      let billsProcessed = 0;
      for (const billSummary of billSummaries.slice(0, 15)) {
        try {
          const fullBill = await qbClient.getBillDetail(billSummary.Id);
          if (!fullBill) continue;

          billsProcessed++;
          console.log(`    Bill ${billSummary.DocNumber}: extracting itemized data from PDF...`);

          let lineItems = [];
          try {
            lineItems = await extractLineItemsFromPdf(fullBill.Id);
            if (lineItems && lineItems.length > 0) {
              console.log(`      ✓ Extracted ${lineItems.length} items from PDF`);
              lineItems.slice(0, 5).forEach((item, idx) => {
                console.log(`        ${idx + 1}. "${item.description.substring(0, 60)}" (${item.quantity} @ $${item.unitPrice})`);
              });
            } else {
              console.log(`      ⚠️  No items extracted from PDF`);
            }
          } catch (e) {
            console.log(`      ⚠️ PDF extraction failed: ${e.message}`);
          }

          // Match PDF line items to recipe ingredients
          if (lineItems && lineItems.length > 0) {
            for (const item of lineItems) {
              const desc = (item.description || '').toUpperCase().trim();
              const unitPrice = item.unitPrice || 0;

              // Try to match to recipe ingredients
              for (const [ingKey, data] of Object.entries(ingredientPrices)) {
                const ingUpper = ingKey.toUpperCase();
                // Split bilingual names (e.g., "BUTTER/MANTEQUILLA" → ["BUTTER", "MANTEQUILLA"])
                const ingParts = ingUpper.split(/[\/\|,]/).map(s => s.trim());

                // Match if any part of ingredient name appears in description
                let matched = false;
                for (const part of ingParts) {
                  if (part.length > 2 && desc.includes(part)) {
                    matched = true;
                    break;
                  }
                }

                if (matched && unitPrice > 0) {
                  data.prices.push(unitPrice);
                  console.log(`        ✓ Matched: ${ingKey} = $${unitPrice} (qty: ${item.quantity})`);
                  break;
                }
              }
            }
          }
        } catch (e) {
          console.log(`    Skipped bill ${billSummary.Id}: ${e.message}`);
        }
      }
      console.log(`  ✓ Bills processed: ${billsProcessed}`);
    };

    await fetchBillsWithDetails();

    // Inject known ingredient prices from master price list (since PDF extraction isn't reliable)
    console.log(`  Step 3b: Injecting ingredient prices from hardcoded price list...`);
    const pricesByKeyword = {
      'butter': 5.180867387,
      'white sugar': 2.226670664,
      'brown sugar': 2.072346955,
      'egg': 4.14469391,
      'flour': 0.9590116228,
      'oatmeal': 2.116439443,
      'baking soda': 3.865441483,
      'salt': 1.587329583,
      'chocolate chip': 11.35998871,
      'guittard cookie drop': 11.35998871,
      'bittersweet': 16.53468315,
      'choc oro': 16.53468315,
      'unsweetened': 23.36901885,
      'cacao': 23.36901885,
    };

    let injectCount = 0;
    for (const [ingKey, data] of Object.entries(ingredientPrices)) {
      const ingLower = ingKey.toLowerCase();
      console.log(`    Checking: "${ingKey}" (${ingLower})`);

      // Try keyword matching (handles "CHOCOLATE CHIPS", "CHOCOLATE BITTERSWEET", etc.)
      for (const [keyword, price] of Object.entries(pricesByKeyword)) {
        if (ingLower.includes(keyword)) {
          data.prices.push(price);
          injectCount++;
          console.log(`      ✓ Matched keyword "${keyword}" → $${price.toFixed(2)}/kg`);
          break;
        }
      }
    }
    console.log(`  ✓ Injected prices for ${injectCount}/${Object.keys(ingredientPrices).length} ingredients`);

    // Calculate COGS from matched ingredient prices
    let totalCogs = 0;
    const missingIngredients = [];

    for (const ing of recipe.ingredients) {
      const ingKey = ing.name.toLowerCase();
      const data = ingredientPrices[ingKey];

      if (data && data.prices.length > 0) {
        // Use average price for this ingredient
        const avgPrice = data.prices.reduce((a, b) => a + b, 0) / data.prices.length;
        const ingCost = ing.kgPerUnit * avgPrice;
        totalCogs += ingCost;
        console.log(`  Ingredient: ${ing.name} (${ing.kgPerUnit} kg @ $${avgPrice.toFixed(2)}/unit) = $${ingCost.toFixed(2)}`);
      } else {
        missingIngredients.push(ing.name);
      }
    }

    if (missingIngredients.length > 0) {
      console.log(`  ⚠️ Missing prices for: ${missingIngredients.join(', ')}`);
    }

    const cogs = totalCogs;

    // Step 4: Get product price (hardcoded per user confirmation)
    console.log('  Step 4: Setting product price...');
    const productPrice = 6.00; // User confirmed: $6.00
    console.log(`  ✓ Product price: $${productPrice.toFixed(2)} (NO-NUT Chocolate Chip Cookie)`)

    // Step 5: Calculate gross margin
    let grossMarginPercent = null;
    if (productPrice && cogs) {
      grossMarginPercent = ((productPrice - cogs) / productPrice) * 100;
      console.log(`  ✓ Gross Margin: ${grossMarginPercent.toFixed(2)}% (Price: $${productPrice}, COGS: $${cogs.toFixed(2)})`);
    }

    res.json({
      status: grossMarginPercent !== null ? 'complete' : 'building',
      message: grossMarginPercent !== null ? 'Gross margin calculated' : 'Calculating costs and revenue',
      product: {
        name: 'NO NUT Chocolate Chip Cookie',
        price: productPrice,
        cogs: cogs?.toFixed(2),
        grossMarginPercent: grossMarginPercent?.toFixed(2)
      },
      recipe: {
        name: recipe.name,
        ingredientCount: recipe.ingredients.length,
        ingredients: recipe.ingredients.slice(0, 3)
      },
      vendor: { id: vendor.Id, name: vendor.DisplayName },
      billsAnalyzed: Math.min(10, billSummaries.length),
      debug: {
        recipeDataRows: recipeData.length,
        ingredientPriceCounts: Object.entries(ingredientPrices).map(([k, v]) => ({ ingredient: k, pricesSampled: v.prices.length }))
      }
    });
  } catch (err) {
    console.error('❌ Error calculating margin:', err.message);
    console.error('Stack:', err.stack);
    res.status(500).json({
      error: err.message,
      code: err.code,
      status: 'error',
      details: err.response?.data || err.message
    });
  }
});

// Calculate gross margins for DOUGH Country products (RND, PC, Baguette)
app.get('/api/dough-country-margin', async (req, res) => {
  try {
    console.log('📊 Calculating DOUGH Country gross margins...');

    // Step 1: Find Chef's Warehouse vendor
    console.log('  Step 1: Finding Chef\'s Warehouse vendor...');
    const vendor = await qbClient.findVendorByName("Warehouse");
    if (!vendor || !vendor.Id) {
      return res.status(400).json({ error: 'Chef\'s Warehouse vendor not found in QB' });
    }
    console.log(`  ✓ Found vendor ID: ${vendor.Id}`);

    // Step 2: Get recipe from Google Sheets
    console.log('  Step 2: Fetching DOUGH Levain recipe...');
    if (!googleSheets.isConnected()) {
      return res.status(401).json({ error: 'Google Sheets not connected. Authorize at /api/google/connect first.' });
    }

    const { drive } = await googleSheets.getClients();
    const recipeFolder = await googleSheets.resolveFolderByName(drive, 'Recipe LSB');
    if (!recipeFolder) {
      return res.status(400).json({ error: 'Recipe LSB folder not found' });
    }

    const recipesInFolder = await googleSheets.listSheetsInFolder(drive, recipeFolder.id);
    const recipeFile = recipesInFolder.find(s => s.name.toLowerCase() === 'dough levain.xlsx');
    if (!recipeFile) {
      return res.status(400).json({ error: 'DOUGH Levain.xlsx not found', found_recipes: recipesInFolder.slice(0, 5).map(s => s.name) });
    }

    const recipeExcel = await googleSheets.downloadAndParseExcel(drive, recipeFile.id, recipeFile.name);
    const sheetName = Object.keys(recipeExcel.tabs)[0];
    const recipeData = recipeExcel.tabs[sheetName].rows;
    console.log(`  ✓ Found recipe: ${recipeFile.name}`);

    // Extract ingredients from rows 8+ (same as NO NUT cookie)
    const ingredients = [];
    if (recipeData && recipeData.length > 0) {
      for (let i = 8; i < recipeData.length; i++) {
        const row = recipeData[i];
        if (!row || !row[0]) break;
        const name = String(row[0]).trim();
        const qty = parseFloat(row[1]);
        if (name && !isNaN(qty) && name.toLowerCase() !== 'total brut' && name.toLowerCase() !== 'total net') {
          ingredients.push({ name, kgPerUnit: qty });
        }
      }
    }
    console.log(`  ✓ Extracted ${ingredients.length} ingredients`);

    // Step 3: Get ingredient costs
    console.log('  Step 3: Fetching Chef\'s Warehouse bills...');
    const sinceDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const billSummaries = await qbClient.listBills(vendor.Id, sinceDate);
    console.log(`  ✓ Found ${billSummaries.length} bills`);

    const ingredientPrices = {};
    ingredients.forEach(ing => {
      ingredientPrices[ing.name.toLowerCase()] = { prices: [] };
    });

    // Inject prices (same as NO NUT cookie)
    console.log(`  Step 3b: Injecting ingredient prices...`);
    const pricesByKeyword = {
      'butter': 5.180867387,
      'white sugar': 2.226670664,
      'brown sugar': 2.072346955,
      'egg': 4.14469391,
      'flour': 0.9590116228,
      'oatmeal': 2.116439443,
      'baking soda': 3.865441483,
      'salt': 1.587329583,
      'chocolate chip': 11.35998871,
      'bittersweet': 16.53468315,
      'unsweetened': 23.36901885,
      'cacao': 23.36901885,
    };

    let injectCount = 0;
    for (const [ingKey, data] of Object.entries(ingredientPrices)) {
      const ingLower = ingKey.toLowerCase();
      for (const [keyword, price] of Object.entries(pricesByKeyword)) {
        if (ingLower.includes(keyword)) {
          data.prices.push(price);
          injectCount++;
          console.log(`    ✓ ${ingKey}: $${price.toFixed(2)}/kg`);
          break;
        }
      }
    }
    console.log(`  ✓ Injected prices for ${injectCount}/${ingredients.length} ingredients`);

    // Calculate COGS per kg of dough
    let totalCogsPerKg = 0;
    const missingIngredients = [];

    for (const ing of ingredients) {
      const ingKey = ing.name.toLowerCase();
      const data = ingredientPrices[ingKey];

      if (data && data.prices.length > 0) {
        const avgPrice = data.prices.reduce((a, b) => a + b, 0) / data.prices.length;
        const ingCost = ing.kgPerUnit * avgPrice;
        totalCogsPerKg += ingCost;
      } else {
        missingIngredients.push(ing.name);
      }
    }

    if (missingIngredients.length > 0) {
      console.log(`  ⚠️ Missing prices for: ${missingIngredients.join(', ')}`);
    }

    // DOUGH Country products with prices and weights
    const products = [
      { name: 'Country RND', weight: 1.0, price: 11.00 },    // 1 kg
      { name: 'Country PC', weight: 0.45, price: 6.00 },      // 450 g = 0.45 kg
      { name: 'Baguette', weight: 0.75, price: 10.00 }        // 750 g = 0.75 kg
    ];

    const results = [];
    for (const product of products) {
      const cogs = product.weight * totalCogsPerKg;
      const grossMarginPercent = ((product.price - cogs) / product.price) * 100;
      results.push({
        name: product.name,
        weight: `${product.weight} kg`,
        price: product.price,
        cogs: parseFloat(cogs.toFixed(2)),
        grossMarginPercent: parseFloat(grossMarginPercent.toFixed(2))
      });
      console.log(`  ${product.name}: $${product.price} - $${cogs.toFixed(2)} COGS = ${grossMarginPercent.toFixed(2)}% margin`);
    }

    res.json({
      status: 'complete',
      message: 'DOUGH Country margins calculated',
      recipe: {
        name: recipeFile.name,
        costsPerKg: parseFloat(totalCogsPerKg.toFixed(2))
      },
      products: results,
      vendor: { id: vendor.Id, name: vendor.DisplayName }
    });
  } catch (err) {
    console.error('❌ Error calculating DOUGH Country margins:', err.message);
    res.status(500).json({
      error: err.message,
      code: err.code,
      status: 'error'
    });
  }
});

// Debug: List all Square products
app.get('/api/debug/square-products', async (req, res) => {
  try {
    if (!process.env.SQUARE_ACCESS_TOKEN) {
      return res.status(400).json({ error: 'SQUARE_ACCESS_TOKEN not configured' });
    }

    console.log('Fetching all Square products...');
    const squareRes = await axios.post('https://connect.squareup.com/v2/catalog/list',
      { types: ['ITEM'], limit: 100 },
      { headers: { Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}` } }
    );

    const items = squareRes.data.objects || [];
    const products = items.map(item => ({
      id: item.id,
      name: item.item_data?.name,
      price: item.item_data?.variations?.[0]?.item_variation_data?.price_money?.amount ?
        (item.item_data.variations[0].item_variation_data.price_money.amount / 100).toFixed(2) :
        null
    }));

    res.json({
      totalProducts: products.length,
      products: products.slice(0, 20)
    });
  } catch (e) {
    res.status(500).json({
      error: e.message,
      status: 'Square API failed',
      details: e.response?.data
    });
  }
});

// Debug: Get recipe details
app.get('/api/debug/recipe/:name', async (req, res) => {
  try {
    const { pullRecipes } = require('./pipeline/recipes');
    const recipeData = await pullRecipes('Recipe LSB', {});
    const recipe = recipeData.recipes.find(r => r.recipe.toLowerCase() === req.params.name.toLowerCase());
    if (!recipe) {
      return res.status(404).json({ error: `Recipe "${req.params.name}" not found` });
    }
    res.json(recipe);
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code });
  }
});

// Debug: List Chef's Warehouse bills
app.get('/api/debug/bills', async (req, res) => {
  try {
    const vendor = await qbClient.findVendorByName('Warehouse');
    if (!vendor) {
      return res.status(400).json({ error: 'Chef\'s Warehouse vendor not found' });
    }

    const sinceDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const bills = await qbClient.listBills(vendor.Id, sinceDate);

    res.json({
      vendor: { id: vendor.Id, name: vendor.DisplayName },
      billCount: bills.length,
      bills: bills.slice(0, 20).map(b => ({
        id: b.Id,
        docNumber: b.DocNumber,
        txnDate: b.TxnDate
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code });
  }
});

// Debug: Extract and show PDF data from a single bill
app.get('/api/debug/bill-pdf/:billId', async (req, res) => {
  try {
    const { extractLineItemsFromPdf } = require('./pipeline/pdf-invoice-parser');
    const billId = req.params.billId;

    console.log(`\n🔍 DEBUG: Extracting PDF for bill ${billId}...`);
    const lineItems = await extractLineItemsFromPdf(billId);

    if (!lineItems) {
      return res.json({ status: 'no_pdf', billId, message: 'No PDF found or extraction failed' });
    }

    res.json({
      billId,
      itemsFound: lineItems.length,
      items: lineItems.map(item => ({
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPrice
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message, billId: req.params.billId });
  }
});

// ============= HEALTH CHECK =============

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile('index.html', { root: __dirname });
});

// Serve overtime report
app.get('/overtime', (req, res) => {
  res.sendFile('overtime.html', { root: __dirname });
});

// ============= LEGAL PAGES (required by Intuit's app settings) =============

app.get('/privacy', (req, res) => {
  res.type('html').send(`<!DOCTYPE html><html><head><title>Privacy Policy</title></head><body style="font-family: sans-serif; max-width: 700px; margin: 40px auto; line-height: 1.6;">
<h1>Privacy Policy</h1>
<p>This dashboard displays financial data for one bakery business. It connects to that business's own QuickBooks Online account via OAuth 2.0 to read Profit &amp; Loss, account, and expense data.</p>
<p>The resulting financial summaries are viewable by anyone with the dashboard link, at the business owner's discretion (e.g. staff, partners, investors). The underlying QuickBooks data is not sold to or shared with any third party, and is not used for any purpose beyond display within this dashboard.</p>
<p>Access tokens are stored on the operator's own server and used only to make authorized API requests to QuickBooks on the business's behalf. Revoking access at any time (via QuickBooks or this app) immediately stops all data access.</p>
</body></html>`);
});

// Intuit sends users here when they disconnect the app from within QuickBooks
app.get('/disconnected', (req, res) => {
  qbClient.disconnect();
  res.type('html').send(`<!DOCTYPE html><html><head><title>Disconnected</title></head><body style="font-family: sans-serif; max-width: 700px; margin: 40px auto; line-height: 1.6;">
<h1>QuickBooks disconnected</h1>
<p>This dashboard no longer has access to your QuickBooks data. <a href="/api/quickbooks/connect">Reconnect</a> at any time.</p>
</body></html>`);
});

app.get('/eula', (req, res) => {
  res.type('html').send(`<!DOCTYPE html><html><head><title>End User License Agreement</title></head><body style="font-family: sans-serif; max-width: 700px; margin: 40px auto; line-height: 1.6;">
<h1>End User License Agreement</h1>
<p>This application is an internal financial dashboard built for one bakery business. The business owner may share view access with staff, partners, or other parties at their discretion via the dashboard link.</p>
<p>The application connects to a single QuickBooks Online account belonging to that business. It is not licensed or distributed as a general-purpose product for unrelated businesses to connect their own accounts. No warranty is provided; the application is used at the operator's own discretion.</p>
</body></html>`);
});

// ============= SQUARE MARKET PERFORMANCE CACHE WARMER =============
// Pre-warms market performance cache on startup and daily at 1 AM UTC, so deployments don't stall.

const refreshSquareMarketCache = async () => {
  try {
    const token = process.env.SQUARE_ACCESS_TOKEN;
    if (!token || token === 'your_square_token_here') {
      console.log(`⏸️  Square market cache refresh skipped: Square API not configured`);
      return;
    }

    const startDow = await fetchWorkweekStartDow();
    const todayStr = new Date().toISOString().slice(0, 10);
    const currentWeekStart = getWeekStart(todayStr, startDow);
    const oneYearAgo = addDays(currentWeekStart, -52 * 7);

    await getMarketWeeklyRevenue(oneYearAgo, currentWeekStart, startDow);
    console.log(`✅ Square market performance cache warmed (${oneYearAgo} to ${currentWeekStart})`);
  } catch (err) {
    console.error(`❌ Square cache refresh failed:`, err.message);
  }
};

// ============= QUICKBOOKS AUTO-REFRESH SCHEDULER =============
// Refreshes all QB data weekly (every Sunday at 12:05 AM UTC), so all users see cached data
// without needing to sign in individually. Runs once on startup with a brief delay, then on schedule.

const refreshQBWeeklyData = async () => {
  try {
    // Refresh persistent QB cache (P&L, accounts, expenses)
    await qbCache.refreshAllQBData();

    // Also refresh the weekly P&L snapshot
    const today = new Date().toISOString().slice(0, 10);
    const currentWeekStart = getWeekStart(today, 0); // Sunday-based weeks
    const twoWeeksAgo = addDays(currentWeekStart, -14);
    await getQBWeeklyRows(twoWeeksAgo, currentWeekStart);

    console.log(`✅ QB cache + weekly snapshot refreshed (${twoWeeksAgo} to ${currentWeekStart})`);
  } catch (err) {
    if (err.code === 'QB_NOT_CONNECTED') {
      console.log(`⏸️  QB cache refresh skipped: QuickBooks not connected. Click "Connect QuickBooks" in the dashboard to authorize.`);
    } else {
      console.error(`❌ QB cache refresh failed:`, err.message);
    }
  }
};

// Run on startup (after a brief delay so DB is ready) - non-blocking
setTimeout(() => {
  try {
    qbCache.warmupCacheOnStartup?.();
  } catch (e) {
    console.log('QB cache startup skipped:', e.message);
  }
}, 500);

setTimeout(() => {
  try {
    refreshQBWeeklyData?.();
  } catch (e) {
    console.log('QB refresh skipped:', e.message);
  }
}, 1000);

setTimeout(() => {
  try {
    refreshSquareMarketCache?.();
  } catch (e) {
    console.log('Square cache skipped:', e.message);
  }
}, 1500);

setTimeout(() => initMargins?.().catch(e => console.log('Margins init: ' + e.message)), 2000);

// Schedule: Square cache refresh daily at 1 AM UTC
cron.schedule('0 1 * * *', refreshSquareMarketCache, {
  runOnInit: false,
  timezone: 'UTC',
});
console.log(`📅 Square market cache warmed daily at 01:00 UTC`);

// Schedule: every Sunday at 12:05 AM UTC to refresh all QB data + weekly snapshot
// '5 0 * * 0' = 00:05 every Sunday
cron.schedule('5 0 * * 0', refreshQBWeeklyData, {
  runOnInit: false, // Already runs on startup above
  timezone: 'UTC',
});
console.log(`📅 QB data auto-refresh scheduled: Sundays at 00:05 UTC (weekly - P&L, accounts, expenses)`);


// ============= INTEGRATIONS STATUS (Google + QuickBooks health) =============

app.get('/api/integrations/status', (req, res) => {
  const composioStatus = composioConnectors.getConnectionStatus();
  const googleConnected = googleSheets.isConnected();

  // Check for legacy QB tokens (for backward compatibility)
  const qbTokens = qbClient.loadTokens();

  res.json({
    composio: process.env.COMPOSIO_API_KEY ? 'configured' : 'not_configured',
    connections: {
      square: composioStatus.square || false,
      quickbooks: composioStatus.quickbooks || (qbTokens && qbTokens.refresh_token),
    },
    google: googleConnected ? 'ok' : 'disconnected',
    legacy: {
      quickbooks: (qbTokens && qbTokens.refresh_token) ? 'connected' : 'disconnected',
    },
  });
});

// ============= PRODUCT MARGINS ENDPOINTS =============

const matcher = require('./pipeline/matcher');

// On-disk cache for Square sales data (persists across server restarts)
const SQUARE_SALES_CACHE_FILE = path.join(DATA_DIR, 'pipeline', 'square-sales-cache.json');

const loadSquareSalesCache = () => {
  try {
    return JSON.parse(fs.readFileSync(SQUARE_SALES_CACHE_FILE, 'utf-8'));
  } catch {
    return null;
  }
};

const saveSquareSalesCache = (data) => {
  const dir = path.dirname(SQUARE_SALES_CACHE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SQUARE_SALES_CACHE_FILE, JSON.stringify(data, null, 2));
};

// Fetch Square order data once for 1 year, cache on disk with timestamp, slice into 5 windows on each request
const fetchSquareSalesData = async () => {
  const cached = loadSquareSalesCache();
  const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

  if (cached && cached.fetchedAt && Date.now() - new Date(cached.fetchedAt).getTime() < MAX_CACHE_AGE_MS) {
    return cached;
  }

  console.log('Fetching 30-day Square sales data...');
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const allOrders = [];

  // Fetch all locations in parallel (not sequentially)
  const locationFetches = WASTE_LOCATIONS.map(async (location) => {
    let cursor = null;
    let page = 0;
    const MAX_PAGES = 5; // Further reduced to ensure fast completion
    const locationOrders = [];

    try {
      while (page < MAX_PAGES) {
        const req = {
          location_ids: [location.squareLocationId],
          limit: 250,
          sort_order: 'DESC',
          query: {
            filter: {
              state_filter: {
                states: ['COMPLETED'],
              },
              date_time_filter: {
                closed_at: {
                  start_at: new Date(`${thirtyDaysAgo}T00:00:00Z`).toISOString(),
                  end_at: new Date().toISOString(),
                },
              },
            },
          },
        };
        if (cursor) req.query.cursor = cursor;

        let res;
        try {
          res = await axios.post(`https://connect.squareup.com/v2/orders/search`, req, {
            headers: {
              Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
            timeout: 10000, // 10s timeout per request
          });
        } catch (apiErr) {
          console.error(`Square API error for location ${location.name}:`, {
            status: apiErr.response?.status,
            errors: apiErr.response?.data?.errors,
            message: apiErr.message,
          });
          return locationOrders; // Return partial data for this location
        }

        for (const order of (res.data.orders || [])) {
          if (order.state !== 'COMPLETED') continue;
          for (const lineItem of (order.line_items || [])) {
            locationOrders.push({
              orderId: order.id,
              closedAt: order.closed_at,
              locationId: order.location_id,
              itemName: lineItem.name,
              qty: lineItem.quantity,
              totalMoney: lineItem.gross_sales_money?.amount || 0,
            });
          }
        }

        cursor = res.data.cursor;
        if (!cursor) break;
        page += 1;
      }
    } catch (e) {
      console.error(`Failed to fetch orders for location ${location.name}:`, e.message);
    }

    return locationOrders;
  });

  // Wait for all location fetches to complete (max 30 seconds)
  try {
    const allLocationOrders = await Promise.race([
      Promise.all(locationFetches),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Square data fetch timeout')), 30000)),
    ]);
    for (const orders of allLocationOrders) {
      allOrders.push(...orders);
    }
  } catch (e) {
    console.error('Error fetching all locations:', e.message);
    // Continue with partial data rather than failing completely
  }

  const cached_data = {
    fetchedAt: new Date().toISOString(),
    orders: allOrders,
  };
  saveSquareSalesCache(cached_data);
  return cached_data;
};

// Bucket orders by item name and date window, compute revenue and qty
const bucketOrdersByItem = (orders, windowDays) => {
  const cutoffDate = new Date(Date.now() - windowDays * 86400_000);
  const byItem = {};

  for (const order of orders) {
    const orderDate = new Date(order.closedAt);
    if (orderDate < cutoffDate) continue;

    const item = order.itemName;
    if (!byItem[item]) byItem[item] = { revenue: 0, qty: 0, avgPrice: 0 };
    byItem[item].revenue += order.totalMoney / 100; // cents to dollars
    byItem[item].qty += parseFloat(order.qty) || 0;
  }

  for (const item of Object.values(byItem)) {
    item.avgPrice = item.qty > 0 ? item.revenue / item.qty : 0;
  }

  return byItem;
};

// Top 20 sellers by revenue
const rankProductsByRevenue = (sales, n = 20) => {
  return Object.entries(sales)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, n)
    .map(([name, data]) => ({ name, ...data }));
};

// Match recipe to Square item name
// Normalize quote characters for consistent matching (handles curly, straight, and other variants)
const normalizeQuotes = (str) => {
  return str
    .replace(/[“”]/g, '"')    // Curly double quotes → straight
    .replace(/[‘’]/g, "'")   // Curly single quotes → straight
    .replace(/[«»]/g, '"')   // Guillemets → straight
    .replace(/[‟]/g, '"');        // Double high-reversed → straight
};

const matchRecipeToSquareItem = (recipeName, squareItemName) => {
  const recipeToks = matcher.tokenize(recipeName);
  const squareToks = matcher.tokenize(squareItemName);

  if (!recipeToks.length || !squareToks.length) return false;
  const overlap = recipeToks.filter((t) => squareToks.includes(t));
  // Lowered to 50% to allow fuzzy matches like "Country Round" -> "Country dough"
  return overlap.length / recipeToks.length >= 0.5;
};

// Simple recipe costs endpoint (raw data)
app.get('/api/recipe-costs', (req, res) => {
  try {
    const recipeCostsFile = path.join(DATA_DIR, 'pipeline', 'recipe-costs.json');
    if (!fs.existsSync(recipeCostsFile)) {
      return res.status(503).json({ error: 'Recipe costs not available. Run: npm run margins' });
    }
    const data = JSON.parse(fs.readFileSync(recipeCostsFile, 'utf-8'));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Debug endpoint to check ingredient overrides are loaded
app.get('/api/debug/overrides', (req, res) => {
  try {
    const overridesFile = path.join(DATA_DIR, 'pipeline', 'ingredient-overrides.json');
    if (!fs.existsSync(overridesFile)) {
      return res.json({ error: 'File not found', path: overridesFile });
    }
    const data = JSON.parse(fs.readFileSync(overridesFile, 'utf-8'));

    // Build overrides object like the main endpoint does (with lowercase keys)
    const overrides = {};
    for (const mapping of data.mappings || []) {
      const key = normalizeQuotes(mapping.squareItem).toLowerCase();
      overrides[key] = mapping.recipe;
    }

    res.json({
      count: data.mappings.length,
      rawMappings: data.mappings.slice(0, 3),
      overrideKeys: Object.keys(overrides),
      sampleLookup: {
        "country round": overrides["country round"],
        "breakfast bar": overrides["breakfast bar"]
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Main product margins endpoint - uses LIVE data from QB, Google Sheets, and Square
app.get('/api/product-margins', async (req, res) => {
  try {
    // Clear any caching - force fresh calculation every time
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');

    console.log('📊 Calculating LIVE product margins from QB + Google Sheets + Square...');
    const startTime = Date.now();

    // Step 1: Fetch live Square orders for all time windows, no caching
    console.log('  Step 1: Fetching LIVE Square orders for each time window...');
    const windows = [
      { name: '1 week', days: 7 },
      { name: '2 weeks', days: 14 },
      { name: '2 months', days: 60 },
      { name: '6 months', days: 180 },
      { name: '1 year', days: 365 },
      { name: '3 years', days: 1095 },
      { name: '5 years', days: 1825 },
    ];

    let windowsData = {};
    let squareFetchedAt = null;

    try {
      if (!process.env.SQUARE_ACCESS_TOKEN) {
        throw new Error('SQUARE_ACCESS_TOKEN not configured');
      }

      for (const window of windows) {
        const beginTime = new Date(Date.now() - window.days * 24 * 60 * 60 * 1000).toISOString();
        const endTime = new Date().toISOString();
        const windowOrders = [];

        // Fetch from all locations for this time window
        for (const location of WASTE_LOCATIONS) {
          let cursor = null;
          let page = 0;
          const MAX_PAGES = 100;

          try {
            while (page < MAX_PAGES) {
              const req = {
                location_ids: [location.squareLocationId],
                limit: 250,
                sort_order: 'DESC',
                query: {
                  filter: {
                    state_filter: { states: ['COMPLETED'] },
                    date_time_filter: {
                      closed_at: {
                        start_at: beginTime,
                        end_at: endTime,
                      },
                    },
                  },
                },
              };
              if (cursor) req.query.cursor = cursor;

              const res = await axios.post(`https://connect.squareup.com/v2/orders/search`, req, {
                headers: {
                  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
                  'Content-Type': 'application/json',
                },
                timeout: 10000,
              });

              const orders = res.data.orders || [];
              for (const order of orders) {
                for (const line of order.line_items || []) {
                  windowOrders.push({
                    itemName: line.name || 'Unknown',
                    quantity: line.quantity ? parseInt(line.quantity) : 1,
                    grossSales: Math.round((line.gross_sales_money?.amount || 0) / 100 * 100) / 100,
                  });
                }
              }

              cursor = res.data.cursor;
              page++;
              if (!cursor) break;
            }
          } catch (e) {
            if (e.response?.status !== 429) {
              console.warn(`    ⚠️  Location ${location.name}: ${e.message}`);
            }
          }
        }

        // Aggregate this window's data by item name
        const itemMap = {};
        for (const order of windowOrders) {
          if (!itemMap[order.itemName]) {
            itemMap[order.itemName] = { quantity: 0, revenue: 0 };
          }
          itemMap[order.itemName].quantity += order.quantity;
          itemMap[order.itemName].revenue += order.grossSales;
        }

        windowsData[window.name] = itemMap;
        console.log(`    ✓ ${window.name}: ${windowOrders.length} line items, ${Object.keys(itemMap).length} unique items`);
      }

      squareFetchedAt = new Date().toISOString();
    } catch (e) {
      console.error('❌ Square fetch error:', e.message);
      return res.status(500).json({ error: 'Failed to fetch Square data', details: e.message });
    }

    // Step 2: Calculate costs using live QB + Google Sheets pipeline (for latest data only)
    console.log('  Step 2: Calculating costs from QB bills + Google Sheets recipes...');
    let productCostMap = {};

    try {
      const { main: calculateMargins } = require('./pipeline/calculate-margins');
      // Pass current 1-year data to calculate margins
      const currentYearData = Object.entries(windowsData['1 year'] || {}).map(([name, data]) => ({
        product: name,
        units: data.quantity,
        price: data.quantity > 0 ? data.revenue / data.quantity : 0,
      }));

      const result = await calculateMargins({ squareSalesData: currentYearData });
      const marginProducts = result.products || [];

      for (const p of marginProducts) {
        const productKey = (p.product || p.recipe || '').toLowerCase();
        productCostMap[productKey] = p.cost_per_unit || p.costPerUnit || 0;
      }

      console.log(`    ✓ Calculated costs for ${marginProducts.length} products`);
    } catch (e) {
      console.warn(`    ⚠️  Cost calculation failed: ${e.message}`);
    }

    // Step 3: Transform results into time-window format for UI
    console.log('  Step 3: Formatting results by time window...');

    const result = {};

    for (const windowName in windowsData) {
      const windowItems = windowsData[windowName];

      // Convert item sales to product list with margins
      const productList = Object.entries(windowItems).map(([name, data]) => {
        const cost = productCostMap[(name || '').toLowerCase()] || 0;
        const revenue = data.revenue;
        const marginPerUnit = cost;

        return {
          name: name,
          revenue: Math.round(revenue * 100) / 100,
          quantity: Math.round(data.quantity * 100) / 100,
          avgPrice: data.quantity > 0 ? Math.round((revenue / data.quantity) * 100) / 100 : 0,
          cogs: Math.round(cost * 100) / 100,
          margin$: Math.round(marginPerUnit * 100) / 100,
          marginPct: revenue > 0 ? Math.round(((revenue - (data.quantity * cost)) / revenue * 100) * 10) / 10 : 0,
          status: (revenue - (data.quantity * cost)) < 0 ? 'error-negative-margin' : (cost > 0 ? 'costed' : 'needs-cost'),
        };
      });

      // Rank by revenue and get top 20
      const ranked = productList
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 20);

      result[windowName] = {
        fetchedAt: squareFetchedAt,
        top20: ranked,
      };
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ Margin calculation complete in ${elapsed}s`);

    res.json({
      generatedAt: new Date().toISOString(),
      dataSource: 'LIVE (QB + Google Sheets + Square)',
      squareFetchedAt: squareFetchedAt,
      calculationMs: Date.now() - startTime,
      windows: result,
      coverage: marginCoverage,
      summary: marginSummary,
    });
  } catch (e) {
    console.error('❌ Product margins error:', e.message, e.stack);
    res.status(500).json({ error: e.message, dataSource: 'LIVE' });
  }
});

// Rebuild product margins from Google Sheets + QB invoices
// GET /api/rebuild-margins (returns immediately, build runs in background)
// GET /api/rebuild-margins/status (check build status)
const REBUILD_STATUS_FILE = path.join(DATA_DIR, 'rebuild-margins-status.json');
const saveRebuildStatus = (status) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(REBUILD_STATUS_FILE, JSON.stringify(status, null, 2));
};
const getRebuildStatus = () => {
  try {
    if (fs.existsSync(REBUILD_STATUS_FILE)) {
      return JSON.parse(fs.readFileSync(REBUILD_STATUS_FILE, 'utf-8'));
    }
  } catch {}
  return { status: 'idle' };
};

// Bakery margin analysis - in-memory cache to prevent 504 timeouts
let marginsCacheData = null;
let marginsCacheTime = 0;
const MARGINS_CACHE_TTL = 1 * 60 * 60 * 1000; // 1 hour

// Bakery margin analysis endpoint - LIVE data from Square Orders with caching
// Debug endpoint to see raw Square data vs QB
app.get('/api/bakery-margins-debug', async (req, res) => {
  try {
    if (!process.env.SQUARE_ACCESS_TOKEN) {
      return res.status(500).json({ error: 'SQUARE_ACCESS_TOKEN not configured' });
    }

    // Fetch just 1 location, 1 week, limited to 3 pages to see actual data structure
    const location = WASTE_LOCATIONS[0]; // ARC store
    const beginTime = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const endTime = new Date().toISOString();

    let cursor = null;
    let page = 0;
    const allLines = [];
    const MAX_PAGES = 3;

    while (page < MAX_PAGES) {
      const response = await axios.post(`https://connect.squareup.com/v2/orders/search`, {
        location_ids: [location.squareLocationId],
        limit: 100,
        sort_order: 'DESC',
        query: {
          filter: {
            state_filter: { states: ['COMPLETED'] },
            date_time_filter: {
              closed_at: { start_at: beginTime, end_at: endTime },
            },
          },
        },
        ...(cursor && { query: { cursor } }),
      }, {
        headers: {
          Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      });

      const orders = response.data.orders || [];
      for (const order of orders) {
        for (const line of order.line_items || []) {
          allLines.push({
            itemName: line.name,
            qty: line.quantity,
            gross_sales_money: line.gross_sales_money?.amount || 0,
            total_money: line.total_money?.amount || 0,
            net_sales_money: line.net_sales_money?.amount || 0,
            total_discount_money: line.total_discount_money?.amount || 0,
            total_tax_money: line.total_tax_money?.amount || 0,
            return_quantity: line.return_quantity || 0,
          });
        }
      }

      cursor = response.data.cursor;
      page++;
      if (!cursor) break;
    }

    const grossSum = allLines.reduce((sum, l) => sum + l.gross_sales_money, 0) / 100;
    const totalSum = allLines.reduce((sum, l) => sum + l.total_money, 0) / 100;
    const netSum = allLines.reduce((sum, l) => sum + l.net_sales_money, 0) / 100;

    res.json({
      location: location.name,
      period: 'Last 7 days',
      ordersProcessed: allLines.length,
      sums: {
        using_gross_sales_money: Math.round(grossSum * 100) / 100,
        using_total_money: Math.round(totalSum * 100) / 100,
        using_net_sales_money: Math.round(netSum * 100) / 100,
      },
      samples: allLines.slice(0, 5),
      note: 'Compare these sums to your Square dashboard for 1 week at ' + location.name,
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

app.get('/api/rebuild-margins', async (req, res) => {
  try {
    const sheetsOAuth = require('./pipeline/sheets-oauth');
    const qbClient = require('./pipeline/qb-client');

    // Check if Google is connected
    if (!sheetsOAuth.isConnected()) {
      return res.status(400).json({
        error: 'Google not authenticated',
        message: 'Visit /api/google/connect to authorize access to recipe sheets',
        status: 'google_not_connected',
      });
    }

    // Check if QB is connected
    let qbConnected = false;
    try {
      const tokens = qbClient.loadTokens();
      qbConnected = !!(tokens && tokens.refresh_token);
    } catch {}

    if (!qbConnected) {
      return res.status(400).json({
        error: 'QuickBooks not authenticated',
        message: 'Visit /api/quickbooks/connect to authorize access to vendor invoices',
        status: 'qb_not_connected',
      });
    }

    // Check if already building
    const currentStatus = getRebuildStatus();
    if (currentStatus.status === 'building') {
      return res.json({
        status: 'already_building',
        message: 'Build already in progress',
        startedAt: currentStatus.startedAt,
      });
    }

    // Start build in background
    saveRebuildStatus({ status: 'building', startedAt: new Date().toISOString() });
    res.json({
      status: 'building_started',
      message: 'Product margins rebuild started. Check /api/rebuild-margins/status for progress.',
      checkUrl: '/api/rebuild-margins/status',
    });

    // Run build in background (don't await)
    (async () => {
      try {
        const buildMargins = require('./pipeline/build-margins');
        console.log('🔄 Rebuilding product margins from Google Sheets + QB…');
        const result = await buildMargins.main({ weeks: 12 });
        saveRebuildStatus({
          status: 'complete',
          completedAt: new Date().toISOString(),
          recipeCount: result.recipeCosts.recipeCount,
          costed: result.coverage.costed.length,
          needsAttention: result.coverage.needsAttention.length,
        });
        console.log('✅ Product margins rebuild complete');
      } catch (err) {
        console.error('Rebuild margins error:', err.message);
        saveRebuildStatus({
          status: 'error',
          error: err.message,
          code: err.code,
          failedAt: new Date().toISOString(),
        });
      }
    })();
  } catch (err) {
    console.error('Rebuild margins startup error:', err.message);
    res.status(500).json({
      error: 'Rebuild startup failed',
      message: err.message,
    });
  }
});

app.get('/api/rebuild-margins/status', (req, res) => {
  const status = getRebuildStatus();
  res.json(status);
});

// Calculate margins from Google Sheets ingredient costs + recipes
app.get('/api/calculate-margins', async (req, res) => {
  try {
    const sheetsOAuth = require('./pipeline/sheets-oauth');
    const calculateMargins = require('./pipeline/calculate-margins');

    // Check if Google is connected
    if (!sheetsOAuth.isConnected()) {
      return res.status(400).json({
        error: 'Google not authenticated',
        message: 'Visit /api/google/connect to authorize access to Recipe LSB folder',
        status: 'google_not_connected',
      });
    }

    // Load Square sales data from analysis.json
    const analysisPath = path.join(__dirname, 'analysis.json');
    let squareSalesData = [];
    if (fs.existsSync(analysisPath)) {
      try {
        const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf-8'));
        squareSalesData = (analysis.products || []).map(p => ({
          product: p.product,
          units: p.units,
          price: p.sale_price,
        }));
      } catch (e) {
        console.warn('Failed to load sales data from analysis.json:', e.message);
      }
    }

    if (squareSalesData.length === 0) {
      return res.status(400).json({
        error: 'No sales data available',
        message: 'Analysis.json not found or empty. Cannot calculate margins without Square sales data.',
        status: 'no_sales_data',
      });
    }

    // Calculate margins in background, return immediately
    res.json({
      status: 'calculating',
      message: 'Margin calculation started. Check /api/calculate-margins/status for progress.',
      productsCount: squareSalesData.length,
    });

    // Run calculation in background
    (async () => {
      try {
        console.log(`🔄 Starting margin calculation with ${squareSalesData.length} products…`);
        const result = await calculateMargins.main({ squareSalesData });

        // Save result to analysis.json for dashboard consumption
        fs.writeFileSync(analysisPath, JSON.stringify(result, null, 2));
        console.log('✅ Margins calculation and analysis.json update complete');
      } catch (err) {
        console.error('Margin calculation error:', err.message);
        if (err.code === 'GOOGLE_NOT_CONNECTED') {
          console.error('  → Google OAuth failed. Visit /api/google/connect to re-authorize');
        }
      }
    })();
  } catch (err) {
    console.error('Calculate margins startup error:', err.message);
    res.status(500).json({
      error: 'Calculation startup failed',
      message: err.message,
    });
  }
});

// Margin scheduler status
app.get('/api/margin-scheduler/status', (req, res) => {
  if (!marginScheduler) {
    return res.status(503).json({
      error: 'Scheduler not initialized',
      message: 'Margin scheduler is still starting up',
    });
  }
  const status = marginScheduler.getStatus();
  res.json({
    scheduler: 'margin-calculator',
    schedule: 'Daily at 6 AM UTC, plus immediate run on startup',
    status,
  });
});

// Extract and display ingredient costs from QB bills
app.get('/api/ingredient-costs', (req, res) => {
  try {
    const cacheFile = path.join(__dirname, 'ingredient-costs-cache.json');

    if (!fs.existsSync(cacheFile)) {
      return res.status(202).json({
        status: 'extracting',
        message: 'Ingredient costs are being extracted in the background. Check /api/ingredient-costs/status for progress.',
        cacheFile,
      });
    }

    // Read cached result instantly (no processing needed)
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));

    res.json({
      status: 'success',
      generatedAt: cached.generatedAt,
      billsProcessed: cached.billsProcessed,
      ingredientsExtracted: cached.ingredientsExtracted,
      ingredients: cached.ingredients,
      note: 'Sorted alphabetically. Shows most recent purchase price per ingredient. From QB bill PDFs.',
      source: 'cached (updated on startup and when manually triggered)',
    });
  } catch (err) {
    console.error('Ingredient cost cache read error:', err.message);
    res.status(500).json({
      error: 'Failed to read ingredient costs cache',
      message: err.message,
      code: err.code,
    });
  }
});

// Ingredient extraction status - check background job progress
// Debug endpoint: show raw extracted PDF text from a real bill
app.get('/api/debug/raw-pdf-text/:billId', async (req, res) => {
  try {
    const billId = req.params.billId;
    const startLine = parseInt(req.query.start || '0', 10);
    const count = parseInt(req.query.count || '50', 10);

    // Download and extract from the actual PDF
    const pdfBuffer = await qbClient.downloadInvoicePdf(billId);
    if (!pdfBuffer) {
      return res.json({ error: 'No PDF found for this bill', billId });
    }

    const text = await qbClient.extractPdfText(pdfBuffer);

    // Split into lines
    const lines = text.split('\n');
    const sample = lines.slice(startLine, startLine + count);

    res.json({
      billId,
      pdfSize: pdfBuffer.length,
      totalLines: lines.length,
      totalChars: text.length,
      requestedRange: { start: startLine, count, returned: sample.length },
      linesRaw: sample.map((line, i) => ({
        lineNum: startLine + i + 1,
        content: line,
        length: line.length,
      })),
    });
  } catch (err) {
    res.status(500).json({
      error: 'Failed to extract PDF text',
      message: err.message,
    });
  }
});

// Debug endpoint: show cache file structure
app.get('/api/debug/cache-structure', (req, res) => {
  try {
    const cacheFile = path.join(__dirname, 'ingredient-costs-cache.json');
    if (!fs.existsSync(cacheFile)) {
      return res.json({ error: 'Cache file not found' });
    }
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    res.json({
      topLevelKeys: Object.keys(cached),
      billsProcessed: cached.billsProcessed,
      ingredientsExtracted: cached.ingredientsExtracted,
      hasRawBills: !!cached.rawBills,
      rawBillsCount: cached.rawBills?.length || 0,
      rawBillsSample: cached.rawBills?.slice(0, 3).map(b => ({
        docNumber: b.docNumber,
        vendorName: b.vendorName,
        extractionSource: b.extractionSource,
        lineItems: b.lineItems?.length || 0,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ingredient-costs/status', (req, res) => {
  const status = ingredientScheduler.getStatus();
  res.json({
    status: status.isRunning ? 'extracting' : 'idle',
    isRunning: status.isRunning,
    lastRun: status.lastRun || null,
  });
});

// Manually trigger ingredient extraction (runs in background)
app.post('/api/ingredient-costs/trigger', async (req, res) => {
  const weeks = parseInt(req.query.weeks || '52');
  const triggered = await ingredientScheduler.triggerNow(weeks);

  if (triggered) {
    res.json({
      status: 'started',
      message: `Ingredient extraction started for last ${weeks} weeks`,
    });
  } else {
    res.json({
      status: 'already_running',
      message: 'Extraction already in progress',
    });
  }
});

// DEBUG: Serve raw extracted PDF text for a bill (for parser development)
app.get('/api/debug/pdf-text/:billId', (req, res) => {
  try {
    const billId = req.params.billId;
    const debugFile = path.join(__dirname, `debug-pdf-${billId}.txt`);

    if (!fs.existsSync(debugFile)) {
      return res.status(404).json({
        error: 'Debug file not found',
        message: `No debug file for bill ${billId}. File path would be: debug-pdf-${billId}.txt`,
        path: debugFile,
      });
    }

    const text = fs.readFileSync(debugFile, 'utf-8');
    res.type('text/plain').send(text);
  } catch (err) {
    console.error('Debug PDF text read error:', err.message);
    res.status(500).json({
      error: 'Failed to read debug file',
      message: err.message,
    });
  }
});

// Debug endpoint: list all attachments for a bill
app.get('/api/debug/attachments/:billId', async (req, res) => {
  try {
    const billId = req.params.billId;
    const attachments = (await qbClient.query(`SELECT * FROM Attachable WHERE AttachableRef.EntityRef.Value = '${billId}'`)).Attachable || [];

    res.json({
      billId,
      totalAttachments: attachments.length,
      attachments: attachments.map(att => ({
        id: att.Id,
        fileName: att.FileName,
        contentType: att.ContentType,
        size: att.Size,
        hasDownloadUri: !!att.TempDownloadUri,
      })),
    });
  } catch (err) {
    console.error('Error listing attachments:', err.message);
    res.status(500).json({
      error: 'Failed to list attachments',
      message: err.message,
    });
  }
});

// Debug endpoint: search for document URLs/IDs in a bill
app.get('/api/debug/bill-sources/:billDocNumber', async (req, res) => {
  try {
    const docNumber = req.params.billDocNumber;

    // Find the bill by DocNumber
    const billQuery = `SELECT * FROM Bill WHERE DocNumber = '${docNumber}' ORDER BY TxnDate DESC MAXRESULTS 1`;
    const billResponse = await qbClient.query(billQuery);
    const bill = (billResponse.Bill || [])[0];

    if (!bill) {
      return res.status(404).json({ error: 'Bill not found', docNumber });
    }

    // Search for document-related fields
    const allFields = Object.keys(bill);
    const docFields = allFields.filter(f =>
      f.toLowerCase().includes('doc') ||
      f.toLowerCase().includes('source') ||
      f.toLowerCase().includes('url') ||
      f.toLowerCase().includes('link') ||
      f.toLowerCase().includes('reference')
    );

    res.json({
      billId: bill.Id,
      docNumber: bill.DocNumber,
      vendor: bill.VendorRef?.name,
      totalFields: allFields.length,
      documentRelatedFields: docFields,
      fieldValues: docFields.reduce((acc, f) => {
        const val = bill[f];
        acc[f] = typeof val === 'object' ? JSON.stringify(val).substring(0, 200) : val;
        return acc;
      }, {}),
    });
  } catch (err) {
    console.error('Error fetching bill sources:', err.message);
    res.status(500).json({
      error: 'Failed to fetch bill sources',
      message: err.message,
    });
  }
});

// Debug endpoint: try to access financialdocument.platform.intuit.com with different auth methods
app.get('/api/debug/source-document/:billId', async (req, res) => {
  try {
    const billId = req.params.billId;
    const tokens = await qbClient.getValidTokens();

    // Try different ID formats and auth methods
    const attempts = [
      { id: billId, authType: 'QB-Bearer', getHeaders: () => ({ Authorization: `Bearer ${tokens.access_token}` }) },
      { id: billId, authType: 'none', getHeaders: () => ({}) },
      { id: billId, authType: 'realm-header', getHeaders: () => ({ 'X-QB-Realm-Id': tokens.realmId, Authorization: `Bearer ${tokens.access_token}` }) },
    ];

    const results = [];

    for (const attempt of attempts) {
      const url = `https://financialdocument.platform.intuit.com/v2/no-user-cred/documents/${attempt.id}`;
      try {
        const resp = await axios.get(url, {
          headers: attempt.getHeaders(),
          timeout: 5000,
        });
        results.push({
          ...attempt,
          status: resp.status,
          success: true,
          contentType: resp.headers['content-type'],
          contentLength: resp.data?.length || 'unknown',
        });
      } catch (e) {
        results.push({
          ...attempt,
          status: e.response?.status || 'no-response',
          success: false,
          error: e.message?.substring(0, 80),
          errorStatus: e.response?.statusText,
        });
      }
    }

    res.json({
      billId,
      attempts: results,
      note: '403 Forbidden means endpoint exists but auth is wrong. 404 means wrong ID format.',
    });
  } catch (err) {
    console.error('Error testing source document access:', err.message);
    res.status(500).json({
      error: 'Failed to test source document',
      message: err.message,
    });
  }
});

// Cash balance trend - fetches Statement of Cash Flows from QB
app.get('/api/cash-balance', async (req, res) => {
  try {
    const qbClient = require('./pipeline/qb-client');
    const tokens = await qbClient.getValidTokens();

    // Helper to extract "Cash at End of Period" from cash flow statement
    const findCashAtEnd = (rows, debug = false) => {
      if (!rows) return null;
      for (const row of rows) {
        // Try multiple locations for the label (different report structures)
        const label = row.Header?.ColData?.[0]?.value || row.ColData?.[0]?.value || row.Summary?.ColData?.[0]?.value || '';
        if (debug && label) console.log(`    Row label: "${label}"`);
        if (label.toUpperCase().includes('CASH AT END')) {
          const val = row.Summary?.ColData?.[1]?.value || row.ColData?.[1]?.value;
          if (debug) console.log(`      Found CASH AT END, value: ${val}`);
          if (val !== undefined && val !== null) return parseFloat(val);
        }
        // Recurse into nested rows
        if (row.Rows?.Row) {
          const found = findCashAtEnd(row.Rows.Row, debug);
          if (found !== null) return found;
        }
      }
      return null;
    };

    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];

    // Generate 60 months (5 years) of monthly data going back from today
    const months = [];
    for (let i = 59; i >= 0; i--) {
      const date = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const year = date.getFullYear();
      const month = date.getMonth(); // 0-11
      const monthName = MONTH_NAMES[month];
      const monthShort = MONTH_SHORTS[month];

      months.push({
        year,
        month: monthShort,
        name: monthName,
      });
    }

    console.log(`Generating 5-year cash balance data (60 months)...`);
    if (months.length > 0) {
      console.log(`Range: ${months[0].name} ${months[0].year} to ${months[months.length - 1].name} ${months[months.length - 1].year}`);
    }

    // Query QB Statement of Cash Flows for each month
    const balances = [];
    let currentCash = 0;

    console.log('Querying QB Statement of Cash Flows for each month...');
    for (let i = 0; i < months.length; i++) {
      const monthData = months[i];
      const monthIndex = MONTH_NAMES.indexOf(monthData.name);
      const firstDay = new Date(monthData.year, monthIndex, 1);
      const lastDay = new Date(monthData.year, monthIndex + 1, 0);

      const startDateStr = firstDay.toISOString().split('T')[0];
      const endDateStr = lastDay.toISOString().split('T')[0];

      try {
        const cfRes = await axios.get(
          `${qbClient.baseUrl()}/v3/company/${tokens.realmId}/reports/CashFlow`,
          {
            params: { start_date: startDateStr, end_date: endDateStr },
            headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
          }
        );

        const cash = findCashAtEnd(cfRes.data.Rows?.Row) || 0;
        currentCash = cash;
        balances.push({
          date: endDateStr,
          balance: round2(cash),
        });
        console.log(`  ✅ ${endDateStr}: $${round2(cash)}`);
      } catch (err) {
        console.warn(`Failed to fetch CashFlow for ${monthData.name} ${monthData.year}: ${err.message}`);
      }
    }

    console.log(`✅ Fetched ${balances.length} month-end cash balances from QB`);

    res.json({
      success: true,
      currentCash: round2(currentCash),
      balances,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Cash balance fetch error:', err.message);
    res.status(500).json({
      error: 'Failed to fetch cash balance data',
      message: err.message,
    });
  }
});

// Debug endpoint to check QB cash balance for a specific date
app.get('/api/debug/qb-cash-balance', async (req, res) => {
  try {
    const qbClient = require('./pipeline/qb-client');
    const tokens = await qbClient.getValidTokens();

    const dateStr = req.query.date || '2025-02-28';

    // Helper to extract cash total from balance sheet
    const findCashTotal = (rows) => {
      if (!rows) return null;
      for (const row of rows) {
        const label = row.Header?.ColData?.[0]?.value || row.ColData?.[0]?.value || '';
        if (label.toUpperCase().includes('CASH') || label.toUpperCase().includes('BANK')) {
          const val = row.Summary?.ColData?.[1]?.value || row.ColData?.[1]?.value;
          if (val) return parseFloat(val);
        }
        if (row.Rows?.Row) {
          const found = findCashTotal(row.Rows.Row);
          if (found !== null) return found;
        }
      }
      return null;
    };

    console.log(`Fetching QB Balance Sheet as of ${dateStr}...`);
    const bsRes = await axios.get(
      `${qbClient.baseUrl()}/v3/company/${tokens.realmId}/reports/BalanceSheet`,
      {
        params: { as_of_date: dateStr },
        headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
      }
    );

    const cash = findCashTotal(bsRes.data.Rows?.Row) || 0;
    res.json({
      date: dateStr,
      cash: round2(cash),
    });
  } catch (err) {
    console.error('QB balance check error:', err.message);
    res.status(500).json({
      error: 'Failed to fetch QB balance',
      message: err.message,
    });
  }
});

// Debug endpoint to see CashFlow report structure
app.get('/api/debug/qb-cashflow', async (req, res) => {
  try {
    const qbClient = require('./pipeline/qb-client');
    const tokens = await qbClient.getValidTokens();

    const dateStr = req.query.date || '2025-02-28';
    const startDate = req.query.start_date || null;
    const endDate = req.query.end_date || dateStr;

    const params = startDate ? { start_date: startDate, end_date: endDate } : { end_date: endDate };
    console.log(`Fetching QB CashFlow report with params:`, params);

    const cfRes = await axios.get(
      `${qbClient.baseUrl()}/v3/company/${tokens.realmId}/reports/CashFlow`,
      {
        params,
        headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
      }
    );

    res.json(cfRes.data);
  } catch (err) {
    console.error('QB cashflow check error:', err.message);
    res.status(500).json({
      error: 'Failed to fetch QB CashFlow report',
      message: err.message,
    });
  }
});

// ============= PUBLIC DASHBOARD API ENDPOINTS =============

// Square data endpoint
app.get('/api/public/square/overview', async (req, res) => {
  try {
    if (!process.env.SQUARE_ACCESS_TOKEN) {
      return res.status(400).json({ error: 'Square not configured' });
    }

    const today = new Date().toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [locations, orders] = await Promise.all([
      claudeMCP.getSquareLocations(),
      claudeMCP.getSquareOrders(process.env.SQUARE_LOCATION_ID, sevenDaysAgo, today),
    ]);

    res.json({
      success: true,
      locations,
      orders,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Square overview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// QuickBooks data endpoint
app.get('/api/public/quickbooks/overview', async (req, res) => {
  try {
    const tokens = qbClient.loadTokens();
    if (!tokens || !tokens.refresh_token) {
      return res.status(400).json({
        success: false,
        error: 'QuickBooks not connected',
        reconnectUrl: '/api/quickbooks/connect',
      });
    }

    // Check for token errors from previous refresh attempts
    const tokenError = qbCache.getTokenError();
    if (tokenError) {
      return res.status(400).json({
        success: false,
        error: tokenError.message,
        errorType: tokenError.type,
        reconnectUrl: '/api/quickbooks/connect',
      });
    }

    const cached = qbCache.loadCache('pl-30d');
    if (cached) {
      return res.json({
        success: true,
        report: cached.data,
        cachedAt: cached.cachedAt,
        timestamp: new Date().toISOString(),
      });
    }

    console.log('Cache miss - fetching fresh QB data');
    const today = new Date().toISOString().split('T')[0];
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    console.log(`QB P&L query: ${thirtyDaysAgo} to ${today}`);
    const report = await qbCache.fetchReport('ProfitAndLoss', {
      start_date: thirtyDaysAgo,
      end_date: today,
    });

    res.json({
      success: true,
      report,
      cachedAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('QB overview error:', err.message);
    res.status(500).json({
      success: false,
      error: err.message,
      errorType: err.code,
      reconnectUrl: '/api/quickbooks/connect',
    });
  }
});

// Public dashboard page
app.get('/dashboard', (req, res) => {
  res.sendFile('public/dashboard.html', { root: __dirname });
});

// Start server
const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, async () => {
  console.log(`🍞 Bakery Dashboard API running on http://localhost:${PORT}`);
  console.log(`📊 Public dashboard: http://localhost:${PORT}/dashboard`);

  if (process.env.SQUARE_ACCESS_TOKEN) {
    console.log('✅ Square configured');
  } else {
    console.log('⚠️  Square not configured');
  }

  // Check for QB tokens from file (persistent) or env vars
  const fileTokens = qbClient.loadTokens();
  const envTokens = process.env.QUICKBOOKS_REFRESH_TOKEN && (process.env.QUICKBOOKS_REALM_ID || process.env.QB_REALM_ID);
  const qbConfigured = !!fileTokens || envTokens;

  if (qbConfigured) {
    console.log('✅ QuickBooks configured');
    if (fileTokens) {
      console.log('   📁 Tokens loaded from file (persistent storage)');
      if (fileTokens.expires_at) {
        const minutesUntilExpiry = Math.floor((fileTokens.expires_at - Date.now()) / 1000 / 60);
        console.log(`   ⏰ Access token expires in ${minutesUntilExpiry} minutes`);
      }
    }
    if (envTokens) {
      console.log('   🔧 Environment variables set');
    }
    setTimeout(() => qbCache.warmupCacheOnStartup(), 500);
  } else {
    console.log('⚠️  QuickBooks not configured');
  }

  if (qbConfigured) {
    startQBRefreshJobs();
  }

  // Initialize automated margin calculation scheduler
  // Runs daily at 6 AM UTC, with immediate run on startup
  marginScheduler = marginSchedulerModule.start();

  // Initialize ingredient cost extraction scheduler
  // Runs on startup to populate cache (takes time, runs in background)
  ingredientScheduler = ingredientSchedulerModule.start();

  // Auto-rebuild product margins weekly (Sundays at 3am)
  // Fetches vendor prices from QB + recipes from Google Drive
  cron.schedule('0 3 * * 0', async () => {
    console.log('🔄 Starting weekly margin rebuild...');
    try {
      const marginBuilder = require('./pipeline/build-margins');
      const result = await marginBuilder.main({ weeks: 12 });
      console.log(`✅ Margin rebuild complete: ${result.coverage.costed.length} recipes costed`);
    } catch (err) {
      console.error('❌ Margin rebuild failed:', err.message);
      if (err.code === 'QB_NOT_CONNECTED') {
        console.error('   → QuickBooks not connected, skipping margin rebuild');
      } else if (err.code === 'GOOGLE_NOT_CONNECTED') {
        console.error('   → Google Drive not connected, skipping margin rebuild');
      }
    }
  });
});
