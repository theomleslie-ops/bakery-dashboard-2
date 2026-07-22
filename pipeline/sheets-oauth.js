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
  // Check .env first for pre-configured tokens (auto-auth, no user sign-in needed)
  if (process.env.GOOGLE_REFRESH_TOKEN) {
    return {
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      access_token: null, // Will be fetched on first use
      expiry_date: 0, // Force immediate refresh
      source: 'env',
    };
  }
  // Fall back to tokens file
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8')); } catch { return null; }
};

const saveTokens = (tokens) => {
  // Don't overwrite if tokens came from .env (they're managed there)
  if (tokens.source === 'env') return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
};

const hasCredentials = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const isConnected = () => !!(loadTokens()?.refresh_token);

const makeOAuthClient = (withTokens = true) => {
  const { google } = require('googleapis');
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
      if (!t.refresh_token && stored.refresh_token) merged.refresh_token = stored.refresh_token;
      saveTokens(merged);
    });
  }
  return client;
};

const getAuthUrl = () =>
  makeOAuthClient(false).generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

const exchangeCodeForTokens = async (code) => {
  const client = makeOAuthClient(false);
  const { tokens } = await client.getToken(code);
  saveTokens({ ...tokens, connectedAt: new Date().toISOString() });
  return tokens;
};

const disconnect = () => { if (fs.existsSync(TOKENS_FILE)) fs.unlinkSync(TOKENS_FILE); };

const getClients = async () => {
  const { google } = require('googleapis');
  const auth = makeOAuthClient(true);
  return {
    sheets: google.sheets({ version: 'v4', auth }),
    drive: google.drive({ version: 'v3', auth }),
  };
};

const resolveFolderByName = async (drive, name) => {
  const all = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: 'nextPageToken, files(id, name)',
      pageSize: 200,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      pageToken,
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

const listSheetsInFolder = async (drive, folderId) => {
  const sheets = [];

  const collectFromFolder = async (parentId) => {
    let pageToken;
    do {
      const res = await drive.files.list({
        q: `'${parentId}' in parents and trashed=false`,
        fields: 'nextPageToken, files(id, name, mimeType)',
        pageSize: 200,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        pageToken,
      });
      for (const file of (res.data.files || [])) {
        if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
          sheets.push({ id: file.id, name: file.name, isExcel: false });
        } else if (file.mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || file.mimeType === 'application/vnd.ms-excel') {
          sheets.push({ id: file.id, name: file.name, isExcel: true });
        } else if (file.mimeType === 'application/vnd.google-apps.folder') {
          await collectFromFolder(file.id);
        }
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  };

  await collectFromFolder(folderId);
  sheets.sort((a, b) => a.name.localeCompare(b.name));
  return sheets;
};

const tabRange = (name) => `'${String(name).replace(/'/g, "''")}'`;

const downloadAndParseExcel = async (drive, fileId, fileName) => {
  const { Readable } = require('stream');
  const buffers = [];
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

  for await (const chunk of res.data) {
    buffers.push(chunk);
  }
  const buffer = Buffer.concat(buffers);

  const { read: readExcel } = require('xlsx');
  const workbook = readExcel(buffer);
  const title = fileName.replace(/\.[^.]+$/, '');

  const tabs = {};
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = [];
    for (let i = 0; ; i++) {
      const row = [];
      let hasData = false;
      for (let j = 0; j < 50; j++) {
        const cell = sheet[String.fromCharCode(65 + j) + (i + 1)];
        const val = cell ? cell.v : '';
        row.push(val);
        if (val != null && val !== '') hasData = true;
      }
      if (!hasData && i > 10) break;
      if (hasData || i < 2) rows.push(row);
    }
    const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
    tabs[sheetName] = { rows, rowCount: rows.length, colCount };
  }

  return { id: fileId, title, tabs };
};

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
  TOKENS_FILE,
  SCOPES,
  hasCredentials,
  isConnected,
  loadTokens,
  saveTokens,
  disconnect,
  getAuthUrl,
  exchangeCodeForTokens,
  getRedirectUri,
  getClients,
  resolveFolderByName,
  listSheetsInFolder,
  pullSpreadsheet,
  downloadAndParseExcel,
};
