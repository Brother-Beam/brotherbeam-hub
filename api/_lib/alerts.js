// Activity alerts: emails Mike when someone uploads a file, logs a meeting, posts on the
// board or changes a roadmap status. The rules are in logic.js (decideActivity,
// composeActivity); this file does the reading, claiming, sending and recording.
//
// Each endpoint calls alertActivity(kind, items) with the current items of its kind, both
// when something is added and when the page reads. So an alert goes out with the request
// that created the news, and one that could not be sent then (mail not set up, Gmail
// unreachable) goes out with a later read. Nothing here can break the request that called
// it: every failure is swallowed and reported as a status word.
import { decideActivity, finishActivity, composeActivity, adminNames } from './logic.js';
import { kvGet, kvUpdate } from './store.js';
import { mailReady, adminAddress, sendWithin } from './mail.js';

const STATE = 'beam-alert-state';
const SEND_LIMIT_MS = 9000;   // the longest a request will wait on the mail server

// The stored alert state, for endpoints that want to read it alongside their own data
// (in parallel) so a quiet read costs no extra round trip. null means "could not read".
export async function alertState() {
  try { return (await kvGet(STATE)).value || {}; } catch (e) { return null; }
}

// kind: 'posts' | 'statuses' | 'meetings' | 'files'
// items: the current items of that kind, as activityItems[kind](...) builds them
// ctx: extra detail the email needs (or a function returning it, called only if an email is sent)
// known: the alert state if the caller already read it; lets a no-news call return at once
// Returns a status word: init, none, self, off, held, busy, sent, failed, or error.
export async function alertActivity(kind, items, ctx, known) {
  try {
    if (known === null) return 'error';
    const now = Date.now();
    const opts = { admins: adminNames(process.env.ADMIN_NAMES), mailReady: mailReady() };
    if (known !== undefined) {
      const quick = decideActivity(known, kind, items, now, opts);
      if (!quick.next) return quick.status;            // nothing to record: no store write needed
    }
    let d = null;
    await kvUpdate(STATE, function (s) { d = decideActivity(s, kind, items, now, opts); return d.next; });
    if (d.status !== 'send') return d.status;
    const detail = typeof ctx === 'function' ? await ctx() : ctx;
    const mail = composeActivity(kind, d.pending, detail);
    const sent = await sendWithin([adminAddress()], mail.subject, mail.html, mail.text, SEND_LIMIT_MS);
    if (!sent.ok) return 'failed';                     // the claim lapses in a few minutes and a later request retries
    try { await kvUpdate(STATE, function (s) { return finishActivity(s, kind, d.advanceTo, Date.now()); }); }
    catch (e) { /* the email went; at worst it is sent once more when the claim lapses */ }
    return 'sent';
  } catch (e) {
    return 'error';
  }
}
