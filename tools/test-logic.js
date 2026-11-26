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
