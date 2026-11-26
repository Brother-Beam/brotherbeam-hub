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

// ---- the real endpoints, run against the fake store ---------------------------------
// Loads api/<name>.js with its two imports pointed at the copies above, and calls it the
// way Vercel would: handler(req, res).
async function loadHandler(name) {
  const s = readFile('api/' + name + '.js')
    .replace("from './_lib/logic.js'", "from '../api/_lib/logic.js'")
    .replace("from './_lib/store.js'", "from './.store-under-test.mjs'")
    .replace("from './_lib/mail.js'", "from './.mail-under-test.mjs'");
  writeFile('tools/.' + name + '-under-test.mjs', s);
  return (await import('./.' + name + '-under-test.mjs')).default;
}
function hit(handler, method, body, query) {
  const res = { code: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; }, send(o) { this.body = o; return this; } };
  return handler({ method: method, body: body, query: query || {}, headers: {} }, res).then(() => res);
}
siteUp = true;
files = { 'roadmap.json': JSON.stringify({ now: [{ id: 'outline' }], next: [{ id: 'process' }, { id: 'sandbox' }] }), 'whatsnew.json': '{"entries":[],"declined":[]}' };

group('Board endpoint');
{
  const board = await loadHandler('board');
  // What is really in the store today looks like this: posts with no ids, saved by the old page.
  const oldPosts = [{ by: 'Nate Treadwell', at: '2026-11-24T22:03:00.000Z', text: 'real post one' }, { by: 'Michael FitzGerald', at: '2026-11-22T02:20:00.000Z', text: 'real post two' }];
  db['beam-progress'] = { value: { items: { outline: { status: 'progress', by: 'someone', at: '2026-11-23T20:00:00.000Z' } }, messages: JSON.parse(JSON.stringify(oldPosts)) }, version: 7 };

  let r = await hit(board, 'GET');
  eq([r.code, r.body.messages, Object.keys(r.body.items), r.body.sandbox], [200, oldPosts, ['outline'], false], 'GET returns the board exactly as stored');
  r = await hit(board, 'POST', { action: 'post', by: 'Pat', text: 'hello' });
  eq([r.code, r.body.ok, r.body.board.messages.length], [201, true, 3], 'a post is added, and the reply carries the whole up-to-date board');
  eq(db['beam-progress'].value.messages.slice(0, 2), oldPosts, 'the posts that were already there are untouched');
  r = await hit(board, 'POST', { action: 'post', by: 'Pat', text: 'hello' });
  eq([r.code, r.body.duplicate, db['beam-progress'].value.messages.length], [200, true, 3], 'a double-click does not post twice');
  r = await hit(board, 'POST', { action: 'post', by: 'Pat', text: '' });
  eq(r.code, 400, 'an empty post is refused');
  r = await hit(board, 'POST', { action: 'status', id: 'process', status: 'blocked', by: 'Nate' });
  eq([r.code, r.body.board.items.process.status, r.body.board.items.outline.status, r.body.board.messages.length], [200, 'blocked', 'progress', 3], 'a status change touches only its own step');
  r = await hit(board, 'POST', { action: 'status', id: 'ghost', status: 'done' });
  eq(r.code, 400, 'a step that is not on the roadmap is refused');
  r = await hit(board, 'POST', { action: 'wipe' });
  eq(r.code, 400, 'an unknown action is refused');
  r = await hit(board, 'POST', { action: 'reset' });
  eq([r.code, db['beam-progress'].value.messages.length], [400, 3], 'the real board cannot be reset');
  r = await hit(board, 'PUT', { items: {}, messages: [] });
  eq([r.code, db['beam-progress'].value.messages.length], [405, 3], 'the whole board cannot be overwritten');
  r = await hit(board, 'DELETE');
  eq(r.code, 405, 'nothing can be deleted');

  // The bug this replaces. Pat has the page open; Nate posts; Pat, whose page has not
  // refreshed, changes a status.
  db.oldway = { value: { items: {}, messages: [{ by: 'A', at: 't', text: 'already there' }] }, version: 1 };
  const patsCopy = JSON.parse(JSON.stringify(db.oldway.value));                    // Pat opens the page
  db.oldway.value.messages.push({ by: 'Nate', at: 't2', text: 'Nate posts' });      // Nate posts
  patsCopy.items.outline = { status: 'done' };                                      // Pat changes a status...
  db.oldway.value = patsCopy;                                                       // ...and his page saves its whole copy
  ok(!db.oldway.value.messages.some((m) => m.text === 'Nate posts'), 'control: the old whole-page save ERASES a post made while your page was open');

  const before = db['beam-progress'].value.messages.length;
  await hit(board, 'POST', { action: 'post', by: 'Nate', text: 'Nate posts while Pat has the page open' });
  r = await hit(board, 'POST', { action: 'status', id: 'outline', status: 'done', by: 'Pat' });
  const now = db['beam-progress'].value;
  ok(now.messages.some((m) => m.text.indexOf('Nate posts') === 0) && now.items.outline.status === 'done', 'the new way: Pat\'s status change and Nate\'s post both survive');
  eq(r.body.board.messages.length, before + 1, 'and Pat\'s page is handed the up-to-date board, Nate\'s post included');

  const c0 = conflicts, jobs = [];
  for (let i = 0; i < 20; i++) jobs.push(hit(board, 'POST', { action: 'post', by: 'P' + (i % 3), text: 'burst ' + i }));
  ['outline', 'process', 'sandbox'].forEach((id, i) => jobs.push(hit(board, 'POST', { action: 'status', id: id, status: ['todo', 'progress', 'done'][i], by: 'S' + i })));
  const outs = await Promise.all(jobs);
  const v = db['beam-progress'].value;
  ok(outs.every((o) => o.code === 201 || o.code === 200), '20 posts and 3 status changes at the same instant: every one is accepted', outs.map((o) => o.code));
  eq(v.messages.filter((m) => m.text.indexOf('burst ') === 0).length, 20, 'all 20 posts are on the board');
  eq([v.items.outline.status, v.items.process.status, v.items.sandbox.status], ['todo', 'progress', 'done'], 'all 3 status changes took');
  eq(v.messages.slice(0, 2), oldPosts, 'and the original posts are still first, still untouched');
  ok(conflicts > c0, 'it really was contended (' + (conflicts - c0) + ' collisions caught and retried)');

  const realBefore = JSON.stringify(db['beam-progress']);
  r = await hit(board, 'POST', { action: 'post', by: 'T', text: 'sandbox post' }, { sandbox: '1' });
  eq([r.code, db['beam-progress-sandbox'].value.messages.length, JSON.stringify(db['beam-progress']) === realBefore], [201, 1, true], 'sandbox: a post goes to separate storage and the real board is not touched');
  r = await hit(board, 'POST', { action: 'status', id: 'sandbox', status: 'blocked', by: 'T' }, { sandbox: '1' });
  eq([r.code, db['beam-progress-sandbox'].value.items.sandbox.status, JSON.stringify(db['beam-progress']) === realBefore], [200, 'blocked', true], 'sandbox: a status change likewise');
  r = await hit(board, 'GET', null, { sandbox: '1' });
  eq([r.body.sandbox, r.body.messages.length], [true, 1], 'sandbox: reading shows the sandbox, and says so');
  r = await hit(board, 'POST', { action: 'reset' }, { sandbox: '1' });
  eq([r.code, db['beam-progress-sandbox'].value, JSON.stringify(db['beam-progress']) === realBefore], [200, { items: {}, messages: [] }, true], 'sandbox: it can be emptied, and the real board is still untouched');
}

