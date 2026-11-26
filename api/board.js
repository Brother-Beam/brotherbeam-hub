// The RoadMap page's shared state: each roadmap step's status, and the message board.
//
//   GET  /api/board                                       -> { items, messages, updatedAt }
//   POST /api/board { action: 'post', by, text }          -> { ok, board }
//   POST /api/board { action: 'status', id, status, by }  -> { ok, board }
//
// The page never sends the whole board back. It sends one small action, and that action
// is applied to whatever is stored right then through a versioned read-change-write, so
// two people posting or changing statuses at the same moment both land. Posts can only
// be added; a status change touches one step and nothing else.
//
// Sandbox. Add ?sandbox=1 and everything reads and writes a separate key
// (beam-progress-sandbox) instead of the real one. That is how this gets tested on the
// live site without leaving a trace on the founders' board. In the sandbox only, the
// action 'reset' empties it again.
import { bodyOf, boardOf, buildPost, addPost, buildStatus, setStatus, stepIds, fits } from './_lib/logic.js';
import { kvGet, kvUpdate, loadSiteJson, storeReady } from './_lib/store.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!storeReady()) { res.status(503).json({ error: 'The shared store is not set up (HUB_API_BASE and HUB_API_TOKEN on Vercel).' }); return; }
  const sandbox = !!(req.query && req.query.sandbox === '1');
  const key = sandbox ? 'beam-progress-sandbox' : 'beam-progress';
  try {
    if (req.method === 'GET') {
      const cur = await kvGet(key);
      const b = boardOf(cur.value);
      res.status(200).json({ items: b.items, messages: b.messages, updatedAt: cur.updatedAt, sandbox: sandbox });
      return;
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); res.status(405).json({ error: 'GET or POST' }); return; }

    const body = bodyOf(req.body);
    const now = Date.now();

    if (body.action === 'post') {
      const made = buildPost(body, now);
      if (!made.ok) { res.status(made.status).json({ error: made.error }); return; }
      let out = {};
      const saved = await kvUpdate(key, function (v) { out = addPost(boardOf(v), made.post, now); return out.board; });
      if (out.full) { res.status(409).json({ error: 'The board is full, so this was not posted. Tell Mike so he can make room.' }); return; }
      res.status(out.duplicate ? 200 : 201).json({ ok: true, duplicate: !!out.duplicate, board: boardOf(saved.value) });
      return;
    }

    if (body.action === 'status') {
      const roadmap = await loadSiteJson('roadmap.json');
      if (!roadmap.data) { res.status(503).json({ error: 'Could not read the roadmap just now. Try again in a moment.' }); return; }
      const made = buildStatus(body, stepIds(roadmap.data), now);
      if (!made.ok) { res.status(made.status).json({ error: made.error }); return; }
      let full = false;
      const saved = await kvUpdate(key, function (v) {
        const next = setStatus(boardOf(v), made.id, made.entry);
        full = !fits(next);
        return full ? undefined : next;
      });
      if (full) { res.status(409).json({ error: 'The board is full, so this was not saved. Tell Mike so he can make room.' }); return; }
      res.status(200).json({ ok: true, board: boardOf(saved.value) });
      return;
    }

    if (body.action === 'reset' && sandbox) {
      await kvUpdate(key, function () { return { items: {}, messages: [] }; });
      res.status(200).json({ ok: true, board: { items: {}, messages: [] } });
      return;
    }

    res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach the shared store, so nothing was saved. Try again in a moment.', detail: String((e && e.message) || e) });
  }
}
