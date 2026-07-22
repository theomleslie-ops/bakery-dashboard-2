const fs = require('fs');
const path = require('path');
const qbClient = require('./qb-client');

const OUT_DIR = '/tmp/invoice-samples';

const inspectVendor = async (vendorName, vendorId) => {
  console.log(`\n========== ${vendorName.toUpperCase()} (ID: ${vendorId}) ==========`);

  try {
    const bills = await qbClient.listBills(vendorId, new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10));
    console.log(`✓ Found ${bills.length} bills in the last 90 days`);

    if (bills.length === 0) {
      console.log(`  ⊘ No recent bills to sample`);
      return;
    }

    const bill = bills[0];
    console.log(`\n→ Inspecting: ${bill.DocNumber} (${bill.TxnDate})`);

    const pdfBuf = await qbClient.downloadInvoicePdf(bill.Id);
    if (!pdfBuf) {
      console.log(`  ✗ No PDF attachment found`);
      return;
    }

    const text = await qbClient.extractPdfText(pdfBuf);
    if (!text) {
      console.log(`  ✗ Failed to extract text`);
      return;
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const outFile = path.join(OUT_DIR, `${vendorName}.txt`);
    fs.writeFileSync(outFile, text);
    console.log(`✓ Saved invoice text to: ${outFile}`);
    console.log(`\n--- FIRST 60 LINES (for parser design) ---\n`);
    text.split('\n').slice(0, 60).forEach((line, i) => {
      console.log(`${String(i + 1).padStart(2)}: ${line}`);
    });
  } catch (e) {
    console.error(`✗ ${e.message}`);
  }
};

const main = async () => {
  try {
    await inspectVendor('allen-brothers', '344');
    console.log(`\n✓ Sample saved to ${OUT_DIR}/allen-brothers.txt`);
  } catch (e) {
    console.error('Failed:', e.message);
    process.exit(1);
  }
};

main();
