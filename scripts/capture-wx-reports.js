#!/usr/bin/env node
// ---------------------------------------------------------------------------
// capture-wx-reports.js
// Saves every METAR, SPECI and TAF of a list of airports, including TAF amendments (AMD), corrections
// (COR) and delayed reports (RTD), into a day-by-day archive, so a weekly report can show each
// airport's reports for every day of its week.
//
// Why a capture at all (research 2026-10-12, tools/research-2026-10-12/metar-taf-sources.md): no free
// archive we may use keeps all of it. Outside the US there is no free TAF archive, and the METAR
// archives keep only the corrected report when a COR comes in. MET Norway's tafmetar service returns
// every report of the last 24 hours in one request, each with its markers, so an hourly run sees every
// report many times and late or dropped runs lose nothing.
//
// Runs in the PUBLIC GitHub repository kwieser76/LSY_WX_Archive (workflow .github/workflows/wx-capture.yml,
// Node 20, no dependencies), every 10 minutes. airports.json there is a neutral list: every large airport with
// scheduled service in Europe, North America and the Middle East (OurAirports, public domain). The
// master copy lives in the briefing project, scripts/capture-wx-reports.js; tools/wx-archive/README.md
// says how it is installed. (2026-10-12: a private repo with a shorter list, every 30 minutes, came first.)
//
// Two sources (PO decision 2026-10-13, tools/research-2026-10-13/fresh-metar-architecture.md): GitHub dropped 18 of 20
// hourly slots, so the newest METAR in the archive was hours old. The runs now come every 10 minutes, but MET Norway is
// still asked only once an hour (its load stays as it was): a run reads MET Norway when no MET Norway request was made
// in the last METNO_EVERY_MIN minutes (state.json lastMetNorwayTry), every other run reads the two whole-world cache
// files of the NOAA/NWS Aviation Weather Center (AWC, public domain, rebuilt every minute, 2 requests, about 585 KB;
// the newest METAR/SPECI and the newest TAF of every station) and keeps the airports of airports.json. AWC has no
// history: a report it shows for less than the gap between two runs is caught by the next MET Norway run.
// A MET Norway run that reads nothing (an error, or its stop note in force) reads AWC instead; an AWC refusal never
// stops the hourly MET Norway run, and a MET Norway refusal never stops the AWC runs.
//
//   node scripts/capture-wx-reports.js                writes <repo>/archive/...
//   WX_ARCHIVE_DIR=/some/dir WX_AIRPORTS=/x/airports.json node scripts/capture-wx-reports.js
//   WX_SOURCE=metno|awc ...                           this run's source instead of the hourly rule (tests, a manual run)
//
// Layout (the workflow publishes it as ONE orphan commit on the branch "data", so git history never grows):
//   archive/YYYY/MM/DD.ndjson.gz  one line per report, filed by the UTC day of the report's own time:
//                                 {"icao","kind":"METAR|SPECI|TAF","marks":["AMD","COR","AUTO","RTD"],
//                                  "time":"YYYY-MM-DDTHH:MMZ","raw","seen","src":"metno|awc"} (src since 2026-10-13; none = metno)
//   archive/latest.json.gz        per airport the last LATEST_METARS METAR/SPECI and the TAFs in force (layout at latestOf)
//   archive/state.json            { checkedAt, source, lastMetNorway, lastMetNorwayTry, lastAwc, lines, added, missing, ... }
//   archive/blocked.json          the stop note: { blocked: [{ host, status, at, until, path }] } after HTTP 403/429
// Day files older than KEEP_DAYS are dropped: the weekly reader takes its week each Monday.
// A report is stored once, by one rule for both sources: the key (keyOf) is ICAO + kind + report time + marks + the report
// body without its keywords (MET Norway moves AUTO, COR, SPECI and AMD out of the body as markers; AWC keeps
// "METAR/SPECI/TAF AMD/COR" in front and AUTO/COR after the time), and across the sources ICAO + kind + report time + COR
// or not (crossKeyOf: MET Norway changes markers and text, measured). `raw` stays as the source served it. `seen` is when
// this capture first saw it. A transient error is a GitHub warning and the job still ends with exit 0, so one bad run
// never turns the workflow red; a gap shows up in the weekly report as a gap.
// Review 2026-10-13, three things DO turn it red (the workflow's last step, --check), after the publish:
//   - a 403 or 429: the stop note is written for that host, and every run of the next BLOCK_HOURS skips it
//     (project rule: no further request to a host that refused us). Until then the next hourly run asked again.
//   - a day file that exists but does not decode: it is kept as it is (never rewritten with only the new
//     reports, which would drop the day's earlier ones) and named in state.undecodable.
//   - (in the workflow, --verify-publish) a restored day file missing before the force-push: nothing is published.
//
//   node scripts/capture-wx-reports.js --check                          exit 1 while a stop note is active or a day is undecodable
//   node scripts/capture-wx-reports.js --verify-publish <list> <dir>    exit 1 when a restored, unexpired day file is missing
//
// Data from MET Norway (CC BY 4.0 / NLOD 2.0): https://api.met.no/doc/License, and from the NOAA/NWS Aviation Weather
// Center (US Government work, public domain): https://aviationweather.gov/data/api/. MET Norway asks for an identifying
// User-Agent with a contact; this one names the GitHub account, nothing about a person. Both AWC requests are the
// same two fixed URLs for the whole world: no airport list is in them.
// ---------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const URL = 'https://api.met.no/weatherapi/tafmetar/1.0/tafmetar.txt';
const AWC_METARS = 'https://aviationweather.gov/data/cache/metars.cache.csv.gz';
const AWC_TAFS = 'https://aviationweather.gov/data/cache/tafs.cache.xml.gz';
const UA = 'LSY-WX-archive/1.0 github.com/kwieser76';
const REPO = path.resolve(__dirname, '..');
const ROOT = process.env.WX_ARCHIVE_DIR ? path.resolve(process.env.WX_ARCHIVE_DIR) : path.join(REPO, 'archive');
const AIRPORTS = process.env.WX_AIRPORTS ? path.resolve(process.env.WX_AIRPORTS) : path.join(REPO, 'airports.json');
const LEAD = new Set(['METAR', 'SPECI', 'TAF', 'AMD', 'COR', 'AUTO', 'RTD']);   // keywords / markers in front of the ICAO
const AFTER = new Set(['AMD', 'COR', 'AUTO', 'RTD']);                            // markers right after the report time (AWC)
const MARK = new Set(['AMD', 'COR', 'AUTO', 'RTD']);                             // what `marks` may hold
const KEEP_DAYS = 21;
const BLOCK_HOURS = 24;
const METNO_EVERY_MIN = 55;      // MET Norway at most about once an hour (runs every 10 min, a few minutes late at times)
const LATEST_METARS = 3;
const SRC = { metno: 'MET Norway tafmetar', awc: 'NOAA/NWS Aviation Weather Center cache files' };
const CREDIT = { metno: 'Data from MET Norway (CC BY 4.0)', awc: 'NOAA/NWS Aviation Weather Center (public domain)' };

