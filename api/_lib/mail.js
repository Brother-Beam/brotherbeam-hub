// Sending email from the hub: the weekly summary (digest.js) and the alert Mike gets the
// moment a suggestion comes in (feedback.js). Files under api/_lib are not routes.
//
// Vercel settings
//   DIGEST_TO            recipients of the weekly summary, comma-separated, Mike first. The
//                        first address is also the Gmail account everything is sent from,
//                        and the one suggestion alerts and test sends go to.
//   GMAIL_APP_PASSWORD   a Google "app password" for that first address.
//   Optional
//   GMAIL_USER           send from a different Gmail account than the first recipient.
//   RESEND_API_KEY + DIGEST_FROM   send through Resend from a verified domain instead.
import { parseRecipients } from './logic.js';

export function recipients() { return parseRecipients(process.env.DIGEST_TO); }
// Who runs the hub: gets suggestion alerts and test sends.
export function adminAddress() { return recipients()[0] || ''; }
function gmailUser() { return String(process.env.GMAIL_USER || adminAddress()).trim(); }
export function provider() {
  if (process.env.RESEND_API_KEY && process.env.DIGEST_FROM) return 'resend';
  if (process.env.GMAIL_APP_PASSWORD && gmailUser()) return 'gmail';
  return null;
}
// True once the hub is able to send anything at all.
export function mailReady() { return !!(provider() && adminAddress()); }

export function short(x) { return String(x == null ? '' : x).slice(0, 300); }
// Error text from a mail service can name an address. Callers without the secret get it masked.
export function redact(x) { return short(x).replace(/[^\s<>"',;:()]+@[^\s<>"',;:()]+/g, '[address]'); }
function sleep(n) { return new Promise(function (r) { setTimeout(r, n); }); }

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
    // Loaded here, not at the top: a mail library must never be able to stop a file loading.
    const mod = await import('nodemailer');
    const nodemailer = mod.default || mod;
    const user = gmailUser();
    const transport = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user: user, pass: String(process.env.GMAIL_APP_PASSWORD).replace(/\s+/g, '') },
      // Bounded, so a slow mail server can never hang the request that triggered the email.
      connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 15000,
    });
    const info = await transport.sendMail({ from: { name: 'Beam Hub', address: user }, to: to, subject: subject, html: html, text: text });
    const rejected = (info && info.rejected) || [];
    return rejected.length ? { ok: false, error: 'Gmail rejected ' + rejected.length + ' of ' + to.length + ' recipients' } : { ok: true };
  }
  return { ok: false, error: 'no way to send is set up' };
}

// The same, but gives up waiting after limitMs, so a slow mail server can never hold up
// the request that triggered the email. One attempt; a later request retries.
export function sendWithin(to, subject, html, text, limitMs) {
  return Promise.race([
    sendMail(to, subject, html, text, 1),
    new Promise(function (r) { setTimeout(function () { r({ ok: false, error: 'the mail server took too long' }); }, limitMs); }),
  ]);
}

// Sends one email and reports { ok } or { ok: false, error }. It never throws.
// attempts: how many tries, 2.5 seconds apart (the weekly summary uses 2; alerts use 1,
// because a failed alert is picked up again the next time the queue is read).
export async function sendMail(to, subject, html, text, attempts) {
  const tries = attempts || 1;
  let last = { ok: false, error: 'not attempted' };
  for (let i = 0; i < tries; i++) {
    try { last = await sendOnce(to, subject, html, text); }
    catch (e) { last = { ok: false, error: short((e && e.message) || e) }; }
    if (last.ok) return last;
    if (i < tries - 1) await sleep(2500);
  }
  return last;
}
