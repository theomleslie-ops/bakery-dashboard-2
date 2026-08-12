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

    try {
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

      if (!response.data) {
        throw new Error('QB API returned empty response');
      }

      return response.data;
    } catch (err) {
      console.error(`QB API error for ${startDate}-${endDate}:`, err.message);
      if (err.response?.data) {
        console.error('  Response:', JSON.stringify(err.response.data).substring(0, 200));
      }
      throw err;
    }
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

    // Handle both nested (MCP) and flat (REST API) response formats
    let rows;
    if (report.reportData?.data?.rows) {
      // MCP response format
      rows = report.reportData.data.rows;
    } else if (report.Rows) {
      // QB REST API format
      rows = report.Rows;
    } else {
      console.error('Unexpected QB response structure:', Object.keys(report));
      throw new Error('Cannot parse QB P&L response: unknown format');
    }

    this.rowMap = {};

    for (const row of rows) {
      // Handle both row formats
      const accountName = row.cells?.[0]?.value || row.Header?.ColData?.[0]?.value || row.ColData?.[0]?.value;
      const rowId = row.metadata?.id || row.id || row.Row?.[0]?.id;
      const rowType = row.metadata?.type || row.type || [];

      if (!accountName) continue;

      // Only look at GROUP/SUMMARY rows (top-level accounts)
      if (Array.isArray(rowType)) {
        if (!rowType.includes('GROUP') && !rowType.includes('SUMMARY')) continue;
      }

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
    // Handle both nested (MCP) and flat (REST API) response formats
    let rows;
    if (qbResponse.reportData?.data?.rows) {
      rows = qbResponse.reportData.data.rows;
    } else if (qbResponse.Rows) {
      rows = qbResponse.Rows;
    } else {
      console.warn('Cannot extract metrics: unknown response format');
      return { revenue: 0, cogs: 0, operations: 0, netIncome: 0 };
    }

    const rowsById = {};

    for (const row of rows) {
      const rowId = row.metadata?.id || row.id || row.Row?.[0]?.id;
      if (rowId) {
        rowsById[rowId] = row;
      }
    }

    const metrics = {
      revenue: 0,
      cogs: 0,
      operations: 0,
      netIncome: 0
    };

    // Extract values, handling both response formats
    if (this.rowMap.revenue && rowsById[this.rowMap.revenue]) {
      const row = rowsById[this.rowMap.revenue];
      metrics.revenue = row.cells?.[1]?.value || row.ColData?.[1]?.value || 0;
    }
    if (this.rowMap.cogs && rowsById[this.rowMap.cogs]) {
      const row = rowsById[this.rowMap.cogs];
      metrics.cogs = row.cells?.[1]?.value || row.ColData?.[1]?.value || 0;
    }
    if (this.rowMap.operations && rowsById[this.rowMap.operations]) {
      const row = rowsById[this.rowMap.operations];
      metrics.operations = row.cells?.[1]?.value || row.ColData?.[1]?.value || 0;
    }
    if (this.rowMap.netIncome && rowsById[this.rowMap.netIncome]) {
      const row = rowsById[this.rowMap.netIncome];
      metrics.netIncome = row.cells?.[1]?.value || row.ColData?.[1]?.value || 0;
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
