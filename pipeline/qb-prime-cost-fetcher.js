/**
 * QB Prime Cost Fetcher
 * Groups P&L weekly data into 4-week periods (Monday-Sunday)
 * Prime cost = (COGS + Labor) / Revenue * 100
 */

const axios = require('axios');

class QPrimeCostFetcher {
  /**
   * Fetch and group P&L data into 4-week periods
   * Periods: Monday to Sunday, aligned from most recent Sunday
   */
  async fetchPrimeCostPeriods(baseUrl) {
    try {
      // Fetch weekly P&L data
      const response = await axios.get(`${baseUrl}/api/pl/weekly`);
      if (!response.data?.data || !Array.isArray(response.data.data)) {
        throw new Error('No weekly P&L data available');
      }

      const weeklyData = response.data.data;
      if (weeklyData.length === 0) {
        return [];
      }

      // Sort weeks by start date
      const sortedWeeks = weeklyData
        .filter(w => !w.error)
        .sort((a, b) => new Date(a.start) - new Date(b.start));

      if (sortedWeeks.length === 0) {
        return [];
      }

      // Find most recent Sunday
      const latestEndDate = new Date(sortedWeeks[sortedWeeks.length - 1].end);
      const mostRecentSunday = this.findMostRecentSunday(latestEndDate);

      // Group weeks into 4-week periods
      const periods = this.groupIntoPeriods(sortedWeeks, mostRecentSunday);

      console.log(`✅ Grouped ${sortedWeeks.length} weeks into ${periods.length} 4-week periods`);
      return periods;
    } catch (err) {
      console.error('Prime cost fetch error:', err.message);
      throw err;
    }
  }

  /**
   * Find the most recent Sunday from a given date
   */
  findMostRecentSunday(date) {
    const d = new Date(date);
    const dayOfWeek = d.getDay();
    if (dayOfWeek !== 0) { // 0 = Sunday
      d.setDate(d.getDate() - dayOfWeek);
    }
    return d;
  }

  /**
   * Group weeks into 4-week periods
   * Each period: Monday (27 days before Sunday) to Sunday
   */
  groupIntoPeriods(weeks, mostRecentSunday) {
    const periods = [];
    let weekIdx = weeks.length - 1;
    let currentPeriodEndDate = new Date(mostRecentSunday);

    while (weekIdx >= 0) {
      const periodWeeks = [];
      const periodStartDate = new Date(currentPeriodEndDate);
      periodStartDate.setDate(periodStartDate.getDate() - 27); // Monday of 4 weeks prior

      // Collect up to 4 weeks within this period (process backward)
      while (weekIdx >= 0 && periodWeeks.length < 4) {
        const week = weeks[weekIdx];
        const weekStartDate = new Date(week.start);
        const weekEndDate = new Date(week.end);

        // Check if week falls within period boundaries
        if (weekEndDate <= currentPeriodEndDate && weekStartDate >= periodStartDate) {
          periodWeeks.unshift(week);
          weekIdx--;
        } else if (weekEndDate < periodStartDate) {
          // Week is from an older period
          break;
        } else {
          // Week is newer than period end
          weekIdx--;
        }
      }

      // Save period if we have exactly 4 weeks
      if (periodWeeks.length === 4) {
        const period = this.aggregatePeriod(periodWeeks);
        periods.unshift(period);

        // Move to previous 4-week period
        currentPeriodEndDate.setDate(currentPeriodEndDate.getDate() - 28);
      } else {
        // No more complete periods
        break;
      }
    }

    // Renumber periods in chronological order
    periods.forEach((p, i) => { p.number = i + 1; });

    return periods;
  }

  /**
   * Aggregate 4 weeks into a single period
   */
  aggregatePeriod(weeks) {
    const totalRevenue = weeks.reduce((sum, w) => sum + (w.revenue || 0), 0);
    const totalCogs = weeks.reduce((sum, w) => sum + (w.cogs || 0), 0);
    const totalLabor = weeks.reduce((sum, w) => sum + (w.labor || 0), 0);
    const totalOperations = weeks.reduce((sum, w) => sum + (w.operations || 0), 0);

    const primeContribution = totalCogs + totalLabor;
    const primeCostPercent = totalRevenue > 0 ? (primeContribution / totalRevenue) * 100 : 0;

    return {
      number: 0, // Will be renumbered
      startDate: weeks[0].start,
      endDate: weeks[3].end,
      label: `${weeks[0].start.split('-')[1]}/${weeks[0].start.split('-')[2]}-${weeks[3].end.split('-')[1]}/${weeks[3].end.split('-')[2]}`,
      weeks: weeks.map(w => w.week || 0),
      totalRevenue,
      totalCogs,
      totalLabor,
      totalOperations,
      primeContribution,
      primeCostPercent,
      meetsGoal: primeCostPercent <= 60
    };
  }

  /**
   * Calculate average prime cost across periods
   */
  calculateAverage(periods) {
    if (periods.length === 0) return 0;
    const totalRevenue = periods.reduce((sum, p) => sum + p.totalRevenue, 0);
    const totalPrime = periods.reduce((sum, p) => sum + p.primeContribution, 0);
    return totalRevenue > 0 ? (totalPrime / totalRevenue) * 100 : 0;
  }
}

module.exports = QPrimeCostFetcher;
