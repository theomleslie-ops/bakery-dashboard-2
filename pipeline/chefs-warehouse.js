// Chef's Warehouse ingredient pricing, straight from QuickBooks.
//
// QB records each CW purchase as a Bill whose lump-sum total carries no line detail — but the
// itemized invoice is attached to the bill as a PDF. So: find the CW bills, download each bill's
// invoice PDF, extract its line items, convert every line's pack price to a normalized $/kg, and
// keep the most-recent price per ingredient. Raw invoice text is cached per bill id so reruns only
// download invoices we haven't parsed before.
//
// Output: { generatedAt, since, vendorId, ingredients: [{ itemCode, description, packSize,
//            unitPrice, priceUOM, pricePerKg, date }] }.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const qb = require('./qb');

const OUT_DIR = path.join(__dirname, '..', 'data', 'pipeline');
const CACHE_FILE = path.join(OUT_DIR, 'cw-invoice-cache.json');
// Chef's Warehouse West Coast, LLC — override in .env if the vendor id differs in this QB company.
const VENDOR_ID = process.env.CW_VENDOR_ID || '233';

// --- unit conversion ---
const KG_PER_LB = 0.45359237;
const KG_PER_OZ = 0.0283495231;
const LITERS_PER = { GAL: 3.785411784, QT: 0.946352946, PT: 0.473176473, LT: 1, L: 1, ML: 0.001 };
// Rough food densities (kg/L) so volume-priced items (oils, syrups, dairy) still yield a $/kg.
const densityFor = (description = '') => {
  const d = String(description).toLowerCase();
  if (/\boil\b|evoo|olive|canola|sesame oil|vegetable oil/.test(d)) return 0.91;
  if (/syrup|honey|molasses|agave/.test(d)) return 1.37;
  return 1.0; // water-based default: milk, cream, buttermilk, juice, vinegar, water
};
const num = (s) => parseFloat(String(s).replace(/,/g, ''));

// Total weight (kg) of one purchased pack, from its pack-size string. Handles count/size weight
// packs ("4/5 LB", "12/15 OZ"), volume packs ("4/1 GAL") via density, and single packs ("5 LB").
// Returns null when no weight is derivable.
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
    const q = num(m[1]); const u = m[2].toUpperCase();
    return u === 'LB' ? q * KG_PER_LB : u === 'OZ' ? q * KG_PER_OZ : u === 'KG' ? q : q / 1000;
  }
  m = s.match(/\b([\d.]+)\s*(GAL|QT|PT|LT|L|ML)\b/i);
  if (m) {
    const liters = num(m[1]) * (LITERS_PER[m[2].toUpperCase()] || 0);
    return liters > 0 ? liters * densityFor(description) : null;
  }
  return null;
};

// $/kg for one parsed line. Weight-priced lines (per LB/OZ/KG) convert directly; pack-priced lines
// (CS/EA/PC) derive $/kg from the pack's total weight.
const pricePerKg = (item) => {
  if (item.priceUOM === 'LB') return item.unitPrice / KG_PER_LB;
  if (item.priceUOM === 'OZ') return item.unitPrice / KG_PER_OZ;
  if (item.priceUOM === 'KG') return item.unitPrice;
  const packKg = packToKg(item.packSize, item.description);
  return packKg ? item.unitPrice / packKg : null;
};

