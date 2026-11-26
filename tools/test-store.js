// Tests for api/_lib/store.js: the read-change-write that protects the suggestions queue,
// and auto-clean. Runs against a fake copy of the store that behaves like the real one
// (versions, and 409 when the version you read is stale), so no server or network is used.
//
//   cd hub && /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc -m tools/test-store.js
//
// store.js imports Node's fs and path, which this engine does not have, so the test loads
// its source with those two lines swapped for stand-ins. Everything else is the real code.
import * as L from '../api/_lib/logic.js';

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; print('  ok    ' + name); }
  else { fail++; print('  FAIL  ' + name + (detail !== undefined ? '   -> ' + JSON.stringify(detail) : '')); }
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b }); }
function group(t) { print('\n' + t); }

// ---- a fake store with the real contract -------------------------------------------
const db = {};                       // key -> { value, version }
let reads = 0, writes = 0, conflicts = 0;
let failNextWrites = 0;              // make the next N writes hit a 409, as if someone else wrote first
let files = {};                      // what "the deploy" has on disk
let siteUp = true;
const tick = () => new Promise((r) => setTimeout(r, Math.floor(Math.random() * 4)));
function res(status, body) { return { ok: status >= 200 && status < 300, status: status, json: async () => body, text: async () => JSON.stringify(body) }; }

globalThis.process = { env: { HUB_API_BASE: 'https://store.test', HUB_API_TOKEN: 't' }, cwd: () => '/app' };
globalThis.__fs = { readFileSync: (p) => { const n = p.replace('/app/', ''); if (!(n in files)) throw new Error('ENOENT'); return files[n]; } };
globalThis.__path = { join: (a, b) => a + '/' + b };
globalThis.fetch = async function (url, opts) {
  await tick();
  if (url.indexOf('https://store.test/api/kv/') === 0) {
    const key = url.split('/api/kv/')[1];
    const row = db[key] || { value: null, version: 0 };
    if (!opts || !opts.method || opts.method === 'GET') { reads++; return res(200, { key: key, value: JSON.parse(JSON.stringify(row.value)), version: row.version }); }
    const body = JSON.parse(opts.body);
    if (failNextWrites > 0) { failNextWrites--; conflicts++; db[key] = { value: row.value, version: row.version + 1 }; return res(409, { error: 'version conflict' }); }
    if (body.if_version !== row.version) { conflicts++; return res(409, { error: 'version conflict', version: row.version }); }
    writes++;
    db[key] = { value: JSON.parse(JSON.stringify(body.value)), version: row.version + 1 };
    return res(200, { key: key, value: body.value, version: row.version + 1 });
  }
  if (url.indexOf(L.SITE + '/') === 0) {
    const n = url.slice(L.SITE.length + 1).split('?')[0];
    if (!siteUp || !(n in files)) return res(404, {});
    return res(200, JSON.parse(files[n]));
  }
  throw new Error('unexpected fetch ' + url);
};

// ---- load the real store.js with fs/path stand-ins ----------------------------------
// Run from the repo root. The two throwaway copies it writes are git-ignored.
const src = readFile('api/_lib/store.js')
  .replace("import fs from 'node:fs';", 'const fs = globalThis.__fs;')
  .replace("import path from 'node:path';", 'const path = globalThis.__path;')
  .replace("from './logic.js'", "from '../api/_lib/logic.js'");
ok(src.indexOf('node:') < 0, 'test harness: store.js loaded with stand-ins for fs and path');
writeFile('tools/.store-under-test.mjs', src);
writeFile('tools/.store-under-test-2.mjs', src);
const S = await import('./.store-under-test.mjs');

const append = (key, item) => S.kvUpdate(key, (v) => ({ feedback: L.listOf(v).concat([item]) }));

group('Read-change-write');
{
  await append('q1', { id: 'a' });
  eq(db.q1, { value: { feedback: [{ id: 'a' }] }, version: 1 }, 'a first write creates the key at version 1');
  await append('q1', { id: 'b' });
  eq([db.q1.value.feedback.length, db.q1.version], [2, 2], 'a second write adds to it and bumps the version');
  const w = writes;
  const r = await S.kvUpdate('q1', () => undefined);
  ok(r.changed === false && writes === w, 'returning undefined writes nothing at all');

  failNextWrites = 3;
  await append('q1', { id: 'c' });
  eq(db.q1.value.feedback.map((f) => f.id), ['a', 'b', 'c'], 'if someone else writes first (3 times in a row), it re-reads and still lands');

  failNextWrites = 99;
  let threw = '';
  try { await append('q1', { id: 'never' }); } catch (e) { threw = String(e.message); }
  failNextWrites = 0;
  ok(/too busy/.test(threw), 'if it can never get a clean write it gives up with a clear error', threw);
  ok(db.q1.value.feedback.every((f) => f.id !== 'never'), 'and nothing half-written is left behind');
}

group('Many people at the same moment');
{
  // Control: the old way (read the list, add to it, write it all back with no version check).
  db.naive = { value: { feedback: [] }, version: 0 };
  const naive = async (i) => {
    const r = await (await fetch('https://store.test/api/kv/naive')).json();
    await tick();
    const next = { feedback: r.value.feedback.concat([{ id: 'n' + i }]) };
    db.naive = { value: next, version: db.naive.version + 1 };   // unconditional write: last one wins
  };
  await Promise.all(Array.from({ length: 30 }, (_, i) => naive(i)));
  const kept = db.naive.value.feedback.length;
  ok(kept < 30, 'control: the old unprotected way LOSES suggestions under the same load (kept ' + kept + ' of 30)');

  const before = conflicts;
  await Promise.all(Array.from({ length: 30 }, (_, i) => append('q2', { id: 's' + i })));
  const got = db.q2.value.feedback.map((f) => f.id).sort();
  eq(got.length, 30, 'the new way: 30 suggestions sent at the same instant, all 30 are saved');
  eq(new Set(got).size, 30, 'with no duplicates');
  ok(conflicts > before, 'and it really was contended (' + (conflicts - before) + ' collisions caught and retried)');
  eq(db.q2.version, 30, 'exactly 30 writes went through, one per suggestion');
}

