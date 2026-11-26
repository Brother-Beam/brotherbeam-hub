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
// What you can call
//   /api/digest?status=1                 open. Is it set up, when did it last send. No secrets, no addresses.
//   /api/digest?preview=1&pw=...         the email as it would look right now. Sends nothing.
//       &format=text | &format=json      the plain-text version, or just the subject and counts
//   /api/digest?dry=1&pw=...&now=ISO     would the scheduler send at that moment? Sends nothing.
//   /api/digest            + the secret  the scheduled run (what cron calls)
//   /api/digest?test=1     + the secret  send it now to the FIRST address in DIGEST_TO only
//   /api/digest?force=1    + the secret  send it now to everyone, whatever the day
//   "the secret" is CRON_SECRET, as "Authorization: Bearer ..." (how Vercel Cron sends it) or &secret=...
//
// Vercel environment variables
//   CRON_SECRET          any long random string. Nothing sends until this is set.
//   DIGEST_TO            the recipients, comma-separated. Put Mike first (tests go to the first one).
//                        They live here, not in the repo, because the repo is public.
//   and ONE way to send:
//   GMAIL_USER + GMAIL_APP_PASSWORD   a Gmail address and an app password for it, or
//   RESEND_API_KEY + DIGEST_FROM      a Resend key and a sender on a domain verified there
import { timingSafeEqual } from 'node:crypto';
import { list } from '@vercel/blob';
import { compose, decide, localParts, parseRecipients, SCHEDULE_TEXT, TZ } from './_lib/logic.js';
import { kvGet, kvUpdate, loadSiteJson, reconcileSuggestions, storeReady } from './_lib/store.js';

export const config = { maxDuration: 60 };

const STATE = 'beam-digest-state';
const HUB_PW = 'scooter';   // the Library's convenience lock; here it only guards the read-only preview

function provider() {
  if (process.env.RESEND_API_KEY && process.env.DIGEST_FROM) return 'resend';
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) return 'gmail';
  return null;
}

function authorized(req) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return false;
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String((req.query && req.query.secret) || '');
  const a = Buffer.from(given), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sleep(n) { return new Promise(function (r) { setTimeout(r, n); }); }
function short(x) { return String(x == null ? '' : x).slice(0, 300); }
function pad(n) { return (n < 10 ? '0' : '') + n; }

async function libraryFiles() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    let all = [], cursor;
    for (let i = 0; i < 10; i++) {
      const page = await list(cursor ? { cursor: cursor } : undefined);
      all = all.concat(page.blobs || []);
      if (!page.hasMore || !page.cursor) break;
      cursor = page.cursor;
    }
    return all;
  } catch (e) { return null; }   // the email says the Library count is unknown rather than guessing zero
}

// Everything the email is built from. Cleans the suggestions queue first, so the counts are true.
async function gather() {
  const rec = await reconcileSuggestions();
  if (!rec.changelog) throw new Error('could not read whatsnew.json');
  const got = await Promise.all([kvGet('beam-progress'), kvGet('beam-meetings'), kvGet('beam-feedback-closed'), loadSiteJson('roadmap.json'), libraryFiles()]);
  if (!got[3].data) throw new Error('could not read roadmap.json');
  return { whatsnew: rec.changelog, open: rec.open, progress: got[0].value, meetings: got[1].value, closed: got[2].value, roadmap: got[3].data, files: got[4] };
}

async function sendOnce(to, subject, html, text) {
  const which = provider();
  if (which === 'resend') {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ from: process.env.DIGEST_FROM, to: to, subject: subject, html: html, text: text }),
    });
    const body = await r.text();
    return r.ok ? { ok: true } : { ok: false, error: 'Resend said HTTP ' + r.status + ': ' + short(body) };
  }
  if (which === 'gmail') {
    // Loaded here, not at the top: a mail library must never be able to stop this file loading.
    const mod = await import('nodemailer');
    const nodemailer = mod.default || mod;
    const user = String(process.env.GMAIL_USER).trim();
    const transport = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user: user, pass: String(process.env.GMAIL_APP_PASSWORD).replace(/\s+/g, '') },
    });
    const info = await transport.sendMail({ from: { name: 'Beam Hub', address: user }, to: to, subject: subject, html: html, text: text });
    const rejected = (info && info.rejected) || [];
    return rejected.length ? { ok: false, error: 'Gmail rejected ' + rejected.length + ' of ' + to.length + ' recipients' } : { ok: true };
  }
  return { ok: false, error: 'no way to send is set up' };
}

