/**
 * QB Prime Cost Refresh Job
 * Runs on schedule to update 4-week prime cost periods
 * Replicates P&L fetching algorithm specifically for prime cost
 */

const QPrimeCostFetcher = require('./qb-prime-cost-fetcher');
const PrimeCostStore = require('./qb-prime-cost-store');

/**
 * Refresh prime cost data using same fetching algorithm as P&L
 */
async function refreshPrimeCostData(qbClient) {
  console.log('\n📈 === PRIME COST REFRESH STARTED ===');
  const startTime = Date.now();

  try {
    const fetcher = new QPrimeCostFetcher(qbClient);
    const store = new PrimeCostStore();

    // Step 1: Identify row IDs (if not cached)
    if (!fetcher.plFetcher.rowMap) {
      await fetcher.plFetcher.identifyRowIds();
    }

    // Step 2: Define time period (5 years back to today)
    const today = new Date();
    const fiveYearsAgo = new Date(today.getFullYear() - 5, today.getMonth(), today.getDate());

    // Step 3: Fetch weekly P&L data and aggregate into 4-week periods
    const periods = await fetcher.fetchPrimeCostPeriods(fiveYearsAgo, today);

    // Step 4: Validate prime cost data
    const validation = fetcher.validatePrimeCost(periods);
    console.log(`\n📊 Prime Cost Validation Results:`);
    console.log(`  Total Revenue:        $${validation.totalRevenue.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
    console.log(`  Total Prime Contribution: $${validation.totalPrimeContribution.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
    console.log(`  Overall Prime Cost %:  ${validation.overallPrimeCostPercent.toFixed(1)}%`);
    console.log(`  Periods Count:         ${validation.periodCount}`);
    console.log(`  Periods Meeting Goal:  ${validation.goalMetCount}/${validation.periodCount} (target ≤60%)`);

    // Step 5: Store data
    const stored = await store.upsertPeriods(periods);
    console.log(`\n✅ Prime cost data stored: ${stored.count} periods`);
    console.log(`   Last updated: ${stored.lastUpdated}`);

    // Step 6: Calculate average
    const avgPrimeCost = await store.getAveragePrimeCost();
    console.log(`   Average prime cost: ${avgPrimeCost.toFixed(1)}%`);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`📈 === PRIME COST REFRESH COMPLETE (${duration}s) ===\n`);

    return {
      success: true,
      periodCount: stored.count,
      validation,
      avgPrimeCost,
      lastUpdated: stored.lastUpdated
    };
  } catch (error) {
    console.error('❌ Prime Cost Refresh failed:', error.message);
    if (error.response?.data) {
      console.error('QB Error:', error.response.data);
    }
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`📈 === PRIME COST REFRESH FAILED (${duration}s) ===\n`);
    throw error;
  }
}

module.exports = { refreshPrimeCostData };
