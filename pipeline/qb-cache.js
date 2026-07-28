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

const QB_ERROR_FILE = path.join(DATA_DIR, 'qb-token-error.json');

const getBaseUrl = () =>
  process.env.QUICKBOOKS_ENVIRONMENT === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';

const saveTokenError = (error) => {
  try {
    fs.writeFileSync(QB_ERROR_FILE, JSON.stringify(error, null, 2));
  } catch (e) {
    console.warn('Failed to save QB token error:', e.message);
  }
};

const getTokenError = () => {
  try {
    if (fs.existsSync(QB_ERROR_FILE)) {
      return JSON.parse(fs.readFileSync(QB_ERROR_FILE, 'utf-8'));
    }
  } catch (e) {
    console.warn('Failed to load QB token error:', e.message);
  }
  return null;
};

const clearTokenError = () => {
  try {
    if (fs.existsSync(QB_ERROR_FILE)) {
      fs.unlinkSync(QB_ERROR_FILE);
    }
  } catch (e) {
    console.warn('Failed to clear QB token error:', e.message);
  }
};

const basicAuth = () =>
  `Basic ${Buffer.from(`${process.env.QUICKBOOKS_CLIENT_ID}:${process.env.QUICKBOOKS_CLIENT_SECRET}`).toString('base64')}`;

const loadTokens = () => {
  // Priority 1: Load from persistent file (survives restarts/redeploys)
  try {
    const fileTokens = JSON.parse(fs.readFileSync(QB_TOKENS_FILE, 'utf-8'));
    if (fileTokens && fileTokens.refresh_token) {
      return fileTokens;
    }
  } catch (e) {
    // File doesn't exist or is invalid - continue to env vars
  }

  // Priority 2: Check env vars (used for initial setup or testing)
  const refreshToken = process.env.QUICKBOOKS_REFRESH_TOKEN;
  const realmId = process.env.QUICKBOOKS_REALM_ID || process.env.QB_REALM_ID;

  if (refreshToken && realmId) {
    // Found in env - save to file so it persists
    const tokens = {
      refresh_token: refreshToken,
      realmId: realmId,
      access_token: null,
      expires_at: 0,
      source: 'env',
    };
    saveTokens(tokens);
    return tokens;
  }

  return null;
};

const saveTokens = (t) => {
  try {
    fs.writeFileSync(QB_TOKENS_FILE, JSON.stringify(t, null, 2));
    console.log('✅ QB tokens persisted to file');
  } catch (e) {
    console.error('❌ Failed to save QB tokens to file:', e.message);
  }
};

// Returns valid tokens (incl. realmId), refreshing the access token if expired.
const getValidAccessToken = async () => {
  const tokens = loadTokens();
  if (!tokens || !tokens.refresh_token) {
    const err = new Error('QuickBooks not connected. Set QUICKBOOKS_REFRESH_TOKEN and QUICKBOOKS_REALM_ID in .env or visit /api/quickbooks/connect');
    err.code = 'QB_NOT_CONNECTED';
    throw err;
  }

  // Check if expired (with 60 second buffer)
  if (tokens.expires_at && Date.now() < tokens.expires_at - 60_000) {
    return tokens;
  }

  // Refresh the access token
  console.log('Refreshing QB access token...');
  let res;
  try {
    res = await axios.post(
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
    console.log('✅ QB token refresh successful');
    // Clear any previous error state
    clearTokenError();
  } catch (err) {
    const errorMsg = err.response?.data?.error_description || err.message;
    const isExpiredToken = err.response?.data?.error === 'invalid_grant' && errorMsg.includes('Incorrect or invalid refresh token');

    console.error('❌ QB token refresh failed:', {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message,
    });

    // If refresh token is invalid/expired, save error state and throw special error
    if (isExpiredToken) {
      saveTokenError({
        type: 'token_expired',
        message: 'QuickBooks refresh token expired. Please reconnect.',
        timestamp: new Date().toISOString(),
      });
      err.code = 'QB_TOKEN_EXPIRED';
    }

    throw err;
  }

  const updated = {
    ...tokens,
    access_token: res.data.access_token,
    refresh_token: res.data.refresh_token || tokens.refresh_token, // QB rotates tokens, use new one if provided
    expires_at: Date.now() + res.data.expires_in * 1000,
    realmId: tokens.realmId,
    last_refreshed: new Date().toISOString(),
  };

  // Always persist refreshed tokens - critical for long-term stability
  saveTokens(updated);

  // Also update env var so it stays in sync
  process.env.QUICKBOOKS_REFRESH_TOKEN = updated.refresh_token;
  process.env.QUICKBOOKS_REALM_ID = updated.realmId;

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
  const url = `${getBaseUrl()}/v3/company/${tokens.realmId}/reports/${reportName}`;
  console.log(`Fetching QB report: ${reportName}`, {
    url,
    realmId: tokens.realmId,
    params,
    hasAccessToken: !!tokens.access_token
  });
  try {
    const res = await axios.get(url, {
      params,
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: 'application/json',
      },
    });
    console.log(`✅ QB report ${reportName} fetched successfully`);
    return res.data;
  } catch (err) {
    console.error(`❌ QB report fetch failed for ${reportName}:`, {
      url,
      status: err.response?.status,
      statusText: err.response?.statusText,
      data: err.response?.data,
      message: err.message,
    });
    throw err;
  }
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

// Check if cache is populated
const isCachePopulated = () => {
  return loadCache('pl-30d') && loadCache('accounts') && loadCache('expenses');
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

// Warm up cache on startup if empty
const warmupCacheOnStartup = async () => {
  if (isCachePopulated()) {
    console.log('✅ QB cache already populated');
    return;
  }
  try {
    await refreshAllQBData();
  } catch (err) {
    console.log('⏸️  QB cache warmup skipped on startup (QB not connected yet)');
  }
};

module.exports = {
  refreshAllQBData,
  warmupCacheOnStartup,
  isCachePopulated,
  loadCache,
  saveCache,
  getValidAccessToken,
  fetchReport,
  fetchAccounts,
  fetchExpenses,
  getTokenError,
  clearTokenError,
};
