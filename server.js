const express = require('express');
const cors = require('cors');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());

// Data storage paths
const DATA_DIR = 'data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// If DATA_DIR is backed by a persistent volume (e.g. Railway), a fresh/empty volume shadows
// whatever git-tracked files used to live at this path in the image (data/monthly-financial.json
// is committed to git specifically so it survives redeploys, but a volume mount replaces the whole
// directory's content on first attach). Restore it from the repo-tracked seed copy if missing.
const MONTHLY_FINANCIAL_FILE = path.join(DATA_DIR, 'monthly-financial.json');
const MONTHLY_FINANCIAL_SEED = 'seed-data/monthly-financial.json';
if (!fs.existsSync(MONTHLY_FINANCIAL_FILE) && fs.existsSync(MONTHLY_FINANCIAL_SEED)) {
  fs.copyFileSync(MONTHLY_FINANCIAL_SEED, MONTHLY_FINANCIAL_FILE);
}

const RECIPES_FILE = path.join(DATA_DIR, 'recipes.json');
const INGREDIENTS_FILE = path.join(DATA_DIR, 'ingredients.json');
const FINANCIAL_FILE = path.join(DATA_DIR, 'financial.json');
const PRODUCTION_FILE = path.join(DATA_DIR, 'production.json');

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

// ============= UPLOAD ENDPOINTS =============

// Upload recipes CSV
app.post('/api/upload/recipes', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const recipes = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on('data', (row) => recipes.push(row))
    .on('end', () => {
      saveData(RECIPES_FILE, recipes);
      fs.unlinkSync(req.file.path);
      cacheManager.invalidate('recipes');
      cacheManager.invalidate('item_margins');
      res.json({ success: true, count: recipes.length, recipes });
    })
    .on('error', (err) => {
      fs.unlinkSync(req.file.path);
      res.status(400).json({ error: err.message });
    });
});

// Upload ingredients CSV
app.post('/api/upload/ingredients', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const ingredients = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on('data', (row) => ingredients.push(row))
    .on('end', () => {
      saveData(INGREDIENTS_FILE, ingredients);
      fs.unlinkSync(req.file.path);
      cacheManager.invalidate('ingredients');
      res.json({ success: true, count: ingredients.length, ingredients });
    })
    .on('error', (err) => {
      fs.unlinkSync(req.file.path);
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
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: `Unknown location "${location}". Expected one of: ${WASTE_LOCATIONS.map((l) => l.name).join(', ')}` });
  }

  const rows = [];
  fs.createReadStream(req.file.path)
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
      fs.unlinkSync(req.file.path);
      cacheManager.invalidate(`waste_${location}`);
      res.json({ success: true, location, count: rows.length, totalRows: production[location].length });
    })
    .on('error', (err) => {
      fs.unlinkSync(req.file.path);
      res.status(400).json({ error: err.message });
    });
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

// ============= QUICKBOOKS DATA ENDPOINTS =============

