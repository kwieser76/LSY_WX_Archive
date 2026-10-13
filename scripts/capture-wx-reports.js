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
// Node 20, no dependencies), hourly. airports.json there is a neutral list: every large airport with
// scheduled service in Europe, North America and the Middle East (OurAirports, public domain). The
// master copy lives in the briefing project, scripts/capture-wx-reports.js; tools/wx-archive/README.md
// says how it is installed. (2026-10-12: a private repo with a shorter list, every 30 minutes, came first.)
//
//   node scripts/capture-wx-reports.js                writes <repo>/archive/...
//   WX_ARCHIVE_DIR=/some/dir WX_AIRPORTS=/x/airports.json node scripts/capture-wx-reports.js
//
// Layout (the workflow publishes it as ONE orphan commit on the branch "data", so git history never grows):
//   archive/YYYY/MM/DD.ndjson.gz  one line per report, filed by the UTC day of the report's own time:
//                                 {"icao","kind":"METAR|SPECI|TAF","marks":["AMD","COR","AUTO","RTD"],
//                                  "time":"YYYY-MM-DDTHH:MMZ","raw","seen"}
//   archive/state.json            { checkedAt, lastModified, lines, added, missing, undecodable }
//   archive/blocked.json          the stop note: { blocked: [{ host, status, at, until, path }] } after HTTP 403/429
// Day files older than KEEP_DAYS are dropped: the weekly reader takes its week each Monday.
// A report is stored once: the key is ICAO + kind + marks + raw text. `seen` is when this capture first
// saw it. A transient error is a GitHub warning and the job still ends with exit 0, so one bad run never
// turns the workflow red; a gap shows up in the weekly report as a gap.
// Review 2026-10-13, three things DO turn it red (the workflow's last step, --check), after the publish:
//   - a 403 or 429: the stop note is written, and every run of the next BLOCK_HOURS skips MET Norway
//     (project rule: no further request to a host that refused us). Until then the next hourly run asked again.
//   - a day file that exists but does not decode: it is kept as it is (never rewritten with only the new
//     reports, which would drop the day's earlier ones) and named in state.undecodable.
//   - (in the workflow, --verify-publish) a restored day file missing before the force-push: nothing is published.
//
//   node scripts/capture-wx-reports.js --check                          exit 1 while a stop note is active or a day is undecodable
//   node scripts/capture-wx-reports.js --verify-publish <list> <dir>    exit 1 when a restored, unexpired day file is missing
//
// Data from MET Norway (CC BY 4.0 / NLOD 2.0): https://api.met.no/doc/License. MET Norway asks for an
// identifying User-Agent with a contact; this one names the GitHub account, nothing about a person.
// ---------------------------------------------------------------------------
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const URL = 'https://api.met.no/weatherapi/tafmetar/1.0/tafmetar.txt';
const UA = 'LSY-WX-archive/1.0 github.com/kwieser76';
const REPO = path.resolve(__dirname, '..');
const ROOT = process.env.WX_ARCHIVE_DIR ? path.resolve(process.env.WX_ARCHIVE_DIR) : path.join(REPO, 'archive');
const AIRPORTS = process.env.WX_AIRPORTS ? path.resolve(process.env.WX_AIRPORTS) : path.join(REPO, 'airports.json');
const MARKS = new Set(['AMD', 'COR', 'SPECI', 'AUTO', 'RTD']);
const KEEP_DAYS = 21;
const BLOCK_HOURS = 24;

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
// One line of the extended answer → a report, or null for anything else (blank line, NIL, a line that
// does not start with a known airport). The markers in front are MET Norway's: it moves AUTO out of
// the report body, so the raw text is kept exactly as served and the markers travel beside it.
function parseLine(line, nowIso, wanted) {
  const toks = String(line || '').trim().split(/\s+/).filter(Boolean);
  const marks = [];
  while (toks.length && MARKS.has(toks[0])) marks.push(toks.shift());
  if (toks.length < 3 || !/^[A-Z0-9]{4}$/.test(toks[0]) || !/^\d{6}Z$/.test(toks[1])) return null;
  const icao = toks[0];
  if (wanted && !wanted.has(icao)) return null;
  if (/^NIL=?$/.test(toks[2])) return null;
  const time = resolveTime(toks[1], nowIso);
  if (!time) return null;
  const isTaf = /^\d{4}\/\d{4}$/.test(toks[2]);
  const kind = isTaf ? 'TAF' : (marks.indexOf('SPECI') >= 0 ? 'SPECI' : 'METAR');
  return { icao, kind, marks: marks.filter(x => x !== 'SPECI'), time, raw: toks.join(' ') };
}
const keyOf = r => [r.icao, r.kind, r.marks.join('+'), r.raw].join('|');
const dayOf = time => ({ dir: time.slice(0, 4) + '/' + time.slice(5, 7), file: time.slice(8, 10) + '.ndjson.gz' });

