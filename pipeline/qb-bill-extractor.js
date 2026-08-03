// Extract ingredient costs from QuickBooks bills from three vendors:
// Chef's Warehouse, Green Leaf (produce), Allen Brothers (meat)
// Pulls full line-item detail and builds ingredient cost table

const qbClient = require('./qb-client');
const pdfParser = require('./pdf-invoice-parser');

// Vendor name patterns to match actual QB vendor names
const VENDOR_PATTERNS = {
  chefs_warehouse: /chef'?s?\s*warehouse/i,  // Matches "Chef's Warehouse West Coast, LLC" and variants
  greenleaf: /green\s*leaf|greenleaf/i,      // Matches "Green Leaf"
};

const VENDOR_NAMES = {
  chefs_warehouse: "Chef's Warehouse West Coast, LLC",  // Actual QB vendor name
  greenleaf: 'Green Leaf',                               // Actual QB vendor name
};

// Parse a bill from QB API response
// Tries to extract itemized line items from attached PDF invoice,
// falls back to QB's Line array if PDF not available or parsing fails
const parseBill = async (bill) => {
  let lines = [];
  let extractionSource = 'unknown';

  // Try PDF extraction first (vendor invoices have itemized detail)
  const pdfItems = await pdfParser.extractLineItemsFromPdf(bill.Id);
  if (pdfItems && pdfItems.length > 0) {
    lines = pdfItems.map(item => ({
      description: item.description.trim(),
      quantity: item.quantity,
      unitPrice: Math.round(item.unitPrice * 100) / 100,
      lineAmount: Math.round((item.quantity * item.unitPrice) * 100) / 100,
    }));
    extractionSource = 'pdf';
    console.log(`      📄 Bill ${bill.DocNumber}: Used PDF extraction (${lines.length} items)`);
  } else {
    // Fall back to QB's Line array
    const lineItems = bill.Line || [];
    for (const line of lineItems) {
      if (line.DetailType === 'ItemBasedExpenseLineDetail' || line.DetailType === 'AccountBasedExpenseLineDetail') {
        const item = line.ItemBasedExpenseLineDetail?.ItemRef || line.AccountBasedExpenseLineDetail?.AccountRef;
        const description = line.Description || item?.name || 'Unknown Item';
        const quantity = line.ItemBasedExpenseLineDetail?.Qty || 1;
        const unitPrice = line.Amount / Math.max(quantity, 1);

        lines.push({
          description: description.trim(),
          quantity,
          unitPrice: Math.round(unitPrice * 100) / 100,
          lineAmount: Math.round(line.Amount * 100) / 100,
        });
      }
    }
    extractionSource = lines.length > 0 ? 'bill_line_array' : 'none';
    if (extractionSource === 'bill_line_array') {
      console.log(`      📋 Bill ${bill.DocNumber}: Fell back to QB Line array (${lines.length} items from bill.Line[0].Description)`);
    }
  }

  return {
    billId: bill.Id,
    vendorName: bill.VendorRef?.name || 'Unknown',
    docNumber: bill.DocNumber,
    txnDate: bill.TxnDate,
    dueDate: bill.DueDate,
    totalAmount: Math.round((bill.TotalAmt || 0) * 100) / 100,
    lineItems: lines,
    extractionSource, // DEBUG: track which method was used
  };
};

// Categorize vendor by pattern match
const categorizeVendor = (vendorName) => {
  const name = vendorName.toLowerCase();
  if (VENDOR_PATTERNS.chefs_warehouse.test(name)) return 'chefs_warehouse';
  if (VENDOR_PATTERNS.greenleaf.test(name)) return 'greenleaf';
  return null;
};

