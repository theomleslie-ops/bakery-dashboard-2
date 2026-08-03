// Extract ingredient costs from QuickBooks bills from three vendors:
// Chef's Warehouse, Green Leaf (produce), Allen Brothers (meat)
// Pulls full line-item detail and builds ingredient cost table

const qbClient = require('./qb-client');

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
const parseBill = (bill) => {
  const lines = [];

  // Extract line items
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

  return {
    billId: bill.Id,
    vendorName: bill.VendorRef?.name || 'Unknown',
    docNumber: bill.DocNumber,
    txnDate: bill.TxnDate,
    dueDate: bill.DueDate,
    totalAmount: Math.round((bill.TotalAmt || 0) * 100) / 100,
    lineItems: lines,
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
    // Query ALL bills from the date range (no vendor filter)
    // Then filter by vendor name in JavaScript for reliability
    console.log(`  Querying all bills since ${cutoffISO}…`);

    const query = `SELECT * FROM Bill WHERE TxnDate >= '${cutoffISO}' ORDER BY TxnDate DESC`;

    try {
      const response = await qbClient.query(query);
      const allQBBills = response.Bill || [];
      console.log(`  ✓ Retrieved ${allQBBills.length} total bills since ${cutoffISO}`);

      // Filter bills by vendor name in JavaScript
      for (const [key, vendorName] of Object.entries(VENDOR_NAMES)) {
        const vendorBills = allQBBills.filter(bill => {
          const billVendor = bill.VendorRef?.name || '';
          // Case-insensitive partial match on vendor name
          return billVendor.toLowerCase().includes(vendorName.toLowerCase());
        });

        if (vendorBills.length > 0) {
          allBills.push(...vendorBills);
          console.log(`    ✓ ${vendorBills.length} bills from ${vendorName}`);
        } else {
          console.log(`    ⊘ No bills from ${vendorName}`);
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

  // Parse bills and extract line items
  const parsedBills = allBills.map(parseBill);

  console.log(`  ✓ Parsed ${parsedBills.length} bills\n`);

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
