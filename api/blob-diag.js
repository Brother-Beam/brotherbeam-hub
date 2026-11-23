// Temporary diagnostic: report which relevant env-var NAMES are present in
// production (names only, never values), and whether a Blob list() works.
// This tells us if BLOB_READ_WRITE_TOKEN / ANTHROPIC_API_KEY are actually
// reaching the live (Production) functions. Delete after setup is confirmed.
export default async function handler(req, res) {
  const out = {
    node: process.version,
    vercelEnv: process.env.VERCEL_ENV || '(none)',
    hasBlobToken: !!process.env.BLOB_READ_WRITE_TOKEN,
    hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
    relatedEnvNames: Object.keys(process.env).filter(function (k) { return /BLOB|ANTHROPIC|OIDC/i.test(k); }).sort(),
  };
  try {
    const { list } = await import('@vercel/blob');
    const r = await list();
    out.list = 'ok, count=' + ((r && r.blobs) ? r.blobs.length : '?');
  } catch (e) {
    out.listError = String((e && e.message) || e);
  }
  res.status(200).json(out);
}
