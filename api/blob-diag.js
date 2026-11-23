// Temporary diagnostic: dynamically import the Blob client and undici inside
// try/catch so the function itself loads, and report the exact load error.
// Delete after the upload path is fixed.
export default async function handler(req, res) {
  const out = { node: process.version, hasBlobToken: !!process.env.BLOB_READ_WRITE_TOKEN };
  try {
    const mod = await import('@vercel/blob/client');
    out.client = 'loaded: ' + Object.keys(mod).join(',');
  } catch (e) {
    out.clientError = String((e && e.stack) || e).split('\n').slice(0, 6).join(' | ');
  }
  try {
    const u = await import('undici');
    out.undici = 'loaded: ' + Object.keys(u).slice(0, 10).join(',');
  } catch (e) {
    out.undiciError = String((e && e.stack) || e).split('\n').slice(0, 6).join(' | ');
  }
  res.status(200).json(out);
}
