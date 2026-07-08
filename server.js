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
      res.json({ success: true, count: ingredients.length, ingredients });
    })
    .on('error', (err) => {
      fs.unlinkSync(req.file.path);
      res.status(400).json({ error: err.message });
    });
});

// ============= DATA ENDPOINTS =============

// Get recipes
app.get('/api/recipes', (req, res) => {
  const recipes = loadData(RECIPES_FILE);
  res.json(recipes);
});

// Get ingredients
app.get('/api/ingredients', (req, res) => {
  const ingredients = loadData(INGREDIENTS_FILE);
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
  const netVals = getVals(report.Rows?.Row?.find((r) => r.group === 'NetIncome'));

  return monthCols.map((col) => {
    const monthIdx = MONTH_NAMES.findIndex((name) => col.title.startsWith(name.slice(0, 3)));
    return {
      month: monthIdx >= 0 ? MONTH_SHORTS[monthIdx] : col.title,
      name: monthIdx >= 0 ? MONTH_NAMES[monthIdx] : col.title,
      revenue: revenueVals[col.index] || 0,
      cogs: cogsVals[col.index] || 0,
      opex: opexVals[col.index] || 0,
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

    const monthShorts = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // Build monthly data from uploaded files
    let monthlyData = Array.from({ length: 12 }, (_, i) => {
      const month = monthShorts[i];
      const data = monthlyFinancial[month];

      return {
        month,
        name: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][i],
        pl: data ? data.pl : 0,
        cogs: data ? data.cogs : 0,
        opex: data ? data.opex : 0,
        revenue: data ? data.revenue : 0,
      };
    });

    // Calculate totals
    let totalRevenue = 0, totalCogs = 0, totalOpex = 0;
    Object.values(monthlyFinancial).forEach(m => {
      totalRevenue += m.revenue || 0;
      totalCogs += m.cogs || 0;
      totalOpex += m.opex || 0;
    });

    const summary = totalRevenue > 0 ? {
      revenue: totalRevenue,
      cogs: totalCogs,
      opex: totalOpex,
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

// ============= HEALTH CHECK =============

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
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
