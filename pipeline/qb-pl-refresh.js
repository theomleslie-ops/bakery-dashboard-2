/**
 * QB P&L Refresh Job
 * Runs on schedule (every 3 days) to update weekly P&L data
 */

const QBPLFetcher = require('./qb-pl-fetcher');
const PLStore = require('./qb-pl-store');

/**
 * Refresh P&L data for past 5 years + future
 */
async function refreshPLData(qbClient) {
  console.log('\n📊 === P&L REFRESH STARTED ===');
  const startTime = Date.now();

  try {
    const fetcher = new QBPLFetcher(qbClient);
    const store = new PLStore();

    // Step 1: Identify row IDs (if not cached)
    if (!fetcher.rowMap) {
      await fetcher.identifyRowIds();
    }

    // Step 2: Define time period (5 years back to today)
    const today = new Date();
    const fiveYearsAgo = new Date(today.getFullYear() - 5, today.getMonth(), today.getDate());

    // Step 3: Fetch all weeks
    const weeklyData = await fetcher.fetchAllWeeks(fiveYearsAgo, today);

    // Step 4: Validate math
    const validation = fetcher.validateTotals(weeklyData);
    console.log(`\n📈 Validation Results:`);
    console.log(`  Revenue:   $${validation.totals.revenue.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
    console.log(`  COGS:      $${validation.totals.cogs.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
    console.log(`  Operations: $${validation.totals.operations.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
    console.log(`  Net Income: $${validation.totals.netIncome.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
    console.log(`  Math Valid: ${validation.isValid ? '✓' : '✗'} (difference: $${validation.difference.toFixed(2)})`);

    if (!validation.isValid) {
      console.warn(`⚠️ Validation warning: Math difference of $${validation.difference.toFixed(2)}`);
    }

    // Step 5: Store data
    const stored = await store.upsertWeeks(weeklyData);
    console.log(`\n✅ P&L data stored: ${stored.count} weeks`);
    console.log(`   Last updated: ${stored.lastUpdated}`);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`📊 === P&L REFRESH COMPLETE (${duration}s) ===\n`);

    return {
      success: true,
      weeksCount: stored.count,
      totals: validation.totals,
      isValid: validation.isValid,
      lastUpdated: stored.lastUpdated
    };
  } catch (error) {
    console.error('❌ P&L Refresh failed:', error.message);
    if (error.response?.data) {
      console.error('QB Error:', error.response.data);
    }
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`📊 === P&L REFRESH FAILED (${duration}s) ===\n`);
    throw error;
  }
}

module.exports = { refreshPLData };
