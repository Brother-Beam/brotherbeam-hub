// The meeting log behind Meeting Minutes.
//
//   GET  /api/meetings                                    -> { meetings, updatedAt }
//   POST /api/meetings { action: 'add', meeting: {...} }  -> { ok, meeting, meetings }
//   POST /api/meetings { action: 'remove', id }           -> { ok, removed, meetings }
//
// The page never sends the whole log back. Adding appends one meeting; removing takes
// out one meeting by id. Each is applied to whatever is stored right then through a
// versioned read-change-write, so two people logging or removing at the same moment
// cannot erase each other's meetings. The server assigns each meeting's id and the time
// it was logged.
//
// Sandbox. Add ?sandbox=1 and everything reads and writes a separate key
// (beam-meetings-sandbox) instead of the real log, for testing on the live site. In the
// sandbox only, the action 'reset' empties it again.
import { bodyOf, meetingsOf, buildMeeting, addMeeting, removeMeeting, activityItems } from './_lib/logic.js';
import { kvGet, kvUpdate, storeReady } from './_lib/store.js';
import { alertActivity, alertState } from './_lib/alerts.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!storeReady()) { res.status(503).json({ error: 'The shared store is not set up (HUB_API_BASE and HUB_API_TOKEN on Vercel).' }); return; }
  const sandbox = !!(req.query && req.query.sandbox === '1');
  const key = sandbox ? 'beam-meetings-sandbox' : 'beam-meetings';
  try {
    if (req.method === 'GET') {
      const got = await Promise.all([kvGet(key), sandbox ? null : alertState()]);
      const cur = got[0];
      // Catch up on any alert that did not go out when its meeting was logged.
      if (!sandbox) await alertActivity('meetings', activityItems.meetings(meetingsOf(cur.value)), null, got[1]);
      res.status(200).json({ meetings: meetingsOf(cur.value), updatedAt: cur.updatedAt, sandbox: sandbox });
      return;
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); res.status(405).json({ error: 'GET or POST' }); return; }

    const body = bodyOf(req.body);
    const now = Date.now();

    if (body.action === 'add') {
      const made = buildMeeting(body, now);
      if (!made.ok) { res.status(made.status).json({ error: made.error }); return; }
      let out = {};
      const saved = await kvUpdate(key, function (v) {
        out = addMeeting(meetingsOf(v), made.meeting, now);
        return out.list ? { meetings: out.list } : undefined;
      });
      if (out.full) { res.status(409).json({ error: 'The meeting log is full, so this was not saved. Tell Mike so he can make room.' }); return; }
      // Saved. Now tell Mike (never from the sandbox, and never about meetings he logged himself).
      if (!sandbox && !out.duplicate) await alertActivity('meetings', activityItems.meetings(meetingsOf(saved.value)));
      res.status(out.duplicate ? 200 : 201).json({ ok: true, duplicate: !!out.duplicate, meeting: out.duplicate || made.meeting, meetings: meetingsOf(saved.value) });
      return;
    }

    if (body.action === 'remove') {
      const id = String(body.id || '');
      if (!id) { res.status(400).json({ error: 'Which meeting? No id was sent.' }); return; }
      let removed = false;
      const saved = await kvUpdate(key, function (v) {
        const out = removeMeeting(meetingsOf(v), id);
        removed = out.removed;
        return out.removed ? { meetings: out.list } : undefined;
      });
      res.status(200).json({ ok: true, removed: removed, meetings: meetingsOf(saved.value) });
      return;
    }

    if (body.action === 'reset' && sandbox) {
      await kvUpdate(key, function () { return { meetings: [] }; });
      res.status(200).json({ ok: true, meetings: [] });
      return;
    }

    res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach the shared store, so nothing was saved. Try again in a moment.', detail: String((e && e.message) || e) });
  }
}
