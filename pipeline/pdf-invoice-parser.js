// Parse itemized line items from vendor invoice PDFs
// Handles Chef's Warehouse invoice format where each item spans 3-5 lines:
// Line 1: qty unit | qty unit | item# | description
// Line 2-3: pack size / origin / formatting info
// Line 4-5: unit_price | uom | extended_price

const path = require('path');
const qbClient = require('./qb-client');

// Parse extracted PDF text to find line items
// Reconstructs multi-line item rows before pattern matching
const parseInvoiceText = (text, billId) => {
  const items = [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // Search for flour items to debug extraction
  const floorLines = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const lineUpper = lines[idx].toUpperCase();
    if (lineUpper.includes('FLOUR') || lineUpper.includes('GALAHAD')) {
      floorLines.push({ idx, line: lines[idx] });
    }
  }
  if (floorLines.length > 0) {
    console.log(`      🌾 FOUND FLOUR in bill ${billId}:`);
    for (const f of floorLines) {
      console.log(`         [${f.idx}] "${f.line}"`);
    }
  }

  // Non-food items and packaging to exclude
  const excludeKeywords = [
    'LINER', 'FOIL', 'GLOVE', 'BAG', 'CLEANING', 'PLASTIC', 'WRAP',
    'TAPE', 'LABEL', 'BOX', 'CRATE', 'CONTAINER', 'PALLET', 'DUNNAGE',
    'BROOM', 'MOP', 'SOAP', 'SANITIZER', 'DISINFECT'
  ];
  const excludePattern = new RegExp(`\\b(${excludeKeywords.join('|')})\\b`, 'i');

  // Skip headers/footers
  const skipPatterns = /^(ordered|shipped|item|description|price|uom|extended|invoice|bill|number|date|po|po#|ship|terms|payment|account|thank|notes|subtotal|total|tax|amount due|grand total|balance|please|reference|vendor|from|to|attention|page|tel|fax|route|ca-|received|date:|po number|thank you|continued|notes:|delivery|instructions|--\s*\d+\s*of\s*\d+|wea|pay|totals)/i;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Skip headers and short lines
    if (line.length < 10 || skipPatterns.test(line)) {
      i++;
      continue;
    }

    // Check if this line starts with qty+unit (item start marker)
    const unitCodes = ['PC', 'CS', 'LB', 'EA', 'BX', 'DZ', 'CT', 'CA', 'KG', 'G', 'OZ', 'QT', 'GL', 'PT', 'ML', 'L'];
    const unitPattern = unitCodes.join('|');
    const qtyUnitMatch = line.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s+(${unitPattern})\\b`, 'i'));

    if (!qtyUnitMatch) {
      i++;
      continue;
    }

    const qty = parseFloat(qtyUnitMatch[1]);
    if (qty < 0.01 || qty > 10000) {
      i++;
      continue;
    }

    // Merge up to next 4 lines to capture complete item row
    // (some items span 3-5 lines depending on PDF layout)
    let mergedLine = line;
    let linesConsumed = 0;

    for (let j = 1; j <= 4 && i + j < lines.length; j++) {
      const nextLine = lines[i + j];

      // Skip headers and short lines
      if (skipPatterns.test(nextLine) || nextLine.length < 3) {
        break;
      }

      // Stop if we hit another item start (but allow price lines like "34.00 CS 34.00")
      // Only break if: starts with qty + unit + SUBSTANTIAL content (like item code or product name)
      const qtyMatch = nextLine.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s+(${unitPattern})\\b`, 'i'));
      if (qtyMatch && qtyMatch[1] >= 10) {
        // Quantity >= 10 suggests a new item (ordered quantities are typically higher)
        // Price lines typically have quantities < 10 (like 34.00)
        break;
      }

      // Include the line
      mergedLine = mergedLine + ' ' + nextLine;
      linesConsumed = j;
    }

    i += linesConsumed; // Skip the lines we merged

    // Extract all numbers from merged line
    const allNumbers = mergedLine.match(/\d+(?:\.\d{1,4})?/g) || [];
    const numericValues = allNumbers.map(n => parseFloat(n));

    // Find valid prices (0.5 to 5000, likely unit costs or totals)
    const validPrices = [];
    for (const val of numericValues) {
      if (val >= 0.5 && val < 5000) {
        validPrices.push(val);
      }
    }

    // Unit price is typically 2nd-to-last (last is usually extended price)
    let unitPrice = null;
    if (validPrices.length >= 2) {
      unitPrice = validPrices[validPrices.length - 2];
    } else if (validPrices.length === 1) {
      unitPrice = validPrices[0];
    }

    if (!unitPrice) {
      i++;
      continue;
    }

    // Extract description: everything after qty+unit, before prices get messy
    let description = mergedLine.substring(qtyUnitMatch[0].length).trim();

    // Conservative cleanup: only remove specific patterns we're confident about
    description = description
      .replace(/\bGF\d+\b/g, '') // Remove Chef's Warehouse item codes like GF298
      .replace(/\bVN\d+\b/g, '') // Remove vendor codes like VN150758
      .replace(/\bBF\d+\b/g, '') // Remove item codes like BF100
      .replace(/\b[A-Z]{2,3}\d{3,}\b/g, '') // Remove general item codes (2-3 letters + 3+ digits)
      .replace(/\d+\/\d+\s*[A-Z]+\b/g, '') // Remove pack formats like "4/1 GAL", "3/5.75 LB"
      .replace(/Plt#?:?\s*\d+/gi, '') // Remove "Plt#: 4", "Plt: 5"
      .replace(/\s+/g, ' ')  // Collapse multiple spaces
      .trim();

    // Filter out garbage: too short, only whitespace/numbers
    if (!description || description.length < 3 || /^[\s\d\-\.]+$/.test(description)) {
      i++;
      continue;
    }

    // Exclude non-food items
    if (excludePattern.test(description)) {
      i++;
      continue;
    }

    // Add the item
    items.push({
      description,
      quantity: qty,
      unitPrice: Math.round(unitPrice * 100) / 100,
    });

    // Debug: log flour items that were successfully extracted
    if (description.toUpperCase().includes('FLOUR') || description.toUpperCase().includes('GALAHAD')) {
      console.log(`        → EXTRACTED FLOUR: "${description}" (${qty} @ $${unitPrice})`);
    }

    i++;
  }

  // Deduplicate by description (same item from different invoices)
  const seen = new Set();
  return items.filter(item => {
    const key = item.description.toLowerCase();
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

    // Save raw extracted text for debugging/analysis
    const debugFile = path.join(__dirname, '..', `raw-pdf-${billId}.txt`);
    try {
      require('fs').writeFileSync(debugFile, text);
    } catch (e) {
      // Silently fail - not critical
    }

    // Parse text to find line items
    const items = parseInvoiceText(text, billId);

    if (items.length > 0) {
      console.log(`      ✓ Parsed ${items.length} line items from PDF`);
      return items;
    }

    // PDF was readable but parsing failed - save full text for debugging
    const failDebugFile = path.join(__dirname, '..', `debug-pdf-${billId}.txt`);
    try {
      require('fs').writeFileSync(failDebugFile, text);
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
