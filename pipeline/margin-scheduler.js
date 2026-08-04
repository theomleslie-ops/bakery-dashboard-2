// Automated daily margin calculation scheduler
// Runs calculate-margins on startup and daily at 6 AM, updates analysis.json in background
// Granular error handling: each data source is independent, partial success is allowed

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const calculateMargins = require('./calculate-margins');
const sheetsOAuth = require('./sheets-oauth');
const qbClient = require('./qb-client');

let lastRun = null;
let isRunning = false;

const loadSquareSalesData = () => {
  try {
    const analysisPath = path.join(__dirname, '..', 'analysis.json');
    if (!fs.existsSync(analysisPath)) return [];

    const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf-8'));
    const products = (analysis.products || []).map(p => ({
      product: p.product,
      units: p.units,
      price: p.sale_price,
    }));

    // Validate data integrity: if products are loaded but have zero units/prices, something broke
    if (products.length > 0 && products.some(p => !p.product || !Number.isFinite(p.units) || !Number.isFinite(p.price))) {
      console.warn('[margin-scheduler] ⚠️  Detected corrupted sales data in analysis.json - some products missing units or prices');
    }

    return products;
  } catch (e) {
    console.warn('[margin-scheduler] Failed to load sales data:', e.message);
    return [];
  }
};

// Check availability of each data source independently (don't block on one failure)
const checkDataSources = () => {
  const sources = {
    google_sheets: false,
    quickbooks: false,
    square_sales: false,
  };

  try {
    sources.google_sheets = sheetsOAuth.isConnected();
  } catch (e) {
    console.warn('[margin-scheduler] Google Sheets check failed:', e.message);
  }

  try {
    const qbTokens = qbClient.loadTokens();
    sources.quickbooks = !!(qbTokens && qbTokens.refresh_token);
  } catch (e) {
    console.warn('[margin-scheduler] QuickBooks check failed:', e.message);
  }

  try {
    const sales = loadSquareSalesData();
    sources.square_sales = sales.length > 0;
  } catch (e) {
    console.warn('[margin-scheduler] Square sales check failed:', e.message);
  }

  return sources;
};

const runCalculation = async () => {
  // Prevent concurrent runs
  if (isRunning) {
    console.log('[margin-scheduler] Calculation already in progress, skipping');
    return;
  }

  isRunning = true;
  const startTime = new Date();
  const sources = checkDataSources();

  try {
    console.log(`\n[margin-scheduler] ▶️  Starting margin calculation at ${startTime.toISOString()}`);
    console.log(`[margin-scheduler] Data sources available:`);
    console.log(`  - Google Sheets: ${sources.google_sheets ? '✅' : '❌'}`);
    console.log(`  - QuickBooks: ${sources.quickbooks ? '✅' : '❌'}`);
    console.log(`  - Square sales: ${sources.square_sales ? '✅' : '❌'}`);

    // BLOCK ONLY IF critical sources unavailable (Google Sheets is fallback, QB is optional)
    if (!sources.square_sales) {
      console.log('[margin-scheduler] ❌ Square sales data unavailable (critical) - cannot proceed');
      isRunning = false;
      return;
    }

    if (!sources.google_sheets && !sources.quickbooks) {
      console.log('[margin-scheduler] ⚠️  Both QB and Google Sheets unavailable - cannot cost recipes');
      isRunning = false;
      return;
    }

    const squareSalesData = loadSquareSalesData();

    if (!squareSalesData || squareSalesData.length === 0) {
      console.log('[margin-scheduler] ⚠️  No Square sales data available - skipping calculation');
      isRunning = false;
      return;
    }

    console.log(`[margin-scheduler] Loaded ${squareSalesData.length} products from Square sales data`);
    const result = await calculateMargins.main({ squareSalesData });

    // Validate result: if products array is empty or missing, something went wrong
    if (!result.products || result.products.length === 0) {
      console.error('[margin-scheduler] ❌ Calculation produced empty products array - check recipe/cost data');
      lastRun = {
        failedAt: new Date().toISOString(),
        success: false,
        error: 'Margin calculation produced empty products (no recipes costed)',
        code: 'EMPTY_PRODUCTS',
        dataSourcesAttempted: sources,
      };
      isRunning = false;
      return;
    }

    // Save to analysis.json with metadata about data source availability
    const outputWithMetadata = {
      ...result,
      data_sources_used: {
        google_sheets: sources.google_sheets,
        quickbooks: sources.quickbooks,
        square_sales: sources.square_sales,
        notes: {
          google_sheets: sources.google_sheets ? 'Recipes and ingredient yields' : 'NOT AVAILABLE',
          quickbooks: sources.quickbooks ? 'QB bills for ingredient costs (primary)' : 'NOT AVAILABLE (using Google Sheets fallback)',
          square_sales: sources.square_sales ? 'Product sales units and prices' : 'NOT AVAILABLE',
          hardcoded: 'Product-to-recipe mappings, base dough definitions, and pre-ferment formulas (business logic)',
        },
      },
      data_policy: 'All numbers derive from three sources: QuickBooks (costs), Google Sheets (recipes), and Square (sales). Pre-ferment formulas and product mappings are hardcoded business logic.',
    };

    const analysisPath = path.join(__dirname, '..', 'analysis.json');
    fs.writeFileSync(analysisPath, JSON.stringify(outputWithMetadata, null, 2));

    const duration = Math.round((Date.now() - startTime.getTime()) / 1000);
    lastRun = {
      completedAt: new Date().toISOString(),
      duration,
      success: true,
      productsCount: result.products.length,
      baseDoughs: result.coverage.baseDoughs,
      products: result.coverage.products,
      dataSourcesUsed: sources,
      warnings: !sources.quickbooks ? ['QuickBooks unavailable - used Google Sheets fallback for costs'] : [],
    };

    console.log(`[margin-scheduler] ✅ Complete in ${duration}s`);
    console.log(`   Products costed: ${lastRun.products}, Base doughs: ${lastRun.baseDoughs}`);
    console.log(`   Blended margin: ${result.summary.blended_margin_pct}%`);
    if (lastRun.warnings.length > 0) {
      console.log(`   ⚠️  Warnings: ${lastRun.warnings.join('; ')}`);
    }
    console.log();
  } catch (err) {
    console.error(`[margin-scheduler] ❌ Calculation failed: ${err.message}`);
    console.error(`[margin-scheduler] Stack: ${err.stack}`);
    lastRun = {
      failedAt: new Date().toISOString(),
      success: false,
      error: err.message,
      code: err.code,
      dataSourcesAttempted: sources,
    };
  } finally {
    isRunning = false;
  }
};

const start = () => {
  console.log('[margin-scheduler] Initializing…');

  // Run immediately on startup (async, don't block server start)
  setImmediate(async () => {
    await runCalculation();
  });

  // Schedule daily run at 6 AM (UTC)
  const dailyJob = cron.schedule('0 6 * * *', async () => {
    await runCalculation();
  });

  console.log('[margin-scheduler] ✓ Scheduled for 6 AM daily (UTC)');
  console.log('[margin-scheduler] ✓ Will run immediately after startup\n');

  return {
    stop: () => dailyJob.stop(),
    getStatus: () => ({
      lastRun,
      isRunning,
      nextRun: dailyJob.nextDate().toISOString(),
    }),
  };
};

module.exports = { start, runCalculation };
