# LSY_WX_Archive

Every METAR, SPECI and TAF, including TAF amendments (AMD), corrections (COR) and delayed reports (RTD),
of the airports in `airports.json`, captured every 10 minutes by GitHub Actions and kept for 21 days.

- **Airports:** every large airport with scheduled service in Europe, North America and the Middle East,
  as typed by [OurAirports](https://ourairports.com/data/) (public domain). Built by `build-airports.js`.
- **Sources:** once an hour MET Norway `tafmetar` (`extended=true`), which returns every report of the last
  24 hours. **Data from MET Norway**, licence [CC BY 4.0 / NLOD 2.0](https://api.met.no/doc/License).
  The runs in between read the whole-world cache files of the **NOAA/NWS Aviation Weather Center**
  (`metars.cache.csv.gz`, `tafs.cache.xml.gz`; US Government work, public domain;
  [aviationweather.gov/data/api](https://aviationweather.gov/data/api/)), the newest METAR, SPECI and TAF of each
  station. `src` in each line says which (`metno` or `awc`; no `src` = `metno`). A report that both serve is
  stored once; `raw` is the text as that source served it.
  The reports themselves are issued by each state's aviation weather service.
- **Not for operational use.** A research archive; reports can be missing or late.
- **Where:** branch `data`, `archive/YYYY/MM/DD.ndjson.gz` (one JSON line per report, UTC day of the report's
  own time), `archive/latest.json.gz` (per airport the last 3 METAR/SPECI and the TAFs in force, with
  `generatedAt` and the source of each entry) and `archive/state.json` (last run, its source). The branch is
  replaced on every run (one commit).
- **Stop note:** when a source answers HTTP 403 or 429, `archive/blocked.json` records the host, the next runs send
  it no request for 24 hours (the other source goes on), and the run shows as failed so it is noticed.
- **KEEPALIVE:** a commit to `main` about once a month, so GitHub keeps the schedule switched on.

One line: `{"icao":"ESGG","kind":"TAF","marks":["AMD"],"time":"2026-10-12T10:55Z","raw":"ESGG 121055Z 1212/1318 ...","seen":"2026-10-12T11:17Z","src":"metno"}`

`latest.json.gz`: `{"v":1,"generatedAt":"...","source":"awc","ap":{"ESGG":{"m":[[time, kind, marks, raw, src], ...],"t":[[time, marks, raw, src, validFrom, validTo]]}},"missing":[...]}`
