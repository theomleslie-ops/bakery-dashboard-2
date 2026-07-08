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
