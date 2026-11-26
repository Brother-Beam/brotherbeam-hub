// Unit tests for api/_lib/logic.js. No server, no network, no Node needed. Run with the
// JavaScript engine that ships with macOS:
//
//   /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc -m tools/test-logic.js
//
// Prints one line per check and a total. "FAIL" anywhere means do not deploy.
import * as L from '../api/_lib/logic.js';

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; print('  ok    ' + name); }
  else { fail++; print('  FAIL  ' + name + (detail !== undefined ? '   -> ' + JSON.stringify(detail) : '')); }
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b }); }
function group(t) { print('\n' + t); }

const NOW = Date.UTC(2026, 10, 30, 1, 5);          // Mon Nov 30 2026 01:05 UTC = Sun Nov 29 18:05 Mountain
const ago = (days) => new Date(NOW - days * L.DAY_MS).toISOString();

// ---------------------------------------------------------------- suggestions
group('Suggestions: validating what the box sends');
{
  let r = L.buildSuggestion({ text: '   ', by: 'Nate' }, NOW);
  ok(!r.ok && r.status === 400, 'empty text is refused');
  r = L.buildSuggestion({ text: 'x'.repeat(L.MAX_TEXT + 1) }, NOW);
  ok(!r.ok && r.status === 400 && /2001/.test(r.error), 'over-long text is refused and says how long it was', r.error);
  r = L.buildSuggestion({ text: 'x'.repeat(L.MAX_TEXT) }, NOW);
  ok(r.ok, 'text exactly at the limit is accepted');
  r = L.buildSuggestion({ text: '  Make the logo bigger\r\nplease \u0007 ', by: '  Nate   Treadwell ', page: 'index' }, NOW);
  ok(r.ok, 'a normal suggestion is accepted');
  eq(r.entry.text, 'Make the logo bigger\nplease', 'text is trimmed, line endings normalised, control characters removed');
  eq(r.entry.by, 'Nate Treadwell', 'name is trimmed and inner spaces collapsed');
  eq(r.entry.page, 'index', 'page is kept');
  eq(r.entry.at, new Date(NOW).toISOString(), 'timestamp is set by the server');
  ok(L.isSuggestionId(r.entry.id), 'id has the expected shape', r.entry.id);
  r = L.buildSuggestion({ text: 'hi', by: '', page: '../../etc/passwd' }, NOW);
  eq([r.entry.by, r.entry.page], ['someone', 'hub'], 'missing name becomes "someone"; a bad page becomes "hub"');
  r = L.buildSuggestion({ text: 'hi', by: 'n'.repeat(90) }, NOW);
  eq(r.entry.by.length, L.MAX_NAME, 'a very long name is cut to the limit');
  r = L.buildSuggestion(null, NOW);
  ok(!r.ok, 'a missing body is refused, not a crash');
  r = L.buildSuggestion({ text: { evil: 1 } }, NOW);
  ok(r.ok && r.entry.text === '[object Object]', 'a non-string text cannot break anything');
  const ids = {}; let clash = 0;
  for (let i = 0; i < 2000; i++) { const id = L.newId(NOW); if (ids[id]) clash++; ids[id] = 1; }
  ok(clash === 0, '2,000 ids made in the same millisecond are all different', clash);
}

group('Suggestions: adding to the queue');
{
  const a = L.buildSuggestion({ text: 'one', by: 'Pat' }, NOW).entry;
  let r = L.addSuggestion([], a, NOW);
  eq(r.list.length, 1, 'first suggestion is added');
  const again = L.buildSuggestion({ text: 'one', by: 'Pat' }, NOW + 5000).entry;
  r = L.addSuggestion([a], again, NOW + 5000);
  ok(r.duplicate && r.duplicate.id === a.id && !r.list, 'same person + same text within 2 minutes is a double-click, not a second entry');
  r = L.addSuggestion([a], L.buildSuggestion({ text: 'one', by: 'Nate' }, NOW + 5000).entry, NOW + 5000);
  eq(r.list.length, 2, 'same text from a different person is kept');
  const later = L.buildSuggestion({ text: 'one', by: 'Pat' }, NOW + 10 * 60000).entry;
  r = L.addSuggestion([a], later, NOW + 10 * 60000);
  eq(r.list.length, 2, 'same person + same text ten minutes later is kept');
  const full = []; for (let i = 0; i < L.MAX_OPEN; i++) full.push({ id: 'fx' + i, by: 'x', text: 't' + i, at: ago(1) });
  r = L.addSuggestion(full, a, NOW);
  ok(r.full && !r.list, 'a full queue refuses the new one instead of silently dropping an old one');
  eq(full.length, L.MAX_OPEN, 'and the queue itself is untouched');
}

// ---------------------------------------------------------------- auto-clean
group('Auto-clean: which suggestions are finished');
{
  const cl = {
    entries: [
      { id: 'a', at: ago(1), title: 'Bigger logo', what: '...', resolves: ['fbuilt0001', 'fboth00001'] },
      { id: 'b', at: ago(2), title: 'No resolves field' },
      { id: 'c', title: 'No date, so not a real entry', resolves: ['fnodate001'] },
    ],
    declined: ['fdeclined01', 'fboth00001', 'not-an-id', 42, null],
  };
  const m = L.closedMap(cl);
  eq(m.fbuilt0001, 'built', 'named in an entry\'s resolves -> built');
  eq(m.fdeclined01, 'declined', 'listed under declined -> declined');
  eq(m.fboth00001, 'built', 'in both -> built wins');
  ok(!('not-an-id' in m) && !('42' in m) && !('null' in m), 'things that are not suggestion ids are ignored');
  ok(!('fnodate001' in m), 'an entry with no date is not live, so it closes nothing');
  eq(Object.keys(L.closedMap(null)).length, 0, 'no changelog -> nothing is closed');
  eq(Object.keys(L.closedMap({ entries: 'oops', declined: 'oops' })).length, 0, 'a malformed changelog -> nothing is closed');

  const queue = [{ id: 'fbuilt0001', by: 'Nate', text: 'secret words' }, { id: 'fopen00001', by: 'Pat', text: 'keep me' }, { id: 'fdeclined01', by: 'Mike', text: 'no' }];
  const s = L.splitClosed(queue, m);
  eq(s.keep.map((f) => f.id), ['fopen00001'], 'only the open one stays in the queue');
  eq(s.removed.map((f) => f.id), ['fbuilt0001', 'fdeclined01'], 'the finished ones are removed');
  const rec = L.closedRecords(s.removed, m, 'T');
  eq(rec, [{ id: 'fbuilt0001', by: 'Nate', outcome: 'built', closedAt: 'T' }, { id: 'fdeclined01', by: 'Mike', outcome: 'declined', closedAt: 'T' }], 'the tally records who/when/outcome');
  ok(JSON.stringify(rec).indexOf('secret words') < 0, 'and never keeps the text of a cleared suggestion');
  eq(L.splitClosed(queue, { constructor: 'built', toString: 'built' }).removed.length, 0, 'odd keys in the map cannot remove anything by accident');
  eq(L.splitClosed([{ id: 'constructor' }], {}).removed.length, 0, 'an id like "constructor" is not treated as closed');
}