group('Meetings endpoint');
{
  const meetings = await loadHandler('meetings');
  const real = [
    { id: 'm1795394285335', date: '2026-11-21', title: 'First Partner Call', disc: 'real one', decisions: ['d'], actionItems: [{ item: 'i', owner: 'All' }], prog: '', by: 'Mike', at: '2026-11-22T00:00:00.000Z', source: 'manual' },
    { id: 'm1795483143658', date: '2026-11-22', title: 'Second', disc: 'real two', decisions: [], actionItems: [], prog: '', by: 'Mike', at: '2026-11-23T00:00:00.000Z', source: 'ai' },
  ];
  db['beam-meetings'] = { value: { meetings: JSON.parse(JSON.stringify(real)) }, version: 4 };

  let r = await hit(meetings, 'GET');
  eq([r.code, r.body.meetings, r.body.sandbox], [200, real, false], 'GET returns the log exactly as stored');
  r = await hit(meetings, 'POST', { action: 'add', meeting: { id: 'mHACK', date: '2026-11-25', title: 'By hand', disc: 'talked', prog: 'moved', by: 'Pat' } });
  ok(r.code === 201 && r.body.meeting.id !== 'mHACK' && r.body.meetings.length === 3, 'a meeting is added, with an id the server chose');
  eq(db['beam-meetings'].value.meetings.slice(0, 2), real, 'the meetings already logged are untouched');
  const addedId = r.body.meeting.id;
  r = await hit(meetings, 'POST', { action: 'add', meeting: { date: '2026-11-25', title: 'By hand', disc: 'talked', prog: 'moved', by: 'Pat' } });
  eq([r.code, r.body.duplicate, r.body.meeting.id, db['beam-meetings'].value.meetings.length], [200, true, addedId, 3], 'pressing Add twice logs it once');
  r = await hit(meetings, 'POST', { action: 'add', meeting: { title: 'nothing in it' } });
  eq(r.code, 400, 'an empty meeting is refused');
  r = await hit(meetings, 'POST', { action: 'remove' });
  eq(r.code, 400, 'remove with no id is refused');
  r = await hit(meetings, 'POST', { action: 'remove', id: 'mNOPE' });
  eq([r.code, r.body.removed, r.body.meetings.length], [200, false, 3], 'removing one that is not there changes nothing and is not an error');
  r = await hit(meetings, 'POST', { action: 'remove', id: addedId });
  eq([r.code, r.body.removed, db['beam-meetings'].value.meetings], [200, true, real], 'removing takes out exactly that meeting and leaves the rest as they were');
  r = await hit(meetings, 'POST', { action: 'reset' });
  eq([r.code, db['beam-meetings'].value.meetings.length], [400, 2], 'the real log cannot be reset');
  r = await hit(meetings, 'PUT', { meetings: [] });
  eq([r.code, db['beam-meetings'].value.meetings.length], [405, 2], 'the whole log cannot be overwritten');

  // The bug this replaces: Pat removes a meeting on a page that has not refreshed since Nate logged one.
  db.oldlog = { value: { meetings: [{ id: 'a' }, { id: 'b' }] }, version: 1 };
  const patsCopy = JSON.parse(JSON.stringify(db.oldlog.value));
  db.oldlog.value.meetings.push({ id: 'c', title: 'Nate logs a meeting' });
  patsCopy.meetings = patsCopy.meetings.filter((m) => m.id !== 'a');
  db.oldlog.value = patsCopy;
  ok(!db.oldlog.value.meetings.some((m) => m.id === 'c'), 'control: the old whole-page save ERASES a meeting logged while your page was open');

  const c0 = conflicts, jobs = [];
  for (let i = 0; i < 10; i++) jobs.push(hit(meetings, 'POST', { action: 'add', meeting: { date: '2026-11-26', title: 'Burst ' + i, disc: 'notes ' + i, by: 'P' + (i % 3), source: i % 2 ? 'ai' : 'manual' } }));
  jobs.push(hit(meetings, 'POST', { action: 'remove', id: real[0].id }));
  jobs.push(hit(meetings, 'POST', { action: 'remove', id: real[0].id }));
  const outs = await Promise.all(jobs);
  const list = db['beam-meetings'].value.meetings;
  ok(outs.every((o) => o.code === 200 || o.code === 201), '10 meetings logged while two people remove another: every request is accepted', outs.map((o) => o.code));
  eq(list.filter((m) => /^Burst /.test(m.title)).length, 10, 'all 10 new meetings are saved');
  ok(!list.some((m) => m.id === real[0].id), 'the removed meeting is gone');
  eq(list.find((m) => m.id === real[1].id), real[1], 'the meeting nobody touched is exactly as it was');
  eq(outs.slice(10).filter((o) => o.body.removed).length, 1, 'two people removing the same meeting: it is removed once, and neither sees an error');
  eq(new Set(list.map((m) => m.id)).size, list.length, 'every meeting has its own id');
  ok(conflicts > c0, 'it really was contended (' + (conflicts - c0) + ' collisions caught and retried)');

  const realBefore = JSON.stringify(db['beam-meetings']);
  r = await hit(meetings, 'POST', { action: 'add', meeting: { disc: 'sandbox meeting', by: 'T' } }, { sandbox: '1' });
  eq([r.code, db['beam-meetings-sandbox'].value.meetings.length, JSON.stringify(db['beam-meetings']) === realBefore], [201, 1, true], 'sandbox: a meeting goes to separate storage and the real log is not touched');
  r = await hit(meetings, 'POST', { action: 'remove', id: r.body.meeting.id }, { sandbox: '1' });
  eq([r.body.removed, db['beam-meetings-sandbox'].value.meetings.length, JSON.stringify(db['beam-meetings']) === realBefore], [true, 0, true], 'sandbox: removing likewise');
  await hit(meetings, 'POST', { action: 'add', meeting: { disc: 'another', by: 'T' } }, { sandbox: '1' });
  r = await hit(meetings, 'POST', { action: 'reset' }, { sandbox: '1' });
  eq([r.code, db['beam-meetings-sandbox'].value, JSON.stringify(db['beam-meetings']) === realBefore], [200, { meetings: [] }, true], 'sandbox: it can be emptied, and the real log is still untouched');
}

