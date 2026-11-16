// The single shared watcher for Budapest Parliament Ticket Alerts. It asks the site which
// dates people are waiting for, checks them on jegymester.hu the way a normal visitor would
// (open the page, pick each date in the calendar, read what the page shows), and reports
// back. The site decides who to email.
const { chromium } = require('playwright');

const PAGE = 'https://jegymester.hu/production/480000/hungarian-parliament-building-parliament-visit';
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 0);   // 0 = check once
const INTERVAL_SECONDS = Number(process.env.INTERVAL_SECONDS || 180);
const { HTTPS_PROXY, WATCHER_TOKEN } = process.env;
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const budapestTime = ms => new Date(ms).toLocaleString('en-GB', { timeZone: 'Europe/Budapest', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

async function site(path, body) {
  const r = await fetch(SITE_URL + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${WATCHER_TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),   // never wait forever on the site
  });
  if (!r.ok) throw new Error(`site ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// Midnight in Budapest for a 'YYYY-MM-DD' day, as epoch ms (the ?date= jegymester's page uses).
function budapestMidnight(iso) {
  for (const off of ['+01:00', '+02:00']) {
    const ms = Date.parse(`${iso}T00:00:00${off}`);
    if (new Date(ms).toLocaleString('sv-SE', { timeZone: 'Europe/Budapest' }).startsWith(`${iso} 00:00`)) return ms;
  }
  return Date.parse(`${iso}T00:00:00+01:00`);
}
const budapestDay = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Europe/Budapest' });

// jegymester's calendar only lets you click days that still have tickets, so a sold-out day
// looks exactly like a day without visits. So: click any day the calendar allows, and let the
// page's own events request ask for the day we want (?date=, as the page itself used to ask).
// That answer lists sold-out slots too. Returns the events the page loaded for that day.
async function loadDay(page, iso, ask, onlyMarketable) {
  ask(iso, onlyMarketable);
  const picker = page.locator('bs-datepicker-container, .bs-datepicker').first();
  const resp = page.waitForResponse(r => r.url().includes('/rest/production/480000/events') && r.status() === 200, { timeout: 30000 });
  resp.catch(() => {});
  let clicked = false;
  try {
    if (!(await picker.isVisible())) await page.locator('input.form-control[readonly]').first().click();
    await picker.waitFor({ timeout: 15000 });
    const day = picker.locator('td[role=gridcell] span:not(.disabled):not(.is-other-month):not(.selected)').first();
    if (await day.count()) { await day.click(); clicked = true; }
  } catch {}
  // No day to click (nothing on sale at all): reloading the page makes the same request.
  if (!clicked) await page.reload({ waitUntil: 'commit', timeout: 60000 });
  const body = await (await resp).json();
  await sleep(500);
  return body;
}

async function eventsForDate(page, iso, ask) {
  const body = await loadDay(page, iso, ask, false);
  const events = (body.events || []).filter(e => budapestDay(e.startDate) === iso);
  // An 'available' slot is not always one a visitor can buy (a user clicked straight through and found nothing).
  // Ask the page's public list too and log the difference, to learn whether alerts should rely on it.
  if (events.some(e => e.status === 'available')) {
    try {
      const pub = new Set(((await loadDay(page, iso, ask, true)).events || []).map(e => e.id));
      for (const e of events) if (e.status === 'available') e.public = pub.has(e.id);
    } catch (err) { console.log(iso, 'public list check failed:', err.message); }
    // An empty public answer hides the date picker; reload so the next date can use it again.
    ask(iso, false);
    await page.reload({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  }
  // Past the last day jegymester sells for: not on sale yet, which is not the same as no visits.
  if (!events.length && Number(body.maxDate) && budapestMidnight(iso) > Number(body.maxDate)) return { events, notOnSale: true, note: 'not on sale yet' };
  return { events, ...(events.length ? {} : { note: 'no visits that day' }) };
}

async function checkOnce(browser, dates) {
  const ctx = await browser.newContext({ locale: 'en-US', timezoneId: 'Europe/Budapest', serviceWorkers: 'block', viewport: { width: 1280, height: 1400 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  // A stuck page must never stall the watcher: give up on this round after 8 minutes.
  let timer;
  const stuck = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('check took over 8 minutes, giving up on this round')), 5 * 60000); });
  try {
    return await Promise.race([stuck, checkDates(page, dates)]);
  } finally { clearTimeout(timer); await Promise.race([ctx.close(), sleep(10000)]).catch(() => {}); }
}

async function checkDates(page, dates) {
  {
    let wanted = null, marketable = false;
    await page.route('**/rest/production/480000/events*', route => {
      if (!wanted) return route.continue();
      const url = new URL(route.request().url());
      url.search = `?date=${budapestMidnight(wanted)}${marketable ? '&onlyMarketable=true' : ''}`;
      return route.continue({ url: url.toString() });
    });
    await page.goto(PAGE, { waitUntil: 'networkidle', timeout: 90000 });
    const out = {};
    let errors = 0;
    for (const iso of dates) {
      if (page.isClosed()) break;
      try { out[iso] = await eventsForDate(page, iso, (d, m) => { wanted = d; marketable = m; }); }
      catch (err) { errors++; console.log(iso, 'skipped:', err.message); }
      await page.keyboard.press('Escape').catch(() => {});
    }
    if (dates.length && errors === dates.length) throw new Error('every date failed to load');
    return out;
  }
}

async function main() {
  if (!SITE_URL || !WATCHER_TOKEN) throw new Error('SITE_URL and WATCHER_TOKEN must be set');
  // Last line of defence: whatever hangs, stop a few minutes after the planned end so the
  // workflow can start the next run instead of being cancelled by GitHub's job timeout.
  setTimeout(() => { console.log('watchdog: run went past its time, exiting'); process.exit(0); }, (RUN_MINUTES + 4) * 60000).unref();
  const browser = await chromium.launch({
    ...(HTTPS_PROXY ? { proxy: { server: HTTPS_PROXY } } : {}),
    args: HTTPS_PROXY ? ['--ignore-certificate-errors'] : [],
  });
  const end = Date.now() + RUN_MINUTES * 60000;
  let ok = 0, failed = 0;
  try {
    do {
      try {
        let dates;
        try { ({ dates } = await site('/api/watcher/watchlist')); }
        catch (err) { console.log(new Date().toISOString(), 'site not reachable (not deployed yet?):', err.message); dates = null; }
        if (!dates) { if (Date.now() + INTERVAL_SECONDS * 1000 > end) break; await sleep(INTERVAL_SECONDS * 1000); continue; }
        // With nothing to watch, still report in (the site shows when it was last checked).
        const result = dates.length ? await checkOnce(browser, dates) : {};
        if (!dates.length) console.log(new Date().toISOString(), 'nobody is waiting for a date right now');
        for (const [iso, r] of Object.entries(result)) {
          console.log(new Date().toISOString(), iso, r.note || r.events.map(e => `${budapestTime(e.startDate)} ${e.status}${'public' in e ? (e.public ? ' (public)' : ' (NOT in public list)') : ''}`).join(' | ') || 'no events');
        }
        let r = await site('/api/watcher/report', { results: result });
        console.log(`site: ${r.opened} slot(s) opened, ${r.queued} alert email(s) queued, ${r.sent} sent, ${r.remaining} waiting`);
        for (let i = 0; i < 20 && r.remaining > 0 && r.sent > 0; i++) r = await site('/api/watcher/flush', {});
        ok++;
      } catch (err) {
        failed++;
        console.log(new Date().toISOString(), 'check failed:', err.message);
      }
      if (Date.now() + INTERVAL_SECONDS * 1000 > end) break;
      await sleep(INTERVAL_SECONDS * 1000);
    } while (true);
  } finally { await Promise.race([browser.close(), sleep(15000)]).catch(() => {}); }
  // Fail the run when every check of jegymester failed, so it shows up red on GitHub.
  if (!ok && failed) process.exit(1);
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
