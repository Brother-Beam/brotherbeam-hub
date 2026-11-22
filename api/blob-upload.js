// Issues the short-lived client token the browser uses to upload a document
// straight to Vercel Blob (so large files skip the serverless body limit).
// Requires BLOB_READ_WRITE_TOKEN (added when the Blob store is linked with the
// read-write token checkbox). Gate: the client must send the hub password.
import { handleUpload } from '@vercel/blob/client';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  let body;
  try { body = await request.json(); } catch (e) { return Response.json({ error: 'bad body' }, { status: 400 }); }
  try {
    const json = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        let pw = '';
        try { pw = String(JSON.parse(clientPayload || '{}').pw || '').toLowerCase(); } catch (e) {}
        if (pw !== 'beam') throw new Error('unauthorized');
        return { addRandomSuffix: true, maximumSizeInBytes: 50 * 1024 * 1024 };
      },
    });
    return Response.json(json);
  } catch (error) {
    return Response.json({ error: (error && error.message) || 'upload error' }, { status: 400 });
  }
}
