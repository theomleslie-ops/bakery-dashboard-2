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

const RECIPES_FILE = path.join(DATA_DIR, 'recipes.json');
const INGREDIENTS_FILE = path.join(DATA_DIR, 'ingredients.json');
const FINANCIAL_FILE = path.join(DATA_DIR, 'financial.json');

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
const SQUARE_API_VERSION = '2025-01-23';
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

const OVERTIME_SNAPSHOT_FILE = path.join(DATA_DIR, 'overtime-snapshot.json');
const loadOvertimeSnapshot = () => loadData(OVERTIME_SNAPSHOT_FILE);

const fetchWorkweekStartDow = async () => {
  const response = await axios.get(`${SQUARE_API_BASE}/labor/workweek-configs`, { headers: squareHeaders() });
  const config = response.data.workweek_configs?.[0];
  return DOW_INDEX[config?.start_of_week] ?? 1; // default Monday
};

// Fetch every CLOSED timecard whose shift starts within [startDate, endDateExclusive), all locations
const fetchAllTimecards = async (startDate, endDateExclusive) => {
  const timecards = [];
  let cursor;
  let page = 0;
  do {
    const response = await axios.post(
      `${SQUARE_API_BASE}/labor/timecards/search`,
      {
        query: {
          filter: {
            location_id: process.env.SQUARE_LOCATION_ID,
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

// GET /api/overtime?weeks=8&end=YYYY-MM-DD
// `end` is the Monday (workweek start) of the most recent week to include; defaults to
// the most recently completed workweek. `weeks` is how many workweeks back to include.
// Cached for 24 hours per query.
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

    const rangeStart = addDays(lastWeekStart, -7 * (weekCount - 1));
    const rangeEndExclusive = addDays(lastWeekStart, 7);

    const [timecards, teamNames] = await Promise.all([
      fetchAllTimecards(rangeStart, rangeEndExclusive),
      fetchTeamMemberNames(),
    ]);

    const weeks = buildOvertimeReport(timecards, teamNames, startDow);
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
    let monthlyData = Object.entries(monthlyFinancial)
      .map(([key, data]) => ({
        ...data,
        sortKey: key, // for chronological sorting
      }))
      .sort((a, b) => {
        // Sort by year-month key chronologically
        const aKey = a.sortKey || `${a.year}-${a.month}`;
        const bKey = b.sortKey || `${b.year}-${b.month}`;
        return aKey.localeCompare(bKey);
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
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve overtime report
app.get('/overtime', (req, res) => {
  res.sendFile(path.join(__dirname, 'overtime.html'));
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