async function send(to, subject, html, text) {
  let last = { ok: false, error: 'not attempted' };
  for (let i = 0; i < 2; i++) {
    try { last = await sendOnce(to, subject, html, text); }
    catch (e) { last = { ok: false, error: short((e && e.message) || e) }; }
    if (last.ok) return last;
    if (i === 0) await sleep(2500);
  }
  return last;
}

async function status(req, res, now) {
  const to = parseRecipients(process.env.DIGEST_TO);
  const which = provider();
  const missing = [];
  if (!process.env.CRON_SECRET) missing.push('CRON_SECRET');
  if (!to.length) missing.push('DIGEST_TO');
  if (!which) missing.push('GMAIL_USER and GMAIL_APP_PASSWORD (or RESEND_API_KEY and DIGEST_FROM)');
  let state = {}, storeOk = storeReady();
  if (storeOk) { try { state = (await kvGet(STATE)).value || {}; } catch (e) { storeOk = false; } }
  const local = localParts(now, TZ);
  const full = authorized(req);   // error text can name an address, so it is only shown with the secret
  res.status(200).json({
    ready: missing.length === 0 && storeOk,
    schedule: SCHEDULE_TEXT,
    mountainTimeNow: local.weekday + ' ' + local.date + ' ' + pad(local.hour) + ':' + pad(local.minute),
    configured: { cronSecret: !!process.env.CRON_SECRET, sendsWith: which, recipients: to.length, store: storeOk, library: !!process.env.BLOB_READ_WRITE_TOKEN },
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

    // Read-only views. They never send anything.
    if (q.preview === '1' || q.dry === '1') {
      if (String(q.pw || '').toLowerCase() !== HUB_PW) { res.status(401).json({ error: 'unauthorized' }); return; }
      if (!storeReady()) { res.status(503).json({ error: 'the shared store is not set up' }); return; }
      if (q.dry === '1') {
        const at = q.now ? new Date(String(q.now)) : now;
        if (isNaN(at.getTime())) { res.status(400).json({ error: 'now must be a date like 2026-11-30T01:05:00Z' }); return; }
        const d = decide(at, (await kvGet(STATE)).value || {});
        res.status(200).json({ wouldSend: d.send, reason: d.reason, mountain: d.local, schedule: SCHEDULE_TEXT });
        return;
      }
      const c = compose(await gather(), now.getTime());
      if (q.format === 'json') { res.status(200).json({ subject: c.subject, counts: c.counts }); return; }
      if (q.format === 'text') { res.setHeader('content-type', 'text/plain; charset=utf-8'); res.status(200).send(c.subject + '\n\n' + c.text); return; }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.status(200).send(c.html);
      return;
    }

    // Everything below can send email, so it needs the secret.
    if (!authorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (!storeReady()) { res.status(503).json({ error: 'the shared store is not set up' }); return; }
    const to = parseRecipients(process.env.DIGEST_TO);
    const which = provider();
    if (!to.length || !which) { res.status(503).json({ error: 'email is not set up yet; see /api/digest?status=1 for what is missing' }); return; }

    if (q.test === '1') {
      const c = compose(await gather(), now.getTime());
      const sent = await send([to[0]], '[Test] ' + c.subject, c.html, c.text);
      await kvUpdate(STATE, function (s) { return Object.assign({}, s || {}, { lastTest: { at: now.toISOString(), ok: sent.ok, error: sent.ok ? null : short(sent.error) } }); });
      res.status(sent.ok ? 200 : 502).json({ ok: sent.ok, test: true, sentTo: 1, sendsWith: which, counts: c.counts, error: sent.ok ? undefined : sent.error });
      return;
    }

    const force = q.force === '1';
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
      c = compose(await gather(), now.getTime());
      sent = await send(to, c.subject, c.html, c.text);
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
    res.status(sent.ok ? 200 : 502).json({ ok: sent.ok, sentTo: sent.ok ? to.length : 0, sendsWith: which, counts: c ? c.counts : null, error: sent.ok ? undefined : sent.error });
  } catch (e) {
    res.status(500).json({ error: short((e && e.message) || e) });
  }
}