// Which lines are new, given the keys already stored. Returns the reports to append, grouped by day file.
function plan(text, nowIso, wanted, storedKeys) {
  const add = {}, seen = new Set();
  let parsed = 0;
  String(text || '').split(/\r?\n/).forEach(line => {
    const r = parseLine(line, nowIso, wanted);
    if (!r) return;
    parsed++;
    const k = keyOf(r);
    if (seen.has(k) || (storedKeys && storedKeys.has(k))) return;
    seen.add(k);
    const p = dayOf(r.time), rel = p.dir + '/' + p.file;
    (add[rel] = add[rel] || []).push(Object.assign(r, { seen: nowIso.slice(0, 16) + 'Z' }));
  });
  return { parsed, add };
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
function keysOfText(text) {
  const keys = new Set();
  text.split('\n').forEach(l => { if (l.trim()) { try { keys.add(keyOf(JSON.parse(l))); } catch (e) { /* a damaged line is skipped */ } } });
  return keys;
}
function listDayFiles(root) {
  const out = [];
  try {
    fs.readdirSync(root).filter(y => /^\d{4}$/.test(y)).forEach(y => fs.readdirSync(path.join(root, y)).filter(m => /^\d{2}$/.test(m))
      .forEach(m => fs.readdirSync(path.join(root, y, m)).filter(f => /^\d{2}\.ndjson\.gz$/.test(f)).forEach(f => out.push(y + '/' + m + '/' + f))));
  } catch (e) { /* no archive yet */ }
  return out.sort();
}

// Batches of BATCH airports, PAUSE_MS apart: one request with all ~530 airports (~8 MB) ended in HTTP 502
// (2026-10-12); 54 airports per request always answered. A 403 or 429 stops the whole run (leave the host
// alone, project rule: the batches read so far are kept, a stop note is written); a server error or timeout
// skips only that batch, after one more try.
const BATCH = 60, PAUSE_MS = 2000;
async function fetchBatch(icaos) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 10000));
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 60000);
    try {
      const res = await fetch(URL + '?icao=' + icaos.join(',') + '&extended=true', { signal: ac.signal, headers: { 'User-Agent': UA, Accept: 'text/plain' } });
      if (res.status === 403 || res.status === 429) { const e = new Error('HTTP ' + res.status); e.stop = true; e.status = res.status; throw e; }
      if (!res.ok) { last = 'HTTP ' + res.status; if (res.status >= 400 && res.status < 500) break; continue; }
      return { text: await res.text(), lastModified: res.headers.get('last-modified') || null };
    } catch (e) { if (e.stop) throw e; last = e && e.name === 'AbortError' ? 'timeout after 60 s' : String((e && e.message) || e); }
    finally { clearTimeout(t); }
  }
  throw new Error(last || 'unknown error');
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

const HOST = 'api.met.no', PATH = '/weatherapi/tafmetar/1.0/tafmetar.txt';   // of URL (the name shadows the global URL class)
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
  const note = readJson(BLOCKED_FILE(), null), active = activeBlocks(note, nowIso).filter(b => b.host === HOST);
  if (active.length) {
    warn(HOST + ' answered HTTP ' + active[0].status + ' at ' + active[0].at.slice(0, 16) + 'Z — not asked until ' + active[0].until.slice(0, 16) +
      'Z (stop note archive/blocked.json). Nothing fetched.');
    return;
  }
  let ans;
  try { ans = await fetchReports(icaos); }
  catch (e) {
    if (e.stopStatus) writeBlocked(activeBlocks(note, nowIso).concat([blockEntry(HOST, e.stopStatus, PATH, nowIso)]));
    warn('MET Norway tafmetar not read (' + e.message + ') — nothing written' + (e.stopStatus ? '; stop note written, no request for ' + BLOCK_HOURS + ' h.' : '; the next run will try again.'));
    return;
  }
  if (ans.stopStatus) {
    writeBlocked(activeBlocks(note, nowIso).concat([blockEntry(HOST, ans.stopStatus, PATH, nowIso)]));
    warn(HOST + ' answered HTTP ' + ans.stopStatus + ' — the batches read before it are stored; stop note written, no request for ' + BLOCK_HOURS + ' h.');
  }
  const wanted = new Set(icaos);
  // The answer covers 24 hours, so it can touch today, yesterday and (a TAF just before midnight) the day before.
  const texts = {}, stored = new Set(), undecodable = [];
  for (let back = 0; back < 3; back++) {
    const p = dayOf(new Date(Date.parse(nowIso) - back * 86400000).toISOString()), rel = p.dir + '/' + p.file;
    texts[rel] = readDayText(path.join(ROOT, rel));
    if (texts[rel] == null) { undecodable.push(rel); continue; }
    keysOfText(texts[rel]).forEach(k => stored.add(k));
  }
  const pl = plan(ans.text, nowIso, wanted, stored);
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
  if (ans.failed.length) warn(ans.failed.length + ' batch(es) not read: ' + ans.failed.join('; '));
  const missing = icaos.filter(i => !ans.text.includes(i + ' '));
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'state.json'), JSON.stringify({ checkedAt: nowIso, lastModified: ans.lastModified,
    airports: icaos.length, lines: pl.parsed, added, missing: missing.length, failedBatches: ans.failed, dropped: old, undecodable }, null, 1) + '\n');
  console.log('capture-wx-reports: ' + pl.parsed + ' report(s) read, ' + added + ' new, ' + touched +
    ' day file(s) touched, ' + missing.length + ' of ' + icaos.length + ' airport(s) without a report' + (old.length ? ', ' + old.length + ' old day file(s) dropped' : '') + '.');
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

module.exports = { URL, UA, KEEP_DAYS, BLOCK_HOURS, BATCH, resolveTime, parseLine, keyOf, dayOf, plan, expired, publishProblems, activeBlocks, blockEntry, readDayText, listDayFiles };
if (require.main === module) {
  const a = process.argv.slice(2);
  if (a[0] === '--check') process.exit(check());
  else if (a[0] === '--verify-publish') process.exit(verifyPublish(a[1], a[2]));
  else main().catch(e => { warn('unexpected error: ' + ((e && e.message) || e)); process.exitCode = 0; });
}
