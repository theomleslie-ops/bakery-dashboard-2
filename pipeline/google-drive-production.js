// Fetches production data from "Little Sky Production Data" Google Drive folder
// and parses it into the production.json format
const sheetsOauth = require('./sheets-oauth');

const PRODUCTION_FOLDER_NAME = 'Little Sky Production Data';
const WASTE_STORE_LOCATIONS = ['ARC', 'LSK', 'State St', 'Catering', 'Delivery 506', '506 Retail'];

// Parse the dates from folder name like "8/3/2026-8/9/2026 Baker Spreadsheets"
const extractDateRange = (folderName) => {
  const match = folderName.match(/^(\d+\/\d+\/\d+)-(\d+\/\d+\/\d+)/);
  if (!match) return null;
  const start = new Date(match[1]);
  const end = new Date(match[2]);
  return { start, end, folderName };
};

// Find the latest weekly production folder
const findLatestProductionFolder = async (drive) => {
  const prodFolder = await sheetsOauth.resolveFolderByName(drive, PRODUCTION_FOLDER_NAME);

  // List all subfolders to find the one with latest date
  let pageToken;
  const folders = [];
  do {
    const res = await drive.files.list({
      q: `'${prodFolder.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 100,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      pageToken,
    });
    folders.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  // Parse dates and find latest
  const dated = folders.map(f => ({ ...extractDateRange(f.name), folderId: f.id }))
    .filter(d => d.start && d.end);

  if (!dated.length) throw new Error('No dated production folders found');

  dated.sort((a, b) => b.end - a.end);
  const latest = dated[0];
  return latest.folderId;
};

// Find the production sheet from a folder
const findProductionSheet = async (drive, folderId) => {
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
      fields: 'nextPageToken, files(id, name)',
      pageSize: 100,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      pageToken,
    });

    for (const file of (res.data.files || [])) {
      if (file.name.includes('Total Production')) {
        return file.id;
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  throw new Error('Sheet "Total Production" not found');
};

// Parse the sheet data into production format per location
const parseProductionData = (sheetData) => {
  const allProduction = [];

  for (const [dayName, dayData] of Object.entries(sheetData.tabs)) {
    const rows = dayData.rows || [];
    if (!rows.length) continue;

    // Extract date from day name like "MONDAY 8/3/2026"
    const dateMatch = dayName.match(/^[A-Z]+\s+(\d+\/\d+\/\d+)/i);
    const date = dateMatch ? dateMatch[1] : null;
    if (!date) continue;

    // First row has headers - find location columns
    const headerRow = rows[0] || [];
    const locationCols = {}; // {locationName: sentColumnIndex}

    for (let col = 0; col < headerRow.length; col++) {
      const header = String(headerRow[col] || '').trim();
      // Headers are like "506 RETAIL", "LSK", "LA STATE", "ARC INSTITUTE"
      for (const loc of WASTE_STORE_LOCATIONS) {
        if (header.toUpperCase().includes(loc.toUpperCase())) {
          // Find the SENT column for this location (usually nearby)
          for (let checkCol = col; checkCol < Math.min(col + 5, headerRow.length); checkCol++) {
            if (String(headerRow[checkCol] || '').toUpperCase().trim() === 'SENT') {
              locationCols[loc] = checkCol;
              break;
            }
          }
        }
      }
    }

    // Parse data rows
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const item = String(row[0] || '').trim();

      if (!item || item === 'TOTAL' || !item.length) continue;

      // For each location, extract SENT quantity
      for (const location in locationCols) {
        const sentCol = locationCols[location];
        const quantity = parseFloat(row[sentCol]);

        if (Number.isFinite(quantity) && quantity > 0) {
          allProduction.push({ date, item, location, quantity });
        }
      }
    }
  }

  return allProduction;
};

// Main function: fetch and parse production data
const fetchProductionData = async () => {
  try {
    const { drive, sheets } = await sheetsOauth.getClients();

    // Find latest production folder
    const folderId = await findLatestProductionFolder(drive);

    // Find production sheet
    const sheetId = await findProductionSheet(drive, folderId);

    // Pull sheet data
    const sheetData = await sheetsOauth.pullSpreadsheet(sheets, sheetId);

    // Parse all data
    const allProduction = parseProductionData(sheetData);

    // Convert to production.json format: {location: [{date, item, quantityProduced}, ...]}
    const production = {};
    for (const p of allProduction) {
      if (!production[p.location]) production[p.location] = [];
      production[p.location].push({ date: p.date, item: p.item, quantityProduced: p.quantity });
    }

    return production;
  } catch (err) {
    if (err.code === 'GOOGLE_NOT_CONNECTED') {
      const e = new Error('Google Drive not connected. Cannot fetch production data. User must authorize via /api/google/connect first.');
      e.code = 'GOOGLE_NOT_CONNECTED';
      throw e;
    }
    throw err;
  }
};

module.exports = { fetchProductionData };
