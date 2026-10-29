// Motus Playwright service — non-API approach to Motus insurance history.
// Why: Motus public pages are a client-side app (no login, no CAPTCHA on the public
// snapshot). A server-side HTML fetch returns an empty shell, and its background API
// was not exposed in browser views. A real headless browser loads the page, waits for
// the Insurance Details table, clicks "Include History", and reads the rows.
// Flow per DOT:
//   1. GET /insurance?dot=3475651
//   2. If a cached result for that DOT is younger than 24h, return it (no new browser run).
//   3. Else launch Chromium (Playwright), open https://motus.dot.gov/customer/<DOT>/account,
//      wait for the Operating Authority Registrations list, open the Motor Carrier of
//      Property authority detail, wait for the INSURANCE DETAILS tab, click
//      "Include History" if it is off, read the table rows, close the browser.
//   4. Return JSON: { dot, motusUrl, insuranceHistory: [...], cached: false, fetchedAt }
// Rate limits: one browser run at a time (a simple queue), max 1 run per DOT per 24h
// from cache, and a 120s overall timeout. This is public data only — no sign-in, no
// CAPTCHA solving, no bypass of any gate. If Motus blocks the run, return an error
// JSON with motusUrl instead of inventing rows.
// Deploy: see Dockerfile and render.yaml. Requires: npm install, then `node server.js`
// (PORT env, default 3000). The Fifty Bridges site should call this service, NOT
// Vercel, for Motus insurance — Vercel Hobby cannot wait for Motus (up to ~60s).
const express = require('express');
const { chromium } = require('playwright');
const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map(); // dot -> { fetchedAt, data }
let queue = Promise.resolve();
function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function parseAmount(text) {
  const n = parseFloat(String(text || '').replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : Math.round(n);
}
async function fetchMotus(dot) {
  const motusUrl = `https://motus.dot.gov/customer/${dot}/account`;
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(120000);
    await page.goto(motusUrl, { waitUntil: 'domcontentloaded' });
    // Wait for the authority list to populate (Motus is slow: up to ~60s).
    await page.waitForSelector('a', { timeout: 120000 });
    // Click the Motor Carrier of Property authority link, if present.
    const authLink = page.locator('a', { hasText: 'Motor Carrier of Property' }).first();
    if (await authLink.count()) await authLink.click();
    // Wait for the Insurance Details tab/table.
    await page.waitForTimeout(5000);
    const includeHistory = page.locator('text=Include History').first();
    // The toggle is a checkbox/switch near that label; try clicking it if it is off.
    try {
      const toggle = page.locator('input[type="checkbox"]').first();
      if (await toggle.count() && !(await toggle.isChecked().catch(() => false))) {
        await toggle.click({ timeout: 10000 });
        await page.waitForTimeout(3000);
      }
    } catch (e) { /* toggle may be a custom switch; table may already include history */ }
    // Read every row of the Insurance Details table.
    const rows = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('table tbody tr').forEach((tr) => {
        const cells = Array.from(tr.querySelectorAll('td')).map((td) => td.innerText.trim().replace(/\s+/g, ' '));
        if (cells.length >= 8) out.push(cells);
      });
      return out;
    });
    const insuranceHistory = rows.map((c) => ({
      insurer: clean(c[0]),
      policyNumber: clean(c[1]),
      form: clean(c[2]),
      amount: parseAmount(c[3]),
      status: clean(c[4]),
      receivedDate: clean(c[5]),
      effectiveDate: clean(c[6]),
      cancellationDate: clean(c[7]) || null,
    })).filter((r) => r.policyNumber);
    return { dot, motusUrl, insuranceHistory, fetchedAt: new Date().toISOString() };
  } finally {
    await browser.close().catch(() => {});
  }
}
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/insurance', (req, res) => {
  const dot = String(req.query.dot || '').replace(/[^0-9]/g, '').slice(0, 10);
  if (!dot) return res.status(400).json({ error: 'bad_dot', message: 'Enter a numeric US DOT number.' });
  const hit = cache.get(dot);
  if (hit && Date.now() - hit.fetchedAtMs < CACHE_TTL_MS) {
    return res.json({ ...hit.data, cached: true });
  }
  // Serialize runs: one browser at a time, so Motus is never hammered.
  queue = queue.then(async () => {
    try {
      const data = await fetchMotus(dot);
      cache.set(dot, { fetchedAtMs: Date.now(), data });
      res.json({ ...data, cached: false });
    } catch (e) {
      res.status(502).json({
        error: 'motus_error',
        dot,
        motusUrl: `https://motus.dot.gov/customer/${dot}/account`,
        message: 'Could not load the Motus public snapshot right now. Open the Motus link directly and check Insurance Details with Include History on.',
      });
    }
  });
  return queue;
});
app.listen(PORT, () => console.log(`Motus Playwright service listening on ${PORT}`));
