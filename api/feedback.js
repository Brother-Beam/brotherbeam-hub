// The suggestions queue behind the "Suggest a change" box on every page.
//
//   GET  /api/feedback                    -> { open: [...newest first], count }
//   POST /api/feedback { by, text, page } -> { ok, entry, count }
//
// Browsers can read the queue and add to it. They cannot edit or remove anything:
// a suggestion leaves the queue on its own once the deployed whatsnew.json marks it
// built or declined (see reconcileSuggestions in _lib/store.js). Every write goes
// through a versioned read-change-write, so two people sending at the same moment
// both land.
import { buildSuggestion, addSuggestion, listOf } from './_lib/logic.js';
import { kvUpdate, reconcileSuggestions, storeReady } from './_lib/store.js';

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!storeReady()) { res.status(503).json({ error: 'The shared store is not set up (HUB_API_BASE and HUB_API_TOKEN on Vercel).' }); return; }
  try {
    if (req.method === 'GET') {
      const r = await reconcileSuggestions();
      const open = r.open.slice().sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); });
      res.status(200).json({ open: open, count: open.length, cleared: r.removed.length, changelog: r.changelogSource });
      return;
    }

    if (req.method === 'POST') {
      const now = Date.now();
      const made = buildSuggestion(parseBody(req), now);
      if (!made.ok) { res.status(made.status).json({ error: made.error }); return; }
      let outcome = {};
      const saved = await kvUpdate('beam-feedback', function (v) {
        outcome = addSuggestion(listOf(v), made.entry, now);
        return outcome.list ? { feedback: outcome.list } : undefined;
      });
      if (outcome.duplicate) { res.status(200).json({ ok: true, duplicate: true, entry: outcome.duplicate, count: listOf(saved.value).length }); return; }
      if (outcome.full) { res.status(409).json({ error: 'The suggestions queue is full. Tell Mike directly so he can clear it.' }); return; }
      res.status(201).json({ ok: true, entry: made.entry, count: outcome.list.length });
      return;
    }

    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'GET or POST' });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach the shared store. Nothing was lost on your side; try again in a moment.', detail: String((e && e.message) || e) });
  }
}
