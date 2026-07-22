// Initialize Product Margins on startup: try to build, fallback to seed data if auth unavailable
const fs = require('fs');
const path = require('path');

const RECIPE_COSTS_FILE = path.join(__dirname, '..', 'data', 'pipeline', 'recipe-costs.json');
const SEED_FILE = path.join(__dirname, '..', 'seed-data', 'recipe-costs.json');

const seedData = () => {
  try {
    if (fs.existsSync(SEED_FILE)) {
      fs.mkdirSync(path.dirname(RECIPE_COSTS_FILE), { recursive: true });
      fs.copyFileSync(SEED_FILE, RECIPE_COSTS_FILE);
      console.log('✓ Seeded recipe-costs.json from seed-data/');
      return true;
    }
  } catch (e) {
    console.warn('Failed to seed data:', e.message);
  }
  return false;
};

const initMargins = async () => {
  // If recipe costs already exist, skip
  if (fs.existsSync(RECIPE_COSTS_FILE)) {
    console.log('✓ Recipe costs already available');
    return;
  }

  try {
    console.log('Attempting to build Product Margins…');
    const { main: buildMargins } = require('./build-margins');
    await buildMargins({ weeks: 12 });
    console.log('✓ Margins built successfully');
  } catch (e) {
    console.warn(`⚠ Could not build margins: ${e.message}`);
    seedData();
  }
};

module.exports = { initMargins };

if (require.main === module) {
  initMargins().catch(e => console.error('Init failed:', e.message));
}
