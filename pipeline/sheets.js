// Google Sheets client for the data pipeline. Uses a service-account key (read-only) so it runs
// headless — no browser consent. Activates automatically once data/google-service-account.json
// exists and sheets are listed in config.js. Pulls every tab of each spreadsheet.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CREDS_FILE = path.join(DATA_DIR, 'google-service-account.json');

const hasCredentials = () => fs.existsSync(CREDS_FILE);

const getSheetsClient = async () => {
  const { google } = require('googleapis'); // lazy — so QB-only runs don't need googleapis installed
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDS_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
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

module.exports = { hasCredentials, getSheetsClient, pullSpreadsheet, CREDS_FILE };
