/**
 * QB Prime Cost Store
 * Stores and retrieves 4-week prime cost periods
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../data/prime-cost-periods.json');

class PrimeCostStore {
  /**
   * Save periods to disk
   */
  async savePeriods(periods) {
    try {
      const dataDir = path.dirname(DATA_FILE);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      const data = {
        periods,
        lastUpdated: new Date().toISOString(),
        count: periods.length
      };

      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
      console.log(`✅ Saved ${periods.length} prime cost periods to disk`);
    } catch (err) {
      console.error('Failed to save prime cost periods:', err.message);
      throw err;
    }
  }

  /**
   * Load periods from disk
   */
  async loadPeriods() {
    try {
      if (!fs.existsSync(DATA_FILE)) {
        return {
          periods: [],
          lastUpdated: null,
          count: 0
        };
      }

      const content = fs.readFileSync(DATA_FILE, 'utf8');
      return JSON.parse(content);
    } catch (err) {
      console.error('Failed to load prime cost periods:', err.message);
      return {
        periods: [],
        lastUpdated: null,
        count: 0
      };
    }
  }

  /**
   * Get all periods
   */
  async getAllPeriods() {
    return this.loadPeriods();
  }

  /**
   * Get average prime cost
   */
  async getAveragePrimeCost() {
    const data = await this.loadPeriods();
    if (data.periods.length === 0) return 0;

    const totalRevenue = data.periods.reduce((sum, p) => sum + p.totalRevenue, 0);
    const totalPrime = data.periods.reduce((sum, p) => sum + p.primeContribution, 0);
    return totalRevenue > 0 ? (totalPrime / totalRevenue) * 100 : 0;
  }
}

module.exports = PrimeCostStore;
