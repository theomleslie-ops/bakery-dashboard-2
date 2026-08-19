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
      // Log exact dates being sent to QB (critical for debugging year/date issues)
      if (startDate.includes('12') && endDate.includes('01')) {
        console.log(`  🔍 Year-boundary fetch: start=${startDate}, end=${endDate}`);
      }

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
      this.rowMap = { revenue: null, cogs: null, labor: null, operations: null, netIncome: null };
      return this.rowMap;
    }

    this.rowMap = {};

    // QB REST API structure: rows ARE the categories, extract totals directly
    this.rowMap = { revenue: null, cogs: null, labor: null, operations: null, netIncome: null };

    // Debug: log all account names first
    console.log('  Available rows:');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const accountName = row.Header?.ColData?.[0]?.value;
      console.log(`    [${i}] ${accountName || '(unnamed)'}`);
    }

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
        // Look for labor in sub-rows under Expenses
        console.log(`    DEBUG Expenses row structure:`, {
          hasRows: !!row.Rows,
          rowsType: typeof row.Rows,
          rowsKeys: Object.keys(row.Rows || {}).slice(0, 10),
          hasRowsRow: !!row.Rows?.Row,
          rowsRowIsArray: Array.isArray(row.Rows?.Row),
          rowsRowLength: row.Rows?.Row?.length,
          hasRowsRows: !!row.Rows?.Rows,
          rowsRowsIsArray: Array.isArray(row.Rows?.Rows),
          isRowsArray: Array.isArray(row.Rows)
        });

        let subRowsArray = null;
        if (Array.isArray(row.Rows?.Row)) {
          subRowsArray = row.Rows.Row;
          console.log(`    Using row.Rows.Row`);
        } else if (Array.isArray(row.Rows?.Rows)) {
          subRowsArray = row.Rows.Rows;
          console.log(`    Using row.Rows.Rows`);
        } else if (Array.isArray(row.Rows)) {
          subRowsArray = row.Rows;
          console.log(`    Using row.Rows directly (array)`);
        } else {
          console.log(`    ⚠️  No array found for sub-rows. Full Expenses row:`, JSON.stringify(row).substring(0, 500));
        }

        if (subRowsArray) {
          console.log(`    DEBUG Found ${subRowsArray.length} sub-rows under Expenses:`);
          for (let j = 0; j < subRowsArray.length; j++) {
            const subRow = subRowsArray[j];
            const subName = subRow.Header?.ColData?.[0]?.value || '';
            console.log(`      [${j}] "${subName}"`);
            // Look for labor/payroll accounts (6200 LABOR/PAYROLL EXPENSES or similar)
            if (subName.includes('LABOR') || subName.includes('PAYROLL') || subName.includes('6200')) {
              this.rowMap.labor = { parentIdx: i, subIdx: j };
              console.log(`  ✓ Labor: sub-row ${i}.${j} (${subName})`);
              break;
            }
          }
          if (!this.rowMap.labor) {
            console.log(`    ⚠️  No labor found in Expenses sub-rows`);
          }
        }
      } else if (accountName === 'Net Income') {
        this.rowMap.netIncome = i;
        console.log(`  ✓ Net Income: index ${i} (${accountName})`);
      }
    }

    // Log final row map for debugging
    console.log(`  📊 Row mapping complete: revenue=${this.rowMap.revenue}, cogs=${this.rowMap.cogs}, labor=${JSON.stringify(this.rowMap.labor)}, ops=${this.rowMap.operations}, net=${this.rowMap.netIncome}`);

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
      return { revenue: 0, cogs: 0, labor: 0, operations: 0, netIncome: 0 };
    }

    const metrics = {
      revenue: 0,
      cogs: 0,
      labor: 0,
      operations: 0,
      netIncome: 0
    };

    // Debug: log the actual row structure for revenue (index 0)
    if (rows[0]) {
      const debugRow = rows[0];
      console.log('  DEBUG row[0] structure:', {
        hasHeader: !!debugRow.Header,
        headerKeys: Object.keys(debugRow.Header || {}),
        colData: debugRow.Header?.ColData,
        hasSummary: !!debugRow.Summary,
        summaryColData: debugRow.Summary?.ColData,
        hasRows: !!debugRow.Rows
      });
    }

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
      // Debug revenue extraction
      console.log(`  DEBUG Revenue extraction:`);
      if (revenueRow.Summary?.ColData) {
        console.log(`    Summary.ColData values:`, revenueRow.Summary.ColData.map((c, i) => `[${i}]=${c.value}`).join(', '));
      }
      if (revenueRow.Header?.ColData) {
        console.log(`    Header.ColData values:`, revenueRow.Header.ColData.map((c, i) => `[${i}]=${c.value}`).join(', '));
      }
      console.log(`    Extracted revenue: ${metrics.revenue}`);
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
      console.log(`  DEBUG labor extraction: rowMap.labor=${JSON.stringify(this.rowMap.labor)}`);
      if (typeof this.rowMap.labor === 'number') {
        // Labor is a top-level account
        console.log(`    Labor is top-level at index ${this.rowMap.labor}`);
        metrics.labor = extractRowValue(rows[this.rowMap.labor]);
        console.log(`    Extracted value: ${metrics.labor}`);
      } else if (typeof this.rowMap.labor === 'object') {
        // Labor is a sub-row under Expenses - search by name since index may vary by date range
        console.log(`    Labor is sub-row: parentIdx=${this.rowMap.labor.parentIdx}, searching by name`);
        const expensesRow = rows[this.rowMap.labor.parentIdx];
        if (expensesRow) {
          console.log(`    Expenses row found at index ${this.rowMap.labor.parentIdx}`);
          let subRowsArray = null;
          if (Array.isArray(expensesRow.Rows?.Row)) {
            subRowsArray = expensesRow.Rows.Row;
            console.log(`      Using Rows.Row (${subRowsArray.length} sub-rows)`);
          } else if (Array.isArray(expensesRow.Rows?.Rows)) {
            subRowsArray = expensesRow.Rows.Rows;
            console.log(`      Using Rows.Rows (${subRowsArray.length} sub-rows)`);
          } else if (Array.isArray(expensesRow.Rows)) {
            subRowsArray = expensesRow.Rows;
            console.log(`      Using Rows directly (${subRowsArray.length} sub-rows)`);
          } else {
            console.log(`      ⚠️  No array found. Rows keys: ${Object.keys(expensesRow.Rows || {})}`);
          }

          if (subRowsArray) {
            console.log(`      Total sub-rows: ${subRowsArray.length}, searching for LABOR/PAYROLL/6200`);
            // Search for labor by name instead of index (index varies by date range)
            for (let i = 0; i < subRowsArray.length; i++) {
              const subRow = subRowsArray[i];
              const subName = subRow.Header?.ColData?.[0]?.value || '';
              if (subName.includes('LABOR') || subName.includes('PAYROLL') || subName.includes('6200')) {
                console.log(`      Found labor row at index ${i}: "${subName}"`);
                metrics.labor = extractRowValue(subRow);
                console.log(`      Extracted labor value: ${metrics.labor}`);
                break;
              }
            }
            if (metrics.labor === 0) {
              console.log(`      ⚠️  No labor row found in sub-rows`);
            }
          }
        } else {
          console.log(`    ⚠️  Expenses row NOT found at index ${this.rowMap.labor.parentIdx}`);
        }
      } else {
        console.log(`    ⚠️  Labor rowMap is neither number nor object: ${typeof this.rowMap.labor}`);
      }
    } else {
      console.log(`  DEBUG labor extraction: rowMap.labor is NULL (not set)`);
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
