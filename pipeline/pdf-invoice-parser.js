// Parse itemized line items from vendor invoice PDFs
// Handles common invoice formats (table-based line items with Qty, Unit Price, Amount)

const qbClient = require('./qb-client');

// Parse extracted PDF text to find line items
// Look for patterns: item description + quantity + unit price + total
const parseInvoiceText = (text) => {
  const items = [];
  const lines = text.split('\n');

  // Find the line items section (typically after headers, before totals)
  let inItemsSection = false;
  let currentItem = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Detect end of document (totals section)
    if (/^(subtotal|total|tax|amount due|grand total|balance)/i.test(line)) {
      if (currentItem) items.push(currentItem);
      break;
    }

    // Skip empty lines and headers
    if (!line || /^(item|description|qty|unit|price|amount|qty.*price|line item)/i.test(line)) {
      inItemsSection = true;
      continue;
    }

    // Skip common non-item lines
    if (/^(invoice|bill|date|po|ship|terms|payment)/.test(line) || line.length < 5) {
      continue;
    }

    // Try to parse line item: look for patterns with numbers (qty, price)
    const numberMatches = line.match(/[\d]+[\.\,]?[\d]*/g) || [];

    if (numberMatches.length >= 2 && line.length > 10) {
      // Likely a line item with at least qty and price
      const parts = line.split(/\s{2,}|[\t]+/).filter(p => p.trim());

      if (parts.length >= 3) {
        // Assume format: [Description...] [Qty] [Unit] [Price] [Amount]
        // or simpler: [Description] [Qty] [Price] [Amount]

        // Extract numbers from right to left (more likely to be qty/price/amount)
        const numbers = line.match(/[\d]+[\.\,]?[\d]*/g) || [];

        if (numbers.length >= 2) {
          // Get the description (everything before the first number)
          const descMatch = line.match(/^(.*?)[\d]+/);
          const description = (descMatch ? descMatch[1] : parts[0]).trim();

          // Get qty (first number) and price (last number)
          const qty = parseFloat(numbers[0]);
          const price = parseFloat(numbers[numbers.length - 1]);

          if (description && !isNaN(qty) && !isNaN(price) && description.length > 2) {
            if (currentItem) items.push(currentItem);
            currentItem = {
              description: description.substring(0, 100),
              quantity: qty,
              unitPrice: price > 100 ? price / qty : price, // Heuristic: if > $100, might be total
            };
          }
        }
      }
    }
  }

  if (currentItem) items.push(currentItem);
  return items.filter(i => i.description && i.quantity > 0 && i.unitPrice > 0);
};

// Try to extract line items from a bill's PDF
// Returns array of {description, quantity, unitPrice} or empty array if no PDF or parsing fails
const extractLineItemsFromPdf = async (billId) => {
  try {
    // Download the bill's attached PDF invoice
    const pdfBuffer = await qbClient.downloadInvoicePdf(billId);
    if (!pdfBuffer) {
      return null; // No PDF attached, will use bill's Line array fallback
    }

    // Extract text from PDF
    const text = await qbClient.extractPdfText(pdfBuffer);
    if (!text || text.trim().length === 0) {
      console.warn(`      ⚠️  Could not extract text from PDF for bill ${billId}`);
      return null;
    }

    // Parse text to find line items
    const items = parseInvoiceText(text);

    if (items.length > 0) {
      return items;
    }

    console.warn(`      ⚠️  Could not parse line items from PDF for bill ${billId}`);
    return null;
  } catch (e) {
    console.warn(`      ⚠️  Error extracting PDF for bill ${billId}: ${e.message}`);
    return null;
  }
};

module.exports = {
  parseInvoiceText,
  extractLineItemsFromPdf,
};
