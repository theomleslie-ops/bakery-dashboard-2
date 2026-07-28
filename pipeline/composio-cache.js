const fs = require('fs');
const path = require('path');
const composio = require('./composio-connectors');

const DATA_DIR = 'data';
const CACHE_FILE = path.join(DATA_DIR, 'composio-cache.json');
const CACHE_TTL = 3600000; // 1 hour

const loadCache = () => {
  try {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    return data || {};
  } catch {
    return {};
  }
};

const saveCache = (cache) => {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.warn('Failed to save composio cache:', e.message);
  }
};

const isStale = (timestamp) => {
  return !timestamp || Date.now() - timestamp > CACHE_TTL;
};

const cacheSquareTimecards = async (startDate, endDate) => {
  const cache = loadCache();
  const key = `timecards_${startDate}_${endDate}`;

  if (cache[key] && !isStale(cache[key].timestamp)) {
    console.log(`Using cached Square timecards for ${startDate}-${endDate}`);
    return cache[key].data;
  }

  console.log(`Fetching fresh Square timecards for ${startDate}-${endDate}`);
  try {
    const data = await composio.getSquareTimecards(startDate, endDate);
    cache[key] = { data, timestamp: Date.now() };
    saveCache(cache);
    return data;
  } catch (err) {
    console.error(`Failed to fetch Square timecards: ${err.message}`);
    return cache[key]?.data || null;
  }
};

const cacheSquareTeamMembers = async () => {
  const cache = loadCache();
  const key = 'team_members';

  if (cache[key] && !isStale(cache[key].timestamp)) {
    console.log('Using cached Square team members');
    return cache[key].data;
  }

  console.log('Fetching fresh Square team members');
  try {
    const data = await composio.getSquareTeamMembers();
    cache[key] = { data, timestamp: Date.now() };
    saveCache(cache);
    return data;
  } catch (err) {
    console.error(`Failed to fetch Square team members: ${err.message}`);
    return cache[key]?.data || null;
  }
};

const cacheSquareOrders = async (locationId, beginTime, endTime) => {
  const cache = loadCache();
  const key = `orders_${locationId}_${beginTime}_${endTime}`;

  if (cache[key] && !isStale(cache[key].timestamp)) {
    console.log(`Using cached Square orders for ${locationId}`);
    return cache[key].data;
  }

  console.log(`Fetching fresh Square orders for ${locationId}`);
  try {
    const data = await composio.getSquareOrders(locationId, beginTime, endTime);
    cache[key] = { data, timestamp: Date.now() };
    saveCache(cache);
    return data;
  } catch (err) {
    console.error(`Failed to fetch Square orders: ${err.message}`);
    return cache[key]?.data || null;
  }
};

const cacheQuickBooksReport = async (query) => {
  const cache = loadCache();
  const key = `qb_report_${query}`;

  if (cache[key] && !isStale(cache[key].timestamp)) {
    console.log(`Using cached QB report: ${query}`);
    return cache[key].data;
  }

  console.log(`Fetching fresh QB report: ${query}`);
  try {
    const data = await composio.getQuickBooksReport(query);
    cache[key] = { data, timestamp: Date.now() };
    saveCache(cache);
    return data;
  } catch (err) {
    console.error(`Failed to fetch QB report: ${err.message}`);
    return cache[key]?.data || null;
  }
};

const clearCache = () => {
  try {
    if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
    console.log('Composio cache cleared');
  } catch (e) {
    console.warn('Failed to clear composio cache:', e.message);
  }
};

const getCacheStatus = () => {
  const cache = loadCache();
  return {
    entries: Object.keys(cache).length,
    lastUpdated: Object.values(cache).reduce((max, entry) => Math.max(max, entry.timestamp || 0), 0),
    cacheFile: CACHE_FILE,
  };
};

const refreshAllData = async () => {
  console.log('Starting Composio cache refresh...');
  const status = { square: null, quickbooks: null, errors: [] };

  const connections = composio.getConnectionStatus();

  if (connections.square) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await cacheSquareTimecards(weekAgo, today);
      await cacheSquareTeamMembers();
      status.square = { updated: new Date().toISOString() };
    } catch (err) {
      status.errors.push(`Square: ${err.message}`);
    }
  }

  if (connections.quickbooks) {
    try {
      await cacheQuickBooksReport('ProfitAndLoss');
      status.quickbooks = { updated: new Date().toISOString() };
    } catch (err) {
      status.errors.push(`QuickBooks: ${err.message}`);
    }
  }

  console.log('Composio cache refresh complete:', status);
  return status;
};

module.exports = {
  cacheSquareTimecards,
  cacheSquareTeamMembers,
  cacheSquareOrders,
  cacheQuickBooksReport,
  clearCache,
  getCacheStatus,
  refreshAllData,
  loadCache,
};
