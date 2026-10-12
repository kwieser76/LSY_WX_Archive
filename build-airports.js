#!/usr/bin/env node
// ---------------------------------------------------------------------------
// build-airports.js
// Writes tools/wx-archive/airports.json, the airport list of the public METAR/TAF archive: every airport
// that OurAirports (public domain) types as "large_airport" with scheduled service and a 4-letter ICAO
// code, in Europe, North America and the Middle East (the regions of the briefing's weather maps).
// A neutral rule on purpose: the list must not show which airports the briefing itself looks at.
//
//   curl -sO https://davidmegginson.github.io/ourairports-data/airports.csv
//   node tools/wx-archive/build-airports.js airports.csv        → tools/wx-archive/airports.json
// Re-run about once a year, or when the briefing adds an airport outside the list (the reader warns).
// ---------------------------------------------------------------------------
'use strict';
const fs = require('fs');
const path = require('path');

const ME = new Set(['AE', 'SA', 'QA', 'BH', 'KW', 'OM', 'IR', 'IQ', 'IL', 'JO', 'LB', 'SY', 'YE', 'EG', 'TR', 'CY']);
// RFC 4180 CSV: quoted fields may hold commas and doubled quotes.
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
function select(rows) {
  const h = rows[0], ix = n => h.indexOf(n);
  const [iT, iS, iI, iC, iK] = ['type', 'scheduled_service', 'icao_code', 'continent', 'iso_country'].map(ix);
  return [...new Set(rows.slice(1).filter(r => r[iT] === 'large_airport' && r[iS] === 'yes' && /^[A-Z]{4}$/.test(r[iI] || '') &&
    (r[iC] === 'EU' || r[iC] === 'NA' || ME.has(r[iK]))).map(r => r[iI]))].sort();
}
module.exports = { parseCsv, select };
if (require.main === module) {
  const list = select(parseCsv(fs.readFileSync(process.argv[2], 'utf8')));
  fs.writeFileSync(path.join(__dirname, 'airports.json'), JSON.stringify(list) + '\n');
  console.log('airports.json: ' + list.length + ' airports');
}
