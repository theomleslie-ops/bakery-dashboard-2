# Google Sheets Integration Setup

This guide walks through setting up the waste dashboard to pull production data live from Google Sheets instead of manual CSV uploads.

## Overview

The dashboard now:
1. Fetches "Total Production" sheets from Google Drive
2. Parses production quantities (ORDER column) for each location and date
3. Compares against Square sales to calculate waste
4. Displays dashboards identically, but with live updated data

## Prerequisites

You already have Google Cloud credentials in Railway. We'll use those.

## Step 1: Configure Environment Variables

Add these to your `.env` file (or `.env.local` locally):

```
# Google OAuth credentials (from your Google Cloud Console)
GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_client_secret_here
GOOGLE_REDIRECT_URL=urn:ietf:wg:oauth:2.0:oob

# Square API (existing, keep as-is)
SQUARE_ACCESS_TOKEN=your_square_token
SQUARE_LOCATION_ID=your_location_id

# Optional: set to automatically sync on startup
AUTO_SYNC_SHEETS=true
```

### Finding Your Google Credentials

If you don't have them handy:
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Select your project
3. Go to **APIs & Services** → **Credentials**
4. Find or create an OAuth 2.0 Desktop Application credential
5. Copy the Client ID and Client Secret

## Step 2: First-Time Authentication

When you run the sync for the first time, it will prompt you to authenticate:

```bash
npm start
```

Then make the first sync request:
```bash
curl -X POST http://localhost:3001/api/sheets/sync
```

You'll see:
```
Authorize this app by visiting this url: https://accounts.google.com/o/oauth2/auth?...
Enter the code from that page here: 
```

1. Open the URL in your browser
2. Sign in with the Google account that owns your production sheets
3. Grant access to Sheets and Drive APIs
4. Copy the code and paste it into the terminal

The token is saved locally in `.env.local.json` (gitignored) and will auto-refresh as needed.

## Step 3: Sync Production Data

Manually sync from Google Sheets:
```bash
curl -X POST http://localhost:3001/api/sheets/sync
```

Response:
```json
{
  "success": true,
  "message": "Production data synced from Google Sheets",
  "totalRows": 1245,
  "locations": 4
}
```

Check authentication status:
```bash
curl http://localhost:3001/api/sheets/auth-status
```

## Step 4: Verify the Data

1. Open the dashboard → **Waste** tab
2. Select a location (e.g., "LSK")
3. You should see production quantities pulled from your "Total Production" sheet

## How It Works

### Data Parsing

The ingestor reads "Total Production" sheets and extracts:
- **Date**: From row headers (e.g., "Monday 7/27/2026")
- **Location**: From column headers (e.g., "LSK (Speed Racks)")
- **Product**: From row labels (e.g., "FICELLE", "BAGUETTE")
- **Quantity Produced**: The **ORDER** column value for each location

Location names are mapped to dashboard locations:
- "506 RETAIL" → "506 Retail"
- "LSK" → "LSK"
- "LA STATE" → "State St"
- "ARC INSTITUTE" → "ARC"

### Waste Calculation (Unchanged)

The waste formula remains the same:
```
waste = quantityProduced (from Sheets) - quantitySold (live from Square)
```

Only the data source changed—the display and calculation logic stayed the same.

## Scheduling Auto-Sync

To run syncs automatically on a schedule (e.g., nightly), add a cron job:

```bash
# Every day at 2 AM
0 2 * * * curl -s -X POST http://localhost:3001/api/sheets/sync
```

Or use the `/schedule` command in Claude Code if you want to set up a managed cron task.

## Troubleshooting

### "No 'Total Production' sheets found in Google Drive"
- Verify the sheets exist and are named exactly "Total Production" (case-sensitive for the search)
- Ensure the Google account used in OAuth has access to the folder containing the sheets

### "Unknown location" error
- Check that column headers in the sheets match one of: 506 RETAIL, LSK, LA STATE, ARC INSTITUTE
- The location name mapping is in `sheets-ingest.js` and can be updated

### Token refresh failed
- Delete `.env.local.json` and re-authenticate by running the sync again

## Rolling Back to Manual Uploads

If you need to revert to CSV uploads:
1. The `/api/upload/production` endpoint still works
2. Upload a CSV with columns: Date | Item | Quantity Produced
3. The dashboard uses whichever data is in `data/production.json`

## API Endpoints

- **POST /api/sheets/sync** — Fetch and sync data from Google Sheets
- **GET /api/sheets/auth-status** — Check if authenticated with Google
- **POST /api/upload/production** — Manual CSV upload (still available)
- **GET /api/waste?location=LSK** — Get waste data for a location (unchanged)