// ---- pure helpers (tested offline in the briefing project) -----------------------------------
// "DDHHMM" of a report → full UTC time, taking the year and month from the moment of capture. A day
// number above tomorrow's belongs to the previous month (a capture on 1 Nov still sees 31 Oct). Day 1 seen on
// the last day of a month belongs to the next month: a METAR for 00:00Z is often sent a few minutes early, so a
// capture at 31 Oct 23:5xZ can see "010000Z" (review 2026-10-13, L11; harmless at :17, but not if the cron moves).
function resolveTime(ddhhmm, nowIso) {
  const d = +ddhhmm.slice(0, 2), h = +ddhhmm.slice(2, 4), mi = +ddhhmm.slice(4, 6);
  const now = new Date(nowIso);
  let y = now.getUTCFullYear(), m = now.getUTCMonth();
  const lastOfMonth = new Date(Date.parse(nowIso) + 86400000).getUTCDate() === 1;
  if (d === 1 && lastOfMonth) { m += 1; if (m > 11) { m = 0; y += 1; } }
  else if (d > now.getUTCDate() + 1) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
  const t = new Date(Date.UTC(y, m, d, h, mi));
  if (t.getUTCDate() !== d) return null;                     // 31st in a 30-day month: not a real time
  return t.toISOString().slice(0, 16) + 'Z';
}
// The head of a report as both sources write it: keywords and markers in front (MET Norway "AUTO XXXX 130820Z ...",
// AWC "METAR XXXX 130820Z AUTO ..." / "TAF AMD XXXX ..."), the ICAO, the time, markers right after the time (AWC's US
// "KXXX 130851Z COR ..."), then the rest. null when the text is no report.
function splitReport(text) {
  const toks = String(text || '').trim().split(/\s+/).filter(Boolean), lead = [];
  while (toks.length && LEAD.has(toks[0])) lead.push(toks.shift());
  if (toks.length < 3 || !/^[A-Z0-9]{4}$/.test(toks[0]) || !/^\d{6}Z$/.test(toks[1])) return null;
  let i = 2;
  const after = [];
  while (i < toks.length && AFTER.has(toks[i])) after.push(toks[i++]);
  return { lead, after, icao: toks[0], ddhhmm: toks[1].slice(0, 6), rest: toks.slice(i), toks };
}
const marksOf = (s, extra) => {
  const out = [];
  (extra || []).concat(s ? s.lead.concat(s.after) : []).forEach(m => { if (MARK.has(m) && out.indexOf(m) < 0) out.push(m); });
  return out;
};
// One report → { icao, kind, marks, time, raw, src }, or null for anything else (blank line, NIL, a line that does not
// start with a known airport). MET Norway (src 'metno', one line of the extended answer): the markers in front are its
// own, so the raw text is kept as served without them and the markers travel beside it (as since 2026-10-12). AWC (src
// 'awc', the raw_text of one row): the raw text is kept exactly as served, keywords included. hint (AWC): { kind } from
// metar_type, for a SPECI whose raw text does not say so, and { marks } from the row's corrected column or the TAF's
// remarks ("AMD"/"COR"), which AWC fills where the raw text has no keyword (2026-10-13: 142 TAF AMD, 6 TAF COR).
function parseLine(line, nowIso, wanted, src, hint) {
  const s = splitReport(line);
  if (!s) return null;
  if (wanted && !wanted.has(s.icao)) return null;
  if (!s.rest.length || /^NIL=?$/.test(s.rest[0])) return null;
  const time = resolveTime(s.ddhhmm, nowIso);
  if (!time) return null;
  const isTaf = s.lead.indexOf('TAF') >= 0 || /^\d{4}\/\d{4}$/.test(s.rest[0]);
  const kind = isTaf ? 'TAF' : (s.lead.indexOf('SPECI') >= 0 || (hint && hint.kind === 'SPECI') ? 'SPECI' : 'METAR');
  const raw = src === 'awc' ? String(line).trim().replace(/\s+/g, ' ') : s.toks.join(' ');
  return { icao: s.icao, kind, marks: marksOf(s, (hint && hint.marks) || []), time, raw, src: src === 'awc' ? 'awc' : 'metno' };
}
// The one dedupe key of the archive, for both sources and for lines stored before 2026-10-13: ICAO + kind + report time
// + marks (the stored ones and the ones the raw text carries) + the body without its keywords and markers, without AUTO,
// without the closing "=", spaces collapsed. MET Norway writes the US maintenance flag "$" as "?" (measured 2026-10-13
// on three US airports: otherwise the same text), so "?" counts as "$". A COR with the same text as its original keeps its
// own key (MET Norway serves both, 2026-10-13 MMTJ).
function keyOf(r) {
  const s = splitReport(r && r.raw), marks = marksOf(s, (r && r.marks) || []).sort();
  const body = s ? [s.icao, s.toks[1]].concat(s.rest) : String((r && r.raw) || '').trim().split(/\s+/);
  const t = body.filter(x => x !== 'AUTO');
  if (t.length) { t[t.length - 1] = t[t.length - 1].replace(/=+$/, ''); if (!t[t.length - 1]) t.pop(); }
  return [r && r.icao, r && r.kind, r && r.time, marks.join('+'), t.map(x => (x === '?' ? '$' : x)).join(' ')].join('|');
}
// The second half of the rule, across the sources only: the same ICAO, kind and report time, both a COR or both not =
// the same report, whatever the text. Measured on the first AWC run (2026-10-13 09:30Z): of 168 AWC reports, 135 were
// already stored from MET Norway and keyOf matched none of them. MET Norway changes markers and text: it marks delayed
// reports RTD (AWC never), sets AMD/COR where AWC's text has none and the other way round, and in 32 of the 135 the text
// differs too (the RMK section of Turkish METARs and the A-group after Q in Iranian and Emirati ones dropped, "AMD" taken
// out of "AMD NOT SKED", TAFs cut short, "18010G 20KT"). A station sends one report per time; a correction is a COR.
const crossKeyOf = r => [r && r.icao, r && r.kind, r && r.time, marksOf(splitReport(r && r.raw), (r && r.marks) || []).indexOf('COR') >= 0 ? 'COR' : ''].join('|');
// What plan() compares against: keyOf of every stored line, and crossKeyOf per source ('X|<src>|...').
function storedKeysOf(lines) {
  const keys = new Set();
  (lines || []).forEach(r => { if (r) { keys.add(keyOf(r)); keys.add('X|' + (r.src || 'metno') + '|' + crossKeyOf(r)); } });
  return keys;
}
const SOURCES = ['metno', 'awc'];
const dayOf = time => ({ dir: time.slice(0, 4) + '/' + time.slice(5, 7), file: time.slice(8, 10) + '.ndjson.gz' });

