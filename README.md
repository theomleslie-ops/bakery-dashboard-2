# 🍞 Bakery Dashboard API

Backend API for P/L dashboard integrating Square, QuickBooks, and manual data (recipes, ingredients).

## Quick Start

```bash
npm start
```

Server runs on `http://localhost:3001`

## API Endpoints

### Upload Data (CSV Files)

**Upload recipes:**
```bash
curl -X POST -F "file=@recipes.csv" http://localhost:3001/api/upload/recipes
```

**Upload ingredients:**
```bash
curl -X POST -F "file=@ingredients.csv" http://localhost:3001/api/upload/ingredients
```

**Upload production (for the Waste tab), one location per upload:**
```bash
curl -X POST -F "file=@arc-production.csv" -F "location=ARC" http://localhost:3001/api/upload/production
```
`location` must be one of the names in `WASTE_STORE_LOCATIONS`/`WASTE_MARKET_LOCATIONS` in `server.js`
(see `GET /api/waste/locations` for the current list). Uploads merge by date: dates present in the
uploaded file replace whatever was on file for those dates (so re-uploading a corrected day is
clean), other dates already on file for that location are kept, and other locations are untouched -
so weekly production sheets accumulate into a running log rather than each upload wiping out prior
weeks.

**Upload P&L by Channel data (for the P&L by Channel tab), one sheet per upload:**
```bash
curl -X POST -F "file=@Market Analysis.csv" http://localhost:3001/api/upload/pl-channel/market-analysis
curl -X POST -F "file=@Non Market Channels.csv" http://localhost:3001/api/upload/pl-channel/non-market
curl -X POST -F "file=@Revenue Allocation.csv" http://localhost:3001/api/upload/pl-channel/revenue-allocation
```
Each expects the exact export format of the corresponding tab in the bakery's "Market Performance"
Google Sheet (title/subtotal rows then a fixed column layout - not a format meant to be hand-authored).
Each upload fully replaces its own slice of `data/pl-by-channel.json` (these are point-in-time
snapshots re-exported periodically, not append-by-date logs); re-upload whichever sheet has changed.

### Get Data

**Get recipes:**
```bash
curl http://localhost:3001/api/recipes
```

**Get ingredients:**
```bash
curl http://localhost:3001/api/ingredients
```

**Get dashboard (combined P/L data):**
```bash
curl http://localhost:3001/api/dashboard
```

**Get weekly overtime report by function (from Square Labor):**
```bash
curl http://localhost:3001/api/overtime?weeks=8
```
Password-protected page at `/overtime`. Computes California overtime (1.5x over 8hrs/day or 40hrs/week,
2x over 12hrs/day, 7th-consecutive-workday rule) per employee, allocated across job/function by hours
worked. Uses `SQUARE_ACCESS_TOKEN` if configured; otherwise falls back to `data/overtime-snapshot.json`.

**Get waste report for a location (Waste tab):**
```bash
curl "http://localhost:3001/api/waste?location=ARC"
```
Compares uploaded production CSVs against Square's actual sales (Orders API, matched by item name
and day) to compute waste = produced − sold, per item per day. Defaults to the date range covered by
that location's uploaded production data; override with `start`/`end` (`YYYY-MM-DD`). Cached 1 hour.
Also returns `unmatchedSoldItems`: things Square sold in that window whose name never matched a
production row — usually means the CSV item name and Square's point-of-sale name have drifted apart.

**Get P&L by channel (P&L by Channel tab):**
```bash
curl http://localhost:3001/api/pl-by-channel
```
Returns `channels` (named channels other than farmers markets - ARC, LSK, State St, Catering,
Delivery 506, 506 Retail - with cost/contribution detail and, for LSK, a `subChannels` array split
into Bakery/Other), `markets` (every farmers market/pop-up kept as its own row, not rolled up), and
`revenueAllocation` (trailing-12-months revenue and % share by channel). Whichever of the three
uploads (above) hasn't happened yet is returned empty.

**Get item margins (Item Margins tab):**
```bash
curl http://localhost:3001/api/item-margins
```
For every uploaded recipe, compares its ingredient cost (`Cost / Yield` from recipes.csv) against
the item's live listed price from the Square catalog, matched by exact name. Returns `items`
(sorted highest ingredient-cost-% first) and `unmatchedRecipes`: recipe names with no matching
active Square catalog item by name — rename the recipe to match Square's item name if it should be
tracked. Cached 1 hour; the cache is cleared on every recipes.csv upload.

## CSV File Formats

### recipes.csv
```
Recipe Name,Ingredients,Cost,Yield,Category
Sourdough Bread,flour;salt;water,15.50,8,Bread
Chocolate Croissants,butter;chocolate;dough,8.25,12,Pastries
```

### ingredients.csv
```
Name,Unit,Cost Per Unit,Quantity Monthly,Category
All-Purpose Flour,lbs,0.75,400,Baking
Butter,lbs,4.50,50,Baking
Chocolate Chips,lbs,6.00,20,Baking
```

### production CSV (one file per location)
```
Date,Item,Quantity Produced
2026-07-05,Baguette,40
2026-07-05,Country Round,20
```
`Item` should match the name Square's point-of-sale shows for that item on the receipt/line item —
that's not always the same as the catalog's internal name (e.g. catalog "Country RND" may sell under
the display name "Country Round"). Check `/api/waste`'s `unmatchedSoldItems` if waste looks inflated.

## Configuration

Edit `.env` with your API credentials:

```
SQUARE_ACCESS_TOKEN=your_token_here
SQUARE_LOCATION_ID=your_location_id_here
QUICKBOOKS_ACCESS_TOKEN=your_token_here
QUICKBOOKS_REALM_ID=your_realm_id_here
```

## Next Steps

1. **Export and upload your CSV files** (recipes.csv, ingredients.csv)
2. **Get Square API credentials** (see below)
3. **Get QuickBooks API credentials** (see below)
4. **Connect to React dashboard**

## Getting API Credentials

### Square API
1. Go to https://developer.squareup.com/apps
2. Create a new application
3. Get **Personal Access Token** from API Keys section
4. Get your **Location ID** from Locations section
5. Add to `.env`

### QuickBooks API
1. Go to https://developer.intuit.com/
2. Create a new app
3. Get **OAuth 2.0 credentials** (Client ID, Client Secret)
4. Get your **Realm ID** (Company ID)
5. Add to `.env`

---

**Status:** Recipes & Ingredients: ✅ Working | Square/QB: 📋 Ready for API keys
