# Waste Dashboard: Live Google Sheets Migration

## What Changed

### Files Added
- **`sheets-ingest.js`** (418 lines) — New module that handles Google Sheets API integration:
  - OAuth 2.0 authentication (installed app flow, one-time login)
  - Discovers "Total Production" sheets in Google Drive
  - Parses each sheet (7 days per sheet, products as rows, locations as columns)
  - Extracts ORDER quantities for each location × product × date
  - Handles mixed numbers and fractions (e.g., "1 2/3", "3/4")
  - Maps location names (506 RETAIL → 506 Retail, etc.)
  - Transforms to internal format: `{ date, item, quantityProduced, location }`

- **`GOOGLE_SHEETS_SETUP.md`** — Step-by-step setup and troubleshooting guide
- **`MIGRATION_SUMMARY.md`** — This file

### Files Modified
- **`package.json`** — Added `googleapis` (^118.0.0) dependency
- **`server.js`** — Added 52 lines:
  - Import SheetsIngestor
  - New endpoint: `POST /api/sheets/sync` — Fetch & sync production data from Google Sheets
  - New endpoint: `GET /api/sheets/auth-status` — Check OAuth authentication status

### Files Unchanged
- **`index.html`** — Display logic, charts, tables, totals remain identical
- **`data/production.json`** — Same structure, now populated from Sheets instead of CSV uploads
- **Waste calculation** — Still `waste = quantityProduced - quantitySold` (Square)
- **All other endpoints** — `/api/waste`, `/api/dashboard`, etc. work unchanged

## Data Flow

### Before (Manual)
```
User uploads CSV 
  → Parsed by /api/upload/production 
  → Stored in data/production.json 
  → Dashboard reads and displays
```

### After (Live)
```
User calls POST /api/sheets/sync 
  → Queries Google Sheets API 
  → Parses "Total Production" sheets 
  → Transforms to internal format 
  → Stored in data/production.json 
  → Dashboard reads and displays (unchanged)
```

## Key Features

### ✅ Automatic Location Discovery
- Searches Google Drive for all "Total Production" sheets
- No hardcoding of spreadsheet IDs
- Automatically picks up new sheets as they're added

### ✅ Robust Parsing
- Handles dates in multiple formats
- Extracts product names correctly
- Parses fractions (`1/3`, `2/3`) and mixed numbers (`1 2/3`)
- Maps location column names to dashboard locations

### ✅ OAuth Token Management
- First-time login is interactive (browser flow)
- Token stored locally in `.env.local.json` (gitignored)
- Automatic refresh when expired
- No manual token management needed

### ✅ Cache Invalidation
- Syncs clear the waste cache for all locations
- Next query will recalculate against fresh Square data

### ✅ Zero Display Changes
- Dashboard renders exactly the same way
- Charts, tables, totals, filters all work identically
- Only the data source changed

## How to Deploy

### 1. Pull Changes
```bash
git pull origin worktree-waste-dashboard
```

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment Variables
Add to your `.env` (or Railway project settings):
```
GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_client_secret_here
GOOGLE_REDIRECT_URL=urn:ietf:wg:oauth:2.0:oob
```

See **GOOGLE_SHEETS_SETUP.md** for finding these credentials.

### 4. First-Time Authentication
Start the server:
```bash
npm start
```

Trigger the first sync:
```bash
curl -X POST http://localhost:3001/api/sheets/sync
```

Follow the interactive prompt to authenticate with Google.

### 5. Verify Sync
```bash
curl http://localhost:3001/api/sheets/auth-status
```

Expected:
```json
{
  "authenticated": true,
  "message": "Authenticated with Google"
}
```

### 6. View the Dashboard
Open http://localhost:3001 → **Waste** tab → Select a location
You should see production quantities pulled from your "Total Production" sheets.

## Testing

### Test 1: Sync Succeeds
```bash
curl -X POST http://localhost:3001/api/sheets/sync
```

Expected: `{ "success": true, "totalRows": X, "locations": Y }`

### Test 2: Auth Status
```bash
curl http://localhost:3001/api/sheets/auth-status
```

Expected: `{ "authenticated": true, ... }`

### Test 3: Dashboard Loads
1. Open http://localhost:3001
2. Navigate to **Waste** tab
3. Select a location (e.g., "LSK")
4. Should show production data, charts, totals, waste metrics

### Test 4: Waste Calculation
- Verify waste = production - sold (from Square)
- Check that waste % is calculated correctly
- Verify "Possible naming mismatches" section still works

## Rollback

If you need to revert to CSV uploads:

1. Keep the current code (no changes needed)
2. Use `POST /api/upload/production` endpoint instead of `/api/sheets/sync`
3. The dashboard will use whatever data is in `data/production.json`

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/sheets/sync` | POST | Fetch & sync production from Google Sheets |
| `/api/sheets/auth-status` | GET | Check OAuth authentication status |
| `/api/upload/production` | POST | Manual CSV upload (still available) |
| `/api/waste?location=LSK` | GET | Get waste data (unchanged) |

## Troubleshooting

See **GOOGLE_SHEETS_SETUP.md** for detailed troubleshooting.

Common issues:
- **"No sheets found"** → Verify sheet names match "Total Production"
- **"Unknown location"** → Check column headers in sheets
- **"Token expired"** → Delete `.env.local.json` and re-authenticate
- **"Permission denied"** → Verify Google account has access to sheets

## Environment Variables Needed

```
GOOGLE_CLIENT_ID              # OAuth Client ID from Google Cloud
GOOGLE_CLIENT_SECRET          # OAuth Client Secret from Google Cloud
GOOGLE_REDIRECT_URL           # Defaults to urn:ietf:wg:oauth:2.0:oob (no change needed)
SQUARE_ACCESS_TOKEN           # Existing, keep as-is
```

## Notes

- The `data/production.json` file is the single source of truth for waste calculations
- Syncing from Sheets overwrites all production data (by design—it's the authoritative source)
- Manual CSV uploads will still work alongside Sheets sync (whichever runs last wins)
- Location name mapping is hardcoded in `sheets-ingest.js` (4 mappings)—extend if needed
