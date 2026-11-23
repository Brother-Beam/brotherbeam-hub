// Streams a private Blob file to the browser as a download. The Library's
// files are private (not reachable by their raw URL), so the page links here
// instead. Gated by the hub password. Uses the RW token server-side via get().
import { get } from '@vercel/blob';
import { Readable } from 'node:stream';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (String((req.query && req.query.pw) || '').toLowerCase() !== 'beam') { res.status(401).json({ error: 'unauthorized' }); return; }
  const pathname = (req.query && req.query.path) || '';
  if (!pathname) { res.status(400).json({ error: 'no path' }); return; }
  try {
    const r = await get(String(pathname), { access: 'private' });
    if (!r || r.statusCode !== 200 || !r.stream) { res.status(404).json({ error: 'not found' }); return; }
    const raw = (req.query && req.query.name) ? String(req.query.name) : String(pathname).split('/').pop();
    const fname = raw.replace(/[\r\n"\\]/g, '').slice(0, 200) || 'file';
    res.setHeader('content-type', (r.blob && r.blob.contentType) || 'application/octet-stream');
    res.setHeader('content-disposition', 'attachment; filename="' + fname + '"');
    if (r.blob && r.blob.size) res.setHeader('content-length', String(r.blob.size));
    Readable.fromWeb(r.stream).pipe(res);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
