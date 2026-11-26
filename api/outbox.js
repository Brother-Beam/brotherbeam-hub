// The outbox: email the hub has ready, for something else to deliver.
//
// Mike does not want his email password stored at Vercel, so the hub does not send its
// own email. Instead it decides what is due and writes each email, and a scheduled Claude
// task on Mike's Mac collects them here and sends them through his Gmail connection.
//
//   GET  /api/outbox?pw=...                    -> { mail: [{ key, to, subject, text, html? }], count }
//   POST /api/outbox?pw=...  { sent: [keys] }   -> { ok, recorded }
//   GET  /api/outbox?pw=...&dry=1[&now=ISO]     -> the same list, but nothing is claimed or
//                                                 changed (now= pretends it is another moment)
//
// What can be in it
//   suggestion alerts   to "mike"      a suggestion that came in and has not been mailed
//   activity alerts     to "mike"      a new board post, roadmap status, meeting or Library file
//   the weekly summary  to "everyone"  due from Sunday 6 PM Mountain until Wednesday 6 PM
// "to" is a role, never an address: the addresses live with the task that delivers, not here
// and not in this public repo.
//
// Collecting claims each email for a few minutes, so two collectors cannot both send it.
// Reporting it sent (POST) records it for good. If the collector never reports back, the
// claim lapses and the email is offered again: nothing is lost, at worst something is
// sent twice. All of the deciding is done by the same tested rules the hub would use if
// it sent email itself (logic.js); this file only asks and records.
import {
  listOf, pickForAlert, claimForAlert, markAlerted, composeAlert,
  ACTIVITY_KINDS, activityItems, decideActivity, finishActivity, composeActivity, adminNames, roadmapTitles,
  boardOf, meetingsOf, bodyOf, weeklyDue, compose, parseOutboxKey,
} from './_lib/logic.js';
import { kvGet, kvUpdate, loadSiteJson, reconcileSuggestions, storeReady } from './_lib/store.js';
import { gatherWeek, libraryFiles } from './_lib/week.js';

export const config = { maxDuration: 60 };

const HUB_PW = 'scooter';            // the Library's convenience lock
const ALERT_STATE = 'beam-alert-state';
const DIGEST_STATE = 'beam-digest-state';
// Whoever delivers has to hand the body to the mail tool, so a long HTML body is left out
// and the plain text goes instead. Alerts are well under this; the weekly summary is over.
const MAX_HTML = 12000;

function pack(key, to, m) {
  return { key: key, to: to, subject: m.subject, text: m.text, html: (m.html && m.html.length <= MAX_HTML) ? m.html : undefined };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  if (String(q.pw || '').toLowerCase() !== HUB_PW) { res.status(401).json({ error: 'unauthorized' }); return; }
  if (!storeReady()) { res.status(503).json({ error: 'the shared store is not set up' }); return; }
  try {
    if (req.method === 'GET') {
      const dry = q.dry === '1';
      let now = Date.now();
      if (dry && q.now) {
        const t = Date.parse(String(q.now));
        if (isNaN(t)) { res.status(400).json({ error: 'now must be a date like 2026-11-30T01:05:00Z' }); return; }
        now = t;
      }
      const iso = new Date(now).toISOString();
      const mail = [];

      // 1. Suggestions that have not been mailed.
      const rec = await reconcileSuggestions();
      let ids = pickForAlert(rec.open, now);
      if (ids.length) {
        let claimed = rec.open.filter(function (e) { return ids.indexOf(e.id) >= 0; });
        let openCount = rec.open.length;
        if (!dry) {
          const saved = await kvUpdate('beam-feedback', function (v) {
            const list = listOf(v);
            ids = pickForAlert(list, now);
            claimed = list.filter(function (e) { return ids.indexOf(e.id) >= 0; });
            return ids.length ? { feedback: claimForAlert(list, ids, iso) } : undefined;
          });
          openCount = listOf(saved.value).length;
        }
        if (claimed.length) mail.push(pack('s|' + claimed.map(function (e) { return e.id; }).join(','), 'mike', composeAlert(claimed, openCount, now)));
      }

      // 2. Activity: board posts, roadmap statuses, meetings, Library files.
      const got = await Promise.all([kvGet('beam-progress'), kvGet('beam-meetings'), libraryFiles(), dry ? kvGet(ALERT_STATE) : null]);
      const board = boardOf(got[0].value);
      const items = {
        posts: activityItems.posts(board),
        statuses: activityItems.statuses(board),
        meetings: activityItems.meetings(meetingsOf(got[1].value)),
        files: got[2] ? activityItems.files(got[2], '') : null,     // null: the Library could not be read just now
      };
      // mailReady: someone is here to deliver. noLimit: a scheduled collector is already paced.
      const opts = { admins: adminNames(process.env.ADMIN_NAMES), mailReady: true, noLimit: true };
      let titles = null;
      for (let i = 0; i < ACTIVITY_KINDS.length; i++) {
        const kind = ACTIVITY_KINDS[i];
        if (!items[kind]) continue;
        let d = null;
        if (dry) d = decideActivity(got[3].value, kind, items[kind], now, opts);
        else await kvUpdate(ALERT_STATE, function (s) { d = decideActivity(s, kind, items[kind], now, opts); return d.next; });
        if (d.status !== 'send') continue;
        if (kind === 'statuses' && !titles) titles = roadmapTitles((await loadSiteJson('roadmap.json')).data);
        mail.push(pack('a|' + kind + '|' + d.advanceTo, 'mike', composeActivity(kind, d.pending, { titles: titles || {} })));
      }

      // 3. The weekly summary, if it is due and has not gone.
      let w = weeklyDue(new Date(now), (await kvGet(DIGEST_STATE)).value || {});
      if (w.due && !dry) {
        await kvUpdate(DIGEST_STATE, function (s) {
          w = weeklyDue(new Date(now), s || {});
          return w.due ? Object.assign({}, s || {}, { claim: { date: w.date, at: iso } }) : undefined;
        });
      }
      if (w.due) mail.push(pack('w|' + w.date, 'everyone', compose(await gatherWeek(), w.asOf)));

      res.status(200).json({ mail: mail, count: mail.length, dry: dry || undefined });
      return;
    }

    if (req.method === 'POST') {
      const now = Date.now();
      const iso = new Date(now).toISOString();
      const body = bodyOf(req.body);
      const keys = Array.isArray(body.sent) ? body.sent.slice(0, 30) : [];
      let recorded = 0;
      for (let i = 0; i < keys.length; i++) {
        const k = parseOutboxKey(keys[i], now);
        if (!k) continue;
        if (k.type === 's') {
          await kvUpdate('beam-feedback', function (v) {
            const out = markAlerted(listOf(v), k.ids, iso);
            return out.changed ? { feedback: out.list } : undefined;
          });
        } else if (k.type === 'a') {
          await kvUpdate(ALERT_STATE, function (s) { return finishActivity(s, k.kind, k.upTo, now); });
        } else {
          await kvUpdate(DIGEST_STATE, function (s) {
            const next = Object.assign({}, s || {});
            delete next.claim;
            if (!next.lastSent || next.lastSent < k.date) { next.lastSent = k.date; next.lastSentAt = iso; next.lastVia = 'outbox'; next.lastError = null; }
            return next;
          });
        }
        recorded++;
      }
      res.status(200).json({ ok: true, recorded: recorded });
      return;
    }

    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'GET or POST' });
  } catch (e) {
    res.status(502).json({ error: 'Could not put the outbox together just now. Nothing was lost; try again shortly.', detail: String((e && e.message) || e) });
  }
}
