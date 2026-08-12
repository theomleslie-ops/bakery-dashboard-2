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

    // Debug: log response structure
    console.log('  QB response keys:', Object.keys(report).slice(0, 10).join(', '));
    if (report.Rows) console.log('  Rows type:', typeof report.Rows, 'Rows keys:', Object.keys(report.Rows || {}).slice(0, 5).join(', '));

    // Handle both nested (MCP) and flat (REST API) response formats
    let rows = [];
    if (report.reportData?.data?.rows && Array.isArray(report.reportData.data.rows)) {
      // MCP response format
      rows = report.reportData.data.rows;
      console.log('  Using MCP format, found', rows.length, 'rows');
    } else if (Array.isArray(report.Rows)) {
      // QB REST API format - Rows array
      rows = report.Rows;
      console.log('  Using REST API format (array), found', rows.length, 'rows');
    } else if (report.Rows && typeof report.Rows === 'object') {
      // QB returns Rows as an object with a Row array inside
      if (Array.isArray(report.Rows.Row)) {
        rows = report.Rows.Row;
        console.log('  Using REST API format (Rows.Row array), found', rows.length, 'rows');
      } else if (report.Rows.Rows && Array.isArray(report.Rows.Rows)) {
        rows = report.Rows.Rows;
        console.log('  Using REST API format (Rows.Rows array), found', rows.length, 'rows');
      } else {
        console.warn('  Rows is object but no Row/Rows array found. Keys:', Object.keys(report.Rows));
        rows = [];
      }
    } else {
      console.error('Unexpected QB response structure:');
      console.error('  Keys:', Object.keys(report));
      console.error('  Rows value:', typeof report.Rows, report.Rows?.constructor?.name);
      throw new Error('Cannot parse QB P&L response: Rows not found');
    }

    if (!rows.length) {
      console.warn('⚠️  No rows found in QB response');
      this.rowMap = { revenue: null, cogs: null, operations: null, netIncome: null };
      return this.rowMap;
    }

    this.rowMap = {};

    // QB REST API structure: rows ARE the categories, extract totals directly
    this.rowMap = { revenue: null, cogs: null, operations: null, netIncome: null };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const accountName = row.Header?.ColData?.[0]?.value;

      if (!accountName) continue;

      // Map account names to our categories (no row IDs needed)
      if (accountName === 'Income') {
        this.rowMap.revenue = i; // Store index instead of ID
        console.log(`  ✓ Revenue: index ${i} (${accountName})`);
      } else if (accountName === 'Cost of Goods Sold') {
        this.rowMap.cogs = i;
        console.log(`  ✓ COGS: index ${i} (${accountName})`);
      } else if (accountName === 'Expenses') {
        this.rowMap.operations = i;
        console.log(`  ✓ Operations: index ${i} (${accountName})`);
      } else if (accountName === 'Net Income') {
        this.rowMap.netIncome = i;
        console.log(`  ✓ Net Income: index ${i} (${accountName})`);
      }
    }

    // Log final row map for debugging
    console.log(`  📊 Row mapping complete: revenue=${this.rowMap.revenue}, cogs=${this.rowMap.cogs}, ops=${this.rowMap.operations}, net=${this.rowMap.netIncome}`);

    return this.rowMap;
  }

  /**
   * Extract metrics from QB response using row indices
   */
  extractMetrics(qbResponse) {
    // Handle both nested (MCP) and flat (REST API) response formats
    let rows = [];
    if (qbResponse.reportData?.data?.rows && Array.isArray(qbResponse.reportData.data.rows)) {
      rows = qbResponse.reportData.data.rows;
    } else if (Array.isArray(qbResponse.Rows)) {
      rows = qbResponse.Rows;
    } else if (qbResponse.Rows && typeof qbResponse.Rows === 'object') {
      // QB returns Rows as an object with a Row array inside
      if (Array.isArray(qbResponse.Rows.Row)) {
        rows = qbResponse.Rows.Row;
      } else if (qbResponse.Rows.Rows && Array.isArray(qbResponse.Rows.Rows)) {
        rows = qbResponse.Rows.Rows;
      }
    }

    if (!Array.isArray(rows)) {
      return { revenue: 0, cogs: 0, operations: 0, netIncome: 0 };
    }

    const metrics = {
      revenue: 0,
      cogs: 0,
      operations: 0,
      netIncome: 0
    };

    // Extract values by row index (QB REST API structure)
    // Each category row has Header.ColData[1].value or Summary with the total
    if (this.rowMap.revenue !== null && rows[this.rowMap.revenue]) {
      const row = rows[this.rowMap.revenue];
      // Try to get total from Header.ColData[1] or Summary
      metrics.revenue = parseFloat(row.Header?.ColData?.[1]?.value) ||
                       parseFloat(row.Summary?.ColData?.[1]?.value) || 0;
    }
    if (this.rowMap.cogs !== null && rows[this.rowMap.cogs]) {
      const row = rows[this.rowMap.cogs];
      metrics.cogs = parseFloat(row.Header?.ColData?.[1]?.value) ||
                    parseFloat(row.Summary?.ColData?.[1]?.value) || 0;
    }
    if (this.rowMap.operations !== null && rows[this.rowMap.operations]) {
      const row = rows[this.rowMap.operations];
      metrics.operations = parseFloat(row.Header?.ColData?.[1]?.value) ||
                          parseFloat(row.Summary?.ColData?.[1]?.value) || 0;
    }
    if (this.rowMap.netIncome !== null && rows[this.rowMap.netIncome]) {
      const row = rows[this.rowMap.netIncome];
      metrics.netIncome = parseFloat(row.Header?.ColData?.[1]?.value) ||
                         parseFloat(row.Summary?.ColData?.[1]?.value) || 0;
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