// ---------------------------------------------------------------- schedule
group('Schedule: Sunday 6 PM Mountain, in both halves of the year');
{
  const at = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo - 1, d, h, mi));
  eq(L.localParts(at(2026, 7, 13, 0, 5)), { weekday: 'Sun', date: '2026-07-12', hour: 18, minute: 5 }, 'summer: Mon 00:05 UTC is Sun 18:05 Mountain (daylight time)');
  eq(L.localParts(at(2026, 11, 30, 1, 5)), { weekday: 'Sun', date: '2026-11-29', hour: 18, minute: 5 }, 'winter: Mon 01:05 UTC is Sun 18:05 Mountain (standard time)');
  eq(L.localParts(at(2026, 11, 29, 7, 0)).hour, 0, 'midnight is hour 0, never 24');

  ok(L.decide(at(2026, 7, 13, 0, 5), {}).send, 'summer, first slot (6 PM): sends');
  ok(L.decide(at(2026, 7, 13, 1, 5), {}).send, 'summer, second slot (7 PM): would send if the first had failed');
  ok(!L.decide(at(2026, 7, 13, 1, 5), { lastSent: '2026-07-12' }).send, 'summer, second slot after a good send: skips');
  ok(!L.decide(at(2026, 11, 30, 0, 5), {}).send, 'winter, first slot (5 PM): too early, skips');
  ok(L.decide(at(2026, 11, 30, 1, 5), {}).send, 'winter, second slot (6 PM): sends');
  ok(!L.decide(at(2026, 11, 26, 16, 0), {}).send, 'a Thursday morning: skips');
  ok(!L.decide(at(2026, 11, 29, 18, 0), {}).send, 'Sunday 11 AM Mountain: skips');
  ok(!L.decide(at(2026, 11, 30, 3, 5), {}).send, 'Sunday 8 PM Mountain: outside the window, skips');
  ok(L.decide(at(2026, 11, 30, 1, 5), { lastSent: '2026-11-22' }).send, 'last week\'s send does not block this week');
  ok(!L.decide(at(2026, 11, 30, 1, 5), { claim: { date: '2026-11-29', at: at(2026, 11, 30, 1, 4).toISOString() } }).send, 'another run claimed it a minute ago: skips');
  ok(L.decide(at(2026, 11, 30, 1, 35), { claim: { date: '2026-11-29', at: at(2026, 11, 30, 1, 4).toISOString() } }).send, 'a claim abandoned 31 minutes ago no longer blocks');

  // Walk every week for three years, firing both cron slots (with Hobby-plan jitter of up
  // to 59 minutes), and require exactly one send per week, always in the 6 PM hour.
  let weeks = 0, bad = [];
  const state = {};
  for (let t = Date.UTC(2026, 0, 5); t < Date.UTC(2029, 0, 1); t += 7 * L.DAY_MS) {   // Jan 5 2026 is a Monday
    weeks++;
    let sends = 0, hour = null;
    [0, 1].forEach(function (slot) {
      const jitter = (weeks * 7 + slot * 13) % 60;
      const when = new Date(t + slot * 3600000 + jitter * 60000);
      const d = L.decide(when, state);
      if (d.send) { sends++; hour = d.local.hour; state.lastSent = d.local.date; if (d.local.weekday !== 'Sun') bad.push('not sunday ' + when.toISOString()); }
    });
    if (sends !== 1 || hour !== 18) bad.push(new Date(t).toISOString().slice(0, 10) + ' sends=' + sends + ' hour=' + hour);
  }
  ok(bad.length === 0, 'three years of Sundays (' + weeks + ' weeks, across 6 clock changes): exactly one send each, always 6 PM', bad.slice(0, 5));

  // And if the first attempt fails in summer, the second slot picks it up.
  let retried = 0;
  for (let t = Date.UTC(2026, 5, 1); t < Date.UTC(2026, 8, 1); t += 7 * L.DAY_MS) {
    if (L.decide(new Date(t + 20 * 60000), {}).send && L.decide(new Date(t + 80 * 60000), {}).send) retried++;
  }
  ok(retried >= 12, 'summer weeks get a second chance an hour later if the first send fails', retried);
}

group('Recipients');
{
  eq(L.parseRecipients('a@x.com, B@y.org;c@z.io  d@w.co'), ['a@x.com', 'B@y.org', 'c@z.io', 'd@w.co'], 'commas, semicolons and spaces all separate addresses');
  eq(L.parseRecipients('a@x.com,A@X.COM, a@x.com'), ['a@x.com'], 'the same address twice (any case) is sent once');
  eq(L.parseRecipients('nope, a@b, @x.com, ok@fine.com, <x@y.com>'), ['ok@fine.com'], 'things that are not addresses are dropped');
  eq(L.parseRecipients(undefined), [], 'not set -> nobody');
}

// ---------------------------------------------------------------- the email
group('The email: a busy week');
const busy = {
  whatsnew: { entries: [
    { id: 'n1', at: ago(1), title: 'Suggest a change, from any page', what: 'A box at the bottom of every page.', suggestedBy: 'Nate', resolves: ['fbuilt0001'] },
    { id: 'n0', at: ago(40), title: 'ANCIENT FEATURE', what: 'too old to mention' },
  ] },
  roadmap: {
    now: [{ id: 'outline', own: 'Pat', t: 'Outline a deliverable' }],
    next: [{ id: 'process', own: 'All three', t: 'Develop the process' }, { id: 'sandbox', own: 'All three', t: 'Put together the sandbox offer' }],
  },
  progress: {
    items: { outline: { status: 'progress', by: 'Pat', at: ago(2) }, process: { status: 'blocked', by: 'Nate', at: ago(30) }, ghost: { status: 'done', by: 'x', at: ago(1) } },
    messages: [
      { by: 'Pat', at: ago(2), text: 'Outline draft is coming along, aiming for Friday.' },
      { by: 'Nate <script>alert(1)</script>', at: ago(3), text: 'Tom & Jerry\'s "deal" <b>closed</b>' },
      { by: 'Nate', at: ago(30), text: 'STALE POST' },
    ],
  },
  meetings: { meetings: [
    { id: 'm1', at: ago(3), date: '2026-11-26', title: 'Weekly sync', disc: 'Talked through the deliverable outline and next steps for the sandbox partner.', decisions: ['Pat owns the outline', 'Price the sandbox small'], actionItems: [{ owner: 'Pat', item: 'Send outline draft' }, { owner: 'Nate', item: 'List three sandbox candidates' }, { item: 'Unowned thing' }], source: 'ai', by: 'Mike' },
    { id: 'm2', date: '2026-11-25', title: '', disc: '', prog: 'Typed in by hand: agreed on the name.', decisions: [], actionItems: [], source: 'manual', by: 'Mike' },
    { id: 'm0', at: ago(20), date: '2026-11-09', title: 'STALE MEETING', disc: 'old' },
  ] },
  files: [
    { pathname: 'Beam Deck v2-AbCdEfGhIjKlMnOpQrStUvWx.pptx', uploadedAt: ago(1), size: 1 },
    { pathname: 'folder/Business case-ZyXwVuTsRqPoNmLkJiHgFeDc.pdf', uploadedAt: ago(4), size: 1 },
    { pathname: 'STALE-AbCdEfGhIjKlMnOpQrStUvWx.pdf', uploadedAt: ago(20), size: 1 },
  ],
  open: [{ id: 'fopen00001' }, { id: 'fopen00002' }],
  closed: { closed: [{ id: 'fbuilt0001', by: 'Nate', outcome: 'built', closedAt: ago(1) }, { id: 'fdeclined01', by: 'Pat', outcome: 'declined', closedAt: ago(2) }, { id: 'fold000001', by: 'x', outcome: 'built', closedAt: ago(30) }] },
};
{
  const c = L.compose(busy, NOW);
  eq(c.counts, { meetings: 2, files: 2, posts: 2, roadmapUpdates: 1, features: 1, openSuggestions: 2, built: 1, declined: 1, quiet: false }, 'counts are right, and only this week\'s items are counted');
  eq(c.subject, 'Beam · our week in the hub (Nov 23 – Nov 29)', 'subject names the week in Mountain dates');
  const h = c.html;
  ok(!/undefined|NaN|\[object Object\]|null/.test(h), 'no "undefined", "NaN", "null" or "[object Object]" anywhere in the email');
  ok(h.indexOf('<script>') < 0 && h.indexOf('&lt;script&gt;alert(1)&lt;/script&gt;') > 0, 'anything a person typed is escaped, so it can never run as code');
  ok(h.indexOf('Tom &amp; Jerry&#39;s &quot;deal&quot; &lt;b&gt;closed&lt;/b&gt;') > 0, 'quotes, ampersands and tags in a post show as typed');
  ok(!/STALE|ANCIENT/.test(h), 'nothing older than a week appears');
  ok(h.indexOf('Beam Deck v2.pptx') > 0 && h.indexOf('Business case.pdf') > 0 && h.indexOf('AbCdEfGh') < 0, 'file names are shown clean, without the storage suffix');
  ok(h.indexOf('3 files in the Library in all') > 0, 'the Library total is shown');
  ok(h.indexOf('Where we stand') > 0 && h.indexOf('Outline a deliverable') > 0 && h.indexOf('In progress') > 0 && h.indexOf('updated by Pat on Nov 27') > 0, 'roadmap shows each step, its status, and this week\'s update');
  ok(h.indexOf('Blocked') > 0 && h.indexOf('updated by Nate') < 0, 'a status changed weeks ago still shows, without claiming it moved this week');
  ok(h.indexOf('Put together the sandbox offer') > 0 && h.indexOf('Not started') > 0, 'a step nobody has touched shows as Not started');
  ok(h.indexOf('ghost') < 0, 'a status for a step that is no longer on the roadmap is ignored');
  ok(h.indexOf('Weekly sync') > 0 && h.indexOf('Thu, Nov 26') > 0, 'meeting shows its title and its own date');
  ok(h.indexOf('Pat owns the outline') > 0 && h.indexOf('List three sandbox candidates') > 0, 'decisions and action items are included');
  ok(h.indexOf('Unassigned') > 0, 'an action item with no owner is labelled Unassigned');
  ok(h.indexOf('Typed in by hand: agreed on the name.') > 0 && h.indexOf('Wed, Nov 25') > 0, 'a hand-typed meeting with no title and no log time is still included, by its date');
  ok(h.indexOf('Suggested by Nate') > 0, 'a new feature credits who suggested it');
  ok(h.indexOf('2 suggestions open in the queue on Our RoadMap, 1 built this week and 1 passed on.') > 0, 'the suggestions line is right');
  ok(h.indexOf(L.SITE + '/guide.html') > 0, 'the button links to the hub');
  const opens = (h.match(/<table/g) || []).length, closes = (h.match(/<\/table>/g) || []).length;
  eq(opens, closes, 'every table that opens also closes (' + opens + ')');
  eq((h.match(/<tr/g) || []).length, (h.match(/<\/tr>/g) || []).length, 'every row that opens also closes');
  eq((h.match(/<td/g) || []).length, (h.match(/<\/td>/g) || []).length, 'every cell that opens also closes');
  eq((h.match(/<div/g) || []).length, (h.match(/<\/div>/g) || []).length, 'every div that opens also closes');
  ok(h.length < 60000, 'small enough that Gmail will not clip it (' + h.length + ' bytes)');
  const t = c.text;
  ok(/WHERE WE STAND/.test(t) && /MEETINGS LOGGED/.test(t) && /NEW IN THE LIBRARY/.test(t) && /ON THE BOARD/.test(t) && /NEW IN THE HUB/.test(t) && /SUGGESTIONS/.test(t), 'the plain-text version has every section');
  ok(!/undefined|NaN|\[object Object\]|<\/?(table|tr|td|div|span|br|a )|style=|&amp;|&middot;/.test(t), 'the plain-text version has no junk and none of the HTML template leaks into it');
  ok(t.indexOf('Tom & Jerry\'s "deal" <b>closed</b>') > 0, 'and it shows what people typed exactly as typed');
  if (typeof writeFile === 'function' && typeof PREVIEW_OUT === 'string') writeFile(PREVIEW_OUT, h);
}

