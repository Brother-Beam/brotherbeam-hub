// The suggestions queue behind the "Suggest a change" box on every page.
//
//   GET  /api/feedback                    -> { open: [...newest first], count }
//   POST /api/feedback { by, text, page } -> { ok, entry, count, alert }
//
// Browsers can read the queue and add to it. They cannot edit or remove anything:
// a suggestion leaves the queue on its own once the deployed whatsnew.json marks it
// built or declined (see reconcileSuggestions in _lib/store.js). Every write goes
// through a versioned read-change-write, so two people sending at the same moment
// both land.
//
// Alerts. When a suggestion is saved, Mike is emailed it straight away (the first
// address in DIGEST_TO). The suggestion is saved first and the email is sent after, so a
// mail problem can never lose or block a suggestion. If the email does not go out
// (mail not set up yet, Gmail unreachable, too many in a few minutes), the suggestion
// stays marked as not yet mailed, and whichever request next reads or adds to the queue
// sends it then. The reply's "alert" says what happened: sent, held, failed, skipped
// (a quiet test), or off (mail is not set up).
import { bodyOf, buildSuggestion, addSuggestion, listOf, pickForAlert, claimForAlert, markAlerted, publicEntry, composeAlert } from './_lib/logic.js';
import { kvUpdate, reconcileSuggestions, storeReady } from './_lib/store.js';
import { mailReady, adminAddress, sendWithin } from './_lib/mail.js';

export const config = { maxDuration: 30 };

const SEND_LIMIT_MS = 9000;   // the longest a request will wait on the mail server

// Emails Mike the suggestions this request claimed, then records that they were mailed.
// If the send fails nothing is recorded: the claim lapses and a later request retries.
async function alertAbout(entries, openCount) {
  const mail = composeAlert(entries, openCount, Date.now());
  const sent = await sendWithin([adminAddress()], mail.subject, mail.html, mail.text, SEND_LIMIT_MS);
  if (!sent.ok) return false;
  const ids = entries.map(function (e) { return e.id; });
  const stamp = new Date().toISOString();
  try {
    await kvUpdate('beam-feedback', function (v) {
      const out = markAlerted(listOf(v), ids, stamp);
      return out.changed ? { feedback: out.list } : undefined;
    });
  } catch (e) { /* the email went; at worst it is sent once more when the claim lapses */ }
  return true;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!storeReady()) { res.status(503).json({ error: 'The shared store is not set up (HUB_API_BASE and HUB_API_TOKEN on Vercel).' }); return; }
  try {
    if (req.method === 'GET') {
      const r = await reconcileSuggestions();
      let open = r.open;
      // Catch up on any alert that did not go out when its suggestion was sent.
      const now = Date.now();
      if (mailReady() && pickForAlert(open, now).length) {
        let claimed = [];
        const saved = await kvUpdate('beam-feedback', function (v) {
          const list = listOf(v);
          const ids = pickForAlert(list, now);
          claimed = list.filter(function (e) { return ids.indexOf(e.id) >= 0; });
          return ids.length ? { feedback: claimForAlert(list, ids, new Date(now).toISOString()) } : undefined;
        });
        open = listOf(saved.value);
        if (claimed.length) await alertAbout(claimed, open.length);
      }
      const shown = open.map(publicEntry).sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); });
      res.status(200).json({ open: shown, count: shown.length, cleared: r.removed.length, changelog: r.changelogSource });
      return;
    }

    if (req.method === 'POST') {
      const now = Date.now();
      const made = buildSuggestion(bodyOf(req.body), now);
      if (!made.ok) { res.status(made.status).json({ error: made.error }); return; }
      let outcome = {}, claimed = [];
      const saved = await kvUpdate('beam-feedback', function (v) {
        outcome = addSuggestion(listOf(v), made.entry, now);
        claimed = [];
        if (!outcome.list) return undefined;
        let next = outcome.list;
        if (mailReady()) {
          // Claim the new one, plus any older ones still waiting, in the same write that saves it.
          const ids = pickForAlert(next, now, made.entry.id);
          claimed = next.filter(function (e) { return ids.indexOf(e.id) >= 0; });
          if (ids.length) next = claimForAlert(next, ids, new Date(now).toISOString());
        }
        return { feedback: next };
      });
      if (outcome.duplicate) { res.status(200).json({ ok: true, duplicate: true, entry: publicEntry(outcome.duplicate), count: listOf(saved.value).length }); return; }
      if (outcome.full) { res.status(409).json({ error: 'The suggestions queue is full. Tell Mike directly so he can clear it.' }); return; }

      // The suggestion is saved. Now tell Mike. Whatever happens here, the reply is still "saved".
      let alert = made.entry.mailed === 'skip' ? 'skipped' : (mailReady() ? 'held' : 'off');
      if (claimed.length) {
        const ok = await alertAbout(claimed, outcome.list.length);
        if (made.entry.mailed !== 'skip') alert = ok ? 'sent' : 'failed';
      }
      res.status(201).json({ ok: true, entry: publicEntry(made.entry), count: outcome.list.length, alert: alert });
      return;
    }

    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'GET or POST' });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach the shared store. Nothing was lost on your side; try again in a moment.', detail: String((e && e.message) || e) });
  }
}
