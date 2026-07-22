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

const qbCache = require('./pipeline/qb-cache');
const { initMargins } = require('./pipeline/init-margins');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

// Data storage paths
const DATA_DIR = 'data';
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

const squareHeaders = () => ({
  Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
  'Square-Version': SQUARE_API_VERSION,
  'Content-Type': 'application/json',
});

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
  const response = await axios.get(`${SQUARE_API_BASE}/labor/workweek-configs`, { headers: squareHeaders() });
  const config = response.data.workweek_configs?.[0];
  return DOW_INDEX[config?.start_of_week] ?? 1; // default Monday
};

// Fetch every CLOSED timecard whose shift starts within [startDate, endDateExclusive) for one window
const fetchTimecardsWindow = async (startDate, endDateExclusive) => {
  const timecards = [];
  let cursor;
  let page = 0;
  do {
    const response = await axios.post(
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
    timecards.push(...(response.data.timecards || []));
    cursor = response.data.cursor;
    page += 1;
  } while (cursor && page < 50);
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
    const response = await axios.post(
      `${SQUARE_API_BASE}/team-members/search`,
      { limit: 200, cursor },
      { headers: squareHeaders() }
    );
    (response.data.team_members || []).forEach((tm) => {
      names[tm.id] = [tm.given_name, tm.family_name].filter(Boolean).join(' ') || tm.id;
    });
    cursor = response.data.cursor;
    page += 1;
  } while (cursor && page < 50);
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
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token || token === 'your_square_token_here') {
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
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token || token === 'your_square_token_here') {
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

const QB_TOKENS_FILE = path.join(DATA_DIR, 'quickbooks-tokens.json');
const QB_AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

const getQBBaseUrl = () =>
  process.env.QUICKBOOKS_ENVIRONMENT === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';

const getQBRedirectUri = () =>
  process.env.QUICKBOOKS_REDIRECT_URI || `http://localhost:${PORT}/api/quickbooks/callback`;

const qbBasicAuthHeader = () =>
  `Basic ${Buffer.from(`${process.env.QUICKBOOKS_CLIENT_ID}:${process.env.QUICKBOOKS_CLIENT_SECRET}`).toString('base64')}`;

const loadQBTokens = () => {
  try {
    return JSON.parse(fs.readFileSync(QB_TOKENS_FILE, 'utf-8'));
  } catch {
    return null;
  }
};

const saveQBTokens = (tokens) => saveData(QB_TOKENS_FILE, tokens);

// Returns a valid access token + realmId, refreshing if the access token has expired.
// Throws if QuickBooks has never been connected.
const getValidQBAccessToken = async () => {
  const tokens = loadQBTokens();
  if (!tokens || !tokens.refresh_token) {
    const err = new Error('QuickBooks not connected. Visit /api/quickbooks/connect to authorize.');
    err.code = 'QB_NOT_CONNECTED';
    throw err;
  }

  const isExpired = !tokens.expires_at || Date.now() > tokens.expires_at - 60_000;
  if (!isExpired) return tokens;

  const response = await axios.post(
    QB_TOKEN_URL,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }).toString(),
    { headers: { Authorization: qbBasicAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } }
  );

  const updated = {
    ...tokens,
    access_token: response.data.access_token,
    refresh_token: response.data.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + response.data.expires_in * 1000,
  };
  saveQBTokens(updated);
  return updated;
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
    state: Math.random().toString(36).slice(2),
  });
  res.redirect(`${QB_AUTH_URL}?${params.toString()}`);
});

