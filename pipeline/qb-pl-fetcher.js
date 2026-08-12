/**
 * QB P&L Weekly Fetcher
 * Fetches profit & loss data week-by-week for past 5 years + rolling
 * Uses QB REST Reports API with robust row ID extraction (no fuzzy matching)
 */

const axios = require('axios');

class QBPLFetcher {
  constructor(qbClient) {
    this.qbClient = qbClient;
    this.rowMap = null;
  }

  /**
   * Fetch P&L report from QB REST API
   */
  async fetchPLReport(startDate, endDate) {
    const tokens = await this.qbClient.getValidTokens();
    const baseUrl = process.env.QUICKBOOKS_ENVIRONMENT === 'sandbox'
      ? 'https://sandbox-quickbooks.api.intuit.com'
      : 'https://quickbooks.api.intuit.com';

    const url = `${baseUrl}/v3/company/${tokens.realmId}/reports/ProfitAndLoss`;

    const response = await axios.get(url, {
      params: {
        start_date: startDate,
        end_date: endDate,
        minorversion: 70
      },
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: 'application/json'
      }
    });

    return response.data;
  }

  /**
   * Identify QB row IDs (run once at startup)
   * Maps account names to row IDs for reliable extraction
   */
  async identifyRowIds() {
    const today = new Date();
    const fiveYearsAgo = new Date(today.getFullYear() - 5, today.getMonth(), today.getDate());

    console.log(`🔍 Identifying QB row IDs for period ${fiveYearsAgo.toISOString().split('T')[0]} to ${today.toISOString().split('T')[0]}`);

    const report = await this.fetchPLReport(
      fiveYearsAgo.toISOString().split('T')[0],
      today.toISOString().split('T')[0]
    );

    const rows = report.reportData.data.rows;
    this.rowMap = {};

    for (const row of rows) {
      const accountName = row.cells[0].value;
      const rowId = row.metadata.id;
      const rowType = row.metadata.type;

      // Only look at GROUP/SUMMARY rows (top-level accounts)
      if (!rowType.includes('GROUP') && !rowType.includes('SUMMARY')) continue;

      if (accountName.includes('Income')) {
        this.rowMap.revenue = rowId;
        console.log(`  ✓ Revenue: row ID "${rowId}" (${accountName})`);
      } else if (accountName.includes('Cost of Goods Sold')) {
        this.rowMap.cogs = rowId;
        console.log(`  ✓ COGS: row ID "${rowId}" (${accountName})`);
      } else if (accountName.includes('Expenses') && !accountName.includes('Other')) {
        this.rowMap.operations = rowId;
        console.log(`  ✓ Operations: row ID "${rowId}" (${accountName})`);
      } else if (accountName.includes('Net Income')) {
        this.rowMap.netIncome = rowId;
        console.log(`  ✓ Net Income: row ID "${rowId}" (${accountName})`);
      }
    }

    return this.rowMap;
  }

  /**
   * Extract metrics from QB response using row IDs
   */
  extractMetrics(qbResponse) {
    const rows = qbResponse.reportData.data.rows;
    const rowsById = {};

    for (const row of rows) {
      rowsById[row.metadata.id] = row;
    }

    const metrics = {
      revenue: 0,
      cogs: 0,
      operations: 0,
      netIncome: 0
    };

    if (this.rowMap.revenue && rowsById[this.rowMap.revenue]) {
      metrics.revenue = rowsById[this.rowMap.revenue].cells[1].value || 0;
    }
    if (this.rowMap.cogs && rowsById[this.rowMap.cogs]) {
      metrics.cogs = rowsById[this.rowMap.cogs].cells[1].value || 0;
    }
    if (this.rowMap.operations && rowsById[this.rowMap.operations]) {
      metrics.operations = rowsById[this.rowMap.operations].cells[1].value || 0;
    }
    if (this.rowMap.netIncome && rowsById[this.rowMap.netIncome]) {
      metrics.netIncome = rowsById[this.rowMap.netIncome].cells[1].value || 0;
    }

    return metrics;
  }

  /**
   * Generate week ranges (Monday-Sunday)
   */
  generateWeekRanges(startDate, endDate) {
    let current = new Date(startDate);
    const dayOfWeek = current.getDay();

    // Adjust to Monday
    if (dayOfWeek !== 1) {
      current.setDate(current.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    }

    const weeks = [];
    while (current <= endDate) {
      const weekStart = new Date(current);
      const weekEnd = new Date(current);
      weekEnd.setDate(weekEnd.getDate() + 6); // Sunday

      // Clamp to actual period
      const fetchStart = new Date(Math.max(weekStart.getTime(), startDate.getTime()));
      const fetchEnd = new Date(Math.min(weekEnd.getTime(), endDate.getTime()));

      weeks.push({
        weekNum: weeks.length + 1,
        start: fetchStart.toISOString().split('T')[0],
        end: fetchEnd.toISOString().split('T')[0]
      });

      current.setDate(current.getDate() + 7);
    }

    return weeks;
  }

  /**
   * Fetch P&L data for each week
   */
  async fetchAllWeeks(startDate, endDate) {
    const weeks = this.generateWeekRanges(startDate, endDate);
    const results = [];
    let successCount = 0;
    let errorCount = 0;

    console.log(`📊 Fetching ${weeks.length} weeks from ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);

    for (const week of weeks) {
      try {
        const report = await this.fetchPLReport(week.start, week.end);

        const metrics = this.extractMetrics(report);

        results.push({
          week: week.weekNum,
          start: week.start,
          end: week.end,
          revenue: metrics.revenue,
          cogs: metrics.cogs,
          operations: metrics.operations,
          netIncome: metrics.netIncome
        });

        successCount++;
        if (successCount % 10 === 0) {
          console.log(`  ✓ Fetched ${successCount}/${weeks.length} weeks`);
        }
      } catch (error) {
        errorCount++;
        console.error(`  ✗ Week ${week.weekNum} (${week.start} to ${week.end}) failed:`, error.message);
        results.push({
          week: week.weekNum,
          start: week.start,
          end: week.end,
          error: error.message
        });
      }
    }

    console.log(`✓ Fetch complete: ${successCount} success, ${errorCount} errors`);
    return results;
  }

  /**
   * Validate that numbers add up correctly
   */
  validateTotals(weeklyData) {
    const totals = {
      revenue: 0,
      cogs: 0,
      operations: 0,
      netIncome: 0
    };

    for (const week of weeklyData) {
      if (!week.error) {
        totals.revenue += week.revenue || 0;
        totals.cogs += week.cogs || 0;
        totals.operations += week.operations || 0;
        totals.netIncome += week.netIncome || 0;
      }
    }

    const calculatedNet = totals.revenue - totals.cogs - totals.operations;
    const difference = Math.abs(calculatedNet - totals.netIncome);

    const isValid = difference < 10; // Allow small rounding differences

    return {
      totals,
      isValid,
      difference,
      calculatedNet
    };
  }
}

module.exports = QBPLFetcher;