// Which reports are new, given the keys already stored (storedKeysOf; a plain set of keyOf keys works too). input: MET
// Norway's answer (text, one report per line) or a list of AWC reports ({ raw, kind, marks }). A report is not new when its
// keyOf is stored, or its crossKeyOf is stored for the other source. Returns the reports to append, grouped by day
// file, and the airports read.
function plan(input, nowIso, wanted, storedKeys, src) {
  const add = {}, seen = new Set(), icaos = new Set();
  let parsed = 0;
  const items = typeof input === 'string' || input == null ? String(input || '').split(/\r?\n/) : input;
  items.forEach(it => {
    const r = typeof it === 'string' ? parseLine(it, nowIso, wanted, src) : parseLine(it && it.raw, nowIso, wanted, src, it);
    if (!r) return;
    parsed++;
    icaos.add(r.icao);
    const k = keyOf(r), ck = crossKeyOf(r);
    if (seen.has(k) || (storedKeys && (storedKeys.has(k) || SOURCES.some(o => o !== r.src && storedKeys.has('X|' + o + '|' + ck))))) return;
    seen.add(k);
    const p = dayOf(r.time), rel = p.dir + '/' + p.file;
    (add[rel] = add[rel] || []).push({ icao: r.icao, kind: r.kind, marks: r.marks, time: r.time, raw: r.raw, seen: nowIso.slice(0, 16) + 'Z', src: r.src });
  });
  return { parsed, add, icaos };
}
// AWC metars.cache.csv (RFC 4180, a header row with raw_text, station_id, observation_time, ..., corrected, ..., metar_type)
// → [{ raw, kind, marks }] of the wanted stations. flight_category and the decoded columns are not used.
function csvRows(text) {
  const rows = [];
  let row = [], f = '', q = false;
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
function parseAwcMetars(text, wanted) {
  const rows = csvRows(String(text || '')), h = rows.findIndex(r => r.indexOf('raw_text') >= 0 && r.indexOf('station_id') >= 0);
  if (h < 0) return [];
  const iRaw = rows[h].indexOf('raw_text'), iSt = rows[h].indexOf('station_id'), iType = rows[h].indexOf('metar_type'), iCor = rows[h].indexOf('corrected'), out = [];
  rows.slice(h + 1).forEach(r => {
    const raw = (r[iRaw] || '').trim(), st = (r[iSt] || '').trim();
    if (!raw || (wanted && !wanted.has(st))) return;
    out.push({ raw, kind: iType >= 0 && r[iType] === 'SPECI' ? 'SPECI' : 'METAR', marks: iCor >= 0 && /^true$/i.test(r[iCor] || '') ? ['COR'] : [] });
  });
  return out;
}
// AWC tafs.cache.xml (<TAF><raw_text><![CDATA[TAF AMD ...]]></raw_text><station_id>...</station_id>...<remarks>AMD</remarks>...</TAF>)
// → [{ raw, kind: 'TAF', marks }].
function parseAwcTafs(text, wanted) {
  const val = (b, tag) => { const m = new RegExp('<' + tag + '>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))</' + tag + '>').exec(b); return m ? (m[1] != null ? m[1] : m[2].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')).trim() : ''; };
  const out = [];
  (String(text || '').match(/<TAF>[\s\S]*?<\/TAF>/g) || []).forEach(b => {
    const raw = val(b, 'raw_text'), st = val(b, 'station_id'), rm = val(b, 'remarks');
    if (raw && (!wanted || wanted.has(st))) out.push({ raw, kind: 'TAF', marks: rm === 'AMD' || rm === 'COR' ? [rm] : [] });
  });
  return out;
}
// The hourly rule: MET Norway when no MET Norway request was made in the last METNO_EVERY_MIN minutes.
function metNorwayDue(state, nowIso) {
  const last = Date.parse((state && (state.lastMetNorwayTry || state.lastMetNorway)) || '');
  return !(last > 0) || Date.parse(nowIso) - last >= METNO_EVERY_MIN * 60000;
}
// A TAF's validity "DDHH/DDHH" → { from, to } ("YYYY-MM-DDTHH:MMZ"), placed next to the issue time (HH 24 = the next
// day 00Z; over a month end). null without a validity group.
function tafValidity(raw, issueIso) {
  const s = splitReport(raw), m = s && /^(\d{2})(\d{2})\/(\d{2})(\d{2})$/.exec(s.rest[0] || '');
  if (!m) return null;
  const near = (dd, hh, ref, after) => {
    const r = new Date(ref);
    let best = null;
    [-1, 0, 1].forEach(o => {
      const d0 = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + o, dd));
      if (d0.getUTCDate() !== dd) return;
      const t = d0.getTime() + hh * 3600000;
      if (after != null && t <= after) return;
      if (best == null || Math.abs(t - ref) < Math.abs(best - ref)) best = t;
    });
    return best;
  };
  const issue = Date.parse(String(issueIso).replace(/Z$/, '').slice(0, 16) + ':00Z');
  const a = near(+m[1], +m[2], issue, null), b = a == null ? null : near(+m[3], +m[4], a, a);
  if (a == null || b == null) return null;
  const iso = t => new Date(t).toISOString().slice(0, 16) + 'Z';
  return { from: iso(a), to: iso(b) };
}
// The TAFs in force at time t (ms): issued by then, valid at t, not replaced or cancelled by then; at most two (an
// airport with a short and a long TAF has both). The rule of the dashboards' wxrSupBy/wxrInForce: a later TAF replaces
// an earlier one whose validity it overlaps when both end within an hour or both are of the same series (shorter or
// longer than 12 h). Added here: at the same issue time and validity an AMD/COR replaces the plain one.
// tafs: [{ ms, v: { a, b } (ms), cnl, fix }] in issue order.
function tafsInForce(tafs, t) {
  const sup = (x, n) => {
    const a = x.v, b = n.v;
    if (n.ms === x.ms) return !!(n.fix && !x.fix && a && b && a.a === b.a && a.b === b.b);
    if (!(n.ms > x.ms)) return false;
    if (!a || !b) return true;
    return b.a < a.b && b.b > a.a && (Math.abs(b.b - a.b) <= 36e5 || (b.b - b.a >= 432e5) === (a.b - a.a >= 432e5));
  };
  const cand = tafs.filter(x => x.v && x.ms <= t && x.v.a <= t && x.v.b > t && !x.cnl);
  return cand.filter(x => !tafs.some(n => n !== x && n.ms <= t && (cand.indexOf(n) >= 0 || n.cnl) && sup(x, n))).slice(-2);
}
// archive/latest.json.gz, written by every run that read something, from the archive's last three day files (so it
// also holds what earlier runs and the other source stored). Neutral like the rest of the repository: every airport of
// airports.json, no airport marked.
//   { v: 1, generatedAt (end of this run's fetch), source (this run's: metno|awc), credit: { metno, awc }, fields,
//     airports, ap: { ICAO: { m: [[time, kind, marks, raw, src], ...] the last LATEST_METARS METAR/SPECI, oldest first,
//                             t: [[time, marks, raw, src, validFrom, validTo], ...] the TAFs in force at generatedAt } },
//     missing: [ICAO without any report in those days] }
// marks "AMD+COR" as in the day files; one report per report time (a COR wins over the report it corrects).
function latestOf(records, icaos, atIso, source) {
  const by = {}, at = Date.parse(atIso), ms = t => Date.parse(String(t).slice(0, 16) + ':00Z');
  (records || []).forEach(r => { if (r && r.icao && r.raw && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(r.time || '')) (by[r.icao] = by[r.icao] || []).push(r); });
  const ap = {}, missing = [];
  (icaos || []).forEach(icao => {
    const rs = (by[icao] || []).filter(r => ms(r.time) <= at + 600000);
    // one METAR/SPECI per report time: the COR, else AWC's text (MET Norway shortens some, see crossKeyOf), else the newest seen
    const one = {}, rank = r => [(r.marks || []).indexOf('COR') >= 0 ? 1 : 0, r.src === 'awc' ? 1 : 0, String(r.seen || '')];
    const better = (a, b) => { const x = rank(a), y = rank(b); return x[0] !== y[0] ? x[0] > y[0] : x[1] !== y[1] ? x[1] > y[1] : x[2] > y[2]; };
    rs.filter(r => r.kind !== 'TAF').forEach(r => { if (!one[r.time] || better(r, one[r.time])) one[r.time] = r; });
    const m = Object.keys(one).sort().slice(-LATEST_METARS).map(t => { const r = one[t]; return [r.time, r.kind, (r.marks || []).join('+'), r.raw, r.src || 'metno']; });
    const tafs0 = rs.filter(r => r.kind === 'TAF').map(r => {
      const val = tafValidity(r.raw, r.time), s = splitReport(r.raw);
      return { r, val, ms: ms(r.time), v: val && { a: ms(val.from), b: ms(val.to) }, fix: (r.marks || []).some(x => x === 'AMD' || x === 'COR'),
        cnl: !!(s && s.rest.some(x => /^CNL=?$/.test(x))) };
    });
    // one TAF per issue time, COR or not, and validity: the same report stored twice (from both sources before crossKeyOf,
    // or from MET Norway once plain and once RTD) shows once, in AWC's text, else the one marked AMD/COR, else the newest seen
    const tb = {}, trank = x => [x.r.src === 'awc' ? 1 : 0, x.fix ? 1 : 0, String(x.r.seen || '')];
    tafs0.forEach(x => {
      const k = crossKeyOf(x.r) + '|' + (x.val ? x.val.from + x.val.to : x.r.raw), o = tb[k];
      if (!o) { tb[k] = x; return; }
      const p = trank(x), q = trank(o);
      if (p[0] !== q[0] ? p[0] > q[0] : p[1] !== q[1] ? p[1] > q[1] : p[2] > q[2]) tb[k] = x;
    });
    const tafs = Object.keys(tb).map(k => tb[k]).sort((a, b) => a.ms - b.ms);
    const t = tafsInForce(tafs, at).map(x => [x.r.time, (x.r.marks || []).join('+'), x.r.raw, x.r.src || 'metno', x.val.from, x.val.to]);
    if (!m.length && !t.length) { missing.push(icao); return; }
    ap[icao] = { m, t };
  });
  return { v: 1, generatedAt: atIso, source, credit: CREDIT, fields: { m: 'time, kind, marks, raw, src', t: 'time, marks, raw, src, validFrom, validTo' },
    airports: (icaos || []).length, ap, missing };
}
// Day files (relative "YYYY/MM/DD.ndjson.gz") older than keepDays before now: to be dropped.
function expired(rels, nowIso, keepDays) {
  const cut = new Date(Date.parse(nowIso) - keepDays * 86400000).toISOString().slice(0, 10);
  return rels.filter(rel => { const m = /^(\d{4})\/(\d{2})\/(\d{2})\.ndjson\.gz$/.exec(rel); return m && (m[1] + '-' + m[2] + '-' + m[3]) < cut; });
}
// Before the force-push: every day file restored from the data branch must still be there, unless retention
// dropped it. [problems]; empty = safe to publish. A transient fetch failure once wiped the archive in theory
// (review 2026-10-13, H2); this is the last line of defence if anything upstream lets one through again.
function publishProblems(restored, current, nowIso, keepDays) {
  const days = rels => (rels || []).filter(r => /^\d{4}\/\d{2}\/\d{2}\.ndjson\.gz$/.test(r));
  const want = days(restored), old = new Set(expired(want, nowIso, keepDays == null ? KEEP_DAYS : keepDays)), have = new Set(days(current));
  const gone = want.filter(r => !old.has(r) && !have.has(r)), P = [];
  if (gone.length) P.push(gone.length + ' restored day file(s) missing: ' + gone.join(', '));
  if (have.size < want.length - old.size) P.push(have.size + ' day file(s) to publish, fewer than the ' + (want.length - old.size) + ' restored and not expired');
  return P;
}
// The stop note: the entries still in force at nowIso (a 403/429 less than BLOCK_HOURS ago).
function activeBlocks(note, nowIso) {
  return ((note && note.blocked) || []).filter(b => b && b.host && Date.parse(b.until || '') > Date.parse(nowIso));
}
function blockEntry(host, status, path, nowIso) {
  return { host, status, at: nowIso, until: new Date(Date.parse(nowIso) + BLOCK_HOURS * 3600000).toISOString(), path };
}

// ---- I/O ---------------------------------------------------------------------------------------
const warn = msg => console.log('::warning title=WX capture::' + msg);
const readJson = (p, dflt) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dflt; } };
// A day file's text: '' when it does not exist yet, null when it exists but does not decode (truncated or corrupt
// gzip). The caller must then leave the file alone: rewriting it as '' + the new lines would drop the day.
function readDayText(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { if (e.code === 'ENOENT') return ''; return null; }
  try { return zlib.gunzipSync(buf).toString('utf8'); } catch (e) { return null; }
}
function linesOf(text) {
  const out = [];
  String(text || '').split('\n').forEach(l => { if (l.trim()) { try { out.push(JSON.parse(l)); } catch (e) { /* a damaged line is skipped */ } } });
  return out;
}
const keysOfText = text => storedKeysOf(linesOf(text));
function listDayFiles(root) {
  const out = [];
  try {
    fs.readdirSync(root).filter(y => /^\d{4}$/.test(y)).forEach(y => fs.readdirSync(path.join(root, y)).filter(m => /^\d{2}$/.test(m))
      .forEach(m => fs.readdirSync(path.join(root, y, m)).filter(f => /^\d{2}\.ndjson\.gz$/.test(f)).forEach(f => out.push(y + '/' + m + '/' + f))));
  } catch (e) { /* no archive yet */ }
  return out.sort();
}