group('The email: edge cases');
{
  let c = L.compose({ roadmap: busy.roadmap, whatsnew: { entries: [] }, files: [] }, NOW);
  ok(c.counts.quiet, 'a week with no activity is recognised as quiet');
  ok(/a quiet week/.test(c.subject), 'and the subject says so');
  ok(c.html.indexOf('A quiet week in the hub. Here is where things stand.') > 0 && c.html.indexOf('Where we stand') > 0, 'a quiet week still shows where the roadmap stands');
  ok(c.html.indexOf('Meetings logged') < 0 && c.html.indexOf('New in the Library') < 0 && c.html.indexOf('>Suggestions<') < 0, 'and leaves out the empty sections');
  ok(!/undefined|NaN|\[object Object\]/.test(c.html + c.text), 'no junk in a quiet email');

  c = L.compose({}, NOW);
  ok(c.html.length > 500 && !/undefined|NaN/.test(c.html), 'even with nothing at all, composing does not crash');

  c = L.compose(Object.assign({}, busy, { files: null }), NOW);
  eq(c.counts.files, null, 'if the Library cannot be read, the count is "unknown", not a made-up zero');
  ok(c.html.indexOf('New in the Library') < 0 && c.html.indexOf('–</div>') > 0, 'and the email shows a dash there');

  const many = { roadmap: busy.roadmap, progress: { messages: [] }, meetings: { meetings: [] }, files: [] };
  for (let i = 0; i < 30; i++) {
    many.progress.messages.push({ by: 'P', at: ago(1), text: 'post ' + i + ' ' + 'word '.repeat(200) });
    many.meetings.meetings.push({ at: ago(1), date: '2026-11-28', title: 'M' + i, disc: 'd '.repeat(500), decisions: new Array(20).fill('a decision'), actionItems: new Array(20).fill({ owner: 'Pat', item: 'do it' }) });
    many.files.push({ pathname: 'f' + i + '.pdf', uploadedAt: ago(1) });
  }
  c = L.compose(many, NOW);
  ok(c.html.indexOf('+ 25 more on Meeting Minutes') > 0 && c.html.indexOf('+ 22 more on Our RoadMap') > 0 && c.html.indexOf('+ 18 more on Our Library') > 0, 'a very busy week is capped, and says how many more there are');
  ok(c.html.indexOf('+ 15 more') > 0 && c.html.indexOf('+ 12 more') > 0, 'long decision and action lists are capped too');
  ok(c.html.length < 100000, 'even a huge week stays under Gmail\'s clipping size (' + c.html.length + ' bytes)');
}

group('The email: wording');
{
  const c = L.compose(Object.assign({}, busy, { progress: { items: { outline: { status: 'done', by: 'someone', at: ago(2) }, process: { status: 'progress', at: ago(1) } }, messages: [] } }), NOW);
  ok(c.html.indexOf('Pat · updated Nov 27') > 0 && c.html.indexOf('updated Nov 28') > 0, 'a status changed by someone who gave no name reads "updated Nov 27"');
  ok(!/by someone/i.test(c.html + c.text), 'and never "updated by someone"');
}

