const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/drive.readonly'];
const TOKEN_PATH = path.join(__dirname, '.env.local.json');

// Location name mappings from sheet column names to dashboard location names
const LOCATION_MAPPINGS = {
  '506 RETAIL': '506 Retail',
  'LSK': 'LSK',
  'LA STATE': 'State St',
  'ARC INSTITUTE': 'ARC',
};

class SheetsIngestor {
  constructor() {
    this.auth = null;
    this.sheets = null;
    this.drive = null;
  }

  async authorize() {
    if (this.auth) return this.auth;

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUrl = process.env.GOOGLE_REDIRECT_URL;

    if (!clientId || !clientSecret) {
      throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env');
    }

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUrl);

    // Check if we have a stored token
    let token = null;
    if (fs.existsSync(TOKEN_PATH)) {
      const tokenData = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
      token = tokenData;
    }

    if (token) {
      oauth2Client.setCredentials(token);
      // Check if token is expired and refresh if needed
      if (token.expiry_date && token.expiry_date < Date.now()) {
        const { credentials } = await oauth2Client.refreshAccessToken();
        token = credentials;
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(credentials, null, 2));
      }
    } else {
      throw new Error('Not authenticated. Call /api/sheets/auth to get the OAuth URL.');
    }

    this.auth = oauth2Client;
    this.sheets = google.sheets({ version: 'v4', auth: oauth2Client });
    this.drive = google.drive({ version: 'v3', auth: oauth2Client });
    return oauth2Client;
  }

  getAuthUrl() {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUrl = process.env.GOOGLE_REDIRECT_URL;

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUrl);
    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
    });
  }

  async exchangeCodeForToken(code) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUrl = process.env.GOOGLE_REDIRECT_URL;

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUrl);
    const { tokens } = await oauth2Client.getToken(code);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    return tokens;
  }

  async findTotalProductionSheets() {
    await this.authorize();

    const query = "name contains 'Total Production' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false";
    const response = await this.drive.files.list({
      q: query,
      spaces: 'drive',
      fields: 'files(id, name)',
      pageSize: 100,
    });

    return response.data.files || [];
  }


  parseProductionSheet(values, sheetTitle) {
    const rows = [];
    if (!values || values.length < 3) return rows; // Need at least date, headers, and one product row

    // Row 0 has the date and location names
    const dateRow = values[0];
    if (!dateRow || dateRow.length === 0) return rows;

    const dateStr = (dateRow[0] || '').toString().trim();
    const date = this.parseDate(dateStr);
    if (!date) return rows; // Can't parse the date

    // Row 1 has the column headers (ORDER, SENT, ST, #LO, SOLD, OVERAGE repeated)
    const headerRow = values[1];
    const locationHeaders = this.parseHorizontalLocationHeaders(dateRow, headerRow);

    // Rows 2+ have product data
    for (let i = 2; i < values.length; i++) {
      const row = values[i];
      if (!row || row.length === 0) continue;

      const productName = (row[0] || '').toString().trim();
      if (!productName) continue; // Skip empty product rows

      rows.push(...this.parseHorizontalProductRow(productName, date, row, locationHeaders));
    }

    return rows;
  }

  parseHorizontalLocationHeaders(dateRow, headerRow) {
    // Build a map of column indices to locations and which sub-column (ORDER, SENT, etc.)
    const headers = [];
    let currentLocationName = '';
    let currentLocationStart = -1;

    for (let col = 1; col < dateRow.length; col++) {
      const locationName = (dateRow[col] || '').toString().trim();
      const subHeader = (headerRow[col] || '').toString().trim().toUpperCase();

      // Track when we hit a new location (when location name changes from empty to non-empty)
      if (locationName && locationName !== currentLocationName) {
        currentLocationName = locationName;
        currentLocationStart = col;
      }

      // Track the ORDER column for this location
      if (subHeader === 'ORDER' && currentLocationName) {
        const mappedLocation = LOCATION_MAPPINGS[currentLocationName];
        if (mappedLocation) {
          headers.push({ location: currentLocationName, orderIndex: col });
        }
      }
    }

    return headers;
  }

  parseHorizontalProductRow(productName, date, row, locationHeaders) {
    const results = [];

    for (const { location, orderIndex } of locationHeaders) {
      const quantityStr = (row[orderIndex] || '').toString().trim();
      const quantity = this.parseQuantity(quantityStr);

      if (quantity !== null && quantity > 0) {
        const dashboardLocation = LOCATION_MAPPINGS[location];
        if (dashboardLocation) {
          results.push({
            date,
            item: productName,
            quantityProduced: quantity,
            location: dashboardLocation,
          });
        }
      }
    }

    return results;
  }

  parseDate(dateStr) {
    const match = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (match) {
      const [, month, day, year] = match;
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    return null;
  }

  parseQuantity(str) {
    if (!str || str === '') return 0;

    str = str.trim();

    // Handle mixed numbers like "1 1/3" or "5 2/3"
    const mixedMatch = str.match(/^(\d+)\s+(\d+)\/(\d+)$/);
    if (mixedMatch) {
      const [, whole, num, denom] = mixedMatch;
      return parseInt(whole) + parseInt(num) / parseInt(denom);
    }

    // Handle fractions like "1/3" or "2/3"
    const fracMatch = str.match(/^(\d+)\/(\d+)$/);
    if (fracMatch) {
      const [, num, denom] = fracMatch;
      return parseInt(num) / parseInt(denom);
    }

    // Handle plain numbers
    const num = parseFloat(str);
    return isNaN(num) ? null : num;
  }

  async ingestProductionData() {
    await this.authorize();

    const spreadsheetFiles = await this.findTotalProductionSheets();
    if (spreadsheetFiles.length === 0) {
      throw new Error('No "Total Production" sheets found in Google Drive');
    }

    console.log(`Found ${spreadsheetFiles.length} Total Production spreadsheet(s)`);

    const allRows = [];

    for (const file of spreadsheetFiles) {
      try {
        const values = await this.fetchAllDataFromSpreadsheet(file.id);
        const parsedRows = this.parseProductionSheet(values, file.name);
        allRows.push(...parsedRows);
      } catch (err) {
        console.error(`  Error fetching spreadsheet ${file.name}:`, err.message);
      }
    }

    // Aggregate by location, date, item
    const production = {};
    for (const row of allRows) {
      if (!production[row.location]) {
        production[row.location] = [];
      }
      production[row.location].push({
        date: row.date,
        item: row.item,
        quantityProduced: row.quantityProduced,
      });
    }

    return production;
  }

  async fetchAllDataFromSpreadsheet(spreadsheetId) {
    try {
      // Get metadata to find the first sheet
      const metadata = await this.sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets(properties(title))',
      });

      if (!metadata.data.sheets || metadata.data.sheets.length === 0) {
        throw new Error('No sheets found in spreadsheet');
      }

      const firstSheetName = metadata.data.sheets[0].properties.title;

      // Fetch all data from the first sheet using its name
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `'${firstSheetName}'!A:Z`,
      });

      return response.data.values || [];
    } catch (err) {
      throw err;
    }
  }
}

module.exports = SheetsIngestor;