// One GET, one more try after 10 s on a server error or timeout. A 403 or 429 throws at once with e.stop (leave the
// host alone, project rule); any other 4xx is not tried again.
async function getOnce(url, accept) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 10000));
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 60000);
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': UA, Accept: accept } });
      if (res.status === 403 || res.status === 429) { const e = new Error('HTTP ' + res.status); e.stop = true; e.status = res.status; throw e; }
      if (!res.ok) { last = 'HTTP ' + res.status; if (res.status >= 400 && res.status < 500) break; continue; }
      return { buf: Buffer.from(await res.arrayBuffer()), lastModified: res.headers.get('last-modified') || null };
    } catch (e) { if (e.stop) throw e; last = e && e.name === 'AbortError' ? 'timeout after 60 s' : String((e && e.message) || e); }
    finally { clearTimeout(t); }
  }
  throw new Error(last || 'unknown error');
}
// Batches of BATCH airports, PAUSE_MS apart: one request with all ~530 airports (~8 MB) ended in HTTP 502
// (2026-10-12); 54 airports per request always answered. A 403 or 429 stops the whole run (leave the host
// alone, project rule: the batches read so far are kept, a stop note is written); a server error or timeout
// skips only that batch, after one more try.
const BATCH = 60, PAUSE_MS = 2000;
async function fetchBatch(icaos) {
  const a = await getOnce(URL + '?icao=' + icaos.join(',') + '&extended=true', 'text/plain');
  return { text: a.buf.toString('utf8'), lastModified: a.lastModified };
}
async function fetchReports(icaos) {
  const texts = [], failed = [];
  let lastModified = null, stopped = null;
  for (let i = 0; i < icaos.length && !stopped; i += BATCH) {
    if (i) await new Promise(r => setTimeout(r, PAUSE_MS));
    const part = icaos.slice(i, i + BATCH);
    try { const a = await fetchBatch(part); texts.push(a.text); lastModified = a.lastModified || lastModified; }
    catch (e) { if (e.stop) stopped = e.status; else failed.push(part[0] + '..' + part[part.length - 1] + ' (' + e.message + ')'); }
  }
  if (!texts.length) throw Object.assign(new Error(stopped ? 'HTTP ' + stopped : 'every batch failed: ' + failed.join('; ')), { stopStatus: stopped });
  return { text: texts.join('\n'), lastModified, failed, stopStatus: stopped };
}
// The two AWC cache files (gzip; unpacked here unless a proxy already did). A 403/429 on the first stops the second.
async function fetchAwc() {
  const out = { csv: null, xml: null, bytes: 0, failed: [], stopStatus: null };
  for (const [k, u] of [['csv', AWC_METARS], ['xml', AWC_TAFS]]) {
    if (out.stopStatus) break;
    try {
      const a = await getOnce(u, 'application/octet-stream');
      out[k] = (a.buf.length > 1 && a.buf[0] === 0x1f && a.buf[1] === 0x8b ? zlib.gunzipSync(a.buf) : a.buf).toString('utf8');
      out.bytes += a.buf.length;
    } catch (e) { if (e.stop) out.stopStatus = e.status; else out.failed.push(u.split('/').pop() + ' (' + ((e && e.message) || e) + ')'); }
  }
  if (out.csv == null && out.xml == null) throw Object.assign(new Error(out.stopStatus ? 'HTTP ' + out.stopStatus : out.failed.join('; ')), { stopStatus: out.stopStatus });
  return out;
}