group('Test data stays out of the email');
{
  ok(L.isTestEntry({ by: 'Claude (testing)' }) && L.isTestEntry({ by: '<b>Claude</b> (Testing) ' }), 'a name ending in "(testing)" marks test data');
  ok(!L.isTestEntry({ by: 'Nate' }) && !L.isTestEntry({ by: 'testing Nate' }) && !L.isTestEntry({ by: '(testing) Nate' }) && !L.isTestEntry({}) && !L.isTestEntry(null), 'ordinary names are never mistaken for test data');
  const rec = L.closedRecords([{ id: 'ftest00001', by: 'Claude (testing)', text: 'x' }, { id: 'freal00001', by: 'Nate', text: 'y' }], { ftest00001: 'declined', freal00001: 'built' }, 'T');
  eq(rec, [{ id: 'ftest00001', by: 'Claude (testing)', outcome: 'declined', closedAt: 'T', test: true }, { id: 'freal00001', by: 'Nate', outcome: 'built', closedAt: 'T' }], 'a cleared test suggestion is tallied like any other, flagged as a test');
  const d = Object.assign({}, busy, {
    open: [{ id: 'fopen00001', by: 'Pat' }, { id: 'ftest00002', by: 'Claude (testing)' }, { id: 'ftest00003', by: 'Claude (testing)' }],
    closed: { closed: [{ id: 'fbuilt0001', by: 'Nate', outcome: 'built', closedAt: ago(1) }, { id: 'ftest00001', by: 'Claude (testing)', outcome: 'declined', closedAt: ago(1), test: true }] },
  });
  let c = L.compose(d, NOW);
  eq([c.counts.openSuggestions, c.counts.built, c.counts.declined], [1, 1, 0], 'the email counts only real suggestions');
  ok(c.html.indexOf('1 suggestion open in the queue on Our RoadMap and 1 built this week.') > 0 && c.html.indexOf('passed on') < 0, 'and its wording reflects only the real ones');
  c = L.compose(d, NOW, { includeTests: true });
  eq([c.counts.openSuggestions, c.counts.built, c.counts.declined], [3, 1, 1], 'the preview can count test data on request, to check the pipeline end to end');
  c = L.compose(Object.assign({}, d, { open: [{ id: 'ftest00002', by: 'Claude (testing)' }], closed: { closed: [{ id: 'ftest00001', by: 'x', outcome: 'declined', closedAt: ago(1), test: true }] }, whatsnew: { entries: [] }, meetings: null, files: [], progress: null }), NOW);
  ok(c.counts.quiet && c.html.indexOf('>Suggestions<') < 0, 'a week with nothing but test activity is still a quiet week');
}

// ---------------------------------------------------------------- suggestion alerts
group('Suggestion alerts: which ones get emailed, and when');
{
  const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
  const mk = (id, ageMs, extra) => Object.assign({ id: id, by: 'Nate', at: iso(ageMs), text: 't ' + id, page: 'guide' }, extra || {});
  const MIN = 60000;

  eq(L.buildSuggestion({ text: 'TEST', by: 'Claude (testing)', quiet: true }, NOW).entry.mailed, 'skip', 'a load test can ask to email nobody');
  ok(!('mailed' in L.buildSuggestion({ text: 'real', by: 'Nate', quiet: true }, NOW).entry), 'a real suggestion cannot: it always alerts');
  ok(!('mailed' in L.buildSuggestion({ text: 'TEST', by: 'Claude (testing)' }, NOW).entry), 'a test that does not ask to be quiet alerts too');

  const fresh = mk('fnew0000001', 0);
  eq(L.pickForAlert([fresh], NOW, 'fnew0000001'), ['fnew0000001'], 'the suggestion just sent is picked');
  eq(L.pickForAlert([fresh], NOW), [], 'a read does not pick one sent seconds ago (the submit itself is emailing it)');
  eq(L.pickForAlert([mk('fold0000001', 2 * MIN)], NOW), ['fold0000001'], 'a read picks one that has waited two minutes unmailed');
  eq(L.pickForAlert([mk('fold0000001', 2 * MIN), fresh], NOW, 'fnew0000001'), ['fold0000001', 'fnew0000001'], 'a new suggestion takes any older waiting ones along in the same email');
  eq(L.pickForAlert([mk('fdone000001', 2 * MIN, { mailed: iso(MIN) }), mk('fskip000001', 2 * MIN, { mailed: 'skip' })], NOW), [], 'ones already mailed, and quiet tests, are never picked again');
  eq(L.pickForAlert([mk('fbusy000001', 2 * MIN, { mailClaim: iso(MIN) })], NOW), [], 'one that another request is sending right now is left alone');
  eq(L.pickForAlert([mk('fstuck00001', 20 * MIN, { mailClaim: iso(6 * MIN) })], NOW), ['fstuck00001'], 'a send that never finished is retried after five minutes');
  eq(L.pickForAlert([], NOW), [], 'an empty queue picks nothing');

  const six = [1, 2, 3, 4, 5, 6].map((i) => mk('fsent00000' + i, 9 * MIN, { mailed: iso(i * MIN) }));
  eq(L.pickForAlert(six.concat([fresh]), NOW, 'fnew0000001'), [], 'after six alert emails in ten minutes, the next one is held');
  const oneEmail = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => mk('fbat00000' + i, 9 * MIN, { mailed: iso(MIN) }));
  eq(L.pickForAlert(oneEmail.concat([fresh]), NOW, 'fnew0000001'), ['fnew0000001'], 'eight suggestions that went out together in ONE email count as one');
  const earlier = [1, 2, 3, 4, 5, 6].map((i) => mk('fago00000' + i, 30 * MIN, { mailed: iso(11 * MIN + i * 1000) }));
  eq(L.pickForAlert(earlier.concat([fresh]), NOW, 'fnew0000001'), ['fnew0000001'], 'and once the ten minutes have passed, it goes out');

  const list = [mk('fa000000001', 0), mk('fb000000001', 0), mk('fc000000001', 0, { mailed: 'skip' })];
  const claimed = L.claimForAlert(list, ['fa000000001'], 'CLAIM');
  eq([claimed[0].mailClaim, 'mailClaim' in claimed[1], 'mailClaim' in list[0]], ['CLAIM', false, false], 'claiming marks only the chosen ones, and does not alter the stored list in place');
  let m = L.markAlerted(claimed, ['fa000000001', 'fc000000001', 'fgone000001'], 'SENT');
  eq([m.changed, m.list[0].mailed, 'mailClaim' in m.list[0], 'mailed' in m.list[1], m.list[2].mailed], [true, 'SENT', false, false, 'skip'], 'marking records the send, clears the claim, and leaves the others alone');
  m = L.markAlerted(m.list, ['fa000000001'], 'AGAIN');
  eq([m.changed, m.list[0].mailed], [false, 'SENT'], 'marking twice changes nothing');
  eq(L.publicEntry(Object.assign({}, list[0], { mailed: 'x', mailClaim: 'y' })), { id: 'fa000000001', by: 'Nate', at: list[0].at, text: 't fa000000001', page: 'guide' }, 'a browser is given the suggestion without the private marks');
}

