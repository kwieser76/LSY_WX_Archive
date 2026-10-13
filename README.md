# LSY_WX_Archive

Every METAR, SPECI and TAF, including TAF amendments (AMD), corrections (COR) and delayed reports (RTD),
of the airports in `airports.json`, captured every hour by GitHub Actions and kept for 21 days.

- **Airports:** every large airport with scheduled service in Europe, North America and the Middle East,
  as typed by [OurAirports](https://ourairports.com/data/) (public domain). Built by `build-airports.js`.
- **Source:** MET Norway `tafmetar` (`extended=true`), which returns every report of the last 24 hours.
  **Data from MET Norway**, licence [CC BY 4.0 / NLOD 2.0](https://api.met.no/doc/License).
  The reports themselves are issued by each state's aviation weather service.
- **Not for operational use.** A research archive; reports can be missing or late.
- **Where:** branch `data`, `archive/YYYY/MM/DD.ndjson.gz` (one JSON line per report, UTC day of the report's
  own time) and `archive/state.json` (last run). The branch is replaced on every run (one commit).
- **Stop note:** when MET Norway answers HTTP 403 or 429, `archive/blocked.json` records it, the next runs send no
  request for 24 hours, and the run shows as failed so it is noticed.
- **KEEPALIVE:** a commit to `main` about once a month, so GitHub keeps the hourly schedule switched on.

One line: `{"icao":"ESGG","kind":"TAF","marks":["AMD"],"time":"2026-10-12T10:55Z","raw":"ESGG 121055Z 1212/1318 ...","seen":"2026-10-12T11:17Z"}`
