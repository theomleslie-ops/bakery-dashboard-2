// Extracts per-ingredient prices from Chef's Warehouse invoices in QuickBooks.
// QB stores each CW bill as a lump-sum total, but the itemized invoice is a text PDF attached to
// the bill. This downloads those PDFs, parses the line items, and keeps the most-recent price per
// ingredient. Parsed invoices are cached by bill id so reruns only fetch new ones.
const fs = require('fs');
const path = require('path');
const qb = require('./quickbooks');
const { PDFParse } = require('pdf-parse');

const DATA_DIR = path.join(__dirname, '..', 'data');
const OUT_DIR = path.join(DATA_DIR, 'pipeline');
const CACHE_FILE = path.join(OUT_DIR, 'cw-invoice-cache.json');
const VENDOR_ID = process.env.CW_VENDOR_ID || '233'; // Chef's Warehouse West Coast, LLC

const qbBase = () => (process.env.QUICKBOOKS_ENVIRONMENT === 'sandbox'
  ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com');

const LB_PER_KG = 2.2046226218;
const KG_PER_LB = 0.45359237;
const KG_PER_OZ = 0.0283495231;

// ---- QuickBooks access ----
const qbQuery = async (sql) => {
  const t = await qb.getValidAccessToken();
  const url = `${qbBase()}/v3/company/${t.realmId}/query?query=${encodeURIComponent(sql)}&minorversion=70`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${t.access_token}`, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`QB query ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
};

// All CW bills on/after sinceDate (YYYY-MM-DD), paged.
const listBills = async (sinceDate) => {
  const bills = [];
  for (let start = 1; ; start += 100) {
    const res = await qbQuery(`select Id, DocNumber, TxnDate from Bill where VendorRef='${VENDOR_ID}' and TxnDate >= '${sinceDate}' ORDERBY TxnDate DESC STARTPOSITION ${start} MAXRESULTS 100`);
    const page = res.QueryResponse?.Bill || [];
    bills.push(...page);
    if (page.length < 100) break;
  }
  return bills;
};

// Download the itemized invoice PDF attached to a bill (skips the "Email_body" attachment).
const downloadInvoicePdf = async (billId) => {
  const atts = (await qbQuery(`select * from Attachable where AttachableRef.EntityRef.Value = '${billId}'`)).QueryResponse?.Attachable || [];
  const inv = atts.find((a) => /pdf/i.test(a.ContentType || '') && !/email/i.test(a.FileName || '')) || atts.find((a) => /pdf/i.test(a.ContentType || ''));
  if (!inv) return null;
  const full = (await qbQuery(`select * from Attachable where Id = '${inv.Id}'`)).QueryResponse?.Attachable?.[0];
  if (!full?.TempDownloadUri) return null;
  const fr = await fetch(full.TempDownloadUri);
  return Buffer.from(await fr.arrayBuffer());
};

// ---- Parsing ----
const num = (s) => parseFloat(String(s).replace(/,/g, ''));

const LITERS_PER = { GAL: 3.785411784, QT: 0.946352946, LT: 1, L: 1, ML: 0.001 };
// Rough food densities (kg/L) for volume→weight conversion.
const densityFor = (description) => {
  const d = String(description).toLowerCase();
  if (/\boil\b|evoo|olive oil|canola|sesame oil|vegetable/.test(d)) return 0.91;
  if (/syrup|honey|molasses|agave/.test(d)) return 1.37;
  return 1.0; // water-based: milk, cream, buttermilk, juice, vinegar, sauce, water
};

// Pack size → total weight of one case in kg. Handles weight packs ("4/5 LB", "12/15 OZ") directly
// and volume packs ("4/1 GAL", "4/3 LT") via a food-density estimate. null if unparseable.
const packToKg = (packSize, description = '') => {
  const s = String(packSize);
  let m = s.match(/(\d+)\s*\/\s*([\d.]+)\s*(LB|OZ|KG|G)\b/i);
  if (m) {
    const qty = num(m[1]) * num(m[2]);
    const u = m[3].toUpperCase();
    if (u === 'LB') return qty * KG_PER_LB;
    if (u === 'OZ') return qty * KG_PER_OZ;
    if (u === 'KG') return qty;
    if (u === 'G') return qty / 1000;
  }
  m = s.match(/(\d+)\s*\/\s*([\d.]+)\s*(GAL|QT|LT|L|ML)\b/i);
  if (m) {
    const liters = num(m[1]) * num(m[2]) * (LITERS_PER[m[3].toUpperCase()] || 0);
    return liters > 0 ? liters * densityFor(description) : null;
  }
  // Single-quantity packs with no count/size slash, e.g. "2 LB POUCH", "5 LB", "1 GAL".
  m = s.match(/\b([\d.]+)\s*(LB|OZ|KG|G)\b/i);
  if (m) {
    const q = num(m[1]); const u = m[2].toUpperCase();
    if (u === 'LB') return q * KG_PER_LB;
    if (u === 'OZ') return q * KG_PER_OZ;
    if (u === 'KG') return q;
    if (u === 'G') return q / 1000;
  }
  m = s.match(/\b([\d.]+)\s*(GAL|QT|LT|L|ML)\b/i);
  if (m) {
    const liters = num(m[1]) * (LITERS_PER[m[2].toUpperCase()] || 0);
    return liters > 0 ? liters * densityFor(description) : null;
  }
  return null;
};

// Parse the line items out of one invoice's extracted text.
// Anchor on the pack line (contains "Plt#:"); the next line is the price line, the previous is the
// item line (code + description, sometimes prefixed by the ordered/shipped qty).
const parseInvoiceText = (text) => {
  const lines = text.split('\n').map((l) => l.trim());
  const items = [];
  for (let i = 1; i < lines.length - 1; i++) {
    if (!/Plt#:/.test(lines[i])) continue;
    const priceM = lines[i + 1].match(/^([\d,.]+)\s+([A-Z]+)\s+([\d,.]+)$/);
    if (!priceM) continue;

    const packSize = lines[i].split('Plt#:')[0].trim();
    // Item line: strip a leading "ordered shipped" qty prefix if present ("1 CS 1 CS ...").
    let itemLine = lines[i - 1].replace(/^\d+\s+[A-Z]{1,3}\s+\d+\s+[A-Z]{1,3}\s+/, '').trim();
    const tokens = itemLine.split(/\s+/);
    let code = null;
    // Item code = leading alphanumeric token containing a digit (incl. purely-numeric codes like
    // "1000150"); description words are letters-only, so requiring a digit distinguishes them.
    if (tokens[0] && /^[0-9A-Z][0-9A-Z-]{2,}$/i.test(tokens[0]) && /\d/.test(tokens[0])) code = tokens.shift();
    const description = tokens.join(' ').trim();
    if (!description) continue;

    items.push({
      itemCode: code,
      description,
      packSize,
      unitPrice: num(priceM[1]),
      priceUOM: priceM[2],
      extended: num(priceM[3]),
    });
  }
  return items;
};

// $/kg for a parsed line item, when weight is derivable.
const pricePerKg = (item) => {
  if (item.priceUOM === 'LB') return item.unitPrice / KG_PER_LB; // $/LB → $/kg
  if (item.priceUOM === 'OZ') return item.unitPrice / KG_PER_OZ;
  // CS / PC / EA etc.: price is per pack; derive $/kg from the pack's weight (incl. volume→weight).
  const packKg = packToKg(item.packSize, item.description);
  return packKg ? item.unitPrice / packKg : null;
};

// ---- Cache ----
const loadCache = () => { try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')); } catch { return {}; } };
const saveCache = (c) => { fs.mkdirSync(OUT_DIR, { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2)); };

// Build the "latest price per ingredient" table from the last `weeks` of invoices.
const buildPriceList = async ({ weeks = 10, onProgress } = {}) => {
  const since = new Date(Date.now() - weeks * 7 * 86400_000).toISOString().slice(0, 10);
  const bills = await listBills(since);
  const cache = loadCache();

  let fetched = 0;
  for (const b of bills) {
    if (cache[b.Id]) continue;
    const buf = await downloadInvoicePdf(b.Id).catch(() => null);
    if (!buf) { cache[b.Id] = { txnDate: b.TxnDate, text: '', noPdf: true }; continue; }
    const parsed = await new PDFParse({ data: buf }).getText().catch(() => ({ text: '' }));
    // Cache the raw invoice text (not parsed items) so parser improvements don't require re-download.
    cache[b.Id] = { txnDate: b.TxnDate, docNumber: b.DocNumber, text: parsed.text || '' };
    fetched += 1;
    if (onProgress && fetched % 10 === 0) onProgress(fetched, bills.length);
  }
  saveCache(cache);

  // Collapse to most-recent price per ingredient (keyed by itemCode, else by description).
  const byKey = {};
  for (const b of bills) {
    const entry = cache[b.Id];
    if (!entry?.text) continue;
    for (const it of parseInvoiceText(entry.text)) {
      const key = it.itemCode || it.description;
      const prev = byKey[key];
      if (!prev || entry.txnDate > prev.date) {
        byKey[key] = { ...it, date: entry.txnDate, pricePerKg: pricePerKg(it) };
      }
    }
  }

  const ingredients = Object.values(byKey).sort((a, b) => a.description.localeCompare(b.description));
  return {
    generatedAt: new Date().toISOString(),
    vendorId: VENDOR_ID,
    since,
    invoicesConsidered: bills.length,
    invoicesFetched: fetched,
    ingredientCount: ingredients.length,
    withPricePerKg: ingredients.filter((i) => i.pricePerKg != null).length,
    ingredients,
  };
};

module.exports = { buildPriceList, parseInvoiceText, packToKg, pricePerKg, listBills, downloadInvoicePdf };

// CLI: node pipeline/chefs-warehouse.js [weeks]  → writes latest-price-per-ingredient JSON + CSV.
if (require.main === module) {
  require('dotenv').config();
  const weeks = parseInt(process.argv[2], 10) || 10;
  console.log(`Extracting Chef's Warehouse prices from the last ${weeks} weeks of invoices…`);
  buildPriceList({ weeks, onProgress: (n) => process.stdout.write(`  …parsed ${n} new invoices\r`) })
    .then((res) => {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, 'chefs-warehouse-prices.json'), JSON.stringify(res, null, 2));
      const csv = ['item_code,description,pack_size,unit_price,price_uom,price_per_kg,invoice_date'];
      res.ingredients.forEach((i) => csv.push([
        i.itemCode || '', `"${i.description.replace(/"/g, '""')}"`, `"${i.packSize}"`,
        i.unitPrice, i.priceUOM, i.pricePerKg != null ? i.pricePerKg.toFixed(4) : '', i.date,
      ].join(',')));
      fs.writeFileSync(path.join(OUT_DIR, 'chefs-warehouse-prices.csv'), csv.join('\n'));
      console.log(`\n${res.ingredientCount} ingredients (${res.withPricePerKg} with $/kg) from ${res.invoicesConsidered} invoices since ${res.since}.`);
      console.log('Wrote data/pipeline/chefs-warehouse-prices.{json,csv}');
    })
    .catch((e) => { console.error('Failed:', e.message); process.exit(1); });
}
