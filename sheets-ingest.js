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
    const redirectUrl = process.env.GOOGLE_REDIRECT_URL || 'urn:ietf:wg:oauth:2.0:oob';

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
      // Need to do interactive login
      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
      });
      console.log('Authorize this app by visiting this url:', authUrl);

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      return new Promise((resolve, reject) => {
        rl.question('Enter the code from that page here: ', async (code) => {
          rl.close();
          try {
            const { tokens } = await oauth2Client.getToken(code);
            oauth2Client.setCredentials(tokens);
            fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
            this.auth = oauth2Client;
            this.sheets = google.sheets({ version: 'v4', auth: oauth2Client });
            this.drive = google.drive({ version: 'v3', auth: oauth2Client });
            resolve(oauth2Client);
          } catch (err) {
            reject(err);
          }
        });
      });
    }

    this.auth = oauth2Client;
    this.sheets = google.sheets({ version: 'v4', auth: oauth2Client });
    this.drive = google.drive({ version: 'v3', auth: oauth2Client });
    return oauth2Client;
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

  async fetchSheetData(spreadsheetId, sheetTitle) {
    const range = `'${sheetTitle}'`;
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    return response.data.values || [];
  }

  parseProductionSheet(values, sheetTitle) {
    const rows = [];
    if (!values || values.length === 0) return rows;

    let currentDate = null;
    let headerRowIndex = -1;
    let locationHeaders = [];

    // Scan for headers and dates
    for (let i = 0; i < values.length; i++) {
      const row = values[i];
      if (!row || row.length === 0) continue;

      const firstCell = (row[0] || '').toString().trim();

      // Check if this looks like a date header (e.g., "Monday 7/27/2026")
      if (this.looksLikeDate(firstCell)) {
        const parsed = this.parseDate(firstCell);
        if (parsed) currentDate = parsed;
      }

      // Check for header row (contains location names)
      if (this.isHeaderRow(row)) {
        headerRowIndex = i;
        locationHeaders = this.parseLocationHeaders(row);
      }

      // If we have a header row and current date, process product rows
      if (currentDate && headerRowIndex !== -1 && i > headerRowIndex) {
        const productName = firstCell;
        if (productName && !this.looksLikeDate(productName) && !this.isHeaderRow(row)) {
          rows.push(...this.parseProductRow(productName, currentDate, row, locationHeaders));
        }
      }
    }

    return rows;
  }

  looksLikeDate(str) {
    const datePattern = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+\d{1,2}\/\d{1,2}\/\d{4}$/i;
    return datePattern.test(str);
  }

  parseDate(dateStr) {
    const match = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (match) {
      const [, month, day, year] = match;
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    return null;
  }

  isHeaderRow(row) {
    if (!row || row.length < 2) return false;
    const headerIndicators = ['ORDER', 'SENT', 'SOLD', 'OVERAGE'];
    return row.some((cell) => headerIndicators.some((ind) => cell && cell.toString().toUpperCase().includes(ind)));
  }

  parseLocationHeaders(row) {
    const headers = [];
    let currentLocation = null;
    let orderIndex = -1;

    for (let i = 0; i < row.length; i++) {
      const cell = (row[i] || '').toString().trim().toUpperCase();

      // Check if this is a location name
      if (this.isLocationName(row[i])) {
        currentLocation = this.normalizeLocationName(row[i]);
      }

      // Track ORDER column index for this location
      if (cell === 'ORDER' && currentLocation) {
        orderIndex = i;
        headers.push({ location: currentLocation, orderIndex });
        currentLocation = null; // Reset for next location
      }
    }

    return headers;
  }

  isLocationName(str) {
    if (!str) return false;
    const normalized = this.normalizeLocationName(str);
    return Object.keys(LOCATION_MAPPINGS).includes(normalized);
  }

  normalizeLocationName(str) {
    if (!str) return '';
    return str.toString().trim().replace(/\s*\([^)]*\)\s*/g, '').trim();
  }

  parseProductRow(productName, date, row, locationHeaders) {
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

    const sheets = await this.findTotalProductionSheets();
    if (sheets.length === 0) {
      throw new Error('No "Total Production" sheets found in Google Drive');
    }

    console.log(`Found ${sheets.length} Total Production sheet(s)`);

    const allRows = [];

    for (const sheet of sheets) {
      console.log(`Fetching data from: ${sheet.name}`);
      try {
        const values = await this.fetchSheetData(sheet.id, sheet.name);
        const parsedRows = this.parseProductionSheet(values, sheet.name);
        allRows.push(...parsedRows);
        console.log(`  Parsed ${parsedRows.length} rows`);
      } catch (err) {
        console.error(`  Error fetching sheet ${sheet.name}:`, err.message);
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
}

module.exports = SheetsIngestor;
