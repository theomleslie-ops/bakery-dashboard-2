// Self-contained QuickBooks report client for the data pipeline.
// Reuses the same OAuth tokens the web app stores (data/quickbooks-tokens.json) and the same
// refresh flow as server.js, but runs standalone — no Express server needs to be running.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const DATA_DIR = path.join(__dirname, '..', 'data');
const QB_TOKENS_FILE = path.join(DATA_DIR, 'quickbooks-tokens.json');
const QB_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

const getBaseUrl = () =>
  process.env.QUICKBOOKS_ENVIRONMENT === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';

const basicAuth = () =>
  `Basic ${Buffer.from(`${process.env.QUICKBOOKS_CLIENT_ID}:${process.env.QUICKBOOKS_CLIENT_SECRET}`).toString('base64')}`;

const loadTokens = () => {
  // Check .env first for pre-configured tokens (auto-auth, no user sign-in needed)
  if (process.env.QUICKBOOKS_REFRESH_TOKEN && process.env.QUICKBOOKS_REALM_ID) {
    return {
      refresh_token: process.env.QUICKBOOKS_REFRESH_TOKEN,
      realmId: process.env.QUICKBOOKS_REALM_ID,
      access_token: null, // Will be fetched on first use
      expires_at: 0, // Force immediate refresh
      source: 'env',
    };
  }
  // Fall back to tokens file
  try { return JSON.parse(fs.readFileSync(QB_TOKENS_FILE, 'utf-8')); } catch { return null; }
};
const saveTokens = (t) => {
  // Don't overwrite if tokens came from .env (they're managed there)
  if (t.source === 'env') return;
  fs.writeFileSync(QB_TOKENS_FILE, JSON.stringify(t, null, 2));
};

// Returns valid tokens (incl. realmId), refreshing the access token if it has expired.
const getValidAccessToken = async () => {
  const tokens = loadTokens();
  if (!tokens || !tokens.refresh_token) {
    const err = new Error('QuickBooks not connected. Connect it once via the app: visit /api/quickbooks/connect.');
    err.code = 'QB_NOT_CONNECTED';
    throw err;
  }
  if (tokens.expires_at && Date.now() < tokens.expires_at - 60_000) return tokens;

  const res = await axios.post(
    QB_TOKEN_URL,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }).toString(),
    { headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } }
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

// Fetch any QuickBooks Reports API report by name, e.g. 'ProfitAndLoss', 'BalanceSheet', 'CashFlow'.
// params are passed straight through (start_date, end_date, summarize_column_by, accounting_method, …).
const fetchReport = async (reportName, params = {}) => {
  const tokens = await getValidAccessToken();
  const res = await axios.get(
    `${getBaseUrl()}/v3/company/${tokens.realmId}/reports/${reportName}`,
    { params, headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' } }
  );
  return res.data;
};

module.exports = { fetchReport, getValidAccessToken, loadTokens };
