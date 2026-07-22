// Chef's Warehouse invoice PDF parser.
// Invoices lay each line item across three text lines: item (code + description),
// pack line with "Plt#:", and price line. Anchor on the pack line and read neighbours.

const KG_PER_LB = 0.45359237;
const KG_PER_OZ = 0.0283495231;
const LITERS_PER = { GAL: 3.785411784, QT: 0.946352946, PT: 0.473176473, LT: 1, L: 1, ML: 0.001 };

const densityFor = (description = '') => {
  const d = String(description).toLowerCase();
  if (/\boil\b|evoo|olive|canola|sesame oil|vegetable oil/.test(d)) return 0.91;
  if (/syrup|honey|molasses|agave/.test(d)) return 1.37;
  return 1.0;
};

const num = (s) => parseFloat(String(s).replace(/,/g, ''));

const packToKg = (packSize, description = '') => {
  const s = String(packSize);
  let m = s.match(/(\d+)\s*\/\s*([\d.]+)\s*(LB|OZ|KG|G)\b/i);
  if (m) {
    const qty = num(m[1]) * num(m[2]);
    const u = m[3].toUpperCase();
    return u === 'LB' ? qty * KG_PER_LB : u === 'OZ' ? qty * KG_PER_OZ : u === 'KG' ? qty : qty / 1000;
  }
  m = s.match(/(\d+)\s*\/\s*([\d.]+)\s*(GAL|QT|PT|LT|L|ML)\b/i);
  if (m) {
    const liters = num(m[1]) * num(m[2]) * (LITERS_PER[m[3].toUpperCase()] || 0);
    return liters > 0 ? liters * densityFor(description) : null;
  }
  m = s.match(/\b([\d.]+)\s*(LB|OZ|KG|G)\b/i);
  if (m) {
    const q = num(m[1]);
    const u = m[2].toUpperCase();
    return u === 'LB' ? q * KG_PER_LB : u === 'OZ' ? q * KG_PER_OZ : u === 'KG' ? q : q / 1000;
  }
  m = s.match(/\b([\d.]+)\s*(GAL|QT|PT|LT|L|ML)\b/i);
  if (m) {
    const liters = num(m[1]) * (LITERS_PER[m[2].toUpperCase()] || 0);
    return liters > 0 ? liters * densityFor(description) : null;
  }
  return null;
};

const pricePerKg = (item) => {
  if (item.priceUOM === 'LB') return item.unitPrice / KG_PER_LB;
  if (item.priceUOM === 'OZ') return item.unitPrice / KG_PER_OZ;
  if (item.priceUOM === 'KG') return item.unitPrice;
  const packKg = packToKg(item.packSize, item.description);
  return packKg ? item.unitPrice / packKg : null;
};

const parseInvoiceText = (text) => {
  const lines = String(text).split('\n').map((l) => l.trim());
  const items = [];
  for (let i = 1; i < lines.length - 1; i++) {
    if (!/Plt#:/.test(lines[i])) continue;
    const priceM = lines[i + 1].match(/^([\d,.]+)\s+([A-Z]+)\s+([\d,.]+)$/);
    if (!priceM) continue;

    const packSize = lines[i].split('Plt#:')[0].trim();
    const itemLine = lines[i - 1].replace(/^\d+\s+[A-Z]{1,3}\s+\d+\s+[A-Z]{1,3}\s+/, '').trim();
    const tokens = itemLine.split(/\s+/);
    let code = null;
    if (tokens[0] && /^[0-9A-Z][0-9A-Z-]{2,}$/i.test(tokens[0]) && /\d/.test(tokens[0])) code = tokens.shift();
    const description = tokens.join(' ').trim();
    if (!description) continue;

    items.push({
      itemCode: code,
      description,
      packSize,
      unitPrice: num(priceM[1]),
      priceUOM: priceM[2].toUpperCase(),
      extended: num(priceM[3]),
    });
  }
  return items;
};

module.exports = {
  parseInvoiceText,
  pricePerKg,
  packToKg,
  densityFor,
};