// Step 2: Intuit redirects back here with a code + realmId
app.get('/api/quickbooks/callback', async (req, res) => {
  const { code, realmId, error } = req.query;
  if (error) return res.status(400).send(`QuickBooks authorization failed: ${error}`);
  if (!code || !realmId) return res.status(400).send('Missing code or realmId from QuickBooks');

  try {
    const response = await axios.post(
      QB_TOKEN_URL,
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: getQBRedirectUri() }).toString(),
      { headers: { Authorization: qbBasicAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } }
    );

    saveQBTokens({
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token,
      expires_at: Date.now() + response.data.expires_in * 1000,
      realmId,
      connectedAt: new Date().toISOString(),
    });
    res.redirect('/?qb=connected');
  } catch (err) {
    res.status(500).send(`Failed to connect QuickBooks: ${err.response?.data?.error_description || err.message}`);
  }
});

// Connection status
app.get('/api/quickbooks/status', (req, res) => {
  const tokens = loadQBTokens();
  res.json({
    connected: !!(tokens && tokens.refresh_token),
    realmId: tokens?.realmId || null,
    connectedAt: tokens?.connectedAt || null,
  });
});

// Disconnect (forget stored tokens)
app.post('/api/quickbooks/disconnect', (req, res) => {
  if (fs.existsSync(QB_TOKENS_FILE)) fs.unlinkSync(QB_TOKENS_FILE);
  res.json({ success: true });
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
  const tokens = await getValidQBAccessToken();
  const response = await axios.get(
    `${getQBBaseUrl()}/v3/company/${tokens.realmId}/reports/ProfitAndLoss`,
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
  // Match the "LABOR/PAYROLL EXPENSES" line specifically - a plain 'LABOR' substring also
  // matches unrelated accounts like "Contracted labor", which silently returns the wrong
  // (all-zero) row once the date range is wide enough for that account to appear in the report.
  const laborVals = getQBRowVals(findQBRowByLabel(report.Rows?.Row, 'LABOR/PAYROLL'));
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
const pairIntoBiweekly = (weeklyRows) => {
  const periods = [];
  let start = 0;
  if (weeklyRows.length % 2 === 1) {
    periods.push(weeklyRows[0]);
    start = 1;
  }
  for (let i = start; i < weeklyRows.length; i += 2) {
    const a = weeklyRows[i];
    const b = weeklyRows[i + 1];
    if (!b) { periods.push(a); break; }
    periods.push({
      label: a.label,
      fullLabel: `${a.fullLabel} + ${b.fullLabel}`,
      revenue: round2(a.revenue + b.revenue),
      cogs: round2(a.cogs + b.cogs),
      opex: round2(a.opex + b.opex),
      labor: round2(a.labor + b.labor),
      pl: round2(a.pl + b.pl),
    });
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
const getQBWeeklyRows = async (rangeStart, rangeEndInclusive) => {
  const snapshot = loadQBWeeklySnapshot();
  const earliestCached = Object.keys(snapshot.weeks).sort()[0];

  // Only try to fetch from QB if connected
  const isQBConnected = () => {
    try { return !!fs.existsSync(QB_TOKENS_FILE) && JSON.parse(fs.readFileSync(QB_TOKENS_FILE, 'utf-8')).refresh_token; } catch { return false; }
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
    if (snapshot.weeks[d]) rows.push(snapshot.weeks[d]);
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
      const todayStr = new Date().toISOString().slice(0, 10);
      const currentWeekStart = getWeekStart(todayStr, 0);
      const rangeStart = addDays(currentWeekStart, -7 * (weeksBack - 1));
      const weeklyRows = await getQBWeeklyRows(rangeStart, currentWeekStart);
      periodData = pairIntoBiweekly(weeklyRows);
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
  } while (cursor && page < 50);

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
  } while (cursor && page < 50);
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
    const backfillResults = await mapWithConcurrency(WASTE_MARKET_LOCATIONS, 6, async (loc) => ({
      name: loc.name,
      revenueByWeek: await fetchWeeklyRevenueForLocation(loc.squareLocationId, rangeStart, backfillEnd, startDow),
    }));
    backfillResults.forEach(({ name, revenueByWeek }) => {
      snapshot.revenueByMarket[name] = { ...(snapshot.revenueByMarket[name] || {}), ...revenueByWeek };
    });
    snapshot.backfilledFrom = rangeStart;
  }

  const liveStart = addDays(rangeEndInclusive, -7);
  const liveResults = await mapWithConcurrency(WASTE_MARKET_LOCATIONS, 6, async (loc) => ({
    name: loc.name,
    revenueByWeek: await fetchWeeklyRevenueForLocation(loc.squareLocationId, liveStart, rangeEndExclusive, startDow),
  }));
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

  const weekCount = Math.min(Math.max(parseInt(req.query.weeks, 10) || 52, 1), 156);
  const cacheKey = `market_perf_${weekCount}`;
  const cached = cacheManager.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const startDow = await fetchWorkweekStartDow();
    const todayStr = new Date().toISOString().slice(0, 10);
    const currentWeekStart = getWeekStart(todayStr, startDow);
    const rangeStart = addDays(currentWeekStart, -7 * (weekCount - 1));

    const weekStarts = [];
    for (let d = rangeStart; d <= currentWeekStart; d = addDays(d, 7)) weekStarts.push(d);

    const revenueByMarket = await getMarketWeeklyRevenue(rangeStart, currentWeekStart, startDow);

    const markets = WASTE_MARKET_LOCATIONS
      .map((loc) => ({ name: loc.name, revenue: weekStarts.map((ws) => round2((revenueByMarket[loc.name] || {})[ws] || 0)) }))
      .filter((m) => m.revenue.some((v) => v > 0))
      .sort((a, b) => b.revenue.reduce((s, v) => s + v, 0) - a.revenue.reduce((s, v) => s + v, 0));

    const response = { success: true, weekStarts, markets, rangeStart, rangeEnd: currentWeekStart };
    cacheManager.set(cacheKey, response, 4 * 60 * 60 * 1000); // Cache for 4 hours
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: 'Square API error', message: err.response?.data?.errors?.[0]?.detail || err.message, weekStarts: [], markets: [] });
  }
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
  res.json({
    status: 'ok',
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
  res.json({ success: true, message: 'Cache cleared', timestamp: new Date().toISOString() });
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
  if (fs.existsSync(QB_TOKENS_FILE)) fs.unlinkSync(QB_TOKENS_FILE);
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
      console.log(`⏸️  QB cache refresh skipped: QuickBooks not connected. Connect at /api/quickbooks/connect`);
    } else {
      console.error(`❌ QB cache refresh failed:`, err.message);
    }
  }
};

