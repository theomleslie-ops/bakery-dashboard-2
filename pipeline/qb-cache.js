const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const qbClient = require('./qb-client');

const DATA_DIR = path.join(__dirname, '..', 'data');
const QB_CACHE_DIR = path.join(DATA_DIR, 'qb-cache');

// Ensure cache directory exists
if (!fs.existsSync(QB_CACHE_DIR)) {
  fs.mkdirSync(QB_CACHE_DIR, { recursive: true });
}

const QB_ERROR_FILE = path.join(DATA_DIR, 'qb-token-error.json');

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

const loadTokens = () => qbClient.loadTokens();

// Returns valid tokens (incl. realmId), refreshing the access token if expired.
const getValidAccessToken = async () => {
  try {
    const tokens = await qbClient.getValidTokens();
    clearTokenError();
    return tokens;
  } catch (err) {
    const isExpiredToken = err.response?.data?.error === 'invalid_grant' &&
      (err.response?.data?.error_description || '').includes('Incorrect or invalid refresh token');

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
  const url = `${qbClient.baseUrl()}/v3/company/${tokens.realmId}/reports/${reportName}`;
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
  const res = await axios.get(`${qbClient.baseUrl()}/v3/company/${tokens.realmId}/query`, {
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
  const res = await axios.get(`${qbClient.baseUrl()}/v3/company/${tokens.realmId}/query`, {
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
    } else if (err.code === 'QB_TOKEN_EXPIRED') {
      console.error('❌ QB token expired - automatic re-auth needed');
      throw err;
    } else {
      console.error('❌ QB cache refresh failed:', err.message);
      throw err;
    }
  }
};

// Check if refresh token is approaching expiry (within 7 days of QB's ~100-day limit)
// QB refresh tokens don't have explicit expiry, but with rotation they stay fresh
// This monitors for unusual patterns that might indicate expiry
const checkTokenHealth = () => {
  const tokens = loadTokens();
  if (!tokens) return { healthy: false, reason: 'no_tokens' };

  // Token is healthy if it was recently refreshed (within last 90 days)
  if (tokens.last_refreshed) {
    const daysSinceRefresh = (Date.now() - new Date(tokens.last_refreshed).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceRefresh > 100) {
      console.warn('⚠️  QB token hasn\'t been refreshed in 100+ days - may be stale');
      return { healthy: false, reason: 'stale_token', daysSinceRefresh };
    }
  }

  return { healthy: true };
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
  checkTokenHealth,
  loadTokens,
};