group('Suggestion alerts: the email');
{
  const one = { id: 'fmwxr2cj7t3333a', by: 'Nate', at: ago(0), text: 'On the Vision page, change the tagline.\nSecond line <b>bold</b> & "quoted"', page: 'index', mailClaim: 'x' };
  let a = L.composeAlert([one], 3, NOW);
  ok(a.subject.indexOf('Suggestion from Nate: On the Vision page, change the tagline.') === 0 && a.subject.indexOf('\n') < 0 && a.subject.length < 100, 'the subject says who and what, on one line', a.subject);
  ok(a.html.indexOf('Nate suggested a change') > 0 && a.html.indexOf('on Our Vision') > 0, 'the email names who sent it and which page they were on');
  ok(a.html.indexOf('Nov 29, 6:05 PM MT') > 0 && a.text.indexOf('Nov 29, 6:05 PM MT') > 0, 'and when, in Mountain time, written the same way on every engine');
  ok(a.html.indexOf('change the tagline.<br>Second line &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot;') > 0, 'the suggestion is shown in full, line breaks kept');
  ok(a.html.indexOf('<b>bold</b>') < 0, 'and anything typed is escaped, so it cannot run as code');
  ok(a.html.indexOf('Ref fmwxr2cj7t3333a') > 0, 'it carries the reference Mike gives Claude to act on it');
  ok(a.html.indexOf('3 suggestions open in the queue.') > 0 && a.html.indexOf(L.SITE + '/progress.html#suggestions') > 0, 'it says how many are open and links to the queue');
  ok(!/undefined|NaN|\[object Object\]|mailClaim/.test(a.html + a.text + a.subject), 'no junk, and no private marks, anywhere in it');
  eq((a.html.match(/<table/g) || []).length, (a.html.match(/<\/table>/g) || []).length, 'every table that opens also closes');
  eq((a.html.match(/<div/g) || []).length, (a.html.match(/<\/div>/g) || []).length, 'every div that opens also closes');
  ok(a.text.indexOf('Second line <b>bold</b> & "quoted"') > 0 && a.text.indexOf('Ref fmwxr2cj7t3333a') > 0 && a.text.indexOf('<td') < 0, 'the plain-text version has the words as typed and none of the template');

  a = L.composeAlert([{ id: 'fb00000002', by: 'Pat', at: ago(0), text: 'Second, newer', page: 'guide' }, { id: 'fa00000001', by: 'Nate', at: ago(1), text: 'First, older', page: 'meetings' }, { id: 'fc00000003', by: 'Mike', at: ago(0.5), text: 'Middle', page: 'progress' }], 5, NOW);
  eq(a.subject, '3 suggestions waiting in the hub', 'several waiting ones go in one email with a plain subject');
  ok(a.html.indexOf('3 suggestions are waiting') > 0 && a.html.indexOf('First, older') < a.html.indexOf('Middle') && a.html.indexOf('Middle') < a.html.indexOf('Second, newer'), 'listed oldest first');
  ok(a.html.indexOf('on Meeting Minutes') > 0 && a.html.indexOf('on Our RoadMap') > 0 && a.html.indexOf('on Guide') > 0, 'each with its own page');

  a = L.composeAlert([{ id: 'ft00000001', by: 'Claude (testing)', at: ago(0), text: 'TEST', page: 'nowhere' }], 1, NOW);
  ok(a.subject.indexOf('[Test] Suggestion from Claude (testing): TEST') === 0, 'a test suggestion is marked [Test] in the subject', a.subject);
  ok(a.html.indexOf('on The hub') > 0 && a.html.indexOf('1 suggestion open in the queue.') > 0, 'an unknown page reads as "The hub"; one open reads as singular');
  a = L.composeAlert([{ id: 'fs00000001', by: 'someone', at: ago(0), text: 'anon', page: 'guide' }], 1, NOW);
  ok(a.subject === 'Suggestion from Someone: anon' && a.html.indexOf('Someone suggested a change') > 0, 'a suggestion with no name reads naturally');
  ok(a.html.length < 6000, 'a short email (' + a.html.length + ' bytes)');
}

// ---------------------------------------------------------------- activity alerts
group('Activity alerts: when Mike is emailed');
{
  const names = L.adminNames('');
  eq(names, ['mike', 'michael'], 'by default, "Mike" and "Michael" are recognised as Mike');
  ok(L.isAdminName('Mike', names) && L.isAdminName('  michael FitzGerald', names) && L.isAdminName('MIKE F', names), 'however he typed his name');
  ok(!L.isAdminName('Nate', names) && !L.isAdminName('Pat Michael', names) && !L.isAdminName('Mikey', names) && !L.isAdminName('', names) && !L.isAdminName(null, names), 'and nobody else is mistaken for him');
  eq(L.adminNames('Michael; mf,  Boss'), ['michael', 'mf', 'boss'], 'the list can be changed with a setting');

  const opts = { admins: names, mailReady: true };
  const t = (minsAgo) => new Date(NOW - minsAgo * 60000).toISOString();
  const post = (by, minsAgo, text) => ({ t: t(minsAgo), by: by, text: text || 'x' });

  let d = L.decideActivity({}, 'posts', [post('Nate', 600)], NOW, opts);
  eq([d.status, d.next.seen.posts, 'pending' in d], ['init', t(1), false], 'first look, only old items: start watching from a minute ago and email nothing');
  d = L.decideActivity(null, 'posts', [post('Nate', 600, 'old'), post('Pat', 0.1, 'just now')], NOW, opts);
  eq([d.status, d.pending.map((x) => x.text)], ['send', ['just now']], 'first look caused by a brand-new item: that item is news, the old one is not');
  ok(d.next.seen.posts === t(1), 'and the starting point is stored either way');

  const base = { seen: { posts: t(30), files: t(30) }, sent: [], claim: {} };
  d = L.decideActivity(base, 'posts', [post('Nate', 60)], NOW, opts);
  eq([d.status, 'next' in d], ['none', false], 'nothing newer than what Mike was told: nothing to do, nothing to store');
  d = L.decideActivity(base, 'posts', [post('Pat', 2, 'newer'), post('Nate', 60, 'old'), post('Nate', 5, 'new one')], NOW, opts);
  eq([d.status, d.pending.map((x) => x.text), d.advanceTo, d.next.claim.posts], ['send', ['new one', 'newer'], t(2), new Date(NOW).toISOString()], 'new items from others: email them oldest first, and claim the send');
  d = L.decideActivity(base, 'posts', [post('Mike', 5), post('michael f', 2)], NOW, opts);
  eq([d.status, d.next.seen.posts, 'pending' in d], ['self', t(2), false], 'only Mike\'s own actions: move on without an email');
  d = L.decideActivity(base, 'posts', [post('Mike', 5, 'mine'), post('Nate', 2, 'theirs')], NOW, opts);
  eq([d.status, d.pending.map((x) => x.text), d.advanceTo], ['send', ['theirs'], t(2)], 'a mix: only the others\' items go in the email');
  d = L.decideActivity(base, 'posts', [post('Nate', 5)], NOW, { admins: names, mailReady: false });
  eq([d.status, 'next' in d], ['off', false], 'email not set up yet: nothing is sent and the item stays pending for later');
  d = L.decideActivity(Object.assign({}, base, { sent: [t(1), t(2), t(3), t(4), t(5), t(6)] }), 'posts', [post('Nate', 0.5)], NOW, opts);
  eq(d.status, 'held', 'six alert emails in ten minutes: the next one is held');
  d = L.decideActivity(Object.assign({}, base, { sent: [t(11), t(12), t(13), t(14), t(15), t(16)] }), 'posts', [post('Nate', 0.5)], NOW, opts);
  eq(d.status, 'send', 'once those are more than ten minutes old, it goes');
  d = L.decideActivity(Object.assign({}, base, { claim: { posts: t(1) } }), 'posts', [post('Nate', 0.5)], NOW, opts);
  eq(d.status, 'busy', 'another request is sending this kind right now: leave it alone');
  d = L.decideActivity(Object.assign({}, base, { claim: { posts: t(6) } }), 'posts', [post('Nate', 0.5)], NOW, opts);
  eq(d.status, 'send', 'a send that never finished is retried after five minutes');
  d = L.decideActivity(Object.assign({}, base, { claim: { files: t(1) } }), 'posts', [post('Nate', 0.5)], NOW, opts);
  eq(d.status, 'send', 'a send in progress for one kind does not block another kind');
  ok(!('posts' in base.claim) && base.seen.posts === t(30) && base.sent.length === 0, 'deciding never alters the stored state in place');

  const claimed = L.decideActivity(base, 'posts', [post('Nate', 2)], NOW, opts).next;
  const after = L.finishActivity(claimed, 'posts', t(2), NOW);
  eq([after.seen.posts, after.seen.files, 'posts' in after.claim, after.sent.length], [t(2), t(30), false, 1], 'after sending: "told up to" moves forward, the claim is dropped, the send is noted, other kinds untouched');
  eq(L.decideActivity(after, 'posts', [post('Nate', 2)], NOW, opts).status, 'none', 'and the same item is never news twice');
  eq(L.finishActivity(after, 'posts', t(20), NOW).seen.posts, t(2), '"told up to" never moves backwards');
  eq(L.finishActivity(after, 'posts', t(2), NOW).sent.length, 1, 'being told twice that the same email went out counts as one email, not two');
  d = L.decideActivity(Object.assign({}, base, { sent: [t(1), t(2), t(3), t(4), t(5), t(6)] }), 'posts', [post('Nate', 0.5)], NOW, { admins: names, mailReady: true, noLimit: true });
  eq(d.status, 'send', 'the flood brake does not apply to a collector that comes by on a schedule');

  eq(L.activityItems.posts({ messages: [{ by: 'Nate', at: t(1), text: 'hi' }] }), [{ t: t(1), by: 'Nate', text: 'hi' }], 'board posts are read into the common shape');
  eq(L.activityItems.statuses({ items: { outline: { status: 'done', by: 'Pat', at: t(1) } } }), [{ t: t(1), by: 'Pat', id: 'outline', status: 'done' }], 'so are roadmap statuses');
  const mi = L.activityItems.meetings([{ at: t(1), by: 'Pat', title: 'T', date: '2026-11-26', disc: 'd', prog: '', decisions: ['a', 'b'], actionItems: [{}] }])[0];
  eq([mi.t, mi.by, mi.title, mi.decisions, mi.actions], [t(1), 'Pat', 'T', 2, 1], 'and meetings, with how many decisions and action items');
  eq(L.activityItems.files([{ pathname: 'a/Deck-AbCdEfGhIjKlMnOpQrStUvWx.pptx', uploadedAt: new Date(NOW), size: 10 }], 'Nate'), [{ t: new Date(NOW).toISOString(), by: 'Nate', name: 'Deck.pptx', size: 10 }], 'and Library files, with their clean names');
  eq(L.roadmapTitles({ now: [{ id: 'outline', t: 'Outline a deliverable' }], next: [{ id: 'x' }] }), { outline: 'Outline a deliverable', x: 'x' }, 'roadmap step titles are looked up by id');
  eq([L.fmtSize(900), L.fmtSize(5000), L.fmtSize(2202009), L.fmtSize(undefined)], ['900 B', '5 KB', '2.1 MB', ''], 'file sizes read naturally');
}

