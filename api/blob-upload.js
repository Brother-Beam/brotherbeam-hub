// Issues the short-lived client token the browser uses to upload a file
// straight to Vercel Blob (so large files like decks skip the serverless
// body limit). Plain Node function (not edge). Needs BLOB_READ_WRITE_TOKEN.
// Open (no password).
import { handleUpload } from '@vercel/blob/client';

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
    const body = (req.body && typeof req.body === 'object') ? req.body : (function () { try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; } })();
    const json = await handleUpload({
      body,
      request: req,
      token: process.env.BLOB_READ_WRITE_TOKEN,
      onBeforeGenerateToken: async () => {
        return { addRandomSuffix: true, maximumSizeInBytes: 50 * 1024 * 1024 };
      },
    });
    res.status(200).json(json);
  } catch (error) {
    res.status(500).json({
      where: 'blob-upload',
      hasToken: !!process.env.BLOB_READ_WRITE_TOKEN,
      message: String((error && error.message) || error),
      stack: String((error && error.stack) || '').split('\n').slice(0, 5).join(' | '),
    });
  }
}
