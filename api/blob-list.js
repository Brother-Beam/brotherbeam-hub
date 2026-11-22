// Lists the documents in the Blob store, newest first. Gated by the hub
// password. Uses BLOB_READ_WRITE_TOKEN from the environment.
import { list } from '@vercel/blob';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  const url = new URL(request.url);
  if (String(url.searchParams.get('pw') || '').toLowerCase() !== 'beam') {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const { blobs } = await list();
    const files = blobs
      .map(function (b) { return { url: b.url, downloadUrl: b.downloadUrl, pathname: b.pathname, size: b.size, uploadedAt: b.uploadedAt }; })
      .sort(function (a, b) { return new Date(b.uploadedAt) - new Date(a.uploadedAt); });
    return Response.json({ files: files });
  } catch (error) {
    return Response.json({ error: (error && error.message) || 'list error' }, { status: 500 });
  }
}
