// Parse itemized line items from vendor invoice PDFs
// Handles common invoice formats (table-based line items with Qty, Unit Price, Amount)

const path = require('path');
const qbClient = require('./qb-client');

// Parse extracted PDF text to find line items
// Matches Chef's Warehouse invoice structure: QTY UNIT | ITEM_CODE | DESCRIPTION | PRICE | UOM | ...
// v2: Strict pattern matching for tabular invoices (fixes garbage extraction)
const parseInvoiceText = (text) => {
  const items = [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // Skip non-item patterns: headers, footers, metadata, route codes, totals
  const skipPatterns = /^(ordered|shipped|item|description|price|uom|extended|invoice|bill|number|date|po|po#|ship|terms|payment|account|thank|notes|subtotal|total|tax|amount due|grand total|balance|please|reference|vendor|from|to|attention|page|tel|fax|route|ca-[a-z]+|received|date:|po number|thank you|continued|notes:)/i;

  for (const line of lines) {
    if (line.length < 10 || skipPatterns.test(line)) continue;

    // Target pattern: QTY UNIT [more fields] PRICE
    // Examples from Chef's Warehouse:
    // "8 PC | 8 PC | BF100 | WHOLE MILK GALLON | 5.71 | PC | 45.68"
    // When extracted from PDF, pipes may be spaces: "8 PC 8 PC BF100 WHOLE MILK GALLON 5.71 PC 45.68"

    // Key: Must start with a quantity (small number 1-999) followed by a unit code
    const unitCodes = ['PC', 'CS', 'LB', 'EA', 'BX', 'DZ', 'CT', 'CA', 'KG', 'G', 'OZ', 'QT', 'GL', 'PT', 'ML', 'L'];
    const unitPattern = unitCodes.join('|');
    const qtyUnitMatch = line.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s+(${unitPattern})\\b`, 'i'));

    if (!qtyUnitMatch) continue;

    const qty = parseFloat(qtyUnitMatch[1]);
    if (qty < 0.01 || qty > 10000) continue; // Reasonable qty range

    // Extract all numbers from line (for finding prices)
    const allNumbers = line.match(/\d+(?:\.\d{1,4})?/g) || [];
    if (allNumbers.length < 2) continue; // Need at least qty and price

    // Parse numbers: qty (already found), skip some middle ones (shipped qty, codes), find prices near end
    const numericValues = allNumbers.map(n => parseFloat(n));

    // Description is text between qty+unit and first price
    // For now, extract everything after the qty+unit part
    const afterQtyUnit = line.substring(qtyUnitMatch[0].length).trim();

    // Look for item code (alphanumeric, usually 4-10 chars, starts with letter or digit)
    // Then everything up to the first price
    let description = '';
    let unitPrice = null;

    // Try to find a price value (should be between 0.5 and 5000 for ingredients)
    // Usually one of the last 1-3 numeric values is the unit price
    for (let i = numericValues.length - 1; i > 0; i--) {
      const val = numericValues[i];
      if (val >= 0.5 && val < 5000) {
        unitPrice = val;
        // Description is text before this price number
        const priceIndex = afterQtyUnit.lastIndexOf(val.toString());
        if (priceIndex > 0) {
          description = afterQtyUnit.substring(0, priceIndex).trim();
        } else {
          description = afterQtyUnit;
        }
        break;
      }
    }

    if (!unitPrice || !description) continue;

    // Clean description
    description = description
      .replace(/\s*\|\s*/g, ' ')  // Replace pipes with spaces
      .replace(/\s+/g, ' ')        // Collapse multiple spaces
      .substring(0, 100)           // Limit length
      .trim();

    // Filter out non-item descriptions
    if (description.length < 3 || /^[\d\s\-\.]+$/.test(description)) continue;

    // Validate price is reasonable
    if (unitPrice > 0 && unitPrice < 5000) {
      items.push({
        description,
        quantity: qty,
        unitPrice: Math.round(unitPrice * 100) / 100,
      });
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
      console.warn(`      ⚠️  No text extracted from PDF for bill ${billId} (${pdfBuffer.length} byte PDF)`);
      return null;
    }

    // Log what we got from the PDF
    console.log(`      ✓ Extracted ${text.length} chars from PDF bill ${billId}`);

    // Parse text to find line items
    const items = parseInvoiceText(text);

    if (items.length > 0) {
      console.log(`      ✓ Parsed ${items.length} line items from PDF`);
      return items;
    }

    // PDF was readable but parsing failed - save full text for debugging
    const debugFile = path.join(__dirname, '..', `debug-pdf-${billId}.txt`);
    try {
      require('fs').writeFileSync(debugFile, text);
      console.warn(`      ⚠️  Could not parse PDF bill ${billId} (${text.length} chars). Full text saved to: debug-pdf-${billId}.txt`);
    } catch (e) {
      const textPreview = text.substring(0, 500).replace(/\n/g, ' | ');
      console.warn(`      ⚠️  Could not parse items from PDF bill ${billId} (${text.length} chars). Sample:\n        "${textPreview}..."`);
    }
    return null;
  } catch (e) {
    if (e.response?.status === 429) {
      console.warn(`      ⚠️  Rate limited for bill ${billId} (will retry)`);
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
