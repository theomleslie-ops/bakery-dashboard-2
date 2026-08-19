/**
 * QB P&L Data Store
 * Persists weekly P&L data to JSON file
 */

const fs = require('fs').promises;
const path = require('path');

class PLStore {
  constructor(dbPath = './data/pl-weekly.json') {
    this.dbPath = dbPath;
  }

  async load() {
    try {
      const data = await fs.readFile(this.dbPath, 'utf-8');
      return JSON.parse(data);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { weeks: [], lastUpdated: null };
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
      console.error(`Error saving P&L data to ${this.dbPath}:`, err.message);
      throw err;
    }
  }

  /**
   * Upsert (insert or update) weeks, avoiding duplicates
   */
  async upsertWeeks(newWeeks) {
    const stored = await this.load();

    // Create a map of existing weeks by date range
    const storedMap = new Map(
      stored.weeks.map(w => [`${w.start}|${w.end}`, w])
    );

    // Remove overlapping weeks from old data before adding new ones
    // An overlapping week is one where the date range is different but dates overlap
    const newWeeksList = newWeeks.filter(w => !w.error);
    const keysToRemove = [];

    for (const [key, oldWeek] of storedMap) {
      const oldStart = new Date(oldWeek.start);
      const oldEnd = new Date(oldWeek.end);

      // Check if this old week overlaps with any new week
      for (const newWeek of newWeeksList) {
        const newStart = new Date(newWeek.start);
        const newEnd = new Date(newWeek.end);

        // Overlaps if: old_start <= new_end AND old_end >= new_start
        const overlaps = oldStart <= newEnd && oldEnd >= newStart;

        // But keep it if it's the exact same date range (replacement)
        const isSameDateRange = oldStart.getTime() === newStart.getTime() &&
                                oldEnd.getTime() === newEnd.getTime();

        if (overlaps && !isSameDateRange) {
          keysToRemove.push(key);
          break;
        }
      }
    }

    // Remove overlapping old entries
    keysToRemove.forEach(key => storedMap.delete(key));

    // Upsert new weeks
    for (const week of newWeeksList) {
      const key = `${week.start}|${week.end}`;
      storedMap.set(key, week);
    }

    // Sort by start date and convert back to array
    const updated = {
      weeks: Array.from(storedMap.values()).sort((a, b) =>
        new Date(a.start).getTime() - new Date(b.start).getTime()
      ),
      lastUpdated: new Date().toISOString(),
      count: Array.from(storedMap.values()).filter(w => !w.error).length
    };

    await this.save(updated);
    return updated;
  }

  /**
   * Get all P&L data
   */
  async getAllData() {
    return await this.load();
  }

  /**
   * Get P&L data for a specific date range
   */
  async getDataByRange(startDate, endDate) {
    const all = await this.load();
    return all.weeks.filter(w => {
      const wStart = new Date(w.start);
      const wEnd = new Date(w.end);
      const qStart = new Date(startDate);
      const qEnd = new Date(endDate);
      return wEnd >= qStart && wStart <= qEnd;
    });
  }

  /**
   * Clear all data
   */
  async clear() {
    await this.save({ weeks: [], lastUpdated: null, count: 0 });
  }
}

module.exports = PLStore;
