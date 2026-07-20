// Minimal QuickBooks Online client for the pipeline. Reuses the OAuth tokens the web app already
// stores (data/quickbooks-tokens.json) and refreshes the access token the same way server.js does,
// but runs standalone so the pipeline needs no running Express server. Exposes just what the
// Chef's Warehouse price extractor needs: a raw SQL-ish `query` and an authed token accessor.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const DATA_DIR = path.join(__dirname, '..', 'data');
const TOKENS_FILE = path.join(DATA_DIR, 'quickbooks-tokens.json');
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

const baseUrl = () =>
  process.env.QUICKBOOKS_ENVIRONMENT === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';

const basicAuth = () =>
  `Basic ${Buffer.from(`${process.env.QUICKBOOKS_CLIENT_ID}:${process.env.QUICKBOOKS_CLIENT_SECRET}`).toString('base64')}`;

const loadTokens = () => {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8')); } catch { return null; }
};
const saveTokens = (t) => fs.writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2));

// Valid tokens (incl. realmId), refreshing the access token if it is within 60s of expiry.
const getValidTokens = async () => {
  const tokens = loadTokens();
  if (!tokens || !tokens.refresh_token) {
    const err = new Error('QuickBooks not connected. Connect once via the app: /api/quickbooks/connect.');
    err.code = 'QB_NOT_CONNECTED';
    throw err;
  }
  if (tokens.expires_at && Date.now() < tokens.expires_at - 60_000) return tokens;

  const res = await axios.post(
    TOKEN_URL,
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

// Run one QBO SQL query (https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/data-queries).
const query = async (sql) => {
  const t = await getValidTokens();
  const url = `${baseUrl()}/v3/company/${t.realmId}/query`;
  const res = await axios.get(url, {
    params: { query: sql, minorversion: 70 },
    headers: { Authorization: `Bearer ${t.access_token}`, Accept: 'application/json' },
  });
  return res.data.QueryResponse || {};
};

module.exports = { getValidTokens, query, baseUrl, loadTokens };
