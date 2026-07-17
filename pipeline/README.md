# Data pipeline

Pulls **QuickBooks reports** (direct Intuit API) and **Google Sheets** (every tab of every sheet),
consolidates them into one JSON, and writes per-dataset CSVs — no manual uploads. Run it as often
as you like to refresh.

## Run

```bash
npm run pipeline                 # both sources
node pipeline/refresh.js --qb-only
node pipeline/refresh.js --sheets-only
```

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

Add a **Google Sheet** (one line — every tab is pulled automatically):

```js
{ id: '1AbC…theIdFromTheSheetURL', label: 'Weekly Ops' },
```

`range` shortcuts: `ytd` · `thisYear` · `lastYear` · `thisMonth` · `asOfToday`. Anything in `params`
is passed straight to the Intuit Reports API (`summarize_column_by`, `accounting_method`, …).

## Prerequisites

- **QuickBooks**: already connected via the web app (uses `data/quickbooks-tokens.json` +
  `QUICKBOOKS_*` in `.env`). Tokens auto-refresh.
- **Google Sheets**: put a service-account key at `data/google-service-account.json` and share each
  sheet with that service-account email (Viewer). Until then, the Sheets step is skipped cleanly.
