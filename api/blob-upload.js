// Issues the short-lived client token the browser uses to upload a file
// straight to Vercel Blob (so large files like decks skip the serverless
// body limit). Plain Node function (not edge). Needs BLOB_READ_WRITE_TOKEN,
// added when the Blob store is linked with the read-write token checkbox.
// Gated: the client must send the hub password in clientPayload.
import { handleUpload } from '@vercel/blob/client';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  const body = (req.body && typeof req.body === 'object') ? req.body : (function () { try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; } })();
  try {
    const json = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        let pw = '';
        try { pw = String(JSON.parse(clientPayload || '{}').pw || '').toLowerCase(); } catch (e) {}
        if (pw !== 'beam') throw new Error('unauthorized');
        return { addRandomSuffix: true, maximumSizeInBytes: 50 * 1024 * 1024 };
      },
    });
    res.status(200).json(json);
  } catch (error) {
    res.status(400).json({ error: (error && error.message) || 'upload error' });
  }
}