group('The real add-a-suggestion path, under load');
{
  const send = async (i) => {
    const now = Date.now();
    const made = L.buildSuggestion({ text: 'idea ' + i, by: 'P' + (i % 3), page: 'guide' }, now);
    let outcome = {};
    await S.kvUpdate('beam-feedback', (v) => { outcome = L.addSuggestion(L.listOf(v), made.entry, now); return outcome.list ? { feedback: outcome.list } : undefined; });
    return outcome;
  };
  const outs = await Promise.all(Array.from({ length: 25 }, (_, i) => send(i)));
  eq(L.listOf(db['beam-feedback'].value).length, 25, '25 people submitting at once: all 25 are in the queue');
  ok(outs.every((o) => o.list), 'every one of them was told it was saved');
  const dupOut = await send(7);
  ok(dupOut.duplicate && L.listOf(db['beam-feedback'].value).length === 25, 'a double-click on Send does not create a second copy');
}

group('Auto-clean');
{
  const q = L.listOf(db['beam-feedback'].value);
  const builtId = q[0].id, declinedId = q[1].id, secret = q[0].text;
  files = { 'whatsnew.json': JSON.stringify({ entries: [{ id: 'x', at: new Date().toISOString(), title: 'Shipped it', what: 'w', resolves: [builtId] }], declined: [declinedId] }) };

  let r = await S.reconcileSuggestions();
  eq(r.removed.map((f) => f.id).sort(), [builtId, declinedId].sort(), 'the built one and the declined one are cleared');
  eq(r.open.length, 23, 'the other 23 are still open');
  eq(L.listOf(db['beam-feedback'].value).length, 23, 'and they are really gone from the store, not just hidden');
  eq(r.changelogSource, 'file', 'it read the changelog that shipped with the deploy');
  const log = db['beam-feedback-closed'].value.closed;
  eq(log.map((x) => x.outcome).sort(), ['built', 'declined'], 'the tally records one built and one passed on');
  ok(JSON.stringify(db['beam-feedback-closed']).indexOf(secret) < 0, 'the cleared suggestion\'s words are not kept anywhere');

  const w = writes;
  r = await S.reconcileSuggestions();
  ok(r.removed.length === 0 && writes === w && db['beam-feedback-closed'].value.closed.length === 2, 'running it again changes nothing and writes nothing');

  // Someone adds a suggestion at the same moment auto-clean runs: it must survive.
  const third = L.listOf(db['beam-feedback'].value)[0].id;
  files['whatsnew.json'] = JSON.stringify({ entries: [], declined: [builtId, declinedId, third] });
  const late = L.buildSuggestion({ text: 'sent during the clean-up', by: 'Nate' }, Date.now()).entry;
  await Promise.all([S.reconcileSuggestions(), S.kvUpdate('beam-feedback', (v) => ({ feedback: L.listOf(v).concat([late]) })), S.reconcileSuggestions()]);
  const after = L.listOf(db['beam-feedback'].value).map((f) => f.id);
  ok(after.indexOf(late.id) >= 0, 'a suggestion sent while auto-clean is running is not lost');
  ok(after.indexOf(third) < 0 && after.length === 23, 'and the finished one is still cleared (exactly once)');
  eq(db['beam-feedback-closed'].value.closed.filter((x) => x.id === third).length, 1, 'two clean-ups at once tally it once, not twice');

  // The changelog cannot be read: do nothing rather than guess.
  const n = L.listOf(db['beam-feedback'].value).length;
  files = {}; siteUp = false;
  r = await S.reconcileSuggestions();
  ok(r.removed.length === 0 && r.open.length === n && r.changelog === null && r.changelogSource === 'none', 'if the changelog cannot be read, nothing is removed');

  // Not on disk but reachable on the site: use that.
  siteUp = true;
  files = { 'whatsnew.json': JSON.stringify({ entries: [], declined: [late.id] }) };
  globalThis.__fs = { readFileSync: () => { throw new Error('ENOENT'); } };
  const S2 = await import('./.store-under-test-2.mjs');   // a fresh copy, loaded after fs was swapped
  r = await S2.reconcileSuggestions();
  ok(r.changelogSource === 'site' && r.removed.length === 1 && r.removed[0].id === late.id, 'if the file is not bundled, it falls back to the public copy and still cleans');
}

group('Store problems are reported, not swallowed');
{
  const real = globalThis.fetch;
  globalThis.fetch = async () => res(500, { error: 'boom' });
  let threw = '';
  try { await S.kvGet('x'); } catch (e) { threw = String(e.message); }
  ok(/store read failed \(HTTP 500\)/.test(threw), 'a store outage is an error the caller sees', threw);
  globalThis.fetch = async () => res(200, { key: 'x', value: null });
  threw = '';
  try { await S.kvGet('x'); } catch (e) { threw = String(e.message); }
  ok(/does not report versions/.test(threw), 'a store without versioning is refused rather than used unsafely', threw);
  globalThis.fetch = real;
}

print('\n' + (fail ? 'FAILED: ' + fail + ' of ' + (pass + fail) + ' checks failed' : 'ALL ' + pass + ' CHECKS PASSED'));