group('Activity alerts: the emails');
{
  const t0 = new Date(NOW).toISOString();
  const all = [];
  let a = L.composeActivity('posts', [{ t: t0, by: 'Nate', text: 'Deck is ready.\nPlease <b>review</b> & comment' }]); all.push(a);
  eq(a.subject, 'Nate posted on the board: Deck is ready. Please <b>review</b> & comment', 'a board post: the subject says who and what');
  ok(a.html.indexOf('Deck is ready.<br>Please &lt;b&gt;review&lt;/b&gt; &amp; comment') > 0 && a.html.indexOf('<b>review</b>') < 0, 'the post is shown in full, line breaks kept, and escaped');
  ok(a.html.indexOf('Nov 29, 6:05 PM MT') > 0 && a.html.indexOf(L.SITE + '/progress.html') > 0 && a.html.indexOf('Open the board') > 0, 'with the time in Mountain and a button to the board');

  a = L.composeActivity('statuses', [{ t: t0, by: 'Pat', id: 'outline', status: 'done' }], { titles: { outline: 'Outline a deliverable' } }); all.push(a);
  eq(a.subject, 'Pat moved "Outline a deliverable" to Done', 'a roadmap change: the subject says who moved what to which status');
  ok(a.text.indexOf('Outline a deliverable is now Done') > 0 && a.html.indexOf('Roadmap update') > 0 && a.html.indexOf('Open the roadmap') > 0, 'and the email says the same');
  eq(L.composeActivity('statuses', [{ t: t0, by: 'Pat', id: 'gone', status: 'weird' }], {}).subject, 'Pat moved "gone" to weird', 'an unknown step or status still produces a readable email');

  a = L.composeActivity('meetings', [{ t: t0, by: 'Pat', title: 'Weekly sync', date: '2026-11-26', disc: 'We covered the outline.', prog: '', decisions: 2, actions: 1 }]); all.push(a);
  eq(a.subject, 'Pat logged a meeting: Weekly sync', 'a meeting: the subject says who logged which meeting');
  ok(a.text.indexOf('Weekly sync (Thu, Nov 26)') > 0 && a.text.indexOf('We covered the outline.') > 0 && a.text.indexOf('2 decisions, 1 action item') > 0, 'with its date, the gist, and how many decisions and action items');
  ok(a.html.indexOf('Open Meeting Minutes') > 0 && a.html.indexOf(L.SITE + '/meetings.html') > 0, 'and a button to Meeting Minutes');
  eq(L.composeActivity('meetings', [{ t: t0, by: 'someone', title: '', date: '', disc: '', prog: 'typed', decisions: 0, actions: 0 }]).subject, 'Someone logged a meeting: Meeting', 'a bare hand-typed meeting with no name still reads naturally');

  a = L.composeActivity('files', [{ t: t0, by: 'Nate', name: 'Beam Deck v2.pptx', size: 2202009 }]); all.push(a);
  eq(a.subject, 'New file in the Library: Beam Deck v2.pptx', 'an upload: the subject names the file');
  ok(a.text.indexOf('Beam Deck v2.pptx (2.1 MB)') > 0 && a.text.indexOf('Nate') > 0 && a.html.indexOf('Open the Library') > 0, 'with its size, who uploaded it when known, and a button to the Library');
  a = L.composeActivity('files', [{ t: t0, by: '', name: 'a.pdf', size: 10 }, { t: t0, by: '', name: 'b.pdf', size: 20 }]); all.push(a);
  eq(a.subject, '2 new files in the Library', 'several files uploaded together arrive as one email');
  ok(a.text.indexOf('a.pdf') > 0 && a.text.indexOf('b.pdf') > 0 && a.text.indexOf('Someone') < 0, 'listing each, and not inventing an uploader when it is not known');

  const many = [];
  for (let i = 0; i < 25; i++) many.push({ t: new Date(NOW - (25 - i) * 1000).toISOString(), by: 'Nate', text: 'post number ' + i + '.' });
  a = L.composeActivity('posts', many); all.push(a);
  eq(a.subject, '25 new posts on the board', 'a backlog arrives as one email');
  ok(a.html.indexOf('Showing the latest 10 of 25.') > 0 && a.html.indexOf('post number 24.') > 0 && a.html.indexOf('post number 15.') > 0 && a.html.indexOf('post number 14.') < 0, 'showing the latest ten and saying how many there were');

  ok(all.every((m) => !/undefined|NaN|\[object Object\]/.test(m.subject + m.html + m.text)), 'no junk in any of them');
  ok(all.every((m) => (m.html.match(/<table/g) || []).length === (m.html.match(/<\/table>/g) || []).length && (m.html.match(/<div/g) || []).length === (m.html.match(/<\/div>/g) || []).length), 'and every one is well-formed');
  ok(all.every((m) => m.text.indexOf('<td') < 0 && m.text.indexOf('style=') < 0), 'with a clean plain-text version');
}

