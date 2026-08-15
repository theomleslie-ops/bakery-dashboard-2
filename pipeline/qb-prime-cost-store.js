/**
 * QB Prime Cost Data Store
 * Persists 4-week aggregated prime cost periods to JSON file
 */

const fs = require('fs').promises;
const path = require('path');

class PrimeCostStore {
  constructor(dbPath = './data/prime-cost-periods.json') {
    this.dbPath = dbPath;
  }

  async load() {
    try {
      const data = await fs.readFile(this.dbPath, 'utf-8');
      return JSON.parse(data);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { periods: [], lastUpdated: null };
      }
      throw err;
    }
  }

  async save(data) {
    try {
      const dir = path.dirname(this.dbPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.dbPath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(`Error saving prime cost data to ${this.dbPath}:`, err.message);
      throw err;
    }
  }

  /**
   * Upsert (insert or update) 4-week periods
   */
  async upsertPeriods(newPeriods) {
    const stored = await this.load();

    // Create a map of existing periods by date range
    const storedMap = new Map(
      stored.periods.map(p => [`${p.startDate}|${p.endDate}`, p])
    );

    // Upsert new periods
    for (const period of newPeriods) {
      const key = `${period.startDate}|${period.endDate}`;
      storedMap.set(key, {
        number: period.number,
        startDate: period.startDate,
        endDate: period.endDate,
        weeks: period.weeks,
        totalRevenue: period.totalRevenue,
        totalCogs: period.totalCogs,
        totalLabor: period.totalLabor,
        primeContribution: period.primeContribution,
        primeCostPercent: period.primeCostPercent,
        meetsGoal: period.meetsGoal
      });
    }

    // Sort by date and convert back to array
    const updated = {
      periods: Array.from(storedMap.values()).sort((a, b) => {
        const dateA = new Date(a.startDate);
        const dateB = new Date(b.startDate);
        return dateA - dateB;
      }),
      lastUpdated: new Date().toISOString(),
      count: Array.from(storedMap.values()).length
    };

    await this.save(updated);
    return updated;
  }

  /**
   * Get all prime cost periods
   */
  async getAllData() {
    return await this.load();
  }

  /**
   * Get prime cost periods for a specific date range
   */
  async getDataByRange(startDate, endDate) {
    const all = await this.load();
    return all.periods.filter(p => {
      const pStart = new Date(p.startDate);
      const pEnd = new Date(p.endDate);
      const qStart = new Date(startDate);
      const qEnd = new Date(endDate);
      return pEnd >= qStart && pStart <= qEnd;
    });
  }

  /**
   * Get last N periods
   */
  async getLastNPeriods(n) {
    const all = await this.load();
    return all.periods.slice(-n);
  }

  /**
   * Calculate average prime cost percent across all periods
   */
  async getAveragePrimeCost() {
    const all = await this.load();
    if (all.periods.length === 0) return 0;

    const sum = all.periods.reduce((acc, p) => acc + (p.primeCostPercent || 0), 0);
    return sum / all.periods.length;
  }

  /**
   * Get periods that meet the 60% goal
   */
  async getPeriodsMetGoal() {
    const all = await this.load();
    return all.periods.filter(p => p.meetsGoal);
  }

  /**
   * Clear all data
   */
  async clear() {
    await this.save({ periods: [], lastUpdated: null, count: 0 });
  }
}

module.exports = PrimeCostStore;
