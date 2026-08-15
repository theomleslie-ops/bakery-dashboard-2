/**
 * QB Prime Cost Fetcher
 * Fetches 2-week P&L periods from QB (includes labor detail)
 * Groups into 4-week periods for prime cost calculation
 * Prime cost = (COGS + Labor) / Revenue * 100
 */

const axios = require('axios');

class QPrimeCostFetcher {
  constructor(qbClient, plFetcher) {
    this.qbClient = qbClient;
    this.plFetcher = plFetcher;
  }

  /**
   * Fetch 2-week periods directly from QB (includes labor detail)
   * Then group into 4-week periods for prime cost
   */
  async fetchPrimeCostPeriodsFromQB(startDate, endDate) {
    try {
      console.log(`📊 Fetching 2-week P&L periods for prime cost (${startDate} to ${endDate})`);

      // Generate 2-week periods
      const twoWeekPeriods = this.generate2WeekPeriods(startDate, endDate);
      console.log(`  Generated ${twoWeekPeriods.length} 2-week periods`);

      // Fetch P&L data for each 2-week period
      const twoWeekData = [];
      for (const period of twoWeekPeriods) {
        try {
          const report = await this.plFetcher.fetchPLReport(period.start, period.end);
          const metrics = this.plFetcher.extractMetrics(report);
          twoWeekData.push({
            start: period.start,
            end: period.end,
            revenue: metrics.revenue,
            cogs: metrics.cogs,
            labor: metrics.labor,
            operations: metrics.operations
          });
          if (metrics.labor > 0) {
            console.log(`  ✓ ${period.start} to ${period.end}: labor=${metrics.labor.toFixed(0)}`);
          }
        } catch (err) {
          console.error(`  ✗ Failed to fetch ${period.start} to ${period.end}:`, err.message);
        }
      }

      console.log(`  ✅ Fetched ${twoWeekData.length} 2-week periods with labor detail`);

      // Group 2-week periods into 4-week periods
      const fourWeekPeriods = this.groupTwoWeekIntoPeriods(twoWeekData);
      return fourWeekPeriods;
    } catch (err) {
      console.error('Prime cost QB fetch error:', err.message);
      throw err;
    }
  }

  /**
   * Generate 2-week periods (include labor detail in QB reports)
   */
  generate2WeekPeriods(startDate, endDate) {
    let current = new Date(startDate);
    const end = new Date(endDate);
    const periods = [];

    // Adjust to Monday
    const dayOfWeek = current.getDay();
    if (dayOfWeek !== 1) {
      current.setDate(current.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    }

    while (current <= end) {
      const periodStart = new Date(current);
      const periodEnd = new Date(current);
      periodEnd.setDate(periodEnd.getDate() + 13); // 2 weeks

      const fetchStart = new Date(Math.max(periodStart.getTime(), new Date(startDate).getTime()));
      const fetchEnd = new Date(Math.min(periodEnd.getTime(), end.getTime()));

      periods.push({
        start: fetchStart.toISOString().split('T')[0],
        end: fetchEnd.toISOString().split('T')[0]
      });

      current.setDate(current.getDate() + 14);
    }

    return periods;
  }

  /**
   * Group 2-week periods into 4-week periods
   */
  groupTwoWeekIntoPeriods(twoWeekData) {
    const periods = [];

    for (let i = 0; i < twoWeekData.length; i += 2) {
      if (i + 1 < twoWeekData.length) {
        const period1 = twoWeekData[i];
        const period2 = twoWeekData[i + 1];

        const totalRevenue = period1.revenue + period2.revenue;
        const totalCogs = period1.cogs + period2.cogs;
        const totalLabor = period1.labor + period2.labor;
        const totalOperations = period1.operations + period2.operations;

        const primeContribution = totalCogs + totalLabor;
        const primeCostPercent = totalRevenue > 0 ? (primeContribution / totalRevenue) * 100 : 0;

        // Extract start date from period1, use next day for label
        const p1start = new Date(period1.start);
        p1start.setDate(p1start.getDate() + 1);
        const labelStart = `${String(p1start.getMonth() + 1).padStart(2, '0')}/${String(p1start.getDate()).padStart(2, '0')}`;

        // Extract end date from period2
        const p2end = new Date(period2.end);
        const labelEnd = `${String(p2end.getMonth() + 1).padStart(2, '0')}/${String(p2end.getDate()).padStart(2, '0')}`;

        periods.push({
          number: periods.length + 1,
          startDate: period1.start,
          endDate: period2.end,
          label: `${labelStart}-${labelEnd}`,
          totalRevenue,
          totalCogs,
          totalLabor,
          totalOperations,
          primeContribution,
          primeCostPercent,
          meetsGoal: primeCostPercent <= 60
        });
      }
    }

    return periods;
  }

  /**
   * Fetch and group P&L data into 4-week periods (old method - uses weekly data)
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