// ---------------------------------------------------------------- the outbox
group('The outbox: when the weekly summary is waiting to be collected');
{
  const at = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo - 1, d, h, mi || 0));
  // Winter: Mountain is UTC-7. Sunday is Nov 29 2026.
  ok(!L.weeklyDue(at(2026, 11, 30, 0, 30), {}).due, 'Sunday 5:30 PM Mountain: not yet');
  let w = L.weeklyDue(at(2026, 11, 30, 1, 5), {});
  eq([w.due, w.date, new Date(w.asOf).toISOString()], [true, '2026-11-29', '2026-11-30T01:00:00.000Z'], 'Sunday 6:05 PM: waiting, for the week ending that Sunday, written as of 6 PM sharp');
  w = L.weeklyDue(at(2026, 12, 1, 16, 0), {});
  eq([w.due, w.date, new Date(w.asOf).toISOString()], [true, '2026-11-29', '2026-11-30T01:00:00.000Z'], 'Tuesday morning (the Mac was off since Sunday): still waiting, same week, same cut-off');
  ok(L.weeklyDue(at(2026, 12, 3, 0, 30), {}).due, 'Wednesday 5:30 PM: still waiting');
  ok(!L.weeklyDue(at(2026, 12, 3, 1, 30), {}).due, 'Wednesday 6:30 PM: too late; it waits for next Sunday rather than arrive stale');
  ok(!L.weeklyDue(at(2026, 12, 4, 18, 0), {}).due && !L.weeklyDue(at(2026, 11, 29, 18, 0), {}).due, 'a Friday, or Sunday morning: nothing waiting');
  ok(!L.weeklyDue(at(2026, 11, 30, 1, 5), { lastSent: '2026-11-29' }).due, 'already sent for that Sunday: not offered again');
  ok(!L.weeklyDue(at(2026, 12, 1, 16, 0), { lastSent: '2026-11-30' }).due, 'sent by hand on the Monday: not offered again that week');
  ok(L.weeklyDue(at(2026, 11, 30, 1, 5), { lastSent: '2026-11-22' }).due, 'last week\'s send does not block this week');
  const claim = { claim: { date: '2026-11-29', at: at(2026, 11, 30, 1, 0).toISOString() } };
  ok(!L.weeklyDue(at(2026, 11, 30, 1, 5), claim).due, 'collected five minutes ago and being sent: not handed out twice');
  ok(L.weeklyDue(at(2026, 11, 30, 1, 30), claim).due, 'collected half an hour ago and never reported sent: offered again');
  // Summer: Mountain is UTC-6. Sunday is Jul 12 2026.
  w = L.weeklyDue(at(2026, 7, 13, 0, 5), {});
  eq([w.due, w.date, new Date(w.asOf).toISOString()], [true, '2026-07-12', '2026-07-13T00:00:00.000Z'], 'in summer the 6 PM cut-off falls an hour earlier in UTC, and that is handled');
  eq(L.weeklyDue(at(2026, 9, 1, 18, 0), {}).date, '2026-08-30', 'the week\'s Sunday is found correctly across a month boundary');
  eq(L.weeklyDue(at(2027, 1, 4, 18, 0), {}).date, '2027-01-03', 'and across a year boundary');

  let weeks = 0;
  const bad = [], st = {};
  for (let t = Date.UTC(2026, 0, 4, 12); t < Date.UTC(2029, 0, 1); t += 6 * 3600000) {
    const r = L.weeklyDue(new Date(t), st);
    if (!r.due) continue;
    const cut = L.localParts(new Date(r.asOf));
    if (cut.weekday !== 'Sun' || cut.hour !== 18 || cut.minute !== 0 || cut.date !== r.date) bad.push('cut-off ' + new Date(r.asOf).toISOString());
    if (st.lastSent === r.date) bad.push('twice ' + r.date);
    st.lastSent = r.date; weeks++;
  }
  ok(weeks >= 155 && weeks <= 157 && bad.length === 0, 'three years of checking every six hours: one summary a week (' + weeks + '), each cut off at Sunday 6:00 PM Mountain', bad.slice(0, 3));
}

group('The outbox: reporting what was sent');
{
  eq(L.parseOutboxKey('s|fmwxr2cj7t3333a,fmwxr2cjrr8ydsf', NOW), { type: 's', ids: ['fmwxr2cj7t3333a', 'fmwxr2cjrr8ydsf'] }, 'a suggestion-alert key names the suggestions it covered');
  eq(L.parseOutboxKey('s|fmwxr2cj7t3333a,not-an-id', NOW), { type: 's', ids: ['fmwxr2cj7t3333a'] }, 'anything in it that is not a suggestion id is dropped');
  eq(L.parseOutboxKey('s|nope', NOW), null, 'and a key with no real ids records nothing');
  eq(L.parseOutboxKey('a|posts|' + ago(1), NOW), { type: 'a', kind: 'posts', upTo: ago(1) }, 'an activity key says which kind, and up to when Mike has now been told');
  eq(L.parseOutboxKey('a|secrets|' + ago(1), NOW), null, 'an unknown kind is refused');
  eq(L.parseOutboxKey('a|posts|' + new Date(NOW + 3600000).toISOString(), NOW), null, 'a time in the future is refused, so nothing can be marked as told before it happens');
  eq(L.parseOutboxKey('a|posts|yesterday', NOW), null, 'a nonsense time is refused');
  eq(L.parseOutboxKey('w|2026-11-29', NOW), { type: 'w', date: '2026-11-29' }, 'a weekly key names the Sunday the summary was for');
  eq([L.parseOutboxKey('w|2027-01-03', NOW), L.parseOutboxKey('w|soon', NOW)], [null, null], 'a future or nonsense week is refused');
  eq([L.parseOutboxKey('', NOW), L.parseOutboxKey(null, NOW), L.parseOutboxKey('x|y', NOW), L.parseOutboxKey({}, NOW), L.parseOutboxKey('s|a|b', NOW)], [null, null, null, null, null], 'anything else records nothing and crashes nothing');
}

// ---------------------------------------------------------------- the board
group('The board: posts');
{
  let r = L.buildPost({ text: '  ' }, NOW);
  ok(!r.ok && r.status === 400, 'an empty post is refused');
  r = L.buildPost({ text: 'x'.repeat(L.MAX_TEXT + 1), by: 'Pat' }, NOW);
  ok(!r.ok && /2001/.test(r.error), 'an over-long post is refused and says how long it was');
  r = L.buildPost({ text: ' We closed the first deal \r\n next step Friday ', by: '  Pat ', at: '1999-01-01T00:00:00Z' }, NOW);
  eq(r.post, { by: 'Pat', at: new Date(NOW).toISOString(), text: 'We closed the first deal \n next step Friday' }, 'a post is cleaned up and stamped with the server\'s time, whatever the page claimed');
  eq(L.buildPost({ text: 'hi' }, NOW).post.by, 'someone', 'no name is recorded as "someone"');
  eq(L.buildPost('{"text":"sent as text","by":"Nate"}', NOW).post.text, 'sent as text', 'a body that arrives as text is still read');
  eq([L.bodyOf('not json'), L.bodyOf(null), L.bodyOf('7')], [{}, {}, {}], 'a body that is not an object reads as empty, not a crash');

  const old = [{ by: 'Nate', at: ago(5), text: 'first' }, { by: 'Mike', at: ago(4), text: 'second', extra: 'kept' }];
  const board = { items: { outline: { status: 'progress', by: 'Pat', at: ago(3) } }, messages: old };
  const p = L.buildPost({ text: 'third', by: 'Pat' }, NOW).post;
  let a = L.addPost(board, p, NOW);
  eq(a.board.messages.slice(0, 2), old, 'existing posts are carried over untouched and in order');
  eq(a.board.messages[2], p, 'the new post goes on the end');
  eq(a.board.items, board.items, 'and the statuses are untouched');
  eq(board.messages.length, 2, 'the stored board is not modified in place');
  a = L.addPost(a.board, L.buildPost({ text: 'third', by: 'Pat' }, NOW + 3000).post, NOW + 3000);
  ok(a.duplicate && !a.board, 'the same post from the same person seconds later is a double-click, not a second post');
  a = L.addPost({ items: {}, messages: [{ by: 'Pat', at: ago(1), text: 'third' }] }, p, NOW);
  ok(a.board && a.board.messages.length === 2, 'the same words a day later are a new post');

  let full = { items: {}, messages: [] }, held = 0, refused = null;
  for (; held < 500; held++) {
    const out = L.addPost(full, { by: 'P', at: ago(1), text: 'y'.repeat(1990) + held }, NOW);
    if (!out.board) { refused = out; break; }
    full = out.board;
  }
  ok(refused && refused.full, 'a board that has reached the store\'s size limit refuses the new post');
  ok(full.messages.length === held && L.fits(full), 'and never drops an old post to make room (' + held + ' maximum-length posts fit; ordinary ones, several hundred)');
}

