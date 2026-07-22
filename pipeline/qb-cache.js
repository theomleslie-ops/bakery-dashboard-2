const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const DATA_DIR = path.join(__dirname, '..', 'data');
const QB_CACHE_DIR = path.join(DATA_DIR, 'qb-cache');
const QB_TOKENS_FILE = path.join(DATA_DIR, 'quickbooks-tokens.json');

// Ensure cache directory exists
if (!fs.existsSync(QB_CACHE_DIR)) {
  fs.mkdirSync(QB_CACHE_DIR, { recursive: true });
}

const getBaseUrl = () =>
  process.env.QUICKBOOKS_ENVIRONMENT === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';

const basicAuth = () =>
  `Basic ${Buffer.from(`${process.env.QUICKBOOKS_CLIENT_ID}:${process.env.QUICKBOOKS_CLIENT_SECRET}`).toString('base64')}`;

const loadTokens = () => {
  // Check .env first for pre-configured tokens (no user sign-in needed)
  if (process.env.QUICKBOOKS_REFRESH_TOKEN && process.env.QUICKBOOKS_REALM_ID) {
    return {
      refresh_token: process.env.QUICKBOOKS_REFRESH_TOKEN,
      realmId: process.env.QUICKBOOKS_REALM_ID,
      access_token: null, // Will be fetched on first use
      expires_at: 0, // Force immediate refresh
      source: 'env',
    };
  }

  // Fall back to stored tokens file
  try {
    return JSON.parse(fs.readFileSync(QB_TOKENS_FILE, 'utf-8'));
  } catch {
    return null;
  }
};

const saveTokens = (t) => {
  // Don't overwrite if tokens came from .env (they're managed there)
  if (t.source === 'env') return;
  fs.writeFileSync(QB_TOKENS_FILE, JSON.stringify(t, null, 2));
};

// Returns valid tokens (incl. realmId), refreshing the access token if expired.
const getValidAccessToken = async () => {
  const tokens = loadTokens();
  if (!tokens || !tokens.refresh_token) {
    const err = new Error('QuickBooks not connected. Set QUICKBOOKS_REFRESH_TOKEN and QUICKBOOKS_REALM_ID in .env or visit /api/quickbooks/connect');
    const err = new Error('QuickBooks not connected. Connect at /api/quickbooks/connect');
    err.code = 'QB_NOT_CONNECTED';
    throw err;
  }

  // Check if expired (with 60 second buffer)
  if (tokens.expires_at && Date.now() < tokens.expires_at - 60_000) {
    return tokens;
  }

  // Refresh the access token
  const res = await axios.post(
    'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    }).toString(),
    {
      headers: {
        Authorization: basicAuth(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
    }
  );

  const updated = {
    ...tokens,
    access_token: res.data.access_token,
    refresh_token: res.data.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + res.data.expires_in * 1000,
  };
  saveTokens(updated);
  return updated;
};

// Cache a QB response to disk
const saveCache = (name, data) => {
  const file = path.join(QB_CACHE_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({
    data,
    cachedAt: new Date().toISOString(),
  }, null, 2));
};

// Load a QB response from disk cache
const loadCache = (name) => {
  try {
    const file = path.join(QB_CACHE_DIR, `${name}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
};

// Fetch any QuickBooks Reports API report by name
const fetchReport = async (reportName, params = {}) => {
  const tokens = await getValidAccessToken();
  const res = await axios.get(
    `${getBaseUrl()}/v3/company/${tokens.realmId}/reports/${reportName}`,
    {
      params,
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: 'application/json',
      },
    }
  );
  return res.data;
};

// Fetch accounts from QB
const fetchAccounts = async () => {
  const tokens = await getValidAccessToken();
  const res = await axios.get(`${getBaseUrl()}/v3/company/${tokens.realmId}/query`, {
    params: { query: 'SELECT * FROM Account' },
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: 'application/json',
    },
  });
  return res.data.QueryResponse.Account || [];
};

// Fetch expenses from QB
const fetchExpenses = async () => {
  const tokens = await getValidAccessToken();
  const res = await axios.get(`${getBaseUrl()}/v3/company/${tokens.realmId}/query`, {
    params: { query: "SELECT * FROM Account WHERE AccountType='Expense'" },
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: 'application/json',
    },
  });
  return res.data.QueryResponse.Account || [];
};

// Fetch and cache all QB data
const refreshAllQBData = async () => {
  try {
    console.log('🔄 Refreshing QuickBooks cache...');

    const [profitAndLoss, accounts, expenses] = await Promise.all([
      (async () => {
        const today = new Date();
        const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
        const startDate = thirtyDaysAgo.toISOString().split('T')[0];
        const endDate = today.toISOString().split('T')[0];
        return fetchReport('ProfitAndLoss', {
          start_date: startDate,
          end_date: endDate,
        });
      })(),
      fetchAccounts(),
      fetchExpenses(),
    ]);

    // Save to disk cache
    saveCache('pl-30d', profitAndLoss);
    saveCache('accounts', accounts);
    saveCache('expenses', expenses);

    console.log('✅ QuickBooks cache refreshed successfully');
    return {
      success: true,
      cachedAt: new Date().toISOString(),
      items: ['pl-30d', 'accounts', 'expenses'],
    };
  } catch (err) {
    if (err.code === 'QB_NOT_CONNECTED') {
      console.log('⏸️  QB cache refresh skipped: QuickBooks not connected');
    } else {
      console.error('❌ QB cache refresh failed:', err.message);
      throw err;
    }
  }
};

module.exports = {
  refreshAllQBData,
  loadCache,
  saveCache,
  getValidAccessToken,
  fetchReport,
  fetchAccounts,
  fetchExpenses,
};