group('Suggestion alerts, end to end (with a fake mailbox)');
{
  // A stand-in for api/_lib/mail.js: records what would have been sent, and can be told to fail.
  writeFile('tools/.mail-under-test.mjs', 'export function mailReady() { return globalThis.__mail.ready; }\nexport function adminAddress() { return "mike@hub.test"; }\nexport async function sendMail(to, subject, html, text) { return globalThis.__mail.send(to, subject, html, text); }\n');
  const box = globalThis.__mail = {
    ready: true, fail: false, sent: [],
    async send(to, subject, html, text) { await tick(); if (this.fail) return { ok: false, error: 'smtp down' }; this.sent.push({ to: to, subject: subject, html: html, text: text }); return { ok: true }; },
  };
  const feedback = await loadHandler('feedback');
  const stored = () => L.listOf(db['beam-feedback'].value);
  const reset = (list) => { db['beam-feedback'] = { value: { feedback: list || [] }, version: (db['beam-feedback'] ? db['beam-feedback'].version : 0) + 1 }; box.sent = []; box.fail = false; box.ready = true; };
  const patch = (id, fields) => { const cur = db['beam-feedback']; db['beam-feedback'] = { value: { feedback: cur.value.feedback.map((e) => e.id === id ? Object.assign({}, e, fields) : e) }, version: cur.version + 1 }; };
  const minsAgo = (n) => new Date(Date.now() - n * 60000).toISOString();
  const last = () => box.sent[box.sent.length - 1];
  files['whatsnew.json'] = '{"entries":[],"declined":[]}';
  reset();

  let r = await hit(feedback, 'POST', { by: 'Nate', text: 'Make the logo bigger', page: 'index' });
  eq([r.code, r.body.alert, box.sent.length], [201, 'sent', 1], 'a suggestion is saved and Mike is emailed at once');
  eq([box.sent[0].to, box.sent[0].subject], [['mike@hub.test'], 'Suggestion from Nate: Make the logo bigger'], 'the email goes to Mike only, and says who and what');
  ok(box.sent[0].html.indexOf('Make the logo bigger') > 0 && box.sent[0].html.indexOf('on Our Vision') > 0 && box.sent[0].html.indexOf('Ref ' + r.body.entry.id) > 0, 'with the full text, the page it came from, and its reference');
  ok(stored()[0].mailed && !stored()[0].mailClaim, 'and it is recorded as mailed');
  eq(Object.keys(r.body.entry), ['id', 'by', 'at', 'text', 'page'], 'the page that sent it is not shown the private marks');
  r = await hit(feedback, 'GET');
  eq([Object.keys(r.body.open[0]), box.sent.length], [['id', 'by', 'at', 'text', 'page'], 1], 'reading the queue shows no private marks and sends nothing more');
  r = await hit(feedback, 'POST', { by: 'Nate', text: 'Make the logo bigger', page: 'index' });
  eq([r.body.duplicate, box.sent.length, stored().length], [true, 1, 1], 'a double-click does not email twice');

  box.fail = true;
  r = await hit(feedback, 'POST', { by: 'Pat', text: 'Sent while mail was down', page: 'guide' });
  eq([r.code, r.body.alert, stored().length, box.sent.length], [201, 'failed', 2, 1], 'if the email fails, the suggestion is still saved and its sender still sees it accepted');
  const pat = stored()[1];
  ok(!pat.mailed && !!pat.mailClaim, 'and it stays marked as not yet mailed');
  box.fail = false;
  await hit(feedback, 'GET');
  eq(box.sent.length, 1, 'a read straight afterwards does not hammer the mail server with a retry');
  patch(pat.id, { at: minsAgo(10), mailClaim: minsAgo(6) });      // a few minutes pass
  await hit(feedback, 'GET');
  eq([box.sent.length, last().subject, !!stored()[1].mailed], [2, 'Suggestion from Pat: Sent while mail was down', true], 'a few minutes later, anyone simply opening the queue sends the alert that failed');
  await hit(feedback, 'GET');
  eq(box.sent.length, 2, 'and it is not sent a second time');

  reset();
  box.ready = false;
  r = await hit(feedback, 'POST', { by: 'Mike', text: 'Sent before email was set up', page: 'build' });
  eq([r.code, r.body.alert, box.sent.length, stored().length], [201, 'off', 0, 1], 'before email is set up, suggestions save normally and nothing is sent');
  await hit(feedback, 'POST', { by: 'Nate', text: 'Another one before setup', page: 'guide' });
  await hit(feedback, 'GET');
  eq(box.sent.length, 0, 'reading the queue sends nothing either while email is off');
  box.ready = true;                                              // Mike adds the two settings
  stored().forEach((e) => patch(e.id, { at: minsAgo(30) }));
  await hit(feedback, 'GET');
  eq([box.sent.length, last().subject], [1, '2 suggestions waiting in the hub'], 'once email is set up, the ones that were waiting go out together in one email');
  ok(last().text.indexOf('Sent before email was set up') > 0 && last().text.indexOf('Another one before setup') > 0 && stored().every((e) => e.mailed), 'with every one of them in it');

  reset([{ id: 'fwaiting001', by: 'Pat', at: minsAgo(10), text: 'Waiting for its alert', page: 'guide' }]);
  await Promise.all([hit(feedback, 'GET'), hit(feedback, 'GET'), hit(feedback, 'GET'), hit(feedback, 'GET')]);
  eq(box.sent.length, 1, 'four people opening the queue at the same moment send that alert once, not four times');

  reset([{ id: 'folder00001', by: 'Pat', at: minsAgo(10), text: 'Older, never mailed', page: 'guide' }]);
  r = await hit(feedback, 'POST', { by: 'Nate', text: 'Newer', page: 'index' });
  eq([r.body.alert, box.sent.length, last().subject], ['sent', 1, '2 suggestions waiting in the hub'], 'a new suggestion takes an older unsent one along in the same email');
  ok(last().text.indexOf('Older, never mailed') < last().text.indexOf('Newer') && stored().every((e) => e.mailed), 'oldest first, and both are then marked as mailed');

  reset();
  const burst = await Promise.all([1, 2, 3, 4, 5].map((i) => hit(feedback, 'POST', { by: 'P' + i, text: 'At the same moment ' + i, page: 'guide' })));
  ok(burst.every((o) => o.code === 201) && stored().length === 5, 'five suggestions at the same instant are all saved');
  const mentioned = [1, 2, 3, 4, 5].filter((i) => box.sent.some((mail) => mail.text.indexOf('At the same moment ' + i) >= 0));
  eq(mentioned.length, 5, 'and every one of them reaches Mike');
  const times = [1, 2, 3, 4, 5].map((i) => box.sent.filter((mail) => mail.text.indexOf('At the same moment ' + i) >= 0).length);
  ok(times.every((n) => n === 1), 'each exactly once', times);

  const sixSent = [1, 2, 3, 4, 5, 6].map((i) => ({ id: 'fsent00000' + i, by: 'Nate', at: minsAgo(9), text: 'earlier ' + i, page: 'guide', mailed: minsAgo(i) }));
  reset(sixSent);
  r = await hit(feedback, 'POST', { by: 'Nate', text: 'The seventh in ten minutes', page: 'guide' });
  eq([r.code, r.body.alert, box.sent.length, stored().length], [201, 'held', 0, 7], 'after six alert emails in ten minutes, the next suggestion is saved but its email is held');
  sixSent.forEach((e, i) => patch(e.id, { mailed: minsAgo(11 + i) }));
  patch(stored()[6].id, { at: minsAgo(3) });
  await hit(feedback, 'GET');
  eq([box.sent.length, last().subject], [1, 'Suggestion from Nate: The seventh in ten minutes'], 'and it goes out as soon as the ten minutes have passed');

  reset();
  r = await hit(feedback, 'POST', { by: 'Claude (testing)', text: 'TEST load', page: 'guide', quiet: true });
  eq([r.body.alert, box.sent.length, stored()[0].mailed], ['skipped', 0, 'skip'], 'a quiet load-test suggestion emails nobody');
  patch(stored()[0].id, { at: minsAgo(30) });
  await hit(feedback, 'GET');
  eq(box.sent.length, 0, 'not later either');
  r = await hit(feedback, 'POST', { by: 'Claude (testing)', text: 'TEST alert check', page: 'guide' });
  ok(r.body.alert === 'sent' && last().subject === '[Test] Suggestion from Claude (testing): TEST alert check', 'a test that is not quiet does email, marked [Test]');
  r = await hit(feedback, 'POST', { by: 'Nate', text: 'A real one asking to be quiet', page: 'guide', quiet: true });
  eq([r.body.alert, box.sent.length], ['sent', 2], 'a real suggestion cannot be made quiet');

  reset([{ id: 'fcleared001', by: 'Pat', at: minsAgo(10), text: 'Built before its alert went out', page: 'guide' }]);
  files['whatsnew.json'] = JSON.stringify({ entries: [{ id: 'x', at: minsAgo(1), title: 'Done', what: 'w', resolves: ['fcleared001'] }], declined: [] });
  r = await hit(feedback, 'GET');
  eq([r.body.count, r.body.cleared, box.sent.length], [0, 1, 0], 'a suggestion already built and cleared is not emailed about afterwards');
  files['whatsnew.json'] = '{"entries":[],"declined":[]}';
}