// Run on startup (after a brief delay so DB is ready)
setTimeout(qbCache.warmupCacheOnStartup, 500); // Warmup QB cache first
setTimeout(refreshQBWeeklyData, 1000);
setTimeout(refreshSquareMarketCache, 1500); // Square after QB
setTimeout(() => initMargins().catch(e => console.warn('Product Margins init failed:', e.message)), 2000); // Build recipe costs if needed

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

// ============= GOOGLE OAUTH (Product Margins recipe sheets) =============

const sheetsOAuth = require('./pipeline/sheets-oauth');

app.get('/api/google/connect', (req, res) => {
  try {
    const authUrl = sheetsOAuth.getAuthUrl();
    res.json({ authUrl });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).json({ error: 'Missing authorization code' });
  }
  try {
    const tokens = await sheetsOAuth.exchangeCodeForTokens(code);
    res.redirect('/?message=Google%20authorized.%20Recipes%20can%20now%20be%20fetched.');
  } catch (e) {
    res.status(400).json({ error: `Failed to exchange code: ${e.message}` });
  }
});

app.post('/api/google/disconnect', (req, res) => {
  try {
    sheetsOAuth.disconnect();
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============= INTEGRATIONS STATUS (Google + QuickBooks health) =============

app.get('/api/integrations/status', (req, res) => {
  const qbTokens = loadQBTokens();
  const googleConnected = sheetsOAuth.isConnected();

  res.json({
    google: googleConnected ? 'ok' : 'disconnected',
    quickbooks: (qbTokens && qbTokens.refresh_token) ? 'ok' : 'disconnected',
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

  console.log('Fetching 1-year Square sales data...');
  const oneYearAgo = new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10);
  const allOrders = [];

  for (const locationId of WASTE_LOCATIONS) {
    let cursor = null;
    let page = 0;
    const MAX_PAGES = 1000;

    try {
      while (page < MAX_PAGES) {
        const req = {
          begin_time: new Date(`${oneYearAgo}T00:00:00Z`).getTime(),
          end_time: Date.now(),
          limit: 500,
          sort_order: 'DESC',
        };
        if (cursor) req.cursor = cursor;

        const res = await axios.post(`https://connect.squareup.com/v2/orders/search`, req, {
          headers: {
            Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
            'Content-Type': 'application/json',
          },
        });

        for (const order of (res.data.orders || [])) {
          if (order.state !== 'COMPLETED') continue;
          for (const lineItem of (order.line_items || [])) {
            allOrders.push({
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
      console.error(`Failed to fetch orders for location ${locationId}:`, e.message);
    }
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
const matchRecipeToSquareItem = (recipeName, squareItemName) => {
  const recipeToks = matcher.tokenize(recipeName);
  const squareToks = matcher.tokenize(squareItemName);

  if (!recipeToks.length || !squareToks.length) return false;
  const overlap = recipeToks.filter((t) => squareToks.includes(t));
  return overlap.length / recipeToks.length >= 0.6; // at least 60% token overlap
};

// Main product margins endpoint
app.get('/api/product-margins', async (req, res) => {
  try {
    // Load recipe costs
    const recipeCostsFile = path.join(DATA_DIR, 'pipeline', 'recipe-costs.json');
    const recipeCosts = JSON.parse(fs.readFileSync(recipeCostsFile, 'utf-8'));
    const costByRecipe = {};
    for (const r of recipeCosts.recipes) {
      costByRecipe[r.recipe.toLowerCase()] = r.costPerUnit;
    }

    // Fetch/cache Square sales data
    const salesData = await fetchSquareSalesData();

    // Compute margins for each time window
    const windows = [
      { name: '2 week', days: 14 },
      { name: '4 week', days: 28 },
      { name: '2 month', days: 60 },
      { name: '6 month', days: 180 },
      { name: '1 year', days: 365 },
    ];

    const result = {};
    for (const window of windows) {
      const sales = bucketOrdersByItem(salesData.orders, window.days);
      const top20 = rankProductsByRevenue(sales, 20);

      const withMargins = [];
      for (const item of top20) {
        const recipeKey = item.name.toLowerCase();
        const costPerUnit = costByRecipe[recipeKey];

        withMargins.push({
          name: item.name,
          revenue: Math.round(item.revenue * 100) / 100,
          quantity: Math.round(item.qty * 100) / 100,
          avgPrice: Math.round(item.avgPrice * 100) / 100,
          cogs: costPerUnit != null ? Math.round(item.qty * costPerUnit * 100) / 100 : null,
          costPerUnit,
          margin$: costPerUnit != null ? Math.round((item.revenue - item.qty * costPerUnit) * 100) / 100 : null,
          marginPct: costPerUnit != null ? Math.round((1 - item.qty * costPerUnit / item.revenue) * 10000) / 100 : null,
          status: costPerUnit != null ? 'costed' : 'needs-cost',
        });
      }

      result[window.name] = {
        fetchedAt: salesData.fetchedAt,
        window: `${window.days} days`,
        top20: withMargins,
      };
    }

    res.json({
      generatedAt: new Date().toISOString(),
      squareSalesCache: salesData.fetchedAt,
      windows: result,
    });
  } catch (e) {
    console.error('Product margins error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🍞 Bakery Dashboard API running on http://localhost:${PORT}`);
  console.log(`📋 Next: Add Square & QuickBooks API credentials to .env`);
  console.log(`🚀 Railway auto-deploy is live and working`);
});
