// Lists the files in the Library (the private Blob store), newest first. Gated by the
// hub password. Uses BLOB_READ_WRITE_TOKEN from the environment.
//
// Listing is also how the hub notices an upload: the Library page lists right after it
// uploads, and any file newer than the last one Mike was told about triggers an alert
// email to him (see _lib/alerts.js). The page says who it is in an "x-hub-by" header after
// its own upload, so Mike is not emailed about files he uploaded himself.
import { list } from '@vercel/blob';
import { activityItems } from './_lib/logic.js';
import { alertActivity } from './_lib/alerts.js';

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  if (String((req.query && req.query.pw) || '').toLowerCase() !== 'scooter') { res.status(401).json({ error: 'unauthorized' }); return; }
  try {
    const { blobs } = await list();
    const files = blobs
      .map(function (b) { return { url: b.url, downloadUrl: b.downloadUrl, pathname: b.pathname, size: b.size, uploadedAt: b.uploadedAt }; })
      .sort(function (a, b) { return new Date(b.uploadedAt) - new Date(a.uploadedAt); });
    const by = String((req.headers && req.headers['x-hub-by']) || '').slice(0, 40);
    await alertActivity('files', activityItems.files(blobs, by));     // never throws; cannot break the listing
    res.status(200).json({ files: files });
  } catch (error) {
    res.status(500).json({ error: (error && error.message) || 'list error' });
  }
}