group('Mail settings (the real module)');
{
  writeFile('tools/.mailreal-under-test.mjs', readFile('api/_lib/mail.js').replace("from './logic.js'", "from '../api/_lib/logic.js'"));
  const M = await import('./.mailreal-under-test.mjs');
  const env = process.env;
  eq([M.mailReady(), M.provider(), M.adminAddress()], [false, null, ''], 'with nothing set, the hub cannot send, and knows it');
  env.DIGEST_TO = 'mike@gmail.test, nate@x.test,pat@y.test';
  eq([M.mailReady(), M.adminAddress(), M.recipients().length], [false, 'mike@gmail.test', 3], 'the recipient list alone is not enough; the first address is the one alerts go to');
  env.GMAIL_APP_PASSWORD = 'abcd efgh ijkl mnop';
  eq([M.mailReady(), M.provider()], [true, 'gmail'], 'the list plus the app password: ready, sending as the first address');
  delete env.DIGEST_TO;
  eq([M.mailReady(), M.provider()], [false, null], 'an app password with nobody to send to is not ready');
  env.GMAIL_USER = 'hub@gmail.test';
  eq([M.provider(), M.mailReady()], ['gmail', false], 'naming a Gmail account still needs the recipient list');
  env.DIGEST_TO = 'mike@gmail.test';
  env.RESEND_API_KEY = 'k'; env.DIGEST_FROM = 'Beam <hub@beam.test>';
  eq(M.provider(), 'resend', 'a Resend key and sender take over from Gmail');
  const out = await M.sendMail(['a@b.test'], 's', 'h', 't', 1);
  ok(out.ok === false && typeof out.error === 'string' && out.error.length > 0, 'a send that blows up is reported as a failure, never thrown', out);
  eq(M.redact('Invalid login for mike.f@gmail.com (nate@x.org), see <pat@y.co>'), 'Invalid login for [address] ([address]), see <[address]>', 'addresses in an error message are masked');
  ['DIGEST_TO', 'GMAIL_APP_PASSWORD', 'GMAIL_USER', 'RESEND_API_KEY', 'DIGEST_FROM'].forEach((k) => { delete env[k]; });
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
