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
  // Priority 1: Check persistent tokens file first (from OAuth authorization, always fresh)
  try {
    const fileTokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
    if (fileTokens && fileTokens.refresh_token) {
      return fileTokens;
    }
  } catch (e) {
    // File doesn't exist or is invalid - continue to env vars
  }

  // Priority 2: Fall back to .env vars (for initial setup)
  if (process.env.QUICKBOOKS_REFRESH_TOKEN && process.env.QUICKBOOKS_REALM_ID) {
    return {
      refresh_token: process.env.QUICKBOOKS_REFRESH_TOKEN,
      realmId: process.env.QUICKBOOKS_REALM_ID,
      access_token: null, // Will be fetched on first use
      expires_at: 0, // Force immediate refresh
      source: 'env',
    };
  }

  return null;
};

const saveTokens = (t) => {
  // Always save to persistent file, even if sourced from env. Once rotated/refreshed,
  // drop the 'source: env' tag so subsequent loads never fall back to stale env vars.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const toSave = { ...t };
  if (toSave.source === 'env') {
    toSave.source = 'oauth';
  }
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(toSave, null, 2));
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
  try {
    const attQuery = `select * from Attachable where AttachableRef.EntityRef.Value = '${billId}'`;
    const attResponse = await query(attQuery);
    const atts = attResponse.Attachable || [];

    console.log(`    [PDF] Bill ${billId}: Query returned ${atts.length} attachments`);
    if (atts.length === 0) {
      return null;
    }

    atts.forEach(att => {
      console.log(`      - ${att.FileName} (${att.ContentType || 'unknown'}) [ID: ${att.Id}]`);
    });

    const pdf = atts.find((a) => /pdf/i.test(a.ContentType || '') && !/email/i.test(a.FileName || ''))
      || atts.find((a) => /pdf/i.test(a.ContentType || ''));

    if (!pdf) {
      console.log(`    [PDF] Bill ${billId}: No PDF found (filtered by ContentType)`);
      return null;
    }

    console.log(`    [PDF] Bill ${billId}: Found PDF: ${pdf.FileName}`);
    const full = (await query(`select * from Attachable where Id = '${pdf.Id}'`)).Attachable?.[0];
    if (!full?.TempDownloadUri) {
      console.log(`    [PDF] Bill ${billId}: No TempDownloadUri for ${pdf.FileName}`);
      return null;
    }

    console.log(`    [PDF] Bill ${billId}: Downloading from URI...`);
    const res = await axios.get(full.TempDownloadUri, { responseType: 'arraybuffer', timeout: 30000 });
    console.log(`    [PDF] Bill ${billId}: ✓ Downloaded ${res.data.length} bytes`);
    return Buffer.from(res.data);
  } catch (e) {
    console.log(`    [PDF] Bill ${billId}: Error - ${e.message}`);
    return null;
  }
};

// Extract text from a PDF buffer using pdfjs-dist (works in Node.js)
const extractPdfText = async (buf) => {
  try {
    const pdfjsLib = require('pdfjs-dist');
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let text = '';

    for (let i = 0; i < pdf.numPages; i++) {
      const page = await pdf.getPage(i + 1);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => item.str || '').join(' ');
      text += pageText + '\n';
    }

    return text;
  } catch (e) {
    console.warn(`  PDF text extraction error: ${e.message}`);
    return '';
  }
};

// Look up a vendor by DisplayName pattern. Returns vendor record or null.
const findVendorByName = async (namePattern) => {
  const sql = `select Id, DisplayName from Vendor where DisplayName like '%${namePattern}%'`;
  const vendors = (await query(sql)).Vendor || [];
  return vendors.length > 0 ? vendors[0] : null;
};

const hasCredentials = () => !!(process.env.QUICKBOOKS_CLIENT_ID && process.env.QUICKBOOKS_CLIENT_SECRET);

const disconnect = () => {
  try {
    if (fs.existsSync(TOKENS_FILE)) fs.unlinkSync(TOKENS_FILE);
  } catch (e) {
    console.warn('Failed to disconnect QB:', e.message);
  }
};

const exchangeCodeForTokens = async (code, realmId) => {
  if (!hasCredentials()) {
    throw new Error('QB app credentials not configured (QUICKBOOKS_CLIENT_ID / QUICKBOOKS_CLIENT_SECRET)');
  }
  const redirectUri = process.env.QUICKBOOKS_REDIRECT_URI || `http://localhost:${process.env.PORT || 3001}/api/quickbooks/callback`;
  const res = await axios.post(
    TOKEN_URL,
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString(),
    { headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } }
  );
  const tokens = {
    access_token: res.data.access_token,
    refresh_token: res.data.refresh_token,
    expires_at: Date.now() + res.data.expires_in * 1000,
    realmId,
    connectedAt: new Date().toISOString(),
    last_refreshed: new Date().toISOString(),
    source: 'oauth',
  };
  saveTokens(tokens);
  return tokens;
};

// Fetch a single Bill by ID with full detail including all Line items
const getBillDetail = async (billId) => {
  const sql = `SELECT * FROM Bill WHERE Id = '${billId}'`;
  const response = await query(sql);
  const bill = (response.Bill || [])[0];
  return bill || null;
};

module.exports = {
  getValidTokens,
  query,
  baseUrl,
  loadTokens,
  saveTokens,
  listBills,
  getBillDetail,
  downloadInvoicePdf,
  extractPdfText,
  findVendorByName,
  hasCredentials,
  disconnect,
  exchangeCodeForTokens,
};
