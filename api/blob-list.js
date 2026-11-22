// Lists the files in the Blob store, newest first. Gated by the hub password.
// Plain Node function. Uses BLOB_READ_WRITE_TOKEN from the environment.
import { list } from '@vercel/blob';

export default async function handler(req, res) {
  if (String((req.query && req.query.pw) || '').toLowerCase() !== 'beam') { res.status(401).json({ error: 'unauthorized' }); return; }
  try {
    const { blobs } = await list();
    const files = blobs
      .map(function (b) { return { url: b.url, downloadUrl: b.downloadUrl, pathname: b.pathname, size: b.size, uploadedAt: b.uploadedAt }; })
      .sort(function (a, b) { return new Date(b.uploadedAt) - new Date(a.uploadedAt); });
    res.status(200).json({ files: files });
  } catch (error) {
    res.status(500).json({ error: (error && error.message) || 'list error' });
  }
}
