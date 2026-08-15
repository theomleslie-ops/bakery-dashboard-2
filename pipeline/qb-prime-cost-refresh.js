/**
 * QB Prime Cost Refresh
 * Refreshes 4-week prime cost periods from weekly P&L data
 */

const QPrimeCostFetcher = require('./qb-prime-cost-fetcher');
const PrimeCostStore = require('./qb-prime-cost-store');

async function refreshPrimeCostData(baseUrl) {
  console.log('📊 === PRIME COST REFRESH STARTED ===');
  const startTime = Date.now();

  try {
    const fetcher = new QPrimeCostFetcher();
    const store = new PrimeCostStore();

    // Fetch and group P&L data into 4-week periods
    const periods = await fetcher.fetchPrimeCostPeriods(baseUrl);

    if (periods.length === 0) {
      console.warn('⚠️ No 4-week periods found');
      return {
        success: false,
        message: 'No data available',
        periods: 0
      };
    }

    // Calculate average prime cost
    const avgPrimeCost = fetcher.calculateAverage(periods);
    const goalMetCount = periods.filter(p => p.meetsGoal).length;

    console.log(`\n📊 Prime Cost Summary:`);
    console.log(`  Periods: ${periods.length}`);
    console.log(`  Average Prime Cost: ${avgPrimeCost.toFixed(1)}%`);
    console.log(`  Periods meeting goal (≤60%): ${goalMetCount}/${periods.length}`);

    // Store periods
    await store.savePeriods(periods);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`📊 === PRIME COST REFRESH COMPLETE (${duration}s) ===\n`);

    return {
      success: true,
      periods: periods.length,
      avgPrimeCost,
      goalMetCount,
      lastUpdated: new Date().toISOString()
    };
  } catch (error) {
    console.error('❌ Prime Cost Refresh failed:', error.message);
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`📊 === PRIME COST REFRESH FAILED (${duration}s) ===\n`);
    throw error;
  }
}

module.exports = { refreshPrimeCostData };