// Main extraction function
const extractBills = async ({ weeks = 12 } = {}) => {
  console.log('🔍 Extracting bills from QuickBooks…\n');

  try {
    const tokens = await qbClient.getValidTokens();
  } catch (e) {
    const err = new Error('QuickBooks not connected. Visit /api/quickbooks/connect to authorize.');
    err.code = 'QB_NOT_CONNECTED';
    throw err;
  }

  // Query bills from past N weeks
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - (weeks * 7));
  const cutoffISO = cutoffDate.toISOString().split('T')[0];

  let allBills = [];

  try {
    // Query bill IDs from the date range
    console.log(`  Querying all bill IDs since ${cutoffISO}…`);

    const query = `SELECT Id, DocNumber, TxnDate, VendorRef FROM Bill WHERE TxnDate >= '${cutoffISO}' ORDER BY TxnDate DESC`;

    try {
      const response = await qbClient.query(query);
      const billSummaries = response.Bill || [];
      console.log(`  ✓ Retrieved ${billSummaries.length} total bill IDs since ${cutoffISO}`);

      // Group by vendor, then fetch full detail for each bill
      const vendorBillIds = {};
      for (const billSummary of billSummaries) {
        const vendorName = billSummary.VendorRef?.name || '';
        let vendorKey = null;

        for (const [key, expectedVendorName] of Object.entries(VENDOR_NAMES)) {
          if (vendorName.toLowerCase().includes(expectedVendorName.toLowerCase())) {
            vendorKey = key;
            break;
          }
        }

        if (vendorKey) {
          if (!vendorBillIds[vendorKey]) vendorBillIds[vendorKey] = [];
          vendorBillIds[vendorKey].push(billSummary.Id);
        }
      }

      // Fetch full detail for each bill from target vendors
      console.log(`  Starting vendor bill detail fetch loop for ${Object.keys(VENDOR_NAMES).length} vendors…`);
      for (const [vendorKey, vendorName] of Object.entries(VENDOR_NAMES)) {
        console.log(`    Processing vendor: ${vendorName}`);
        const billIds = vendorBillIds[vendorKey] || [];
        if (billIds.length === 0) {
          console.log(`    ⊘ No bills from ${vendorName}`);
          continue;
        }

        console.log(`    ⬇️  Fetching full detail for ${billIds.length} bills from ${vendorName}…`);
        const fullBills = [];

        for (const billId of billIds) {
          try {
            const fullBill = await qbClient.getBillDetail(billId);
            if (fullBill) {
              fullBills.push(fullBill);
            }
          } catch (e) {
            console.warn(`      ⚠️  Could not fetch detail for bill ${billId}: ${e.message}`);
          }
        }

        console.log(`    Fetched ${fullBills.length} full bills from ${vendorName}`);

        if (fullBills.length > 0) {
          allBills.push(...fullBills);
          console.log(`    ✓ ${fullBills.length} bills from ${vendorName} (with full line detail)`);

          // DEBUG: Log ALL fields from first bill to check for source document reference
          console.log(`    About to log first bill fields for ${vendorName}…`);
          try {
            const firstBill = fullBills[0];
            console.log(`\n    DEBUG: First ${vendorName} bill (ID: ${firstBill.Id}) all fields:`);
            const fieldNames = Object.keys(firstBill).sort();
            console.log(`      Total fields: ${fieldNames.length}`);
            console.log(`      All field names: ${fieldNames.join(', ')}`);

            // Look specifically for source document or file references
            const sourceFields = fieldNames.filter(f =>
              f.toLowerCase().includes('source') ||
              f.toLowerCase().includes('document') ||
              f.toLowerCase().includes('file') ||
              f.toLowerCase().includes('ref') ||
              f.toLowerCase().includes('url') ||
              f.toLowerCase().includes('link')
            );
            if (sourceFields.length > 0) {
              console.log(`      Source/Document/File fields: ${sourceFields.join(', ')}`);
              for (const field of sourceFields) {
                const value = JSON.stringify(firstBill[field]).substring(0, 500);
                console.log(`        ${field}: ${value}`);
              }
            } else {
              console.log(`      ⚠️  No source/document/file/url fields found on Bill object`);
            }
          } catch (debugErr) {
            console.error(`    ERROR in debug logging: ${debugErr.message}`);
            console.error(debugErr.stack);
          }
          console.log();
        }
      }
    } catch (e) {
      console.warn(`    ⚠️  Error querying bills: ${e.message}`);
      throw e;
    }
  } catch (e) {
    console.error('Bill query failed:', e.message);
    throw e;
  }

  // Parse bills and extract line items sequentially (to avoid rate limiting PDFs)
  // This is slower but avoids HTTP 429 errors from too many concurrent requests
  const parsedBills = [];
  for (let i = 0; i < allBills.length; i++) {
    const bill = allBills[i];
    const parsed = await parseBill(bill);
    parsedBills.push(parsed);
    // Small delay between PDFs to space out requests
    if (i < allBills.length - 1) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  console.log(`  ✓ Parsed ${parsedBills.length} bills\n`);

  // Show extraction source breakdown
  const sourceCount = {};
  for (const bill of parsedBills) {
    const src = bill.extractionSource;
    sourceCount[src] = (sourceCount[src] || 0) + 1;
  }
  console.log('  Extraction sources:');
  for (const [source, count] of Object.entries(sourceCount)) {
    console.log(`    ${source}: ${count} bills`);
  }
  console.log();

  // Build ingredient cost table: aggregate by ingredient and find most recent price
  const ingredientCosts = {};

  for (const bill of parsedBills) {
    const vendorCategory = categorizeVendor(bill.vendorName);
    const vendorDisplay = bill.vendorName;

    for (const line of bill.lineItems) {
      const ingredient = line.description;

      if (!ingredientCosts[ingredient]) {
        ingredientCosts[ingredient] = {
          ingredient,
          vendor: vendorDisplay,
          mostRecentDate: bill.txnDate,
          mostRecentCost: line.unitPrice,
          invoiceNumber: bill.docNumber,
          quantity: line.quantity,
        };
      } else {
        // Update if this purchase is more recent
        if (new Date(bill.txnDate) > new Date(ingredientCosts[ingredient].mostRecentDate)) {
          ingredientCosts[ingredient].mostRecentDate = bill.txnDate;
          ingredientCosts[ingredient].mostRecentCost = line.unitPrice;
          ingredientCosts[ingredient].invoiceNumber = bill.docNumber;
          ingredientCosts[ingredient].vendor = vendorDisplay;
          ingredientCosts[ingredient].quantity = line.quantity;
        }
      }
    }
  }

  // Sort alphabetically and format for output
  const sortedIngredients = Object.values(ingredientCosts)
    .sort((a, b) => a.ingredient.localeCompare(b.ingredient));

  console.log('📊 INGREDIENT COST TABLE (Most Recent Purchase)');
  console.log('=' .repeat(100));
  console.log(
    'Ingredient'.padEnd(40) +
    'Vendor'.padEnd(20) +
    'Most Recent Date'.padEnd(18) +
    'Unit Cost'.padEnd(12) +
    'Invoice #'
  );
  console.log('-'.repeat(100));

  for (const ing of sortedIngredients) {
    console.log(
      ing.ingredient.substring(0, 38).padEnd(40) +
      ing.vendor.substring(0, 18).padEnd(20) +
      ing.mostRecentDate.padEnd(18) +
      `$${ing.mostRecentCost.toFixed(2)}`.padEnd(12) +
      ing.invoiceNumber
    );
  }

  console.log('=' .repeat(100) + '\n');

  return {
    generatedAt: new Date().toISOString(),
    billsProcessed: parsedBills.length,
    ingredientsExtracted: sortedIngredients.length,
    ingredients: sortedIngredients,
    rawBills: parsedBills,
  };
};

module.exports = { extractBills, parseBill };
