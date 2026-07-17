// ============================================================================
// Data pipeline config — THIS is the file you edit to scale to many sources.
// Add a Google Sheet: drop one line in googleSheets. Add a QB report: one line
// in quickbooksReports. refresh() loops over both lists automatically.
// ============================================================================

module.exports = {
  // Google Sheets to pull. EVERY tab of each spreadsheet is pulled automatically.
  // `id` is the long string in the sheet URL:
  //   https://docs.google.com/spreadsheets/d/<THIS_IS_THE_ID>/edit
  // Remember to share each sheet with the service-account email (Viewer is enough).
  googleSheets: [
    // { id: '1AbCdEf...', label: 'Weekly Ops Tracker' },
    // { id: '1GhIjKl...', label: 'Market Schedule' },
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
