// Aggregate ingredient prices from all three vendors (Chef's Warehouse, Greenleaf, Alan Brothers).
// Fetches Bills from QB, downloads/parses invoices, converts pack prices to $/kg, and merges
// into one ingredient price catalog. Latest invoice date wins globally (not per-vendor).

const fs = require('fs');
const path = require('path');
const qbClient = require('./qb-client');
const cwParser = require('./invoice-parsers/chefs-warehouse');
const greenleafParser = require('./invoice-parsers/greenleaf');
const alanBrothersParser = require('./invoice-parsers/alan-brothers');

const OUT_DIR = path.join(__dirname, '..', 'data', 'pipeline');
const CACHE_FILE = path.join(OUT_DIR, 'vendor-invoice-cache.json');
const VENDOR_IDS_FILE = path.join(OUT_DIR, 'vendor-ids.json');

const VENDOR_CONFIG = [
  {
    name: 'chefs-warehouse',
    displayName: 'Chef\'s Warehouse',
    parser: cwParser,
    vendorIdEnv: 'CW_VENDOR_ID',
    vendorIdDefault: '233',
  },
  // TODO: Greenleaf (image-based PDFs — needs OCR or digital invoice format)
  // TODO: Alan Brothers (image-based PDFs — needs OCR or digital invoice format)
];

const loadCache = () => { try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')); } catch { return {}; } };
const saveCache = (c) => { fs.mkdirSync(OUT_DIR, { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2)); };

const loadVendorIds = () => { try { return JSON.parse(fs.readFileSync(VENDOR_IDS_FILE, 'utf-8')); } catch { return {}; } };
const saveVendorIds = (ids) => { fs.mkdirSync(OUT_DIR, { recursive: true }); fs.writeFileSync(VENDOR_IDS_FILE, JSON.stringify(ids, null, 2)); };

// Resolve vendor IDs: try env var, then cached lookup, then live QB query.
const getVendorId = async (vendorConfig, vendorIds) => {
  const id = process.env[vendorConfig.vendorIdEnv] || vendorConfig.vendorIdDefault;
  if (id) return id;

  if (vendorIds[vendorConfig.name]) return vendorIds[vendorConfig.name];

  try {
    const vendor = await qbClient.findVendorByName(vendorConfig.displayName);
    if (vendor?.Id) {
      vendorIds[vendorConfig.name] = vendor.Id;
      saveVendorIds(vendorIds);
      return vendor.Id;
    }
  } catch (e) {
    console.warn(`Failed to look up vendor ${vendorConfig.displayName}:`, e.message);
  }
  return null;
};

// Fetch and parse invoices for one vendor, updating cache with raw text.
const fetchVendorPrices = async (vendorConfig, vendorId, sinceDate, { onProgress } = {}) => {
  if (!vendorId) {
    console.warn(`Skipping ${vendorConfig.name}: no vendor ID`);
    return [];
  }

  const bills = await qbClient.listBills(vendorId, sinceDate);
  const cache = loadCache();

  let fetched = 0;
  for (const bill of bills) {
    if (cache[bill.Id]) continue;
    const buf = await qbClient.downloadInvoicePdf(bill.Id).catch(() => null);
    cache[bill.Id] = buf
      ? { vendor: vendorConfig.name, txnDate: bill.TxnDate, docNumber: bill.DocNumber, text: await qbClient.extractPdfText(buf) }
      : { vendor: vendorConfig.name, txnDate: bill.TxnDate, docNumber: bill.DocNumber, text: '', noPdf: true };
    fetched += 1;
    if (onProgress && fetched % 5 === 0) onProgress(vendorConfig.name, fetched, bills.length);
  }
  if (fetched > 0) saveCache(cache);

  const parsed = [];
  for (const bill of bills) {
    const entry = cache[bill.Id];
    if (!entry?.text) continue;
    try {
      const items = vendorConfig.parser.parseInvoiceText(entry.text);
      for (const item of items) {
        const pricePerKg = vendorConfig.parser.pricePerKg ? vendorConfig.parser.pricePerKg(item) : item.pricePerKg;
        parsed.push({
          ...item,
          vendor: vendorConfig.name,
          invoiceDate: entry.txnDate,
          pricePerKg,
        });
      }
    } catch (e) {
      console.warn(`Failed to parse ${vendorConfig.name} invoice ${bill.DocNumber}:`, e.message);
    }
  }
  return parsed;
};

// Build the unified ingredient price catalog from all 3 vendors.
const buildPriceList = async ({ weeks = 12, onProgress } = {}) => {
  const since = new Date(Date.now() - weeks * 7 * 86400_000).toISOString().slice(0, 10);
  const vendorIds = loadVendorIds();

  const allItems = [];
  for (const vendorConfig of VENDOR_CONFIG) {
    const vendorId = await getVendorId(vendorConfig, vendorIds);
    const items = await fetchVendorPrices(vendorConfig, vendorId, since, { onProgress });
    allItems.push(...items);
  }

  // Merge to the latest price per ingredient (keyed by normalized description).
  // Latest invoice date wins globally across all vendors.
  const byKey = {};
  for (const item of allItems) {
    const key = (item.itemCode || item.description).toLowerCase();
    const prev = byKey[key];
    if (!prev || item.invoiceDate > prev.invoiceDate) {
      byKey[key] = item;
    }
  }

  const ingredients = Object.values(byKey)
    .filter((i) => i.pricePerKg != null)
    .sort((a, b) => a.description.localeCompare(b.description));

  return {
    generatedAt: new Date().toISOString(),
    since,
    ingredientCount: ingredients.length,
    ingredients,
  };
};

module.exports = { buildPriceList };

// CLI: node pipeline/vendor-prices.js [weeks]
if (require.main === module) {
  const weeks = parseInt(process.argv[2], 10) || 12;
  console.log(`Extracting ingredient prices from 3 vendors (${weeks} weeks)…`);
  buildPriceList({
    weeks,
    onProgress: (vendor, n, total) => process.stdout.write(`  ${vendor}: parsed ${n}/${total} invoices\r`),
  })
    .then((res) => {
      const outFile = path.join(OUT_DIR, 'vendor-prices.json');
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(outFile, JSON.stringify(res, null, 2));
      console.log(`\n${res.ingredientCount} ingredients from all vendors since ${res.since}.`);
      console.log(`Wrote ${outFile}`);
    })
    .catch((e) => { console.error('Failed:', e.message); process.exit(1); });
}