const HOST = 'api.met.no', PATH = '/weatherapi/tafmetar/1.0/tafmetar.txt';   // of URL (the name shadows the global URL class)
const AWC_HOST = 'aviationweather.gov', AWC_PATH = '/data/cache/';
const BLOCKED_FILE = () => path.join(ROOT, 'blocked.json');
function writeBlocked(entries) {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(BLOCKED_FILE(), JSON.stringify({ _comment: 'Stop note of the WX capture: a host that answered HTTP 403/429 is not asked again until "until". ' +
    'Remove an entry (or the file) on the data branch to ask again earlier.', blocked: entries }, null, 1) + '\n');
}

async function main() {
  const nowIso = new Date().toISOString();
  const icaos = readJson(AIRPORTS, []);
  if (!Array.isArray(icaos) || !icaos.length) { warn('airports.json is missing or empty — nothing fetched.'); return; }
  const stateFile = path.join(ROOT, 'state.json'), prev = readJson(stateFile, {}) || {};
  const src0 = process.env.WX_SOURCE, due = src0 === 'metno' ? true : src0 === 'awc' ? false : metNorwayDue(prev, nowIso);
  let blocks = activeBlocks(readJson(BLOCKED_FILE(), null), nowIso);
  const blockOf = host => blocks.filter(b => b.host === host)[0];
  const addBlock = (host, status, p) => { blocks = blocks.filter(b => b.host !== host).concat([blockEntry(host, status, p, nowIso)]); writeBlocked(blocks); };
  const blockedSay = b => b.host + ' answered HTTP ' + b.status + ' at ' + String(b.at).slice(0, 16) + 'Z — not asked until ' + String(b.until).slice(0, 16) + 'Z (stop note archive/blocked.json)';
  const st = { lastMetNorway: prev.lastMetNorway || null, lastMetNorwayTry: prev.lastMetNorwayTry || null, lastAwc: prev.lastAwc || null };
  const wanted = new Set(icaos);
  let got = null;
  if (due) {
    if (blockOf(HOST)) warn(blockedSay(blockOf(HOST)) + '. Reading the AWC cache files instead.');
    else {
      st.lastMetNorwayTry = nowIso;
      try {
        const a = await fetchReports(icaos);
        got = { src: 'metno', input: a.text, failed: a.failed, lastModified: a.lastModified, bytes: Buffer.byteLength(a.text) };
        st.lastMetNorway = nowIso;
        if (a.stopStatus) { addBlock(HOST, a.stopStatus, PATH); warn(HOST + ' answered HTTP ' + a.stopStatus + ' — the batches read before it are stored; stop note written, no request for ' + BLOCK_HOURS + ' h.'); }
      } catch (e) {
        if (e.stopStatus) addBlock(HOST, e.stopStatus, PATH);
        warn('MET Norway tafmetar not read (' + e.message + ')' + (e.stopStatus ? '; stop note written, no request for ' + BLOCK_HOURS + ' h' : '; the next hourly turn tries again') + '. Reading the AWC cache files instead.');
      }
    }
  }
  if (!got) {
    if (blockOf(AWC_HOST)) warn(blockedSay(blockOf(AWC_HOST)) + '. Nothing fetched' + (due ? '.' : '; MET Norway is read at its next hourly turn.'));
    else {
      try {
        const a = await fetchAwc();
        got = { src: 'awc', input: parseAwcMetars(a.csv, wanted).concat(parseAwcTafs(a.xml, wanted)), failed: a.failed, lastModified: null, bytes: a.bytes };
        st.lastAwc = nowIso;
        if (a.stopStatus) { addBlock(AWC_HOST, a.stopStatus, AWC_PATH); warn(AWC_HOST + ' answered HTTP ' + a.stopStatus + ' — the file read before it is stored; stop note written, no request for ' + BLOCK_HOURS + ' h.'); }
      } catch (e) {
        if (e.stopStatus) addBlock(AWC_HOST, e.stopStatus, AWC_PATH);
        warn('AWC cache files not read (' + e.message + ') — nothing written' + (e.stopStatus ? '; stop note written, no request for ' + BLOCK_HOURS + ' h.' : '; the next run will try again.'));
      }
    }
  }
  const fetchedAt = new Date().toISOString();
  if (!got) {
    // Nothing read: checkedAt stays the last run that read something (the pages show it); the try is kept for the hourly rule.
    if (fs.existsSync(ROOT) || st.lastMetNorwayTry !== prev.lastMetNorwayTry) {
      fs.mkdirSync(ROOT, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(Object.assign({}, prev, st, { lastRunAt: nowIso, lastRunRead: false }), null, 1) + '\n');
    }
    return;
  }
  // The answer covers 24 hours (AWC: the newest report), so it can touch today, yesterday and (a TAF just before
  // midnight) the day before.
  const texts = {}, stored = new Set(), undecodable = [];
  for (let back = 0; back < 3; back++) {
    const p = dayOf(new Date(Date.parse(nowIso) - back * 86400000).toISOString()), rel = p.dir + '/' + p.file;
    texts[rel] = readDayText(path.join(ROOT, rel));
    if (texts[rel] == null) { undecodable.push(rel); continue; }
    keysOfText(texts[rel]).forEach(k => stored.add(k));
  }
  const pl = plan(got.input, nowIso, wanted, stored, got.src);
  let added = 0, touched = 0;
  Object.keys(pl.add).sort().forEach(rel => {
    const file = path.join(ROOT, rel), before = rel in texts ? texts[rel] : readDayText(file);
    if (before == null) {
      if (undecodable.indexOf(rel) < 0) undecodable.push(rel);
      warn(rel + ' exists but does not decode — kept as it is, ' + pl.add[rel].length + ' new report(s) for that day not stored.');
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, zlib.gzipSync(Buffer.from(before + pl.add[rel].map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8'), { level: 9 }));
    added += pl.add[rel].length; touched++;
  });
  const old = expired(listDayFiles(ROOT), nowIso, KEEP_DAYS);
  old.forEach(rel => fs.rmSync(path.join(ROOT, rel), { force: true }));
  if (got.failed.length) warn(got.failed.length + (got.src === 'metno' ? ' batch(es)' : ' file(s)') + ' not read: ' + got.failed.join('; '));
  const missing = icaos.filter(i => !pl.icaos.has(i));
  // latest.json.gz from the three day files as they are now (the ones that decode) plus what this run added
  const recs = [];
  Object.keys(texts).forEach(rel => { if (texts[rel] != null) linesOf(texts[rel]).forEach(r => recs.push(r)); });
  Object.keys(pl.add).forEach(rel => pl.add[rel].forEach(r => recs.push(r)));
  const lt = latestOf(recs, icaos, fetchedAt, got.src), ltBuf = zlib.gzipSync(Buffer.from(JSON.stringify(lt), 'utf8'), { level: 9 });
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'latest.json.gz'), ltBuf);
  fs.writeFileSync(stateFile, JSON.stringify(Object.assign({ checkedAt: nowIso, source: got.src, sourceName: SRC[got.src] }, st, {
    lastModified: got.lastModified, downloadBytes: got.bytes, airports: icaos.length, lines: pl.parsed, added, missing: missing.length,
    failedBatches: got.failed, dropped: old, undecodable, latest: { generatedAt: fetchedAt, bytes: ltBuf.length, airports: Object.keys(lt.ap).length } }), null, 1) + '\n');
  console.log('capture-wx-reports: ' + pl.parsed + ' report(s) read, ' + added + ' new, ' + touched +
    ' day file(s) touched, ' + missing.length + ' of ' + icaos.length + ' airport(s) without a report' + (old.length ? ', ' + old.length + ' old day file(s) dropped' : '') +
    '; source ' + SRC[got.src] + ' (' + Math.round(got.bytes / 1024) + ' KB); latest.json.gz ' + Math.round(ltBuf.length / 1024) + ' KB.');
}

// --check: the workflow's last step. Red while a stop note is in force or a day file did not decode, so either is noticed.
function check() {
  const nowIso = new Date().toISOString(), act = activeBlocks(readJson(BLOCKED_FILE(), null), nowIso), st = readJson(path.join(ROOT, 'state.json'), {});
  const P = act.map(b => b.host + ' answered HTTP ' + b.status + ' at ' + String(b.at).slice(0, 16) + 'Z — stop note in force until ' + String(b.until).slice(0, 16) +
    'Z (archive/blocked.json on the data branch; delete the entry to ask again earlier)');
  ((st && st.undecodable) || []).forEach(rel => P.push('day file ' + rel + ' does not decode — kept unchanged, its new reports were not stored; repair or delete it on the data branch'));
  P.forEach(p => console.log('::error title=WX capture::' + p));
  if (!P.length) console.log('capture-wx-reports: no stop note in force, every day file decoded.');
  return P.length ? 1 : 0;
}
// --verify-publish <restored list> <archive dir>: the list is `git ls-tree` of the data branch's archive/ (paths relative to it).
function verifyPublish(listFile, dir) {
  let restored = [];
  try { restored = fs.readFileSync(listFile, 'utf8').split('\n').map(l => l.trim()).filter(Boolean); }
  catch (e) { console.log('::error title=WX capture::restored list ' + listFile + ' not readable — nothing published'); return 1; }
  const P = publishProblems(restored, listDayFiles(dir), new Date().toISOString(), KEEP_DAYS);
  P.forEach(p => console.log('::error title=WX capture::' + p + ' — nothing published, the data branch stays as it was'));
  if (!P.length) console.log('capture-wx-reports: ' + listDayFiles(dir).length + ' day file(s) to publish, every restored day file still there (or expired).');
  return P.length ? 1 : 0;
}

module.exports = { URL, AWC_METARS, AWC_TAFS, UA, KEEP_DAYS, BLOCK_HOURS, BATCH, METNO_EVERY_MIN, LATEST_METARS, resolveTime, splitReport, parseLine, keyOf, crossKeyOf, storedKeysOf, dayOf, plan,
  csvRows, parseAwcMetars, parseAwcTafs, metNorwayDue, tafValidity, tafsInForce, latestOf, expired, publishProblems, activeBlocks, blockEntry, readDayText, listDayFiles };
if (require.main === module) {
  const a = process.argv.slice(2);
  if (a[0] === '--check') process.exit(check());
  else if (a[0] === '--verify-publish') process.exit(verifyPublish(a[1], a[2]));
  else main().catch(e => { warn('unexpected error: ' + ((e && e.message) || e)); process.exitCode = 0; });
}
