// Automated daily margin calculation scheduler
// Runs calculate-margins on startup and daily at 6 AM, updates analysis.json in background

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const calculateMargins = require('./calculate-margins');
const sheetsOAuth = require('./sheets-oauth');

let lastRun = null;
let isRunning = false;

const loadSquareSalesData = () => {
  try {
    const analysisPath = path.join(__dirname, '..', 'analysis.json');
    if (!fs.existsSync(analysisPath)) return [];

    const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf-8'));
    return (analysis.products || []).map(p => ({
      product: p.product,
      units: p.units,
      price: p.sale_price,
    }));
  } catch (e) {
    console.warn('Failed to load sales data:', e.message);
    return [];
  }
};

const runCalculation = async () => {
  // Prevent concurrent runs
  if (isRunning) {
    console.log('[margin-scheduler] Calculation already in progress, skipping');
    return;
  }

  if (!sheetsOAuth.isConnected()) {
    console.log('[margin-scheduler] Google not connected, skipping calculation');
    return;
  }

  isRunning = true;
  const startTime = new Date();

  try {
    console.log(`\n[margin-scheduler] ▶️  Starting margin calculation at ${startTime.toISOString()}`);

    const squareSalesData = loadSquareSalesData();
    if (squareSalesData.length === 0) {
      console.log('[margin-scheduler] ⚠️  No sales data found, cannot calculate margins');
      isRunning = false;
      return;
    }

    const result = await calculateMargins.main({ squareSalesData });

    // Save to analysis.json
    const analysisPath = path.join(__dirname, '..', 'analysis.json');
    fs.writeFileSync(analysisPath, JSON.stringify(result, null, 2));

    lastRun = {
      completedAt: new Date().toISOString(),
      duration: Math.round((Date.now() - startTime.getTime()) / 1000),
      success: true,
      productsCount: result.products.length,
      baseDoughs: result.coverage.baseDoughs,
      products: result.coverage.products,
    };

    console.log(`[margin-scheduler] ✅ Complete in ${lastRun.duration}s`);
    console.log(`   Base doughs: ${lastRun.baseDoughs}, Products: ${lastRun.products}`);
    console.log(`   ${result.summary.blended_margin_pct}% blended margin\n`);
  } catch (err) {
    console.error(`[margin-scheduler] ❌ Calculation failed: ${err.message}`);
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
