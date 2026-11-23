// Issues the short-lived client token the browser uses to upload a file
// straight to Vercel Blob (so large files like decks skip the serverless
// body limit). Needs BLOB_READ_WRITE_TOKEN. Open (no password).
//
// handleUpload is imported DYNAMICALLY inside the handler: a top-level
// `import ... from '@vercel/blob/client'` crashes this function at load on
// Vercel (FUNCTION_INVOCATION_FAILED), while a runtime import() resolves
// cleanly. Keep it dynamic.
export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  try {
    const { handleUpload } = await import('@vercel/blob/client');
    const body = (req.body && typeof req.body === 'object') ? req.body : (function () { try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; } })();
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
    res.status(500).json({ error: String((error && error.message) || error), hasToken: !!process.env.BLOB_READ_WRITE_TOKEN });
  }
}
