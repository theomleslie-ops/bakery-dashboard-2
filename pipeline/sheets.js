// Google Sheets client for the data pipeline. Uses a service-account key (read-only) so it runs
// headless — no browser consent. Sheets are referenced BY NAME: the Drive API resolves a name to
// an ID, so you never deal with URLs. The service account can only see sheets that have been shared
// with it (share a single Drive folder with it and every sheet inside becomes discoverable).
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CREDS_FILE = path.join(DATA_DIR, 'google-service-account.json');

// spreadsheets.readonly → read values; drive.metadata.readonly → look sheets up by name.
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
];

const hasCredentials = () => fs.existsSync(CREDS_FILE);

const getClients = async () => {
  const { google } = require('googleapis'); // lazy — QB-only runs don't need googleapis installed
  const auth = new google.auth.GoogleAuth({ keyFile: CREDS_FILE, scopes: SCOPES });
  const authClient = await auth.getClient();
  return {
    sheets: google.sheets({ version: 'v4', auth: authClient }),
    drive: google.drive({ version: 'v3', auth: authClient }),
  };
};

// Every spreadsheet the service account can see (i.e. that's been shared with it), newest first.
const listSpreadsheets = async (drive) => {
  const files = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
      fields: 'nextPageToken, files(id, name, modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: 200,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      pageToken,
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
};

// Resolve a spreadsheet by (case-insensitive) name → { id, name }. Prefers an exact match, falls
// back to a unique "contains" match, and throws a helpful error if it's missing or ambiguous.
const resolveByName = async (drive, name) => {
  const all = await listSpreadsheets(drive);
  const q = String(name).trim().toLowerCase();
  const exact = all.filter((f) => f.name.toLowerCase() === q);
  const partial = all.filter((f) => f.name.toLowerCase().includes(q));
  const matches = exact.length ? exact : partial;

  if (matches.length === 1) return { id: matches[0].id, name: matches[0].name };
  if (matches.length === 0) {
    const visible = all.map((f) => f.name).join(', ') || '(none — has it been shared with the service account?)';
    const err = new Error(`No sheet named like "${name}". Sheets I can see: ${visible}`);
    err.code = 'SHEET_NOT_FOUND';
    throw err;
  }
  const err = new Error(`"${name}" is ambiguous — matches: ${matches.map((f) => f.name).join(', ')}. Be more specific.`);
  err.code = 'SHEET_AMBIGUOUS';
  throw err;
};

// Resolve a Drive folder by (fuzzy) name → { id, name }. The folder itself must be shared with
// the service account (sharing individual sheets does not make their folder visible).
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
    const visible = all.map((f) => f.name).join(', ') || '(none — share the folder itself with the service account)';
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

module.exports = { hasCredentials, getClients, listSpreadsheets, resolveByName, resolveFolderByName, listSheetsInFolder, pullSpreadsheet, CREDS_FILE };
