// Parse itemized line items from vendor invoice PDFs
// Handles common invoice formats (table-based line items with Qty, Unit Price, Amount)

const qbClient = require('./qb-client');

// Parse extracted PDF text to find line items
// Handles multiple invoice formats: table-based, CSV-like, or free-form
const parseInvoiceText = (text) => {
  const items = [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // Strategy: look for lines that have multiple numeric values (likely qty + price)
  // Filter out obvious non-item lines (headers, totals, metadata)

  const skipPatterns = /^(invoice|bill|number|date|po|po#|ship|terms|payment|account|thank|notes|subtotal|total|tax|amount due|grand total|balance|please|reference|vendor|from|to|attention)/i;
  const numericLine = /[\d]+[\.\,]?[\d]*/g;

  for (const line of lines) {
    // Skip empty, too-short, or header lines
    if (line.length < 5 || skipPatterns.test(line)) continue;

    // Extract all numbers from the line
    const numbers = line.match(numericLine) || [];

    // Skip if no numbers or too many (likely not a line item)
    if (numbers.length < 2 || numbers.length > 6) continue;

    // Parse the line
    // Typical formats:
    // 1. "Item Name QTY UNIT PRICE AMOUNT"
    // 2. "Item Name QTY PRICE"
    // 3. "Item Name: QTY @ PRICE"

    const numericValues = numbers.map(n => parseFloat(n.replace(/,/g, '')));
    if (numericValues.some(isNaN)) continue;

    // Extract description (everything up to first number)
    const descMatch = line.match(/^([^\d]*?)[\d]/);
    let description = descMatch ? descMatch[1].trim() : '';

    // Clean up description
    description = description
      .replace(/\*+$/, '') // Remove trailing asterisks
      .replace(/^\W+/, '')  // Remove leading non-word chars
      .substring(0, 80);    // Limit length

    if (!description || description.length < 2) continue;

    // Heuristic for parsing qty and price:
    // Usually: [small number or decimal] [larger number or currency]
    // Try different arrangements

    let qty, unitPrice;

    if (numericValues.length === 2) {
      // Simple: qty and price (or total)
      qty = numericValues[0];
      unitPrice = numericValues[1];
    } else if (numericValues.length >= 3) {
      // Multiple numbers: usually qty, unit_price, total
      // Qty is usually smallest, price is somewhere in middle/end
      // Total is usually largest
      qty = numericValues[0];
      unitPrice = numericValues[1];
      const total = numericValues[numericValues.length - 1];

      // If unitPrice > total, it might be reversed
      if (unitPrice > total) {
        unitPrice = total / qty; // Assume last is total, calculate unit price
      } else if (unitPrice * qty > total * 1.2) {
        // Unit price too high relative to total, try next number
        unitPrice = numericValues[2] || unitPrice;
      }
    }

    // Validate and add item
    if (qty > 0 && unitPrice > 0 && !isNaN(qty) && !isNaN(unitPrice)) {
      // Sanity check: reasonable ingredient prices are typically < $1000/unit
      if (unitPrice < 1000) {
        items.push({
          description,
          quantity: qty,
          unitPrice: Math.round(unitPrice * 100) / 100,
        });
      }
    }
  }

  // Deduplicate by description (same item from different pages)
  const seen = new Set();
  return items.filter(i => {
    const key = i.description.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

// Try to extract line items from a bill's PDF with retry logic for rate limiting
// Returns array of {description, quantity, unitPrice} or null if no PDF or parsing fails
const extractLineItemsFromPdf = async (billId, retryCount = 0, maxRetries = 3) => {
  try {
    // Download the bill's attached PDF invoice
    let pdfBuffer;
    try {
      pdfBuffer = await qbClient.downloadInvoicePdf(billId);
    } catch (e) {
      if (e.response?.status === 429 && retryCount < maxRetries) {
        // Rate limited - wait and retry with exponential backoff
        const delayMs = Math.min(1000 * Math.pow(2, retryCount), 10000);
        await new Promise(r => setTimeout(r, delayMs));
        return extractLineItemsFromPdf(billId, retryCount + 1, maxRetries);
      }
      throw e;
    }

    if (!pdfBuffer) {
      return null; // No PDF attached, will use bill's Line array fallback
    }

    // Extract text from PDF
    const text = await qbClient.extractPdfText(pdfBuffer);
    if (!text || text.trim().length === 0) {
      return null;
    }

    // Parse text to find line items
    const items = parseInvoiceText(text);

    if (items.length > 0) {
      return items;
    }

    // PDF was readable but parsing failed - log sample for debugging
    const textPreview = text.substring(0, 300).replace(/\n/g, ' | ');
    console.warn(`      ⚠️  Could not parse items from PDF bill ${billId}. Text preview: "${textPreview}..."`);
    return null;
  } catch (e) {
    if (e.response?.status === 429) {
      console.warn(`      ⚠️  Rate limited for bill ${billId} (will retry later)`);
    } else {
      console.warn(`      ⚠️  Error extracting PDF for bill ${billId}: ${e.message}`);
    }
    return null;
  }
};

module.exports = {
  parseInvoiceText,
  extractLineItemsFromPdf,
};
