/**
 * QB Prime Cost Fetcher
 * Replicates P&L fetching algorithm specifically for prime cost dashboard
 * Prime cost = COGS + Labor
 * Aggregates weekly data into 4-week periods
 */

const QBPLFetcher = require('./qb-pl-fetcher');

class QPrimeCostFetcher {
  constructor(qbClient) {
    this.plFetcher = new QBPLFetcher(qbClient);
  }

  /**
   * Fetch and aggregate prime cost data into 4-week periods
   * Uses the same algorithm as P&L fetcher for consistency
   */
  async fetchPrimeCostPeriods(startDate, endDate) {
    console.log(`📊 Fetching prime cost data from ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);

    // Step 1: Identify row IDs if not already done
    if (!this.plFetcher.rowMap) {
      await this.plFetcher.identifyRowIds();
    }

    // Step 2: Fetch weekly P&L data
    const weeklyData = await this.plFetcher.fetchAllWeeks(startDate, endDate);

    // Step 3: Aggregate into 4-week periods
    const periods = this.aggregateToFourWeekPeriods(weeklyData);

    return periods;
  }

  /**
   * Aggregate weekly data into 4-week periods
   * Prime cost = (COGS + Labor) / Revenue * 100
   */
  aggregateToFourWeekPeriods(weeklyData) {
    const successWeeks = weeklyData.filter(w => !w.error).sort((a, b) => {
      const dateA = new Date(a.start);
      const dateB = new Date(b.start);
      return dateA - dateB;
    });

    if (successWeeks.length < 4) {
      console.warn(`⚠️  Only ${successWeeks.length} successful weeks found, need at least 4 for period aggregation`);
      return [];
    }

    const periods = [];

    // Group weeks into 4-week chunks (continue as long as we have at least 4 weeks left)
    for (let i = 0; i + 4 <= successWeeks.length; i += 4) {
      const periodWeeks = successWeeks.slice(i, i + 4);

      // Ensure we have exactly 4 weeks
      if (periodWeeks.length !== 4) {
        console.warn(`⚠️  Skipping incomplete period at index ${i}: only ${periodWeeks.length} weeks`);
        continue;
      }

      const totalRevenue = periodWeeks.reduce((sum, w) => sum + (w.revenue || 0), 0);
      const totalCogs = periodWeeks.reduce((sum, w) => sum + (w.cogs || 0), 0);
      const totalLabor = periodWeeks.reduce((sum, w) => sum + (w.labor || 0), 0);

      console.log(`📊 Period ${periods.length + 1}: weeks ${i}-${i+3}, revenue=$${totalRevenue}, cogs=$${totalCogs}, labor=$${totalLabor}`);

      if (totalRevenue > 0) {
        const primeContribution = totalCogs + totalLabor;
        const primeCostPercent = (primeContribution / totalRevenue) * 100;

        periods.push({
          number: periods.length + 1,
          startDate: periodWeeks[0].start,
          endDate: periodWeeks[3].end,
          weeks: periodWeeks.map(w => w.week),
          totalRevenue,
          totalCogs,
          totalLabor,
          primeContribution,
          primeCostPercent,
          meetsGoal: primeCostPercent <= 60 // Standard prime cost target
        });
      }
    }

    console.log(`✅ Aggregated ${successWeeks.length} weeks into ${periods.length} 4-week periods`);
    return periods;
  }

  /**
   * Validate prime cost totals
   */
  validatePrimeCost(periods) {
    if (periods.length === 0) {
      return { isValid: true, warning: 'No periods to validate' };
    }

    let totalRevenue = 0;
    let totalPrimeContribution = 0;

    for (const period of periods) {
      totalRevenue += period.totalRevenue || 0;
      totalPrimeContribution += period.primeContribution || 0;
    }

    const overallPrimeCostPercent = totalRevenue > 0 ? (totalPrimeContribution / totalRevenue) * 100 : 0;

    return {
      isValid: true,
      totalRevenue,
      totalPrimeContribution,
      overallPrimeCostPercent,
      periodCount: periods.length,
      goalMetCount: periods.filter(p => p.meetsGoal).length
    };
  }
}

module.exports = QPrimeCostFetcher;
