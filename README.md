# Ticket watcher for Budapest Parliament Ticket Alerts

Checks [jegymester.hu](https://jegymester.hu/production/480000/hungarian-parliament-building-parliament-visit)
for returned Hungarian Parliament visit tickets on the dates people are waiting for, and reports what it sees to
[budapestparliamentticketalerts.com](https://budapestparliamentticketalerts.com), which emails the people waiting.

- `watch.js` opens the ticket page in a headless browser like a normal visitor and checks at most 25 dates every
  3 minutes. Runs chain themselves (about 50 minutes each); a 30-minute cron restarts the chain if it stops.
  Set the repository variable `WATCHER_PAUSED` to `true` to stop.
- `bing-fetch.mjs` passes Bing Webmaster numbers to the site's dashboard at the start of each run (about hourly).

Needs the repository secret `WATCHER_TOKEN` (shared with the site) and the variable `SITE_URL`.
Independent; not affiliated with the Hungarian Parliament or jegymester.hu.
