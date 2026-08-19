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
          minorversion: 75
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

    const report = await this.fetchPLReport(
      fiveYearsAgo.toISOString().split('T')[0],
      today.toISOString().split('T')[0]
    );

    // Handle both nested (MCP) and flat (REST API) response formats
    let rows = [];
    if (report.reportData?.data?.rows && Array.isArray(report.reportData.data.rows)) {
      rows = report.reportData.data.rows;
    } else if (Array.isArray(report.Rows)) {
      rows = report.Rows;
    } else if (report.Rows && typeof report.Rows === 'object') {
      if (Array.isArray(report.Rows.Row)) {
        rows = report.Rows.Row;
      } else if (report.Rows.Rows && Array.isArray(report.Rows.Rows)) {
        rows = report.Rows.Rows;
      } else {
        rows = [];
      }
    }

    if (!rows.length) {
      this.rowMap = { revenue: null, cogs: null, labor: null, operations: null, netIncome: null };
      return this.rowMap;
    }

    this.rowMap = { revenue: null, cogs: null, labor: null, operations: null, netIncome: null };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const accountName = row.Header?.ColData?.[0]?.value;

      if (!accountName) continue;

      // Map account names to our categories (no row IDs needed)
      if (accountName === 'Income') {
        this.rowMap.revenue = i;
      } else if (accountName === 'Cost of Goods Sold') {
        this.rowMap.cogs = i;
      } else if (accountName === 'Expenses') {
        this.rowMap.operations = i;
        // Look for labor in sub-rows under Expenses
        let subRowsArray = null;
        if (Array.isArray(row.Rows?.Row)) {
          subRowsArray = row.Rows.Row;
        } else if (Array.isArray(row.Rows?.Rows)) {
          subRowsArray = row.Rows.Rows;
        } else if (Array.isArray(row.Rows)) {
          subRowsArray = row.Rows;
        }

        if (subRowsArray) {
          for (let j = 0; j < subRowsArray.length; j++) {
            const subRow = subRowsArray[j];
            const subName = subRow.Header?.ColData?.[0]?.value || '';
            if (subName.includes('LABOR') || subName.includes('PAYROLL') || subName.includes('6200')) {
              this.rowMap.labor = { parentIdx: i, subIdx: j };
              break;
            }
          }
        }
      } else if (accountName === 'Net Income') {
        this.rowMap.netIncome = i;
        console.log(`  ✓ Net Income: index ${i} (${accountName})`);
      }
    }

    return this.rowMap;
  }

  /**
   * Extract metrics from QB response using row indices
   */
  extractMetrics(qbResponse, startDate = null, endDate = null) {
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
      return { revenue: 0, cogs: 0, labor: 0, operations: 0, netIncome: 0 };
    }

    const metrics = {
      revenue: 0,
      cogs: 0,
      labor: 0,
      operations: 0,
      netIncome: 0
    };

    // Extract values by row index (QB REST API structure)
    // QB returns nested structure: each row has Header (category name), Rows (details), and Summary (total)
    const extractRowValue = (row) => {
      if (!row) return 0;

      // Try Summary first (should be the total for the category)
      if (row.Summary?.ColData?.[1]?.value) {
        const val = parseFloat(row.Summary.ColData[1].value);
        if (!isNaN(val)) return val;
      }

      // Try Header second
      if (row.Header?.ColData?.[1]?.value) {
        const val = parseFloat(row.Header.ColData[1].value);
        if (!isNaN(val)) return val;
      }

      // If row has nested Rows, sum them up
      if (row.Rows?.Row && Array.isArray(row.Rows.Row)) {
        let total = 0;
        for (const subRow of row.Rows.Row) {
          if (subRow.Summary?.ColData?.[1]?.value) {
            total += parseFloat(subRow.Summary.ColData[1].value) || 0;
          }
        }
        if (total !== 0) return total;
      }

      return 0;
    };

    if (this.rowMap.revenue !== null && rows[this.rowMap.revenue]) {
      const revenueRow = rows[this.rowMap.revenue];
      metrics.revenue = extractRowValue(revenueRow);
      // Debug revenue extraction with dates
      const dateRange = startDate && endDate ? ` (${startDate} to ${endDate})` : '';
      console.log(`  Revenue: ${metrics.revenue}${dateRange}`);
      if (revenueRow.Summary?.ColData) {
        console.log(`    ColData: [${revenueRow.Summary.ColData.map((c, i) => `${i}:${c.value}`).join(', ')}]`);
      }
    }
    if (this.rowMap.cogs !== null && rows[this.rowMap.cogs]) {
      metrics.cogs = extractRowValue(rows[this.rowMap.cogs]);
      // QB API sometimes returns negative COGS even when value is positive in UI
      // Use absolute value to match QB UI display
      if (metrics.cogs < 0) {
        metrics.cogs = Math.abs(metrics.cogs);
      }
    }
    if (this.rowMap.labor !== null) {
      if (typeof this.rowMap.labor === 'number') {
        metrics.labor = extractRowValue(rows[this.rowMap.labor]);
      } else if (typeof this.rowMap.labor === 'object') {
        const expensesRow = rows[this.rowMap.labor.parentIdx];
        if (expensesRow) {
          let subRowsArray = null;
          if (Array.isArray(expensesRow.Rows?.Row)) {
            subRowsArray = expensesRow.Rows.Row;
          } else if (Array.isArray(expensesRow.Rows?.Rows)) {
            subRowsArray = expensesRow.Rows.Rows;
          } else if (Array.isArray(expensesRow.Rows)) {
            subRowsArray = expensesRow.Rows;
          }

          if (subRowsArray) {
            for (let i = 0; i < subRowsArray.length; i++) {
              const subRow = subRowsArray[i];
              const subName = subRow.Header?.ColData?.[0]?.value || '';
              if (subName.includes('LABOR') || subName.includes('PAYROLL') || subName.includes('6200')) {
                metrics.labor = extractRowValue(subRow);
                break;
              }
            }
          }
        }
      }
    }
    if (this.rowMap.operations !== null && rows[this.rowMap.operations]) {
      metrics.operations = extractRowValue(rows[this.rowMap.operations]);
    }
    if (this.rowMap.netIncome !== null && rows[this.rowMap.netIncome]) {
      metrics.netIncome = extractRowValue(rows[this.rowMap.netIncome]);
    } else {
      // If Net Income row not found, calculate it
      metrics.netIncome = metrics.revenue - metrics.cogs - metrics.operations;
    }

    return metrics;
  }

  /**
   * Generate week ranges (Monday-Sunday)
   * Only includes COMPLETE weeks with natural Monday-Sunday boundaries
   * Partial weeks (at start or end) are excluded
   */
  generateWeekRanges(startDate, endDate) {
    let current = new Date(startDate);
    const dayOfWeek = current.getDay();

    // Adjust to next Monday (don't include partial week at start)
    if (dayOfWeek !== 1) {
      const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
      current.setDate(current.getDate() + daysUntilMonday);
    }

    const weeks = [];
    while (current <= endDate) {
      const weekStart = new Date(current);
      const weekEnd = new Date(current);
      weekEnd.setDate(weekEnd.getDate() + 6); // Sunday

      // Only include if the entire week (Mon-Sun) is within the period
      // This avoids partial weeks and overlaps
      if (weekStart >= startDate && weekEnd <= endDate) {
        weeks.push({
          weekNum: weeks.length + 1,
          start: weekStart.toISOString().split('T')[0],
          end: weekEnd.toISOString().split('T')[0]
        });
      }

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
          labor: metrics.labor,
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
