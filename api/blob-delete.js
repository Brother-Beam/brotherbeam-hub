// Removes one document from the Blob store. POST only, gated by the hub
// password. Uses BLOB_READ_WRITE_TOKEN from the environment.
import { del } from '@vercel/blob';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405 });
  const url = new URL(request.url);
  if (String(url.searchParams.get('pw') || '').toLowerCase() !== 'beam') {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  const target = url.searchParams.get('url');
  if (!target) return Response.json({ error: 'no url' }, { status: 400 });
  try {
    await del(target);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: (error && error.message) || 'delete error' }, { status: 500 });
  }
}
