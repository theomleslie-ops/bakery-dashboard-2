// Initialize Product Margins on startup: try to build, fallback to seed data if auth unavailable
const fs = require('fs');
const path = require('path');
const { main: buildMargins } = require('./build-margins');

const RECIPE_COSTS_FILE = path.join(__dirname, '..', 'data', 'pipeline', 'recipe-costs.json');
const SEED_FILE = path.join(__dirname, '..', 'seed-data', 'recipe-costs.json');

const seedData = () => {
  console.log('Using seed recipe costs (QB/Google not connected)…');
  try {
    if (fs.existsSync(SEED_FILE)) {
      fs.mkdirSync(path.dirname(RECIPE_COSTS_FILE), { recursive: true });
      fs.copyFileSync(SEED_FILE, RECIPE_COSTS_FILE);
      console.log('✓ Seeded recipe-costs.json from seed-data/');
    } else {
      console.log('⚠ No seed data found. Pipeline will need to be run manually: npm run margins');
    }
  } catch (e) {
    console.warn('Failed to seed data:', e.message);
  }
};

const initMargins = async () => {
  // If recipe costs already exist (e.g. from prior build), skip
  if (fs.existsSync(RECIPE_COSTS_FILE)) {
    console.log('✓ Recipe costs already available, skipping build');
    return;
  }

  try {
    console.log('Building Product Margins on startup…');
    await buildMargins({ weeks: 12 });
    console.log('✓ Margins built successfully');
  } catch (e) {
    if (e.code === 'QB_NOT_CONNECTED' || e.code === 'GOOGLE_NOT_CONNECTED') {
      console.warn(`⚠ ${e.message}`);
      seedData();
    } else {
      console.error('Failed to build margins:', e.message);
      seedData();
    }
  }
};

module.exports = { initMargins };

// CLI: node pipeline/init-margins.js
if (require.main === module) {
  initMargins().catch(e => {
    console.error('Init failed:', e.message);
    process.exit(1);
  });
}