// --- invoice text parsing ---
// Chef's Warehouse invoice PDFs lay each line item across three text lines: an item line
// (code + description), a pack line containing "Plt#:", and a price line ("<unit> <UOM> <ext>").
// Anchor on the pack line and read its neighbours.
const parseInvoiceText = (text) => {
  const lines = String(text).split('\n').map((l) => l.trim());
  const items = [];
  for (let i = 1; i < lines.length - 1; i++) {
    if (!/Plt#:/.test(lines[i])) continue;
    const priceM = lines[i + 1].match(/^([\d,.]+)\s+([A-Z]+)\s+([\d,.]+)$/);
    if (!priceM) continue;

    const packSize = lines[i].split('Plt#:')[0].trim();
    // Item line may be prefixed with an "ordered shipped" qty ("1 CS 1 CS ..."); strip it.
    const itemLine = lines[i - 1].replace(/^\d+\s+[A-Z]{1,3}\s+\d+\s+[A-Z]{1,3}\s+/, '').trim();
    const tokens = itemLine.split(/\s+/);
    let code = null;
    // Item code = a leading alphanumeric token containing a digit (incl. all-numeric codes);
    // description words are letters-only, so requiring a digit tells them apart.
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

// --- QB bill + attachment access ---
const listBills = async (sinceDate) => {
  const bills = [];
  for (let start = 1; ; start += 100) {
    const q = `select Id, DocNumber, TxnDate from Bill where VendorRef='${VENDOR_ID}' and TxnDate >= '${sinceDate}' ORDERBY TxnDate DESC STARTPOSITION ${start} MAXRESULTS 100`;
    const page = (await qb.query(q)).Bill || [];
    bills.push(...page);
    if (page.length < 100) break;
  }
  return bills;
};

// Download a bill's itemized invoice PDF (skip the "email body" attachment). Returns a Buffer|null.
const downloadInvoicePdf = async (billId) => {
  const atts = (await qb.query(`select * from Attachable where AttachableRef.EntityRef.Value = '${billId}'`)).Attachable || [];
  const pdf = atts.find((a) => /pdf/i.test(a.ContentType || '') && !/email/i.test(a.FileName || ''))
    || atts.find((a) => /pdf/i.test(a.ContentType || ''));
  if (!pdf) return null;
  const full = (await qb.query(`select * from Attachable where Id = '${pdf.Id}'`)).Attachable?.[0];
  if (!full?.TempDownloadUri) return null;
  const res = await axios.get(full.TempDownloadUri, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
};

const extractPdfText = async (buf) => {
  const { PDFParse } = require('pdf-parse'); // lazy so non-CW runs don't need pdf-parse installed
  const parsed = await new PDFParse({ data: buf }).getText().catch(() => ({ text: '' }));
  return parsed.text || '';
};

const loadCache = () => { try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')); } catch { return {}; } };
const saveCache = (c) => { fs.mkdirSync(OUT_DIR, { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2)); };

// Build the "latest price per ingredient" table from the last `weeks` of CW invoices.
const buildPriceList = async ({ weeks = 12, onProgress } = {}) => {
  const since = new Date(Date.now() - weeks * 7 * 86400_000).toISOString().slice(0, 10);
  const bills = await listBills(since);
  const cache = loadCache();

  let fetched = 0;
  for (const b of bills) {
    if (cache[b.Id]) continue;
    const buf = await downloadInvoicePdf(b.Id).catch(() => null);
    // Cache raw text (not parsed items) so parser improvements never require re-downloading.
    cache[b.Id] = buf
      ? { txnDate: b.TxnDate, docNumber: b.DocNumber, text: await extractPdfText(buf) }
      : { txnDate: b.TxnDate, docNumber: b.DocNumber, text: '', noPdf: true };
    fetched += 1;
    if (onProgress && fetched % 5 === 0) onProgress(fetched, bills.length);
  }
  saveCache(cache);

  // Collapse to the most-recent price per ingredient (keyed by item code, else description).
  const byKey = {};
  for (const b of bills) {
    const entry = cache[b.Id];
    if (!entry?.text) continue;
    for (const it of parseInvoiceText(entry.text)) {
      const key = it.itemCode || it.description.toLowerCase();
      const prev = byKey[key];
      if (!prev || entry.txnDate > prev.date) byKey[key] = { ...it, date: entry.txnDate, pricePerKg: pricePerKg(it) };
    }
  }
  const ingredients = Object.values(byKey).sort((a, b) => a.description.localeCompare(b.description));

  return {
    generatedAt: new Date().toISOString(),
    since,
    vendorId: VENDOR_ID,
    invoicesConsidered: bills.length,
    invoicesFetched: fetched,
    ingredientCount: ingredients.length,
    withPricePerKg: ingredients.filter((i) => i.pricePerKg != null).length,
    ingredients,
  };
};

module.exports = { buildPriceList, parseInvoiceText, packToKg, pricePerKg, listBills, downloadInvoicePdf, VENDOR_ID };

// CLI: node pipeline/chefs-warehouse.js [weeks]
if (require.main === module) {
  const weeks = parseInt(process.argv[2], 10) || 12;
  console.log(`Extracting Chef's Warehouse prices from the last ${weeks} weeks of invoices…`);
  buildPriceList({ weeks, onProgress: (n, total) => process.stdout.write(`  …parsed ${n}/${total} new invoices\r`) })
    .then((res) => {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, 'chefs-warehouse-prices.json'), JSON.stringify(res, null, 2));
      console.log(`\n${res.ingredientCount} ingredients (${res.withPricePerKg} with $/kg) from ${res.invoicesConsidered} invoices since ${res.since}.`);
      console.log('Wrote data/pipeline/chefs-warehouse-prices.json');
    })
    .catch((e) => { console.error('Failed:', e.message); process.exit(1); });
}
