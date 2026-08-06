#!/usr/bin/env node
/**
 * Test script to verify date range filtering in bakery-margins endpoint
 * Run this to manually test what Square is returning for different periods
 */

const axios = require('axios');
require('dotenv').config();

const API_BASE = 'http://localhost:3000';
const SQUARE_LOCATION_ID = 'L41E1NSH9N1GC'; // ARC store

async function testDateRange() {
  console.log('🔍 Testing date range filtering...\n');

  // Test different periods
  const periods = ['1_week', '2_weeks'];

  for (const period of periods) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Testing period: ${period}`);
    console.log(`${'='.repeat(60)}`);

    try {
      // Call the diagnostic endpoint
      const response = await axios.get(`${API_BASE}/api/bakery-margins-diagnostic?period=${period}`);
      const data = response.data;

      console.log(`\n📅 Date Range:`);
      console.log(`   Start: ${data.computed_begin}`);
      console.log(`   End:   ${data.computed_end}`);
      console.log(`   Days:  ${data.days}`);

      console.log(`\n📊 Results from ${data.location} (${data.location_id}):`);
      console.log(`   Total Orders:    ${data.totals.orders}`);
      console.log(`   Total Line Items: ${data.totals.line_items}`);
      console.log(`   Total Units:     ${data.totals.units}`);
      console.log(`   Total Revenue:   $${data.totals.revenue}`);

      console.log(`\n📄 Page Breakdown:`);
      data.pages.forEach((page, idx) => {
        console.log(`   Page ${page.page}:`);
        console.log(`     Orders:     ${page.orders}`);
        console.log(`     Line Items: ${page.line_items}`);
        console.log(`     Units:      ${page.units}`);
        console.log(`     Revenue:    $${page.revenue}`);
        console.log(`     Has More:   ${page.hasMore}`);
      });

      // Call the main endpoint to compare
      const marginsResponse = await axios.get(`${API_BASE}/api/bakery-margins?period=${period}`);
      const marginsData = marginsResponse.data;

      console.log(`\n🔄 Comparison with /api/bakery-margins endpoint:`);
      console.log(`   Total Orders Processed: ${marginsData.ordersProcessed}`);
      console.log(`   Total Revenue:         $${marginsData.summary.total_revenue}`);
      console.log(`   Total Units:           ${marginsData.summary.total_units}`);

      console.log(`\n⚠️ IMPORTANT: Verify these numbers match your Square dashboard!`);
      console.log(`   Check Square Dashboard > Orders for ${data.location} for the same date range`);

    } catch (error) {
      console.error(`❌ Error for period ${period}:`, error.message);
      if (error.response?.data) {
        console.error('   Response:', error.response.data);
      }
    }
  }

  console.log(`\n\n📝 NEXT STEPS:`);
  console.log(`1. Go to your Square Dashboard > Orders`);
  console.log(`2. Filter to ARC location and Last 7 Days`);
  console.log(`3. Note the total revenue shown there`);
  console.log(`4. Compare to the diagnostic output above`);
  console.log(`5. If numbers don't match, date filtering is broken`);
  console.log(`6. If numbers match, the aggregation across all locations might be the issue`);
}

testDateRange().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
