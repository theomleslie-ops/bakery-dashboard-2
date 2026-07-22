// Initialize Product Margins on startup: seed from static snapshot only, never live-build.
// Live rebuild (local Google Sheets pull + QB vendor invoice parsing) happens only via npm run margins
const fs = require('fs');
const path = require('path');

const RECIPE_COSTS_FILE = path.join(__dirname, '..', 'data', 'pipeline', 'recipe-costs.json');
const SEED_FILE = path.join(__dirname, '..', 'seed-data', 'recipe-costs.json');

const seedData = () => {
  try {
    if (fs.existsSync(SEED_FILE)) {
      fs.mkdirSync(path.dirname(RECIPE_COSTS_FILE), { recursive: true });
      fs.copyFileSync(SEED_FILE, RECIPE_COSTS_FILE);
      console.log('✓ Recipe costs seeded from snapshot');
      return true;
    }
  } catch (e) {
    console.warn('Failed to seed recipe costs:', e.message);
  }
  return false;
};

const initMargins = async () => {
  // If recipe costs already exist, skip
  if (fs.existsSync(RECIPE_COSTS_FILE)) {
    console.log('✓ Recipe costs available');
    return;
  }

  // Seed from snapshot only — no live builds on startup
  seedData();
};

module.exports = { initMargins };

if (require.main === module) {
  initMargins().catch(e => console.error('Init failed:', e.message));
}
