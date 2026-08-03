// Ingredient cost extraction scheduler - runs in background to avoid timeouts
// Extraction result cached to disk so /api/ingredient-costs reads cached result instantly

const fs = require('fs');
const path = require('path');
const qbBillExtractor = require('./qb-bill-extractor');

let lastRun = null;
let isRunning = false;

const CACHE_FILE = path.join(__dirname, '..', 'ingredient-costs-cache.json');

const runExtraction = async (weeks = 52) => {
  if (isRunning) {
    console.log('[ingredient-scheduler] Extraction already in progress, skipping');
    return;
  }

  isRunning = true;
  const startTime = new Date();

  try {
    console.log(`\n[ingredient-scheduler] ▶️  Starting ingredient extraction at ${startTime.toISOString()}`);
    console.log(`[ingredient-scheduler] Weeks: ${weeks}`);

    const result = await qbBillExtractor.extractBills({ weeks });

    // Cache result to disk
    fs.writeFileSync(CACHE_FILE, JSON.stringify(result, null, 2));

    const duration = Math.round((Date.now() - startTime.getTime()) / 1000);
    lastRun = {
      completedAt: new Date().toISOString(),
      duration,
      success: true,
      billsProcessed: result.billsProcessed,
      ingredientsExtracted: result.ingredientsExtracted,
      generatedAt: result.generatedAt,
    };

    console.log(`[ingredient-scheduler] ✅ Complete in ${duration}s`);
    console.log(`   Bills processed: ${result.billsProcessed}`);
    console.log(`   Ingredients extracted: ${result.ingredientsExtracted}`);
    console.log();
  } catch (err) {
    console.error(`[ingredient-scheduler] ❌ Extraction failed: ${err.message}`);
    console.error(`[ingredient-scheduler] Stack: ${err.stack}`);
    lastRun = {
      failedAt: new Date().toISOString(),
      success: false,
      error: err.message,
      code: err.code,
    };
  } finally {
    isRunning = false;
  }
};

const start = () => {
  console.log('[ingredient-scheduler] Initializing…');

  // Run immediately on startup (async, don't block server start)
  setImmediate(async () => {
    await runExtraction(52);
  });

  console.log('[ingredient-scheduler] ✓ Will run on startup\n');

  return {
    getStatus: () => ({
      lastRun,
      isRunning,
    }),
    triggerNow: async (weeks = 52) => {
      if (!isRunning) {
        setImmediate(async () => {
          await runExtraction(weeks);
        });
        return true;
      }
      return false;
    },
  };
};

module.exports = { start, runExtraction };
