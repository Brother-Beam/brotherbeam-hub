// The weekly email: every Sunday at 6:00 PM Mountain, a summary of the week in the hub
// goes to the three founders. What is new, meetings logged, files added to the Library,
// board posts, where the roadmap stands, and the state of the suggestions queue.
//
// How it runs
//   Two Vercel Cron slots call this each week (vercel.json), an hour apart, because cron
//   only speaks UTC and Mountain time shifts with daylight saving. This function checks
//   Mountain time itself and sends in the 6 PM hour, so the email arrives at 6 PM all
//   year. Before sending it claims the week in the store, so two runs can never both
//   send; if a send fails the claim is released and the next slot tries again.
//
// Sending itself lives in _lib/mail.js, shared with the suggestion alerts in feedback.js.
//
// Setting it up: two Vercel environment variables
//   DIGEST_TO            who gets it, comma-separated, Mike first. The first address is
//                        also the Gmail account it is sent from, and where tests go.
//                        Kept here, not in the repo, because the repo is public.
//   GMAIL_APP_PASSWORD   a Google "app password" for that first address. It lets the hub
//                        send as that account and nothing else.
//   Optional
//   GMAIL_USER           send from a different Gmail account than the first recipient.
//   RESEND_API_KEY + DIGEST_FROM   send through Resend from a verified domain instead of Gmail.
//   CRON_SECRET          turns on strict mode (below) and allows force-sends.
//
// What you can call
//   /api/digest?status=1                 open. Is it set up, when did it last send. No secrets, no addresses.
//   /api/digest?preview=1&pw=...         the email as it would look right now. Sends nothing.
//       &format=text | &format=json      the plain-text version, or just the subject and counts
//   /api/digest?dry=1&pw=...&now=ISO     would the scheduler send at that moment? Sends nothing.
//   /api/digest?test=1&pw=...            send it now to the FIRST address in DIGEST_TO only (at most
//                                        once every 10 minutes; no limit with the secret)
//   /api/digest                          the scheduled run (what cron calls)
//   /api/digest?force=1 + the secret     send it now to everyone, whatever the day
//
// Why the scheduled run needs no secret by default
//   It only ever does one thing: send this week's email, once, and only inside the Sunday
//   6-8 PM Mountain window. Calling it at any other time does nothing, and calling it
//   inside the window just sends the email that was about to go anyway. So there is
//   nothing for a stranger to abuse. Setting CRON_SECRET makes it strict regardless: the
//   scheduled run then needs the secret too (Vercel Cron sends it automatically as
//   "Authorization: Bearer ..."). Sending to everyone on demand (force) always needs it.
import { timingSafeEqual } from 'node:crypto';
import { compose, decide, localParts, SCHEDULE_TEXT, TZ } from './_lib/logic.js';
import { provider, recipients, mailReady, sendMail, short, redact } from './_lib/mail.js';
import { kvGet, kvUpdate, storeReady } from './_lib/store.js';
import { gatherWeek } from './_lib/week.js';

export const config = { maxDuration: 60 };

const STATE = 'beam-digest-state';
const HUB_PW = 'scooter';            // the Library's convenience lock; here it guards the preview and the test send
const TEST_GAP_MS = 10 * 60 * 1000;  // password-triggered tests: one every 10 minutes

function hasSecret() { return !!process.env.CRON_SECRET; }
function authorized(req) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return false;
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String((req.query && req.query.secret) || '');
  const a = Buffer.from(given), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function pad(n) { return (n < 10 ? '0' : '') + n; }

