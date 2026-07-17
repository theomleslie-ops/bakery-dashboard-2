// ============================================================================
// Data pipeline config — THIS is the file you edit to scale to many sources.
// Add a Google Sheet: drop one line in googleSheets. Add a QB report: one line
// in quickbooksReports. refresh() loops over both lists automatically.
// ============================================================================

module.exports = {
  // Google Sheets to pull. EVERY tab of each spreadsheet is pulled automatically.
  // Reference sheets BY NAME — the Drive API resolves the name to an ID, so no URLs needed.
  // (The sheet just has to be shared with the service account, e.g. via a shared folder.)
  // Run `node pipeline/refresh.js --list` to see every name the service account can pull.
  googleSheets: [
    // { name: 'Weekly Ops Tracker' },
    // { name: 'Market Schedule' },
    // { id: '1AbCdEf...' },   // an explicit ID also works if you ever want one
  ],

  // QuickBooks reports to pull. `report` is the Intuit Reports API name; `params` are passed
  // straight through; `range` is a shortcut resolved in refresh.js (thisYear | lastYear |
  // ytd | asOfToday). Add any report QuickBooks supports — one line each.
  quickbooksReports: [
    { key: 'profit_and_loss_monthly', report: 'ProfitAndLoss', range: 'ytd', params: { summarize_column_by: 'Month' } },
    { key: 'balance_sheet', report: 'BalanceSheet', range: 'asOfToday' },
    { key: 'cash_flow_monthly', report: 'CashFlow', range: 'ytd', params: { summarize_column_by: 'Month' } },
    // More you can enable anytime:
    // { key: 'ar_aging', report: 'AgedReceivables', range: 'asOfToday' },
    // { key: 'ap_aging', report: 'AgedPayables', range: 'asOfToday' },
    // { key: 'sales_by_customer', report: 'CustomerSales', range: 'ytd', params: { summarize_column_by: 'Customers' } },
    // { key: 'sales_by_product', report: 'ItemSales', range: 'ytd' },
    // { key: 'general_ledger', report: 'GeneralLedger', range: 'thisMonth' },
    // { key: 'trial_balance', report: 'TrialBalance', range: 'asOfToday' },
  ],
};
