// Everything the weekly summary is built from, gathered in one place, so the hub's own
// scheduled send (digest.js) and the outbox (outbox.js) build exactly the same email.
// Files under api/_lib are not routes.
import { list } from '@vercel/blob';
import { kvGet, loadSiteJson, reconcileSuggestions } from './store.js';

// Every file in the Library, or null if the Library cannot be read. null means "unknown",
// so the summary shows a dash rather than a made-up zero.
export async function libraryFiles() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    let all = [], cursor;
    for (let i = 0; i < 10; i++) {
      const page = await list(cursor ? { cursor: cursor } : undefined);
      all = all.concat(page.blobs || []);
      if (!page.hasMore || !page.cursor) break;
      cursor = page.cursor;
    }
    return all;
  } catch (e) { return null; }
}

// What compose() needs. Cleans the suggestions queue first, so the counts are true. Throws
// if the changelog or the roadmap cannot be read: better no email than a hollow one.
export async function gatherWeek() {
  const rec = await reconcileSuggestions();
  if (!rec.changelog) throw new Error('could not read whatsnew.json');
  const got = await Promise.all([kvGet('beam-progress'), kvGet('beam-meetings'), kvGet('beam-feedback-closed'), loadSiteJson('roadmap.json'), libraryFiles()]);
  if (!got[3].data) throw new Error('could not read roadmap.json');
  return { whatsnew: rec.changelog, open: rec.open, progress: got[0].value, meetings: got[1].value, closed: got[2].value, roadmap: got[3].data, files: got[4] };
}
