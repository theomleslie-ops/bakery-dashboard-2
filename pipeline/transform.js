// Turns nested QuickBooks report JSON into a flat table, plus small CSV helpers shared by the
// pipeline. QB reports nest rows (sections → subaccounts → summaries); flattenQBReport walks that
// tree into a flat list of records while keeping the section breadcrumb in `group`.

const zip = (columns, cells) => {
  const out = {};
  columns.forEach((c, i) => { out[c || `col${i}`] = cells[i] ?? ''; });
  return out;
};

const flattenQBReport = (report) => {
  const columns = (report?.Columns?.Column || []).map((c) => c.ColTitle || '');
  const records = [];

  const walk = (rows, trail) => {
    (rows || []).forEach((row) => {
      // Leaf data row
      if (row.ColData) {
        const cells = row.ColData.map((c) => c.value ?? '');
        records.push({ group: trail.join(' > '), label: cells[0] || '', values: zip(columns, cells) });
      }
      // Section row: header, nested rows, optional summary total
      if (row.Header || row.Rows || row.Summary) {
        const headerLabel = row.Header?.ColData?.[0]?.value || '';
        const nextTrail = headerLabel ? [...trail, headerLabel] : trail;
        walk(row.Rows?.Row, nextTrail);
        if (row.Summary?.ColData) {
          const cells = row.Summary.ColData.map((c) => c.value ?? '');
          records.push({ group: trail.join(' > '), label: cells[0] || `${headerLabel} — total`, values: zip(columns, cells) });
        }
      }
    });
  };

  walk(report?.Rows?.Row, []);
  return { columns, records };
};

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Flattened QB table → CSV (leading Group column, then the report's own columns).
const qbTableToCSV = (table) => {
  const colKeys = table.columns.map((c, i) => c || `col${i}`);
  const header = ['Group', ...colKeys];
  const lines = [header.map(csvCell).join(',')];
  table.records.forEach((rec) => {
    lines.push([rec.group, ...colKeys.map((k) => rec.values[k] ?? '')].map(csvCell).join(','));
  });
  return lines.join('\n');
};

// Raw sheet rows (array of arrays) → CSV.
const rowsToCSV = (rows) => (rows || []).map((r) => (r || []).map(csvCell).join(',')).join('\n');

const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'untitled';

module.exports = { flattenQBReport, qbTableToCSV, rowsToCSV, csvCell, slug };
