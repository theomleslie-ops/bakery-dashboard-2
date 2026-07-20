// Google Sheets/Drive client for the data pipeline — authenticated AS THE USER via OAuth 2.0
// (mirrors the QuickBooks OAuth flow in server.js), NOT a service account.
//
// Why OAuth: the recipe sheets live in a private Drive folder the bakery owns. An API key has no
// user identity, so it can't read private files or list a folder; a service account works only for
// files explicitly shared to its email (and was buggy in practice). OAuth acts as the signed-in
// user, so their own folder + every private sheet inside it is readable with no sharing changes.
//
// Tokens are stored in data/google-tokens.json and auto-refreshed. Until the user connects once
// (via /api/google/connect), getClients() throws GOOGLE_NOT_CONNECTED and callers skip the Sheets
// step cleanly.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TOKENS_FILE = path.join(DATA_DIR, 'google-tokens.json');

// drive.readonly → list the recipe folder + read file metadata; spreadsheets.readonly → read values.
const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
];

const getRedirectUri = () =>
  process.env.GOOGLE_REDIRECT_URI || `http://localhost:${process.env.PORT || 3001}/api/google/callback`;

const loadTokens = () => {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8')); } catch { return null; }
};
const saveTokens = (tokens) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
};

const hasCredentials = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const isConnected = () => !!(loadTokens()?.refresh_token);

// Build an OAuth2 client from env credentials. If withTokens, load stored tokens and persist any
// refreshed access/refresh token the library hands back (the 'tokens' event fires on auto-refresh).
const makeOAuthClient = (withTokens = true) => {
  const { google } = require('googleapis'); // lazy — QB-only runs don't need googleapis installed
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    getRedirectUri()
  );
  if (withTokens) {
    const stored = loadTokens();
    if (!stored || !stored.refresh_token) {
      const err = new Error('Google not connected. Visit /api/google/connect to authorize.');
      err.code = 'GOOGLE_NOT_CONNECTED';
      throw err;
    }
    client.setCredentials(stored);
    client.on('tokens', (t) => {
      const merged = { ...loadTokens(), ...t };
      // Google only returns a refresh_token on the first consent; never overwrite it with undefined.
      if (!t.refresh_token && stored.refresh_token) merged.refresh_token = stored.refresh_token;
      saveTokens(merged);
    });
  }
  return client;
};

// --- OAuth flow helpers (used by the server routes) ---
const getAuthUrl = () =>
  makeOAuthClient(false).generateAuthUrl({
    access_type: 'offline',      // request a refresh_token
    prompt: 'consent',           // force refresh_token even on re-auth
    scope: SCOPES,
  });

const exchangeCodeForTokens = async (code) => {
  const client = makeOAuthClient(false);
  const { tokens } = await client.getToken(code);
  saveTokens({ ...tokens, connectedAt: new Date().toISOString() });
  return tokens;
};

const disconnect = () => { if (fs.existsSync(TOKENS_FILE)) fs.unlinkSync(TOKENS_FILE); };

// --- Authenticated API clients ---
const getClients = async () => {
  const { google } = require('googleapis');
  const auth = makeOAuthClient(true);
  return {
    sheets: google.sheets({ version: 'v4', auth }),
    drive: google.drive({ version: 'v3', auth }),
  };
};

// Every spreadsheet the user can see, newest first.
const listSpreadsheets = async (drive) => {
  const files = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
      fields: 'nextPageToken, files(id, name, modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: 200, includeItemsFromAllDrives: true, supportsAllDrives: true, pageToken,
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
};

// Resolve a spreadsheet by (case-insensitive) name → { id, name }.
const resolveByName = async (drive, name) => {
  const all = await listSpreadsheets(drive);
  const q = String(name).trim().toLowerCase();
  const exact = all.filter((f) => f.name.toLowerCase() === q);
  const partial = all.filter((f) => f.name.toLowerCase().includes(q));
  const matches = exact.length ? exact : partial;
  if (matches.length === 1) return { id: matches[0].id, name: matches[0].name };
  if (matches.length === 0) {
    const err = new Error(`No sheet named like "${name}".`);
    err.code = 'SHEET_NOT_FOUND';
    throw err;
  }
  const err = new Error(`"${name}" is ambiguous — matches: ${matches.map((f) => f.name).join(', ')}.`);
  err.code = 'SHEET_AMBIGUOUS';
  throw err;
};

// Resolve a Drive folder by (fuzzy) name → { id, name }.
const resolveFolderByName = async (drive, name) => {
  const all = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: 'nextPageToken, files(id, name)',
      pageSize: 200, includeItemsFromAllDrives: true, supportsAllDrives: true, pageToken,
    });
    all.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  const q = String(name).trim().toLowerCase();
  const exact = all.filter((f) => f.name.toLowerCase() === q);
  const partial = all.filter((f) => f.name.toLowerCase().includes(q));
  const matches = exact.length ? exact : partial;
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    const visible = all.map((f) => f.name).join(', ') || '(none visible)';
    const err = new Error(`No folder named like "${name}". Folders I can see: ${visible}`);
    err.code = 'FOLDER_NOT_FOUND';
    throw err;
  }
  const err = new Error(`Folder "${name}" is ambiguous — matches: ${matches.map((f) => f.name).join(', ')}.`);
  err.code = 'FOLDER_AMBIGUOUS';
  throw err;
};

// Every spreadsheet directly inside a folder → [{ id, name }].
const listSheetsInFolder = async (drive, folderId) => {
  const files = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.spreadsheet' and '${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id, name)',
      orderBy: 'name', pageSize: 200, includeItemsFromAllDrives: true, supportsAllDrives: true, pageToken,
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
};

// A1 range for a whole tab; single-quote and escape the title so tabs with spaces/quotes work.
const tabRange = (name) => `'${String(name).replace(/'/g, "''")}'`;

// Pull every tab of one spreadsheet in a single batch call.
// Returns { id, title, tabs: { <tabName>: { rows, rowCount, colCount } } }
const pullSpreadsheet = async (sheets, spreadsheetId) => {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'properties.title,sheets.properties(title,sheetId,gridProperties)',
  });
  const title = meta.data.properties.title;
  const tabNames = (meta.data.sheets || []).map((s) => s.properties.title);

  const tabs = {};
  if (tabNames.length) {
    const resp = await sheets.spreadsheets.values.batchGet({
      spreadsheetId,
      ranges: tabNames.map(tabRange),
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    });
    (resp.data.valueRanges || []).forEach((vr, i) => {
      const rows = vr.values || [];
      tabs[tabNames[i]] = { rows, rowCount: rows.length, colCount: rows.reduce((m, r) => Math.max(m, r.length), 0) };
    });
  }
  return { id: spreadsheetId, title, tabs };
};

module.exports = {
  TOKENS_FILE, SCOPES,
  hasCredentials, isConnected, loadTokens, saveTokens, disconnect,
  getAuthUrl, exchangeCodeForTokens, getRedirectUri,
  getClients, listSpreadsheets, resolveByName, resolveFolderByName, listSheetsInFolder, pullSpreadsheet,
};