// Fetch a Profit & Loss report summarized by month for a date range
const fetchQBProfitAndLoss = async (startDate, endDate) => {
  const tokens = await getValidQBAccessToken();
  const response = await axios.get(
    `${getQBBaseUrl()}/v3/company/${tokens.realmId}/reports/ProfitAndLoss`,
    {
      params: { start_date: startDate, end_date: endDate, summarize_column_by: 'Month' },
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

// Convert a QuickBooks ProfitAndLoss report (summarized by month) into our monthlyData shape
const parseQBMonthlyPL = (report) => {
  const columns = report.Columns?.Column || [];
  const monthCols = columns
    .map((c, i) => ({ index: i, title: c.ColTitle }))
    .filter((c) => c.title && c.title !== 'Total');

  const getVals = (row) => row?.Summary?.ColData?.map((c) => parseFloat(c.value) || 0) || [];
  const revenueVals = getVals(findQBSummaryRow(report.Rows?.Row, 'Income'));
  const cogsVals = getVals(findQBSummaryRow(report.Rows?.Row, 'COGS'));
  const opexVals = getVals(findQBSummaryRow(report.Rows?.Row, 'Expenses'));
  const laborVals = getVals(findQBSummaryRow(report.Rows?.Row, 'Payroll'));
  const netVals = getVals(report.Rows?.Row?.find((r) => r.group === 'NetIncome'));

  return monthCols.map((col) => {
    const monthIdx = MONTH_NAMES.findIndex((name) => col.title.startsWith(name.slice(0, 3)));
    return {
      month: monthIdx >= 0 ? MONTH_SHORTS[monthIdx] : col.title,
      name: monthIdx >= 0 ? MONTH_NAMES[monthIdx] : col.title,
      revenue: revenueVals[col.index] || 0,
      cogs: cogsVals[col.index] || 0,
      opex: opexVals[col.index] || 0,
      labor: laborVals[col.index] || 0,
      pl: netVals[col.index] || 0,
    };
  });
};

// Get raw P/L Statement from QuickBooks
app.get('/api/quickbooks/pl', async (req, res) => {
  try {
    const year = new Date().getFullYear();
    const data = await fetchQBProfitAndLoss(req.query.start_date || `${year}-01-01`, req.query.end_date || `${year}-12-31`);
    res.json({ success: true, data, note: 'P/L statement from QuickBooks' });
  } catch (err) {
    if (err.code === 'QB_NOT_CONNECTED') return res.json({ error: err.message, connected: false, data: [] });
    res.status(500).json({ error: 'QuickBooks API error', message: err.response?.data?.fault?.detail?.[0]?.message || err.message });
  }
});

// Get Account Balances from QuickBooks
app.get('/api/quickbooks/accounts', async (req, res) => {
  try {
    const tokens = await getValidQBAccessToken();
    const response = await axios.get(`${getQBBaseUrl()}/v3/company/${tokens.realmId}/query`, {
      params: { query: 'SELECT * FROM Account' },
      headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
    });
    res.json({ success: true, data: response.data.QueryResponse.Account || [], note: 'Account balances from QuickBooks' });
  } catch (err) {
    if (err.code === 'QB_NOT_CONNECTED') return res.json({ error: err.message, connected: false, data: [] });
    res.status(500).json({ error: 'QuickBooks API error', message: err.response?.data?.fault?.detail?.[0]?.message || err.message });
  }
});

// Get Expenses from QuickBooks (filtered by category)
app.get('/api/quickbooks/expenses', async (req, res) => {
  try {
    const tokens = await getValidQBAccessToken();
    const response = await axios.get(`${getQBBaseUrl()}/v3/company/${tokens.realmId}/query`, {
      params: { query: "SELECT * FROM Account WHERE AccountType='Expense'" },
      headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' },
    });
    res.json({ success: true, data: response.data.QueryResponse.Account || [], note: 'Expense accounts from QuickBooks' });
  } catch (err) {
    if (err.code === 'QB_NOT_CONNECTED') return res.json({ error: err.message, connected: false, data: [] });
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

    res.json({
      monthlyData,
      summary,
      recipes: { count: recipes.length },
      ingredients: { count: ingredients.length },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// P&L by Channel
app.get('/api/pl-by-channel', (req, res) => {
  try {
    const PL_CHANNEL_FILE = path.join(DATA_DIR, 'pl-by-channel.json');
    const plData = loadData(PL_CHANNEL_FILE);

    if (!plData || plData.length === 0) {
      return res.json({
        channels: [
          { name: 'ARC', revenue: 0, variableCosts: 0, bakeryAllocation: 0 },
          { name: 'LSK', revenue: 0, variableCosts: 0, bakeryAllocation: 0 },
          { name: 'State St', revenue: 0, variableCosts: 0, bakeryAllocation: 0 },
          { name: 'Catering', revenue: 0, variableCosts: 0, bakeryAllocation: 0 },
          { name: 'Delivery 506', revenue: 0, variableCosts: 0, bakeryAllocation: 0 },
        ],
        message: 'No P&L data provided yet. Upload bakery allocation data to populate this view.',
      });
    }

    res.json({
      channels: plData,
      lastUpdated: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// ============= ITEM MARGIN DASHBOARD =============
// For every recipe, compares Square's live listed price against the recipe's ingredient cost
// (Cost / Yield, both already tracked per-batch in the uploaded recipes CSV) to show what share
// of the price the ingredients eat up. Matched to the Square catalog by exact item name (same
// name-matching approach as the Waste tab), since there's no shared ID between recipes.csv and
// the catalog.

// Paginates GET /v2/catalog/list for ITEM objects and returns { lowercased name: { name, price } }
// using each item's first priced variation. Catalog rarely changes within a session, so callers
// cache the result.
const fetchCatalogItemPrices = async () => {
  const prices = {};
  let cursor;
  let page = 0;
  do {
    const response = await axios.get(`${SQUARE_API_BASE}/catalog/list`, {
      headers: squareHeaders(),
      params: { types: 'ITEM', cursor },
    });
    (response.data.objects || []).forEach((obj) => {
      if (obj.type !== 'ITEM' || obj.is_deleted) return;
      const itemData = obj.item_data || {};
      const name = (itemData.name || '').trim();
      if (!name) return;
      const variation = (itemData.variations || []).find((v) => v.item_variation_data?.price_money?.amount != null);
      const amount = variation?.item_variation_data?.price_money?.amount;
      if (amount == null) return;
      const key = name.toLowerCase();
      if (!prices[key]) prices[key] = { name, price: amount / 100 };
    });
    cursor = response.data.cursor;
    page += 1;
  } while (cursor && page < 50);
  return prices;
};

// GET /api/item-margins - ingredient cost as % of listed price, per item. Cached 1 hour.
app.get('/api/item-margins', async (req, res) => {
  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token || token === 'your_square_token_here') {
    return res.status(400).json({ error: 'Square API credentials not configured', items: [] });
  }

  const recipes = loadData(RECIPES_FILE);
  if (recipes.length === 0) {
    return res.json({ items: [], unmatchedRecipes: [], status: 'empty', message: 'No recipes uploaded yet.' });
  }

  const cacheKey = 'item_margins';
  const cached = cacheManager.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const catalogPrices = await fetchCatalogItemPrices();

    const items = [];
    const unmatchedRecipes = [];
    recipes.forEach((r) => {
      const name = (r['Recipe Name'] || '').trim();
      const cost = parseFloat(r['Cost']);
      const yieldQty = parseFloat(r['Yield']);
      if (!name || !Number.isFinite(cost) || !Number.isFinite(yieldQty) || yieldQty <= 0) return;

      const match = catalogPrices[name.toLowerCase()];
      if (!match || !(match.price > 0)) {
        unmatchedRecipes.push(name);
        return;
      }

      const ingredientCost = cost / yieldQty;
      items.push({
        name,
        category: r['Category'] || '',
        listedPrice: match.price,
        ingredientCost,
        percent: (ingredientCost / match.price) * 100,
      });
    });

    items.sort((a, b) => b.percent - a.percent);

    const result = { items, unmatchedRecipes, lastUpdated: new Date().toISOString() };
    cacheManager.set(cacheKey, result, 60 * 60 * 1000); // 1 hour
    res.json(result);
  } catch (err) {
    res.status(500).json({
      error: 'Square API error',
      message: err.response?.data?.errors?.[0]?.detail || err.message,
      items: [],
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

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🍞 Bakery Dashboard API running on http://localhost:${PORT}`);
  console.log(`📋 Next: Add Square & QuickBooks API credentials to .env`);
});
