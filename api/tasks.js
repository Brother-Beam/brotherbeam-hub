// Same-origin proxy for the hub's shared key-value store, which lives in the
// company's own API on Railway. The browser never sees the API token: it is
// added here, server side, from Vercel environment variables.
//
//   GET  /api/tasks?key=action-items          -> { key, value, updated_at }
//   POST /api/tasks?key=action-items {value}   -> saves and returns the same shape
//
// Vercel environment variables (Project -> Settings -> Environment Variables):
//   HUB_API_BASE   e.g. https://brotherbeam-api-production.up.railway.app
//   HUB_API_TOKEN  the same value as API_TOKEN on the Railway service
const BASE = (process.env.HUB_API_BASE || '').replace(/\/+$/, '');
const TOKEN = process.env.HUB_API_TOKEN || '';
const KEY = /^[a-z0-9-]{1,64}$/;

export default async function handler(req, res) {
  const key = String((req.query && req.query.key) || 'action-items');
  if (!KEY.test(key)) { res.status(400).json({ error: 'bad key' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  if (!BASE || !TOKEN) { res.status(503).json({ error: 'store not configured: set HUB_API_BASE and HUB_API_TOKEN on Vercel' }); return; }
  const headers = { accept: 'application/json', authorization: 'Bearer ' + TOKEN };
  try {
    if (req.method === 'GET') {
      const r = await fetch(BASE + '/api/kv/' + key, { headers });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(r.status).send(await r.text());
      return;
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
      if (body.length > 200000) { res.status(413).json({ error: 'too large' }); return; }
      const r = await fetch(BASE + '/api/kv/' + key, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(r.status).send(await r.text());
      return;
    }
    res.status(405).json({ error: 'GET or POST' });
  } catch (e) {
    res.status(502).json({ error: 'store unreachable', detail: String((e && e.message) || e) });
  }
}
