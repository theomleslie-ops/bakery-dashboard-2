// Unified QuickBooks Online client for the Product Margins pipeline.
// Handles token load/refresh, SQL queries, Bill listing, and PDF attachment downloads.
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
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8')); } catch { return null; }
};

const saveTokens = (t) => {
  // Don't overwrite if tokens came from .env (they're managed there)
  if (t.source === 'env') return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2));
};

// Returns valid tokens (with realmId), refreshing the access token if within 60s of expiry.
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

// Run one QBO SQL query.
const query = async (sql) => {
  const t = await getValidTokens();
  const url = `${baseUrl()}/v3/company/${t.realmId}/query`;
  const res = await axios.get(url, {
    params: { query: sql, minorversion: 70 },
    headers: { Authorization: `Bearer ${t.access_token}`, Accept: 'application/json' },
  });
  return res.data.QueryResponse || {};
};

// List Bills for a vendor since a given date (paginated).
const listBills = async (vendorId, sinceDate) => {
  const bills = [];
  for (let start = 1; ; start += 100) {
    const sql = `select Id, DocNumber, TxnDate from Bill where VendorRef='${vendorId}' and TxnDate >= '${sinceDate}' ORDER BY TxnDate DESC STARTPOSITION ${start} MAXRESULTS 100`;
    const page = (await query(sql)).Bill || [];
    bills.push(...page);
    if (page.length < 100) break;
  }
  return bills;
};

// Download a bill's itemized invoice PDF (skip email-body attachments). Returns Buffer|null.
const downloadInvoicePdf = async (billId) => {
  const atts = (await query(`select * from Attachable where AttachableRef.EntityRef.Value = '${billId}'`)).Attachable || [];
  const pdf = atts.find((a) => /pdf/i.test(a.ContentType || '') && !/email/i.test(a.FileName || ''))
    || atts.find((a) => /pdf/i.test(a.ContentType || ''));
  if (!pdf) return null;
  const full = (await query(`select * from Attachable where Id = '${pdf.Id}'`)).Attachable?.[0];
  if (!full?.TempDownloadUri) return null;
  const res = await axios.get(full.TempDownloadUri, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
};

// Extract text from a PDF buffer.
const extractPdfText = async (buf) => {
  const { PDFParse } = require('pdf-parse');
  const parsed = await new PDFParse({ data: buf }).getText().catch(() => ({ text: '' }));
  return parsed.text || '';
};

// Look up a vendor by DisplayName pattern. Returns vendor record or null.
const findVendorByName = async (namePattern) => {
  const sql = `select Id, DisplayName from Vendor where DisplayName like '%${namePattern}%'`;
  const vendors = (await query(sql)).Vendor || [];
  return vendors.length > 0 ? vendors[0] : null;
};

module.exports = {
  getValidTokens,
  query,
  baseUrl,
  loadTokens,
  listBills,
  downloadInvoicePdf,
  extractPdfText,
  findVendorByName,
};
