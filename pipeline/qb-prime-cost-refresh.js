/**
 * QB Prime Cost Refresh
 * Refreshes 4-week prime cost periods from QB 2-week P&L data
 * (2-week reports include labor detail, weekly reports do not)
 */

const QPrimeCostFetcher = require('./qb-prime-cost-fetcher');
const QBPLFetcher = require('./qb-pl-fetcher');
const PrimeCostStore = require('./qb-prime-cost-store');

async function refreshPrimeCostData(qbClient) {
  console.log('📊 === PRIME COST REFRESH STARTED ===');
  const startTime = Date.now();

  try {
    const plFetcher = new QBPLFetcher(qbClient);

    // Ensure row IDs are identified (needed for labor extraction)
    if (!plFetcher.rowMap) {
      await plFetcher.identifyRowIds();
    }

    const fetcher = new QPrimeCostFetcher(qbClient, plFetcher);
    const store = new PrimeCostStore();

    // Fetch 4-week P&L data from QB (includes labor detail)
    // Use past 1 year (~13 API calls for 4-week periods)
    const endDate = new Date();
    const startDate = new Date(endDate);
    startDate.setFullYear(startDate.getFullYear() - 1);

    const periods = await fetcher.fetchPrimeCostPeriodsFromQB(
      startDate.toISOString().split('T')[0],
      endDate.toISOString().split('T')[0]
    );

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
