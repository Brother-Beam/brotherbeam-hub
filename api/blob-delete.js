// Removes one file from the Blob store. POST only. Open (no password).
// Plain Node function. Uses BLOB_READ_WRITE_TOKEN from the environment.
import { del } from '@vercel/blob';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  if (String((req.query && req.query.pw) || '').toLowerCase() !== 'beam') { res.status(401).json({ error: 'unauthorized' }); return; }
  const target = (req.query && req.query.url) || '';
  if (!target) { res.status(400).json({ error: 'no url' }); return; }
  try {
    await del(String(target));
    res.status(200).json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: (error && error.message) || 'delete error' });
  }
}