async function status(req, res, now) {
  const to = recipients();
  const which = provider();
  const missing = [];
  if (!to.length) missing.push('DIGEST_TO');
  if (!which) missing.push('GMAIL_APP_PASSWORD');
  let state = {}, storeOk = storeReady();
  if (storeOk) { try { state = (await kvGet(STATE)).value || {}; } catch (e) { storeOk = false; } }
  // Can the Gmail route's mail library be loaded here? Loads it, connects to nothing.
  let mailLibrary = false;
  try { const mod = await import('nodemailer'); mailLibrary = typeof (mod.default || mod).createTransport === 'function'; } catch (e) { mailLibrary = false; }
  const local = localParts(now, TZ);
  const full = authorized(req);   // error text can name an address, so it is only shown with the secret
  res.status(200).json({
    ready: missing.length === 0 && storeOk,
    schedule: SCHEDULE_TEXT,
    mountainTimeNow: local.weekday + ' ' + local.date + ' ' + pad(local.hour) + ':' + pad(local.minute),
    configured: { recipients: to.length, sendsWith: which, suggestionAlerts: mailReady(), strictMode: hasSecret(), store: storeOk, library: !!process.env.BLOB_READ_WRITE_TOKEN, mailLibrary: mailLibrary },
    missing: missing,
    lastSent: state.lastSent || null,
    lastSentAt: state.lastSentAt || null,
    lastRecipients: state.lastRecipients || null,
    lastError: state.lastError ? (full ? state.lastError : { at: state.lastError.at }) : null,
    lastTest: state.lastTest ? (full ? state.lastTest : { at: state.lastTest.at, ok: state.lastTest.ok }) : null,
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  const now = new Date();
  try {
    if (q.status === '1') { await status(req, res, now); return; }

    const pwOk = String(q.pw || '').toLowerCase() === HUB_PW;
    const secretOk = authorized(req);

    // Read-only views. They never send anything.
    if (q.preview === '1' || q.dry === '1') {
      if (!pwOk) { res.status(401).json({ error: 'unauthorized' }); return; }
      if (!storeReady()) { res.status(503).json({ error: 'the shared store is not set up' }); return; }
      if (q.dry === '1') {
        const at = q.now ? new Date(String(q.now)) : now;
        if (isNaN(at.getTime())) { res.status(400).json({ error: 'now must be a date like 2026-11-30T01:05:00Z' }); return; }
        const d = decide(at, (await kvGet(STATE)).value || {});
        res.status(200).json({ wouldSend: d.send, reason: d.reason, mountain: d.local, schedule: SCHEDULE_TEXT });
        return;
      }
      // &tests=1 also counts suggestions sent under a "(testing)" name, which real emails never do.
      const c = compose(await gatherWeek(), now.getTime(), { includeTests: q.tests === '1' });
      if (q.format === 'json') { res.status(200).json({ subject: c.subject, counts: c.counts }); return; }
      if (q.format === 'text') { res.setHeader('content-type', 'text/plain; charset=utf-8'); res.status(200).send(c.subject + '\n\n' + c.text); return; }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.status(200).send(c.html);
      return;
    }

    const isTest = q.test === '1', force = q.force === '1';

    // Who may do what. A test goes only to the first recipient, so the hub password is enough.
    // Sending to everyone on demand always needs the secret. The scheduled run needs it only
    // in strict mode; otherwise the Sunday-window and once-a-week checks below are the guard.
    if (isTest) { if (!secretOk && !pwOk) { res.status(401).json({ error: 'unauthorized' }); return; } }
    else if (force) { if (!secretOk) { res.status(401).json({ error: 'unauthorized: force needs CRON_SECRET' }); return; } }
    else if (hasSecret() && !secretOk) { res.status(401).json({ error: 'unauthorized' }); return; }

    if (!storeReady()) { res.status(503).json({ error: 'the shared store is not set up' }); return; }
    const to = recipients();
    const which = provider();
    if (!to.length || !which) { res.status(503).json({ error: 'email is not set up yet; see /api/digest?status=1 for what is missing' }); return; }

    if (isTest) {
      // Mark the attempt first, so a password-triggered test cannot be repeated in a burst.
      let tooSoon = false;
      await kvUpdate(STATE, function (s) {
        const cur = s || {};
        tooSoon = !secretOk && cur.lastTest && now.getTime() - Date.parse(cur.lastTest.at) < TEST_GAP_MS;
        return tooSoon ? undefined : Object.assign({}, cur, { lastTest: { at: now.toISOString(), ok: null } });
      });
      if (tooSoon) { res.status(429).json({ error: 'A test was sent in the last 10 minutes. Check the inbox, or try again shortly.' }); return; }
      const c = compose(await gatherWeek(), now.getTime());
      const sent = await sendMail([to[0]], '[Test] ' + c.subject, c.html, c.text, 2);
      await kvUpdate(STATE, function (s) { return Object.assign({}, s || {}, { lastTest: { at: now.toISOString(), ok: sent.ok, error: sent.ok ? null : short(sent.error) } }); });
      res.status(sent.ok ? 200 : 502).json({ ok: sent.ok, test: true, sentTo: 1, sendsWith: which, counts: c.counts, error: sent.ok ? undefined : (secretOk ? sent.error : redact(sent.error)) });
      return;
    }

    const local = localParts(now, TZ);

    // Claim today before doing anything slow. Of two runs at the same moment, exactly one wins.
    let won = false, why = '';
    await kvUpdate(STATE, function (s) {
      const cur = s || {};
      const d = decide(now, cur);
      won = force || d.send;
      why = d.reason;
      if (!won) return undefined;
      return Object.assign({}, cur, { claim: { date: local.date, at: now.toISOString() } });
    });
    if (!won) { res.status(200).json({ ok: true, skipped: true, reason: why }); return; }

    let c = null, sent;
    try {
      c = compose(await gatherWeek(), now.getTime());
      sent = await sendMail(to, c.subject, c.html, c.text, 2);
    } catch (e) {
      sent = { ok: false, error: short((e && e.message) || e) };
    }

    // Record the result and release the claim. On failure lastSent stays unset, so the next slot retries.
    await kvUpdate(STATE, function (s) {
      const next = Object.assign({}, s || {});
      delete next.claim;
      if (sent.ok) {
        next.lastSent = local.date; next.lastSentAt = new Date().toISOString();
        next.lastRecipients = to.length; next.lastCounts = c.counts; next.lastError = null;
      } else {
        next.lastError = { at: new Date().toISOString(), message: short(sent.error) };
      }
      return next;
    });
    res.status(sent.ok ? 200 : 502).json({ ok: sent.ok, sentTo: sent.ok ? to.length : 0, sendsWith: which, counts: c ? c.counts : null, error: sent.ok ? undefined : (secretOk ? sent.error : redact(sent.error)) });
  } catch (e) {
    res.status(500).json({ error: short((e && e.message) || e) });
  }
}
