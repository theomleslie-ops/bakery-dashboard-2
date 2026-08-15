/**
 * QB Prime Cost Fetcher
 * Fetches 4-week P&L periods from QB using custom date ranges
 * Each 4-week period: Monday to Sunday, generated backward from most recent Sunday
 * Prime cost = (COGS + Labor) / Revenue * 100
 */

const axios = require('axios');

class QPrimeCostFetcher {
  constructor(qbClient, plFetcher) {
    this.qbClient = qbClient;
    this.plFetcher = plFetcher;
  }

  /**
   * Fetch 4-week periods directly from QB using custom date ranges
   * Each period is Monday to Sunday, generated backward from most recent Sunday
   */
  async fetchPrimeCostPeriodsFromQB(startDate, endDate) {
    try {
      console.log(`📊 Fetching 4-week P&L periods for prime cost (${startDate} to ${endDate})`);

      // Generate 4-week periods (Monday to Sunday)
      const fourWeekPeriods = this.generateFourWeekPeriods(startDate, endDate);
      console.log(`  Generated ${fourWeekPeriods.length} 4-week periods`);

      // Log all periods upfront
      if (fourWeekPeriods.length > 0) {
        console.log(`  📅 Period date ranges:`);
        fourWeekPeriods.forEach((p, i) => {
          console.log(`      [${i + 1}] ${p.start} to ${p.end}`);
        });
      }

      // Fetch P&L data for each 4-week period
      const periods = [];
      const failedPeriods = [];
      console.log(`  📋 Fetching ${fourWeekPeriods.length} periods...`);
      for (let i = 0; i < fourWeekPeriods.length; i++) {
        const periodDates = fourWeekPeriods[i];
        try {
          console.log(`  [${i + 1}/${fourWeekPeriods.length}] Fetching ${periodDates.start} to ${periodDates.end}...`);
          const report = await this.plFetcher.fetchPLReport(periodDates.start, periodDates.end);
          const metrics = this.plFetcher.extractMetrics(report);

          // Create 4-week period
          // Use actual period dates for both hover and label
          const [startYear, startMonth, startDay] = periodDates.start.split('-').map(Number);
          const [endYear, endMonth, endDay] = periodDates.end.split('-').map(Number);

          // Label: subtract 1 day from hover
          const startLabelDate = new Date(startYear, startMonth - 1, startDay - 1);
          const endLabelDate = new Date(endYear, endMonth - 1, endDay - 1);
          const labelStart = `${startLabelDate.getMonth() + 1}/${startLabelDate.getDate()}`;
          const labelEnd = `${endLabelDate.getMonth() + 1}/${endLabelDate.getDate()}`;

          const primeContribution = metrics.cogs + metrics.labor;
          const primeCostPercent = metrics.revenue > 0 ? (primeContribution / metrics.revenue) * 100 : 0;

          const period = {
            number: i + 1,
            startDate: periodDates.start,
            endDate: periodDates.end,
            label: `${labelStart}-${labelEnd}`,
            totalRevenue: metrics.revenue,
            totalCogs: metrics.cogs,
            totalLabor: metrics.labor,
            totalOperations: metrics.operations,
            primeContribution,
            primeCostPercent,
            meetsGoal: primeCostPercent <= 60
          };

          periods.push(period);
          console.log(`    ✓ labor=${metrics.labor.toFixed(0)}, prime cost=${primeCostPercent.toFixed(1)}%`);
        } catch (err) {
          console.error(`    ✗ Error: ${err.message}`);
          failedPeriods.push({ index: i + 1, dates: periodDates, error: err.message });
        }
      }

      console.log(`  ✅ Fetched ${periods.length}/${fourWeekPeriods.length} periods`);
      if (failedPeriods.length > 0) {
        console.warn(`  ⚠️  ${failedPeriods.length} periods failed:`);
        failedPeriods.forEach(f => {
          console.warn(`      [${f.index}] ${f.dates.start} to ${f.dates.end}: ${f.error}`);
        });
      }
      return periods;
    } catch (err) {
      console.error('Prime cost QB fetch error:', err.message);
      throw err;
    }
  }

  /**
   * Generate 4-week periods: Monday to Sunday
   * Start with most recent Sunday as end date, go back 4 weeks at a time
   */
  generateFourWeekPeriods(startDate, endDate) {
    const end = new Date(endDate);
    const start = new Date(startDate);
    const periods = [];

    // Find most recent Sunday from end date
    let currentSunday = new Date(end);
    const dayOfWeek = currentSunday.getDay();
    if (dayOfWeek !== 0) { // 0 = Sunday
      currentSunday.setDate(currentSunday.getDate() - dayOfWeek);
    }

    // Generate periods backward from most recent Sunday
    while (currentSunday >= start) {
      // Monday is 6 days before Sunday (or 27 days in the past from current Sunday)
      const periodStart = new Date(currentSunday);
      periodStart.setDate(periodStart.getDate() - 27); // Monday, 4 weeks before

      // Don't go before the requested start date
      const fetchStart = new Date(Math.max(periodStart.getTime(), start.getTime()));

      if (fetchStart <= currentSunday) {
        periods.unshift({
          start: fetchStart.toISOString().split('T')[0],
          end: currentSunday.toISOString().split('T')[0]
        });
      }

      // Move back to previous Sunday (4 weeks back = 28 days)
      currentSunday.setDate(currentSunday.getDate() - 28);
    }

    // Log periods generated
    if (periods.length > 0) {
      console.log(`  📅 Generated ${periods.length} 4-week periods:`);
      console.log(`    First: ${periods[0].start} to ${periods[0].end}`);
      console.log(`    Last:  ${periods[periods.length-1].start} to ${periods[periods.length-1].end}`);
      if (periods.length <= 10) {
        periods.forEach((p, i) => {
          console.log(`      [${i + 1}] ${p.start} to ${p.end}`);
        });
      }
    } else {
      console.log(`  📅 No periods generated for range ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
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
