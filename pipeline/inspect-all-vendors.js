const fs = require('fs');
const path = require('path');
const qbClient = require('./qb-client');

const OUT_DIR = '/tmp/invoice-samples';

const inspectVendor = async (vendorName, vendorId) => {
  console.log(`\n========== ${vendorName} (ID: ${vendorId}) ==========`);

  try {
    const bills = await qbClient.listBills(vendorId, new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10));
    console.log(`✓ Found ${bills.length} bills in the last 90 days`);

    if (bills.length === 0) return;

    const bill = bills[0];
    console.log(`→ Inspecting: ${bill.DocNumber} (${bill.TxnDate})`);

    const pdfBuf = await qbClient.downloadInvoicePdf(bill.Id);
    if (!pdfBuf) {
      console.log(`  ✗ No PDF found`);
      return;
    }

    const text = await qbClient.extractPdfText(pdfBuf);
    if (!text || text.trim().length < 100) {
      console.log(`  ⚠ PDF text extraction returned ${text?.length || 0} chars (likely image-based PDF)`);
      console.log(`  → Saved raw extraction for inspection`);
    } else {
      console.log(`✓ Extracted ${text.length} chars`);
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const outFile = path.join(OUT_DIR, `${vendorName}.txt`);
    fs.writeFileSync(outFile, text || '(empty or image-based PDF)');
    
    console.log(`\n--- FIRST 60 LINES ---\n`);
    const lines = (text || '').split('\n').slice(0, 60);
    lines.forEach((line, i) => {
      console.log(`${String(i + 1).padStart(2)}: ${line}`);
    });
  } catch (e) {
    console.error(`✗ ${e.message}`);
  }
};

const main = async () => {
  await inspectVendor('Chef\\'s Warehouse', '233');
  await inspectVendor('Allen Brothers', '344');
  console.log(`\n\nSamples saved to ${OUT_DIR}`);
};

main();
