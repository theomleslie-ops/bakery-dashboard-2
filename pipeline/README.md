# Data pipeline

Pulls **QuickBooks reports** (direct Intuit API) and **Google Sheets** (every tab of every sheet),
consolidates them into one JSON, and writes per-dataset CSVs — no manual uploads. Run it as often
as you like to refresh.

## Run

```bash
npm run pipeline                       # both sources
node pipeline/refresh.js --qb-only
node pipeline/refresh.js --sheets-only
node pipeline/refresh.js --list        # every sheet name the service account can pull
node pipeline/refresh.js --sheet "Weekly Ops"    # pull one sheet ad hoc, by name
node pipeline/refresh.js --folder "Recipe LSB"   # pull every sheet in a folder, by folder name
```

Sheets are referenced **by name** — the Drive API resolves the name to an ID, so you never handle
URLs. A sheet (or a whole folder) just has to be shared with the service account. Share a **folder**
and you can pull it by name with `--folder` (or `{ folder: 'Name' }` in config) — every sheet inside,
including ones added later, comes through automatically. Note: sharing an individual sheet does *not*
make its folder visible; share the folder itself to use folder mode.

Programmatic:

```js
const { refresh } = require('./pipeline/refresh');
const data = await refresh();   // returns the consolidated object and writes files
```

## Output (in `data/pipeline/`, git-ignored)

- `latest/consolidated.json` — everything, full fidelity (includes raw QB report trees).
- `latest/qb_<key>.csv` — one CSV per QuickBooks report (flattened: `Group, account, <periods…>, Total`).
- `latest/sheet_<title>__<tab>.csv` — one CSV per sheet tab.
- `snapshots/<timestamp>/consolidated.json` — a dated copy each run, so history is kept.

## Scaling — edit `pipeline/config.js`

Add a **QuickBooks report** (one line):

```js
{ key: 'ar_aging', report: 'AgedReceivables', range: 'asOfToday' },
```

Add a **Google Sheet** by name (one line — every tab is pulled automatically):

```js
{ name: 'Weekly Ops' },
```

`range` shortcuts: `ytd` · `thisYear` · `lastYear` · `thisMonth` · `asOfToday`. Anything in `params`
is passed straight to the Intuit Reports API (`summarize_column_by`, `accounting_method`, …).

## Product Margins (`npm run margins`)

A separate, self-contained pipeline that computes each product's cost-to-make and feeds the
**Product Margins** dashboard tab. It does not use the service account — it reads recipes via
**Google OAuth as the user** (see below).

```bash
npm run margins                                    # refresh CW prices + recost every recipe
node pipeline/build-margins.js --folder "Recipe LSB" --weeks 12
node pipeline/build-margins.js --no-price-refresh  # reuse cached CW prices, just recost
node pipeline/chefs-warehouse.js 12                # just refresh Chef's Warehouse prices
```

Flow: **Chef's Warehouse** ingredient prices come from **QuickBooks** — each CW bill's attached
invoice PDF is downloaded and parsed into `$/kg` per item (`pipeline/chefs-warehouse.js`, vendor
`CW_VENDOR_ID`). **Recipes** come from the Google Drive recipe folder (`pipeline/recipes.js`), each
batch recipe divided by a per-unit **yield** to get cost per sold unit. `pipeline/match-cost.js`
matches ingredients → CW items and writes:

- `data/pipeline/recipe-costs.json` — costed recipes the `/api/product-margins` endpoint reads.
- `data/pipeline/coverage.json` — every recipe bucketed by why it can/can't be costed.
- `data/pipeline/ingredient-match-approval.csv` — reviewable ingredient→CW matches + alternates.

Square sell price + volume are joined **live** at request time, not here.

**Closing coverage gaps** (override files in `data/pipeline/`, all optional):
- `yield-overrides.json` — `{ "<recipe>": <grams per unit> }` for recipes with no yield in the sheet.
- `ingredient-overrides.json` — `{ "<recipe ingredient>": "<CW item code>" }` to pin a price match.
- `product-name-overrides.json` — `{ "<recipe>": "<square item name>" }` to pin a Square sales match.

## Prerequisites

- **QuickBooks**: connected via the web app (uses `data/quickbooks-tokens.json` + `QUICKBOOKS_*` in
  `.env`). Tokens auto-refresh. Used for both the reports pipeline and Chef's Warehouse invoices.
- **Google (Product Margins)**: set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env` (OAuth
  client from Google Cloud Console, redirect `…/api/google/callback`), then connect once at
  `/api/google/connect`. Reads your private recipe folder as you — no sharing or service account.
- **Google Sheets (reports pipeline, legacy)**: the `npm run pipeline` path still uses a
  service-account key at `data/google-service-account.json`. The margins path does not.
