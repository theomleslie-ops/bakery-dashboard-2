// Parse itemized line items from vendor invoice PDFs
// Handles Chef's Warehouse invoice format where each item spans 3 lines:
// Line 1: qty unit | qty unit | item# | description
// Line 2: pack size / origin info
// Line 3: unit_price | uom | extended_price

const path = require('path');
const qbClient = require('./qb-client');

// Parse extracted PDF text to find line items
// Reconstructs multi-line item rows before pattern matching
const parseInvoiceText = (text) => {
  const items = [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // Non-food items and packaging to exclude
  const excludeKeywords = [
    'LINER', 'FOIL', 'GLOVE', 'BAG', 'CLEANING', 'PLASTIC', 'WRAP',
    'TAPE', 'LABEL', 'BOX', 'CRATE', 'CONTAINER', 'PALLET', 'DUNNAGE',
    'BROOM', 'MOP', 'SOAP', 'SANITIZER', 'DISINFECT'
  ];
  const excludePattern = new RegExp(`\\b(${excludeKeywords.join('|')})\\b`, 'i');

  // Skip headers/footers
  const skipPatterns = /^(ordered|shipped|item|description|price|uom|extended|invoice|bill|number|date|po|po#|ship|terms|payment|account|thank|notes|subtotal|total|tax|amount due|grand total|balance|please|reference|vendor|from|to|attention|page|tel|fax|route|ca-|received|date:|po number|thank you|continued|notes:|delivery|instructions)/i;

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

    // Extract description from this line (everything after qty+unit)
    const afterQtyUnit = line.substring(qtyUnitMatch[0].length).trim();

    // Next line should be pack size / origin info (optional)
    // We'll merge the next 2 lines if they exist and look like continuation lines
    let mergedLine = line;
    if (i + 2 < lines.length) {
      const nextLine = lines[i + 1];
      const pricingLine = lines[i + 2];

      // Pricing line should contain price numbers
      const priceMatch = pricingLine.match(/\d+\.?\d*/);

      // If next line doesn't look like a header and pricing line has numbers, merge
      if (priceMatch && !skipPatterns.test(nextLine)) {
        mergedLine = line + ' ' + nextLine + ' ' + pricingLine;
        i += 2; // Skip the next two lines
      }
    }

    // Extract all numbers from merged line
    const allNumbers = mergedLine.match(/\d+(?:\.\d{1,4})?/g) || [];
    const numericValues = allNumbers.map(n => parseFloat(n));

    // Find valid prices (0.5 to 5000)
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

    // Description is the part after qty+unit, before numbers get too messy
    let description = afterQtyUnit;

    // Remove UOM codes and numbers that aren't part of item name
    description = description
      .replace(/\d+\.?\d*\s*(PC|CS|LB|EA|BX|DZ|CT|CA|KG|G|OZ|QT|GL|PT|ML|L|UOM)\b/gi, '') // Remove UOM patterns
      .replace(/\d+\.?\d*/g, '') // Remove remaining numbers
      .replace(/\s+/g, ' ')       // Collapse spaces
      .trim();

    // Filter out garbage: too short, only numbers, suspicious patterns
    if (!description || description.length < 3) {
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
