// Server-side access to the shared store (brotherbeam-api on Railway) and to the hub's
// own data files (whatsnew.json, roadmap.json). Files under api/_lib are not routes.
import fs from 'node:fs';
import path from 'node:path';
import { SITE, listOf, closedMap, splitClosed, closedRecords } from './logic.js';

const BASE = (process.env.HUB_API_BASE || '').replace(/\/+$/, '');
const TOKEN = process.env.HUB_API_TOKEN || '';

export function storeReady() { return !!(BASE && TOKEN); }

function headers(extra) { return Object.assign({ accept: 'application/json', authorization: 'Bearer ' + TOKEN }, extra || {}); }
function sleep(n) { return new Promise(function (r) { setTimeout(r, n); }); }

export async function kvGet(key) {
  const r = await fetch(BASE + '/api/kv/' + key, { headers: headers() });
  if (!r.ok) throw new Error('store read failed (HTTP ' + r.status + ')');
  const j = await r.json();
  if (typeof j.version !== 'number') throw new Error('the store does not report versions; deploy brotherbeam-api');
  return { value: j.value, version: j.version };
}

// Writes only if the key is still at the version we read. ok:false means someone else wrote first.
export async function kvPutIf(key, value, version) {
  const r = await fetch(BASE + '/api/kv/' + key, {
    method: 'PUT', headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ value: value, if_version: version }),
  });
  if (r.status === 409) return { ok: false };
  if (!r.ok) throw new Error('store write failed (HTTP ' + r.status + ')');
  return { ok: true };
}

// Read, change, write back, without ever erasing someone else's write. change(value)
// returns the new value, or undefined to leave the key alone. If another writer gets in
// between the read and the write, this reads again and redoes the change on fresh data.
// change() can therefore run more than once: it must not have side effects that add up.
export async function kvUpdate(key, change) {
  for (let i = 0; i < 8; i++) {
    const cur = await kvGet(key);
    const next = change(cur.value);
    if (next === undefined) return { value: cur.value, changed: false };
    const put = await kvPutIf(key, next, cur.version);
    if (put.ok) return { value: next, changed: true };
    await sleep(30 + Math.random() * 90 * (i + 1));
  }
  throw new Error('the store was too busy to save this; try again');
}

// Reads one of the hub's own JSON files. The copy bundled with this function is the one
// that shipped in the same deploy; the public URL is a fallback if it is not on disk.
export async function loadSiteJson(name) {
  try {
    return { data: JSON.parse(fs.readFileSync(path.join(process.cwd(), name), 'utf8')), source: 'file' };
  } catch (e) { /* not bundled: fall through to the public copy */ }
  try {
    const r = await fetch(SITE + '/' + name + '?t=' + Date.now(), { headers: { accept: 'application/json' } });
    if (r.ok) return { data: await r.json(), source: 'site' };
  } catch (e) { /* fall through */ }
  return { data: null, source: 'none' };
}

// Auto-clean. A suggestion is finished when the deployed whatsnew.json says so: named in
// an entry's "resolves" (built) or listed under "declined" (passed on). This removes every
// finished suggestion from the queue and returns what is still open. Nobody tidies by
// hand; it runs whenever the queue is read and before each weekly email.
// If the changelog cannot be read, nothing is removed.
export async function reconcileSuggestions() {
  const cl = await loadSiteJson('whatsnew.json');
  const closed = closedMap(cl.data);
  let removed = [];
  let value;
  if (Object.keys(closed).length) {
    const out = await kvUpdate('beam-feedback', function (v) {
      const parts = splitClosed(listOf(v), closed);
      removed = parts.removed;
      return parts.removed.length ? { feedback: parts.keep } : undefined;
    });
    value = out.value;
  } else {
    value = (await kvGet('beam-feedback')).value;
  }
  if (removed.length) {
    // Keep a tally for the weekly email: who, when, built or passed on. Never the text.
    const records = closedRecords(removed, closed, new Date().toISOString());
    try {
      await kvUpdate('beam-feedback-closed', function (v) {
        const log = (v && Array.isArray(v.closed)) ? v.closed : [];
        const have = {};
        log.forEach(function (x) { have[x.id] = 1; });
        const add = records.filter(function (x) { return !have[x.id]; });
        return add.length ? { closed: log.concat(add).slice(-200) } : undefined;
      });
    } catch (e) { /* the queue is already clean; the tally is best-effort */ }
  }
  return { open: listOf(value), removed: removed, changelog: cl.data, changelogSource: cl.source };
}