group('The board: statuses');
{
  const steps = L.stepIds({ now: [{ id: 'outline' }], next: [{ id: 'process' }, { id: 'sandbox' }, { noId: true }, null] });
  eq(steps, ['outline', 'process', 'sandbox'], 'the steps a status can be set on come from roadmap.json');
  eq(L.stepIds(null), [], 'no roadmap means no steps');
  const r = L.buildStatus({ id: 'outline', status: 'done', by: 'Pat' }, steps, NOW);
  eq([r.ok, r.id, r.entry], [true, 'outline', { status: 'done', by: 'Pat', at: new Date(NOW).toISOString() }], 'a status change records who and when');
  ok(!L.buildStatus({ id: 'ghost', status: 'done' }, steps, NOW).ok, 'a step that is not on the roadmap is refused');
  ok(!L.buildStatus({ id: 'outline', status: 'finished' }, steps, NOW).ok, 'a made-up status is refused');
  ok(!L.buildStatus({ id: 'outline', status: 'constructor' }, steps, NOW).ok && !L.buildStatus({ id: 'outline', status: 'toString' }, steps, NOW).ok, 'odd status names cannot slip through');
  ok(!L.buildStatus({ id: '__proto__', status: 'done' }, steps, NOW).ok && !L.buildStatus({}, steps, NOW).ok, 'an odd or missing step id is refused');
  const board = { items: { process: { status: 'blocked', by: 'Nate', at: ago(9) } }, messages: [{ by: 'Nate', at: ago(5), text: 'keep me' }] };
  const next = L.setStatus(board, 'outline', r.entry);
  eq(next.items, { process: { status: 'blocked', by: 'Nate', at: ago(9) }, outline: r.entry }, 'changing one step leaves the other steps alone');
  eq(next.messages, board.messages, 'and leaves every post alone');
  ok(!('outline' in board.items), 'the stored board is not modified in place');
  eq(L.boardOf(null), { items: {}, messages: [] }, 'an empty store reads as an empty board');
  eq(L.boardOf({ items: [1], messages: 'x' }), { items: {}, messages: [] }, 'a malformed value reads as an empty board, not a crash');
}

// ---------------------------------------------------------------- the meeting log
group('The meeting log');
{
  let r = L.buildMeeting({ meeting: { title: 'Empty', date: '2026-11-20' } }, NOW);
  ok(!r.ok && r.status === 400, 'a meeting with nothing in it is refused');
  r = L.buildMeeting({ meeting: { id: 'mHACKED', at: '1999-01-01T00:00:00Z', date: '2026-11-20', title: '  Weekly   sync ', disc: ' We met. ', decisions: ['  Ship it ', '', null, 7], actionItems: [{ item: ' Send deck ', owner: 'Pat' }, { item: 'No owner' }, { owner: 'Nate' }, 'junk'], prog: '', by: ' Mike ', source: 'ai', evil: 'x' } }, NOW);
  ok(r.ok, 'a normal meeting is accepted');
  const m = r.meeting;
  eq(Object.keys(m), ['id', 'date', 'title', 'disc', 'decisions', 'actionItems', 'prog', 'by', 'at', 'source'], 'it is stored in the same shape as the meetings already in the log');
  ok(/^m[a-z0-9]{10,}$/.test(m.id) && m.id !== 'mHACKED' && m.at === new Date(NOW).toISOString(), 'the id and the logged time are the server\'s, not the page\'s');
  eq([m.date, m.title, m.disc, m.by, m.source], ['2026-11-20', 'Weekly sync', 'We met.', 'Mike', 'ai'], 'the fields are cleaned up');
  eq(m.decisions, ['Ship it', '7'], 'empty decisions are dropped');
  eq(m.actionItems, [{ item: 'Send deck', owner: 'Pat' }, { item: 'No owner', owner: 'Unassigned' }], 'action items with no text are dropped; a missing owner becomes Unassigned');
  eq(L.buildMeeting({ meeting: { disc: 'x', date: 'tomorrow' } }, NOW).meeting.date, '2026-11-29', 'a missing or nonsense date becomes today in Mountain time');
  eq(L.buildMeeting({ meeting: { prog: 'typed by hand' } }, NOW).meeting.source, 'manual', 'anything not marked as AI notes is a hand entry');
  r = L.buildMeeting({ meeting: { disc: 'x'.repeat(L.MAX_MEETING) } }, NOW);
  ok(!r.ok && /too long/.test(r.error), 'a meeting too long to store is refused out loud, never cut short');
  const ids = {}; let clash = 0;
  for (let i = 0; i < 1000; i++) { const id = L.buildMeeting({ meeting: { disc: 'x' } }, NOW).meeting.id; if (ids[id]) clash++; ids[id] = 1; }
  eq(clash, 0, '1,000 meetings logged in the same millisecond all get different ids');

  const stored = [{ id: 'm1795394285335', date: '2026-11-21', title: 'Old one', disc: 'kept exactly', decisions: [], actionItems: [], prog: 'p', by: 'Mike', at: ago(8), source: 'manual', legacy: true }];
  let a = L.addMeeting(stored, m, NOW);
  eq(a.list[0], stored[0], 'existing meetings are carried over exactly, extra fields and all');
  eq([a.list.length, stored.length], [2, 1], 'the new meeting is added, and the stored list is not modified in place');
  const again = L.buildMeeting({ meeting: { date: '2026-11-20', title: 'Weekly sync', disc: 'We met.', decisions: ['Ship it', '7'], actionItems: [{ item: 'Send deck', owner: 'Pat' }, { item: 'No owner' }], by: 'Mike', source: 'ai' } }, NOW + 4000).meeting;
  const twice = L.addMeeting(a.list, again, NOW + 4000);
  ok(twice.duplicate && twice.duplicate.id === m.id && !twice.list, 'pressing Add twice does not log the meeting twice');
  ok(L.addMeeting(a.list, again, NOW + 10 * 60000).list, 'the same meeting entered again ten minutes later is kept (it is deliberate)');
  let rm = L.removeMeeting(a.list, 'm1795394285335');
  eq([rm.removed, rm.list.map((x) => x.id), a.list.length], [true, [m.id], 2], 'removing takes out exactly the one asked for');
  rm = L.removeMeeting(a.list, 'mNOPE');
  eq([rm.removed, rm.list.length], [false, 2], 'removing one that is already gone changes nothing');
  eq(L.removeMeeting(a.list, '').removed, false, 'an empty id removes nothing');
  eq(L.meetingsOf(null), [], 'an empty store reads as an empty log');

  let log = [], n = 0, refused = null;
  for (; n < 60; n++) {
    const t = NOW + n * 600000;
    const out = L.addMeeting(log, L.buildMeeting({ meeting: { disc: 'd'.repeat(20000) + n } }, t).meeting, t);
    if (!out.list) { refused = out; break; }
    log = out.list;
  }
  ok(refused && refused.full, 'a log that has reached the store\'s size limit refuses the new meeting');
  ok(log.length === n && L.fits({ meetings: log }), 'and never drops an old one to make room (' + n + ' very long meetings fit; ordinary ones, well over a hundred)');
}

group('Small helpers');
{
  eq(L.clip('short', 10), 'short', 'clip leaves short text alone');
  eq(L.clip('The quick brown fox jumps over the lazy dog', 20), 'The quick brown fox…', 'clip cuts at a word and adds an ellipsis');
  eq(L.clip('  many   spaces\n\nand lines ', 100), 'many spaces and lines', 'clip flattens whitespace');
  eq(L.baseName('a/b/Report-AbCdEfGhIjKlMnOpQrStUvWx.docx'), 'Report.docx', 'baseName strips the folder and the storage suffix');
  eq(L.baseName('Q3-results.xlsx'), 'Q3-results.xlsx', 'baseName leaves a normal hyphenated name alone');
  eq(L.esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;', 'esc escapes all five risky characters');
}

print('\n' + (fail ? 'FAILED: ' + fail + ' of ' + (pass + fail) + ' checks failed' : 'ALL ' + pass + ' CHECKS PASSED'));
