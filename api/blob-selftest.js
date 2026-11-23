// Temporary self-test: writes a tiny file to the Blob store, reads the count,
// then deletes it — proving read+write+delete work with the real token,
// server-side, leaving nothing behind. Delete this file after confirming.
import { put, del, list } from '@vercel/blob';

export default async function handler(req, res) {
  try {
    const before = (await list()).blobs.length;
    const r = await put('beam-selftest.txt', 'ok ' + new Date().toISOString(), { access: 'public', addRandomSuffix: true, contentType: 'text/plain' });
    const afterWrite = (await list()).blobs.length;
    await del(r.url);
    const afterDelete = (await list()).blobs.length;
    res.status(200).json({ ok: true, wrote: r.pathname, before: before, afterWrite: afterWrite, afterDelete: afterDelete });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
