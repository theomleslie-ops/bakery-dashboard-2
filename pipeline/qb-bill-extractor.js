// Extract ingredient costs from QuickBooks bills from three vendors:
// Chef's Warehouse, Green Leaf (produce), Allen Brothers (meat)
// Pulls full line-item detail and builds ingredient cost table

const qbClient = require('./qb-client');

// Vendor name patterns to match
const VENDOR_PATTERNS = {
  chefs_warehouse: /chef'?s?\s*warehouse/i,
  greenleaf: /green\s*leaf|greenleaf|green\s*leafs?/i,
  allen_brothers: /allen\s*brothers?|allen\s*bros?/i,
};

const VENDOR_NAMES = {
  chefs_warehouse: "Chef's Warehouse",
  greenleaf: 'Green Leaf',
  allen_brothers: 'Allen Brothers',
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
  if (VENDOR_PATTERNS.allen_brothers.test(name)) return 'allen_brothers';
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

  // Build QBO query for bills from the three vendors
  const vendorList = Object.values(VENDOR_NAMES).map(v => `'${v}'`).join(',');
  const query = `
    SELECT * FROM Bill
    WHERE TxnDate >= '${cutoffISO}'
    AND VendorRef IN (${vendorList})
    ORDERBY TxnDate DESC
  `;

  let allBills = [];
  let bills = [];

  try {
    // Try querying each vendor separately in case names don't match exactly
    for (const [key, vendorName] of Object.entries(VENDOR_NAMES)) {
      const vendorQuery = `
        SELECT * FROM Bill
        WHERE TxnDate >= '${cutoffISO}'
        AND VendorRef.name LIKE '%${vendorName}%'
        ORDERBY TxnDate DESC
      `;

      try {
        const response = await qbClient.makeAuthenticatedRequest('/query', {
          method: 'GET',
          qs: { query: vendorQuery },
        });

        const vendorBills = response.QueryResponse?.Bill || [];
        allBills.push(...vendorBills);
        console.log(`  Found ${vendorBills.length} bills from ${vendorName}`);
      } catch (e) {
        console.warn(`  ⚠️  Error querying ${vendorName}: ${e.message}`);
      }
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
