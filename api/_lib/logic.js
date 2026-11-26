// Pure logic shared by the hub's server functions: no imports and no I/O, so every
// rule here can be unit-tested without a server (see tools/test-logic.js).
//
//   suggestions  validating one, adding it to the queue, deciding which ones are closed
//   schedule     "is it Sunday evening in Mountain time, and has this week's email gone?"
//   email        turning a week of hub activity into the digest (HTML + plain text)

export const SITE = 'https://brotherbeam-hub.vercel.app';
export const DAY_MS = 86400000;

// ---------- small helpers ----------

export function ms(x) { const n = Date.parse(x); return isNaN(n) ? 0 : n; }
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
// One line, at most n characters, cut at a word where possible.
export function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s.,;:—-]+$/, '') + '…';
}

// ---------- suggestions ----------

export const MAX_TEXT = 2000;   // characters in one suggestion
export const MAX_NAME = 40;
export const MAX_OPEN = 200;    // open suggestions the queue will hold
const DUPLICATE_MS = 2 * 60 * 1000;   // the same person sending the same text again within this is a double-click
const ID = /^f[a-z0-9]{6,24}$/;

export function isSuggestionId(id) { return typeof id === 'string' && ID.test(id); }
export function listOf(value) { return (value && Array.isArray(value.feedback)) ? value.feedback : []; }
export function newId(nowMs) { return 'f' + nowMs.toString(36) + Math.random().toString(36).slice(2, 8).padEnd(6, '0'); }

function tidy(x) {
  return String(x == null ? '' : x)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

// Turns what the browser sent into a suggestion, or says exactly why it cannot.
export function buildSuggestion(body, nowMs) {
  const b = (body && typeof body === 'object') ? body : {};
  const text = tidy(b.text);
  if (!text) return { ok: false, status: 400, error: 'Write the change you want first.' };
  if (text.length > MAX_TEXT) return { ok: false, status: 400, error: 'That is ' + text.length + ' characters. Keep it under ' + MAX_TEXT + ', or split it into two.' };
  const by = tidy(b.by).replace(/\s+/g, ' ').slice(0, MAX_NAME) || 'someone';
  const page = /^[a-z0-9-]{1,40}$/.test(String(b.page || '')) ? String(b.page) : 'hub';
  const entry = { id: newId(nowMs), by: by, at: new Date(nowMs).toISOString(), text: text, page: page };
  // A load test can ask not to email anyone. Only test data may; a real suggestion always alerts.
  if (b.quiet === true && isTestEntry(entry)) entry.mailed = 'skip';
  return { ok: true, entry: entry };
}

// Adds one suggestion to the queue. Never drops anything to make room.
export function addSuggestion(list, entry, nowMs) {
  const dup = list.find(function (f) { return f.by === entry.by && f.text === entry.text && nowMs - ms(f.at) < DUPLICATE_MS; });
  if (dup) return { duplicate: dup };
  if (list.length >= MAX_OPEN) return { full: true };
  return { list: list.concat([entry]) };
}

// ---------- the changelog (whatsnew.json) and auto-clean ----------

export function entriesOf(changelog) {
  const raw = (changelog && Array.isArray(changelog.entries)) ? changelog.entries : [];
  return raw
    .filter(function (e) { return e && e.title && ms(e.at) > 0; })
    .map(function (e) {
      return {
        id: String(e.id || ''), at: e.at, t: ms(e.at), title: String(e.title), what: String(e.what || ''),
        suggestedBy: String(e.suggestedBy || ''),
        resolves: Array.isArray(e.resolves) ? e.resolves.map(String) : [],
      };
    })
    .sort(function (a, b) { return b.t - a.t; });
}

// Which suggestions are finished, and how: { id: 'built' | 'declined' }.
// Built = named in a What's-new entry's "resolves". Declined = listed under "declined".
export function closedMap(changelog) {
  const map = {};
  const declined = (changelog && Array.isArray(changelog.declined)) ? changelog.declined : [];
  declined.forEach(function (id) { if (isSuggestionId(id)) map[id] = 'declined'; });
  entriesOf(changelog).forEach(function (e) { e.resolves.forEach(function (id) { if (isSuggestionId(id)) map[id] = 'built'; }); });
  return map;
}

export function splitClosed(list, closed) {
  const keep = [], removed = [];
  list.forEach(function (f) { (f && Object.prototype.hasOwnProperty.call(closed, f.id) ? removed : keep).push(f); });
  return { keep: keep, removed: removed };
}

// Test data. A suggestion sent under a name ending in "(testing)" is how the queue gets
// checked on the live site. It goes through everything a real one does (stored, shown in
// the queue, cleared by auto-clean, tallied) but is left out of the weekly email, so a
// test never shows up in the founders' inboxes.
export function isTestEntry(x) { return /\(testing\)\s*$/i.test(String((x && x.by) || '')); }

// What we remember about a cleared suggestion: that it happened, never what it said.
export function closedRecords(removed, closed, nowIso) {
  return removed.map(function (f) {
    const rec = { id: f.id, by: f.by || 'someone', outcome: closed[f.id], closedAt: nowIso };
    if (isTestEntry(f)) rec.test = true;
    return rec;
  });
}

// ---------- suggestion alerts ----------
// The moment a suggestion comes in, Mike gets an email with it, so he can act on it
// straight away instead of finding it in Sunday's summary. Each stored suggestion carries
// two private marks that browsers never see: `mailed`, when its alert went out ('skip'
// for a quiet test), and `mailClaim`, set while a request is in the middle of sending it.
//
// If the email cannot go out just then (mail not set up yet, a Gmail hiccup), the
// suggestion simply stays unmailed, and the next request that reads or adds to the queue
// sends it. So alerts catch up by themselves and nothing depends on a timer.

export const PAGE_NAMES = { guide: 'Guide', index: 'Our Vision', progress: 'Our RoadMap', documents: 'Our Library', meetings: 'Meeting Minutes', build: 'How I built this', hub: 'The hub' };
export const ALERT_SETTLE_MS = 90 * 1000;      // a read only picks up suggestions older than this, so it never races the submit that is emailing one right now
export const ALERT_CLAIM_MS = 5 * 60 * 1000;   // how long a claim holds; also the wait before retrying a send that failed
export const ALERT_WINDOW_MS = 10 * 60 * 1000;
export const ALERT_MAX_IN_WINDOW = 6;          // alert emails per window; past that, new ones are held and go out together

// What a browser is given: the suggestion, without the private marks.
export function publicEntry(e) { return { id: e.id, by: e.by, at: e.at, text: e.text, page: e.page }; }

function alertsInWindow(list, nowMs) {
  const stamps = {};
  list.forEach(function (e) { if (e && e.mailed && e.mailed !== 'skip' && nowMs - ms(e.mailed) < ALERT_WINDOW_MS) stamps[e.mailed] = 1; });
  return Object.keys(stamps).length;   // one email can cover several suggestions; they share a stamp
}

// Which suggestions should be emailed right now. newId is the one just submitted, if any.
export function pickForAlert(list, nowMs, newId) {
  if (alertsInWindow(list, nowMs) >= ALERT_MAX_IN_WINDOW) return [];
  return list.filter(function (e) {
    if (!e || e.mailed) return false;
    if (e.mailClaim && nowMs - ms(e.mailClaim) < ALERT_CLAIM_MS) return false;
    return e.id === newId || nowMs - ms(e.at) > ALERT_SETTLE_MS;
  }).map(function (e) { return e.id; });
}
export function claimForAlert(list, ids, nowIso) {
  return list.map(function (e) { return ids.indexOf(e.id) >= 0 ? Object.assign({}, e, { mailClaim: nowIso }) : e; });
}
export function markAlerted(list, ids, nowIso) {
  let changed = false;
  const next = list.map(function (e) {
    if (ids.indexOf(e.id) < 0 || e.mailed) return e;
    const c = Object.assign({}, e, { mailed: nowIso });
    delete c.mailClaim;
    changed = true;
    return c;
  });
  return { list: next, changed: changed };
}

// ---------- the frame both kinds of alert email share ----------

// "Nov 29, 6:05 PM MT". Date and time are formatted separately and joined here, because
// engines disagree on how to join them ("Nov 29, 6:05 PM" or "Nov 29 at 6:05 PM") and on
// the space before "PM".
function stampMT(t) { return dayShort(t) + ', ' + fmt(t, { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ') + ' MT'; }
function who2(x) { return (x && x.by && x.by !== 'someone') ? x.by : 'Someone'; }

// A button that keeps its dark fill in every mail app. The colour sits on a table cell as a
// bgcolor attribute as well as in CSS: the first real email through Gmail came back with
// every "background" style stripped and every bgcolor attribute intact, which would have
// left white text on a white page.
function mailButton(label, href) {
  return '<table role="presentation" cellpadding="0" cellspacing="0"><tr><td bgcolor="' + C.ink + '" style="background-color:' + C.ink + ';border-radius:999px;">'
    + '<a href="' + href + '" style="margin:0;font-family:' + FONT + ';display:inline-block;color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;padding:13px 26px;">' + esc(label) + '</a>'
    + '</td></tr></table>';
}

// One item in an alert: a small line saying who and when, the thing itself in a box, an optional note under it.
function alertBlock(metaHtml, bodyHtml, noteText) {
  const P = 'margin:0;font-family:' + FONT + ';';
  return '<tr><td style="padding:18px 28px 0;">'
    + '<div style="' + P + 'font-size:13px;color:' + C.muted + ';">' + metaHtml + '</div>'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr><td bgcolor="' + C.paper + '" style="' + P + 'font-size:16px;line-height:1.55;color:' + C.ink + ';padding:14px 16px;background-color:' + C.paper + ';border-left:3px solid ' + C.accent + ';border-radius:6px;">' + bodyHtml + '</td></tr></table>'
    + (noteText ? '<div style="' + P + 'font-size:11px;color:' + C.faint + ';margin-top:6px;">' + esc(noteText) + '</div>' : '')
    + '</td></tr>';
}
function strong(t) { return '<b style="font-weight:600;color:' + C.ink + ';">' + esc(t) + '</b>'; }

// The whole email: dark header, a headline, the blocks, one button, a footnote.
function alertShell(o) {
  const P = 'margin:0;font-family:' + FONT + ';';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light only"><title>' + esc(o.subject) + '</title></head>'
    + '<body bgcolor="' + C.paper + '" style="margin:0;padding:0;background-color:' + C.paper + ';">'
    + '<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">' + esc(o.preheader || '') + '</div>'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="' + C.paper + '" style="background-color:' + C.paper + ';"><tr><td align="center" style="padding:24px 12px;">'
    + '<table role="presentation" width="600" cellpadding="0" cellspacing="0" bgcolor="' + C.surface + '" style="width:100%;max-width:600px;background-color:' + C.surface + ';border:1px solid ' + C.line + ';border-radius:12px;">'
    + '<tr><td bgcolor="' + C.ink + '" style="background-color:' + C.ink + ';padding:20px 28px;border-radius:11px 11px 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
    + '<td style="' + P + 'font-size:15px;letter-spacing:.24em;color:#ffffff;">BEAM</td>'
    + '<td align="right" style="' + P + 'font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#9aa6b2;">The hub &middot; ' + esc(o.tag) + '</td>'
    + '</tr></table></td></tr>'
    + '<tr><td style="padding:26px 28px 0;"><div style="' + P + 'font-size:23px;line-height:1.25;font-weight:300;color:' + C.ink + ';">' + esc(o.headline) + '</div></td></tr>'
    + o.blocks
    + '<tr><td style="padding:24px 28px 0;">' + mailButton(o.button, o.href) + '</td></tr>'
    + '<tr><td style="padding:20px 28px 28px;"><div style="' + P + 'font-size:12px;line-height:1.6;color:' + C.faint + ';">' + esc(o.foot) + '</div></td></tr>'
    + '</table></td></tr></table></body></html>';
}

// The suggestion alert. One suggestion, or several that were waiting, oldest first.
export function composeAlert(entries, openCount, nowMs) {
  const list = (entries || []).slice().sort(function (a, b) { return ms(a.at) - ms(b.at); });
  const n = list.length;
  const first = list[0] || {};
  const where = function (e) { return Object.prototype.hasOwnProperty.call(PAGE_NAMES, e.page) ? PAGE_NAMES[e.page] : 'The hub'; };
  const when = function (e) { return stampMT(ms(e.at)); };
  const tag = (n > 0 && list.every(isTestEntry)) ? '[Test] ' : '';
  const subject = tag + (n === 1 ? 'Suggestion from ' + who2(first) + ': ' + clip(first.text, 70) : n + ' suggestions waiting in the hub');
  const headline = n === 1 ? who2(first) + ' suggested a change' : n + ' suggestions are waiting';
  const queue = SITE + '/progress.html#suggestions';
  const foot = plural(openCount, 'suggestion') + ' open in the queue. Once it is built, or you decide to pass on it, it clears itself from the queue.';

  const html = alertShell({
    subject: subject, preheader: clip(first.text, 120), tag: 'suggestion', headline: headline,
    blocks: list.map(function (e) {
      return alertBlock(strong(who2(e)) + ' &middot; on ' + esc(where(e)) + ' &middot; ' + esc(when(e)), esc(e.text).replace(/\n/g, '<br>'), 'Ref ' + e.id);
    }).join(''),
    button: 'Open the queue', href: queue, foot: foot,
  });

  const T = [headline, ''];
  list.forEach(function (e) { T.push(who2(e) + ' · on ' + where(e) + ' · ' + when(e), e.text, 'Ref ' + e.id, ''); });
  T.push(foot, 'Open the queue: ' + queue);
  return { subject: subject, html: html, text: T.join('\n') };
}

// ---------- activity alerts ----------
// The same idea for everything else that happens in the hub: when someone uploads a file,
// logs a meeting, posts on the board or changes a roadmap status, Mike gets an email then,
// not on Sunday. His own actions are left out where the hub can tell they are his.
//
// Unlike suggestions, these records are not marked. Instead one small stored value
// (beam-alert-state) remembers, per kind, the time of the newest item Mike has been told
// about. Anything newer is pending. So a failed send is retried on the next request for
// that kind, and nothing depends on a timer.
//   { seen: { posts, statuses, meetings, files }, claim: { [kind]: time }, sent: [times] }

export const ACTIVITY_KINDS = ['posts', 'statuses', 'meetings', 'files'];

// Whose actions Mike does not need to hear about: his own. Matched on the first word of the
// name someone typed, so "Mike", "mike f" and "Michael FitzGerald" all count.
export function adminNames(str) { return String(str == null || str === '' ? 'mike,michael' : str).toLowerCase().split(/[\s,;]+/).filter(Boolean); }
export function isAdminName(by, names) {
  const first = String(by || '').trim().toLowerCase().split(/\s+/)[0] || '';
  return !!first && (names || []).indexOf(first) >= 0;
}

function isoOf(x) { const n = x instanceof Date ? x.getTime() : ms(x); return n ? new Date(n).toISOString() : ''; }

// Turns each kind of stored data into the same simple list: { t: when, by: who, ...details }.
export const activityItems = {
  posts: function (board) { return (board.messages || []).map(function (m) { return { t: isoOf(m.at), by: m.by, text: m.text }; }); },
  statuses: function (board) { return Object.keys(board.items || {}).map(function (id) { const x = board.items[id] || {}; return { t: isoOf(x.at), by: x.by, id: id, status: x.status }; }); },
  meetings: function (list) {
    return (list || []).map(function (m) {
      return { t: isoOf(m.at), by: m.by, title: m.title, date: m.date, disc: m.disc, prog: m.prog, decisions: (m.decisions || []).length, actions: (m.actionItems || []).length };
    });
  },
  files: function (blobs, by) { return (blobs || []).map(function (f) { return { t: isoOf(f.uploadedAt), by: by || '', name: baseName(f.pathname), size: f.size }; }); },
};
export function roadmapTitles(roadmap) {
  const out = {}, r = roadmap || {};
  [].concat(Array.isArray(r.now) ? r.now : [], Array.isArray(r.next) ? r.next : []).forEach(function (x) { if (x && x.id) out[x.id] = String(x.t || x.id); });
  return out;
}

// What to do about one kind right now. Returns { status } and, when the stored state must
// change, { next }. status is one of:
//   init   first look at this kind, nothing new: start watching from here
//   none   nothing new
//   self   only Mike's own actions are new: move on without emailing
//   off    there is news, but the hub cannot send email yet (it goes out once it can)
//   held   too many alert emails in the last few minutes; it goes out later
//   busy   another request is sending this kind right now
//   send   email { pending }, then record it with finishActivity(advanceTo)
// The first time a kind is looked at there is no "told up to" time yet, so it starts a
// minute back: nothing older is ever emailed as a backlog, but the action that caused
// this very first look still counts as news.
const FIRST_LOOK_BACK_MS = 60 * 1000;
export function decideActivity(state, kind, items, nowMs, opts) {
  const o = opts || {};
  const s = (state && typeof state === 'object') ? state : {};
  const nowIso = new Date(nowMs).toISOString();
  const had = !!(s.seen && s.seen[kind]);
  const seen = had ? s.seen[kind] : new Date(nowMs - FIRST_LOOK_BACK_MS).toISOString();
  const withSeen = function (iso) { const n = Object.assign({}, s, { seen: Object.assign({}, s.seen || {}) }); n.seen[kind] = iso; return n; };
  // On a first look the starting point has to be stored whatever else happens.
  const keep = function (status) { return had ? { status: status } : { status: status, next: withSeen(seen) }; };

  const fresh = (items || []).filter(function (x) { return x && ms(x.t) > ms(seen); }).sort(function (a, b) { return ms(a.t) - ms(b.t); });
  if (!fresh.length) return keep(had ? 'none' : 'init');
  const upTo = fresh[fresh.length - 1].t;
  const others = fresh.filter(function (x) { return !isAdminName(x.by, o.admins); });
  if (!others.length) return { status: 'self', next: withSeen(upTo) };
  if (!o.mailReady) return keep('off');
  // The flood brake only matters when the hub sends by itself, the moment something happens.
  // A collector that comes by on a schedule is already paced, so it passes noLimit.
  const recent = (Array.isArray(s.sent) ? s.sent : []).filter(function (t) { return nowMs - ms(t) < ALERT_WINDOW_MS; });
  if (!o.noLimit && recent.length >= ALERT_MAX_IN_WINDOW) return keep('held');
  const claim = s.claim && s.claim[kind];
  if (claim && nowMs - ms(claim) < ALERT_CLAIM_MS) return keep('busy');
  const next = withSeen(seen);
  next.claim = Object.assign({}, s.claim || {});
  next.claim[kind] = nowIso;
  return { status: 'send', next: next, pending: others, advanceTo: upTo };
}
// After the email went out: remember how far Mike has been told, note the send, drop the claim.
export function finishActivity(state, kind, advanceTo, nowMs) {
  const s = (state && typeof state === 'object') ? state : {};
  const next = Object.assign({}, s, { seen: Object.assign({}, s.seen || {}), claim: Object.assign({}, s.claim || {}) });
  const moved = !next.seen[kind] || ms(advanceTo) > ms(next.seen[kind]);
  if (moved) next.seen[kind] = advanceTo;
  delete next.claim[kind];
  // Count one send, but only if this really was news. Being told twice that the same email
  // went out must not look like two emails.
  next.sent = (Array.isArray(s.sent) ? s.sent : []).filter(function (t) { return nowMs - ms(t) < ALERT_WINDOW_MS; });
  if (moved) next.sent = next.sent.concat([new Date(nowMs).toISOString()]);
  return next;
}

export function fmtSize(n) {
  const b = Number(n);
  if (!(b >= 0)) return '';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return Math.round(b / 1024) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

const ACTIVITY_MAIL = {
  posts: { tag: 'board', path: '/progress.html', button: 'Open the board' },
  statuses: { tag: 'roadmap', path: '/progress.html', button: 'Open the roadmap' },
  meetings: { tag: 'meeting', path: '/meetings.html', button: 'Open Meeting Minutes' },
  files: { tag: 'library', path: '/documents.html', button: 'Open the Library' },
};
const ACTIVITY_SHOWN = 10;

// The activity alert. ctx.titles maps roadmap step ids to their titles (for statuses).
export function composeActivity(kind, pending, ctx) {
  const c = ctx || {};
  const about = ACTIVITY_MAIL[kind];
  const all = (pending || []).slice().sort(function (a, b) { return ms(a.t) - ms(b.t); });
  const n = all.length;
  const shown = all.slice(-ACTIVITY_SHOWN);
  const one = shown[shown.length - 1] || {};
  const when = function (x) { return stampMT(ms(x.t)); };
  const stepTitle = function (x) { return (c.titles && Object.prototype.hasOwnProperty.call(c.titles, x.id)) ? c.titles[x.id] : String(x.id); };
  const stepLabel = function (x) { return Object.prototype.hasOwnProperty.call(STATUS, x.status) ? STATUS[x.status][0] : String(x.status); };
  let subject, headline, blocks, lines;

  if (kind === 'posts') {
    headline = n === 1 ? who2(one) + ' posted on the board' : n + ' new posts on the board';
    subject = n === 1 ? headline + ': ' + clip(one.text, 70) : headline;
    blocks = shown.map(function (x) { return alertBlock(strong(who2(x)) + ' &middot; ' + esc(when(x)), esc(x.text).replace(/\n/g, '<br>')); });
    lines = shown.map(function (x) { return who2(x) + ' · ' + when(x) + '\n' + x.text; });
  } else if (kind === 'statuses') {
    headline = n === 1 ? 'Roadmap update' : n + ' roadmap updates';
    subject = n === 1 ? who2(one) + ' moved "' + stepTitle(one) + '" to ' + stepLabel(one) : headline;
    blocks = shown.map(function (x) { return alertBlock(strong(who2(x)) + ' &middot; ' + esc(when(x)), esc(stepTitle(x)) + ' is now ' + strong(stepLabel(x))); });
    lines = shown.map(function (x) { return who2(x) + ' · ' + when(x) + '\n' + stepTitle(x) + ' is now ' + stepLabel(x); });
  } else if (kind === 'meetings') {
    headline = n === 1 ? who2(one) + ' logged a meeting' : n + ' meetings logged';
    subject = n === 1 ? headline + ': ' + (one.title || 'Meeting') : headline;
    const day = function (x) { return meetingDay({ date: x.date, at: x.t }); };
    const tally = function (x) { return [x.decisions ? plural(x.decisions, 'decision') : '', x.actions ? plural(x.actions, 'action item') : ''].filter(Boolean).join(', '); };
    const gist = function (x) { return clip(x.disc || x.prog || '', 400); };
    blocks = shown.map(function (x) {
      return alertBlock(strong(who2(x)) + ' &middot; ' + esc(when(x)), strong(x.title || 'Meeting') + (day(x) ? ' &middot; ' + esc(day(x)) : '') + (gist(x) ? '<br>' + esc(gist(x)) : ''), tally(x));
    });
    lines = shown.map(function (x) { return who2(x) + ' · ' + when(x) + '\n' + (x.title || 'Meeting') + (day(x) ? ' (' + day(x) + ')' : '') + (gist(x) ? '\n' + gist(x) : '') + (tally(x) ? '\n' + tally(x) : ''); });
  } else {
    headline = n === 1 ? 'New in the Library' : n + ' new files in the Library';
    subject = n === 1 ? 'New file in the Library: ' + (one.name || 'Untitled file') : headline;
    blocks = shown.map(function (x) { return alertBlock((x.by ? strong(who2(x)) + ' &middot; ' : '') + esc(when(x)), strong(x.name || 'Untitled file') + (fmtSize(x.size) ? ' &middot; ' + esc(fmtSize(x.size)) : '')); });
    lines = shown.map(function (x) { return (x.by ? who2(x) + ' · ' : '') + when(x) + '\n' + (x.name || 'Untitled file') + (fmtSize(x.size) ? ' (' + fmtSize(x.size) + ')' : ''); });
  }

  const foot = (n > shown.length ? 'Showing the latest ' + shown.length + ' of ' + n + '. ' : '') + 'You get these as they happen. Sunday’s email is the recap for all three of us.';
  const href = SITE + about.path;
  const html = alertShell({ subject: subject, preheader: clip(lines[lines.length - 1] || '', 120), tag: about.tag, headline: headline, blocks: blocks.join(''), button: about.button, href: href, foot: foot });
  const text = [headline, ''].concat(lines.map(function (l) { return l + '\n'; })).concat([foot, about.button + ': ' + href]).join('\n');
  return { subject: subject, html: html, text: text };
}

// ---------- the outbox: delivery by something other than the hub ----------
// Mike did not want his email password stored at Vercel, so the hub's email is delivered
// by a scheduled Claude task on his Mac, which collects it from /api/outbox. These are the
// extra rules that needs.

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function dayBefore(dateStr, n) { const p = dateStr.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] - n, 12)).toISOString().slice(0, 10); }
// 6 PM Mountain on that calendar day, as a moment in time (daylight saving included).
function sendPointMs(dateStr) {
  const p = dateStr.split('-');
  for (let off = 6; off <= 7; off++) {
    const t = Date.UTC(+p[0], +p[1] - 1, +p[2], SEND_HOURS[0] + off);
    const l = localParts(new Date(t), TZ);
    if (l.date === dateStr && l.hour === SEND_HOURS[0]) return t;
  }
  return Date.UTC(+p[0], +p[1] - 1, +p[2], SEND_HOURS[0] + 7);
}

// Is the weekly summary waiting to be collected? When the hub sends its own email it goes
// at Sunday 6 PM sharp (decide, above). A collector may not be running at that moment, so
// here the summary is due from Sunday 6 PM until Wednesday 6 PM Mountain, and the first
// collection in that window takes it. It is written as of Sunday 6 PM whenever it is
// collected, so it always covers the same week. state is the stored beam-digest-state.
export function weeklyDue(now, state) {
  const local = localParts(now, TZ);
  const idx = WEEKDAYS.indexOf(local.weekday);
  const open = (idx === 0 && local.hour >= SEND_HOURS[0]) || idx === 1 || idx === 2 || (idx === 3 && local.hour < SEND_HOURS[0]);
  if (!open) return { due: false, reason: 'It is not between Sunday 6 PM and Wednesday 6 PM Mountain.' };
  const sunday = dayBefore(local.date, idx);
  const s = state || {};
  if (s.lastSent && s.lastSent >= sunday) return { due: false, date: sunday, reason: 'The summary for the week ending ' + sunday + ' already went out.' };
  if (s.claim && s.claim.date === sunday && now.getTime() - ms(s.claim.at) < CLAIM_MS) return { due: false, date: sunday, reason: 'Another run is sending it right now.' };
  return { due: true, date: sunday, asOf: sendPointMs(sunday) };
}

// Each email in the outbox has a key saying what it covers, so that reporting it sent
// records exactly that. Returns null for anything that is not a key the hub would issue.
//   s|id,id        suggestion alerts for those suggestions
//   a|kind|time    an activity alert covering that kind up to that time
//   w|YYYY-MM-DD   the weekly summary for the week ending that Sunday
export function parseOutboxKey(key, nowMs) {
  const parts = String(key == null ? '' : key).split('|');
  if (parts[0] === 's' && parts.length === 2) {
    const ids = parts[1].split(',').filter(isSuggestionId);
    return ids.length ? { type: 's', ids: ids } : null;
  }
  if (parts[0] === 'a' && parts.length === 3) {
    const t = ms(parts[2]);
    if (ACTIVITY_KINDS.indexOf(parts[1]) < 0 || !t || t > nowMs + 60000) return null;   // never mark the future as told
    return { type: 'a', kind: parts[1], upTo: new Date(t).toISOString() };
  }
  if (parts[0] === 'w' && parts.length === 2) {
    if (!isDay(parts[1]) || ms(parts[1] + 'T00:00:00Z') > nowMs + DAY_MS) return null;
    return { type: 'w', date: parts[1] };
  }
  return null;
}

// ---------- the board and the meeting log ----------
// Both used to be saved whole by the browser, so two people acting within the same
// minute could erase each other. Now the browser sends one small action, and these rules
// apply it to whatever is stored at that moment. Nothing here ever drops an existing
// post or meeting to make room: if the store is full, the new one is refused out loud.

export const STORE_LIMIT = 190000;   // the store refuses values over 200,000 characters; stop short of it
export const MAX_MEETING = 30000;    // characters in one meeting, as stored

export function bodyOf(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { const j = JSON.parse(raw || '{}'); return (j && typeof j === 'object') ? j : {}; } catch (e) { return {}; }
}
export function fits(value) { return JSON.stringify(value).length <= STORE_LIMIT; }
function who(x) { return tidy(x).replace(/\s+/g, ' ').slice(0, MAX_NAME) || 'someone'; }
function isDay(d) { return /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !isNaN(Date.parse(d + 'T12:00:00Z')); }

// The board: { items: { [stepId]: { status, by, at } }, messages: [{ by, at, text }] }
export function boardOf(value) {
  const v = (value && typeof value === 'object') ? value : {};
  return {
    items: (v.items && typeof v.items === 'object' && !Array.isArray(v.items)) ? v.items : {},
    messages: Array.isArray(v.messages) ? v.messages : [],
  };
}
export function stepIds(roadmap) {
  const r = roadmap || {};
  return [].concat(Array.isArray(r.now) ? r.now : [], Array.isArray(r.next) ? r.next : [])
    .map(function (x) { return x && x.id; }).filter(Boolean).map(String);
}

export function buildPost(body, nowMs) {
  const b = bodyOf(body);
  const text = tidy(b.text);
  if (!text) return { ok: false, status: 400, error: 'Write your update first.' };
  if (text.length > MAX_TEXT) return { ok: false, status: 400, error: 'That is ' + text.length + ' characters. Keep a post under ' + MAX_TEXT + ', or split it into two.' };
  return { ok: true, post: { by: who(b.by), at: new Date(nowMs).toISOString(), text: text } };
}
// Adds a post to the end. Existing posts are never touched or reordered.
export function addPost(board, post, nowMs) {
  const dup = board.messages.find(function (m) { return m && m.by === post.by && m.text === post.text && nowMs - ms(m.at) < DUPLICATE_MS; });
  if (dup) return { duplicate: dup };
  const next = { items: board.items, messages: board.messages.concat([post]) };
  return fits(next) ? { board: next } : { full: true };
}

export function buildStatus(body, steps, nowMs) {
  const b = bodyOf(body);
  const id = String(b.id || '');
  if (steps.indexOf(id) < 0) return { ok: false, status: 400, error: 'That step is not on the roadmap any more. Reload the page.' };
  const status = String(b.status || '');
  if (!Object.prototype.hasOwnProperty.call(STATUS, status)) return { ok: false, status: 400, error: 'That is not a status the roadmap knows.' };
  return { ok: true, id: id, entry: { status: status, by: who(b.by), at: new Date(nowMs).toISOString() } };
}
// Sets one step's status. Every other step and every post is carried over as it is.
export function setStatus(board, id, entry) {
  const items = Object.assign({}, board.items);
  items[id] = entry;
  return { items: items, messages: board.messages };
}

// The meeting log: { meetings: [{ id, date, title, disc, decisions[], actionItems[], prog, by, at, source }] }
export function meetingsOf(value) { return (value && Array.isArray(value.meetings)) ? value.meetings : []; }

// Builds one meeting from what the page sent. The id and the logged time are always the
// server's, whatever the page says.
export function buildMeeting(body, nowMs) {
  const b = bodyOf(body);
  const m = (b.meeting && typeof b.meeting === 'object') ? b.meeting : {};
  const decisions = (Array.isArray(m.decisions) ? m.decisions : []).map(tidy).filter(Boolean);
  const actionItems = (Array.isArray(m.actionItems) ? m.actionItems : [])
    .map(function (a) {
      const o = (a && typeof a === 'object') ? a : {};
      return { item: tidy(o.item), owner: tidy(o.owner).replace(/\s+/g, ' ').slice(0, MAX_NAME) || 'Unassigned' };
    })
    .filter(function (a) { return a.item; });
  const meeting = {
    id: 'm' + nowMs.toString(36) + Math.random().toString(36).slice(2, 8).padEnd(6, '0'),
    date: isDay(m.date) ? String(m.date) : localParts(new Date(nowMs), TZ).date,
    title: tidy(m.title).replace(/\s+/g, ' ').slice(0, 200),
    disc: tidy(m.disc), decisions: decisions, actionItems: actionItems, prog: tidy(m.prog),
    by: who(m.by), at: new Date(nowMs).toISOString(), source: m.source === 'ai' ? 'ai' : 'manual',
  };
  if (!meeting.disc && !meeting.prog && !decisions.length && !actionItems.length) {
    return { ok: false, status: 400, error: 'There is nothing to log yet. Add what was discussed or the progress made.' };
  }
  const size = JSON.stringify(meeting).length;
  if (size > MAX_MEETING) return { ok: false, status: 400, error: 'This meeting is too long to save in one piece (' + size + ' characters; the limit is ' + MAX_MEETING + '). Trim it, or split it into two.' };
  return { ok: true, meeting: meeting };
}
function sameMeeting(a, b) {
  return a.by === b.by && a.date === b.date && a.title === b.title && a.disc === b.disc && a.prog === b.prog
    && JSON.stringify(a.decisions || []) === JSON.stringify(b.decisions || [])
    && JSON.stringify(a.actionItems || []) === JSON.stringify(b.actionItems || []);
}
export function addMeeting(list, meeting, nowMs) {
  const dup = list.find(function (x) { return x && nowMs - ms(x.at) < DUPLICATE_MS && sameMeeting(x, meeting); });
  if (dup) return { duplicate: dup };
  const next = list.concat([meeting]);
  return fits({ meetings: next }) ? { list: next } : { full: true };
}
// Removes one meeting by id. Removing one that is already gone changes nothing.
export function removeMeeting(list, id) {
  const want = String(id || '');
  const keep = want ? list.filter(function (x) { return !(x && x.id === want); }) : list;
  return { list: keep, removed: keep.length !== list.length };
}

// ---------- schedule: Sunday 6 PM Mountain, once ----------

export const TZ = 'America/Denver';
export const SEND_WEEKDAY = 'Sun';
// Two cron slots fire each week (see vercel.json). Depending on daylight saving, one lands
// in the 6 PM hour and sends. In summer the other lands at 7 PM and acts as a retry.
export const SEND_HOURS = [18, 19];
export const CLAIM_MS = 15 * 60 * 1000;
export const SCHEDULE_TEXT = 'Sundays at 6:00 PM Mountain Time';

export function localParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz || TZ, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = {};
  f.formatToParts(date).forEach(function (x) { p[x.type] = x.value; });
  return { weekday: p.weekday, date: p.year + '-' + p.month + '-' + p.day, hour: Number(p.hour) % 24, minute: Number(p.minute) };
}

// Should the weekly email go out right now? state is the stored beam-digest-state.
export function decide(now, state) {
  const local = localParts(now, TZ);
  const s = state || {};
  if (local.weekday !== SEND_WEEKDAY) return { send: false, reason: 'It is not Sunday in Mountain time.', local: local };
  if (SEND_HOURS.indexOf(local.hour) < 0) return { send: false, reason: 'It is outside the Sunday 6-8 PM Mountain window.', local: local };
  if (s.lastSent === local.date) return { send: false, reason: 'This week’s email already went out (' + local.date + ').', local: local };
  if (s.claim && s.claim.date === local.date && now.getTime() - ms(s.claim.at) < CLAIM_MS) return { send: false, reason: 'Another run is sending it right now.', local: local };
  return { send: true, reason: 'Sunday evening, and this week’s email has not gone out.', local: local };
}

export function parseRecipients(str) {
  const seen = {}, out = [];
  String(str || '').split(/[\s,;]+/).forEach(function (a) {
    if (!a || !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(a)) return;
    const k = a.toLowerCase();
    if (seen[k]) return;
    seen[k] = 1; out.push(a);
  });
  return out;
}

// ---------- the weekly email ----------

export const WINDOW_DAYS = 7;
const STATUS = {
  todo: ['Not started', '#98A4B0'],
  progress: ['In progress', '#1F5EFF'],
  blocked: ['Blocked', '#B3382C'],
  done: ['Done', '#0FA37F'],
};
const C = { ink: '#141B22', muted: '#5A6775', faint: '#98A4B0', line: '#DDE3E9', hair: '#EAEEF2', paper: '#F3F5F7', accent: '#1F5EFF', surface: '#FFFFFF' };
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

function fmt(t, opts, tz) { return new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: tz || TZ }, opts)).format(new Date(t)); }
function dayShort(t) { return fmt(t, { month: 'short', day: 'numeric' }); }
// A meeting's own date is a plain calendar day (YYYY-MM-DD), so it is shown as written, in no time zone.
function meetingDay(m) {
  const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(m.date || ''));
  if (p) return fmt(Date.UTC(+p[1], +p[2] - 1, +p[3], 12), { weekday: 'short', month: 'short', day: 'numeric' }, 'UTC');
  return m.at ? fmt(ms(m.at), { weekday: 'short', month: 'short', day: 'numeric' }) : '';
}
// Same rule the Library page uses to show a file's name without its storage suffix.
export function baseName(pathname) {
  return String(pathname || '').split('/').pop().replace(/-[a-zA-Z0-9]{20,}(?=\.[^.]+$)/, '');
}

// Reads a week of activity out of everything the hub holds. opts.includeTests counts test
// suggestions too (only the preview uses that, to check the pipeline end to end).
export function summarize(data, nowMs, opts) {
  const d = data || {};
  const real = (opts && opts.includeTests) ? function () { return true; } : function (x) { return !(x && x.test) && !isTestEntry(x); };
  const from = nowMs - WINDOW_DAYS * DAY_MS;
  const inWeek = function (t) { return t > from && t <= nowMs; };

  const progress = d.progress || {};
  const items = (progress.items && typeof progress.items === 'object') ? progress.items : {};
  const roadmap = d.roadmap || {};
  const stages = [['Now', roadmap.now], ['Next', roadmap.next]];
  const steps = [];
  stages.forEach(function (st) {
    (Array.isArray(st[1]) ? st[1] : []).forEach(function (x) {
      if (!x || !x.id) return;
      const s = items[x.id] || {};
      const status = STATUS[s.status] ? s.status : 'todo';
      steps.push({ stage: st[0], title: String(x.t || x.id), owner: String(x.own || ''), status: status, by: s.by || '', at: ms(s.at), moved: inWeek(ms(s.at)) });
    });
  });

  const meetings = (Array.isArray((d.meetings || {}).meetings) ? d.meetings.meetings : [])
    .map(function (m) { return Object.assign({}, m, { t: ms(m.at) || ms(m.date) }); })
    .filter(function (m) { return inWeek(m.t); })
    .sort(function (a, b) { return b.t - a.t; });

  const posts = (Array.isArray(progress.messages) ? progress.messages : [])
    .map(function (p) { return Object.assign({}, p, { t: ms(p.at) }); })
    .filter(function (p) { return inWeek(p.t); })
    .sort(function (a, b) { return b.t - a.t; });

  const filesKnown = Array.isArray(d.files);
  const allFiles = filesKnown ? d.files : [];
  const files = allFiles
    .map(function (f) { return { name: baseName(f.pathname), t: ms(f.uploadedAt) }; })
    .filter(function (f) { return inWeek(f.t); })
    .sort(function (a, b) { return b.t - a.t; });

  const features = entriesOf(d.whatsnew).filter(function (e) { return inWeek(e.t); });
  const open = (Array.isArray(d.open) ? d.open : []).filter(real);
  const closedLog = (d.closed && Array.isArray(d.closed.closed)) ? d.closed.closed : [];
  const closedWeek = closedLog.filter(function (c) { return inWeek(ms(c.closedAt)) && real(c); });
  const built = closedWeek.filter(function (c) { return c.outcome === 'built'; }).length;
  const declined = closedWeek.filter(function (c) { return c.outcome === 'declined'; }).length;
  const moves = steps.filter(function (s) { return s.moved; }).length;

  return {
    from: from, to: nowMs, steps: steps, meetings: meetings, posts: posts, files: files, filesKnown: filesKnown, totalFiles: allFiles.length,
    features: features, open: open.length, built: built, declined: declined, moves: moves,
    quiet: !(meetings.length || posts.length || files.length || features.length || moves || built || declined),
  };
}

function joinAnd(parts) {
  if (parts.length <= 1) return parts.join('');
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

// "updated by Pat on Nov 27", or just "updated Nov 27" when whoever did it had not put a name in.
function movedBy(x) {
  const named = x.by && String(x.by).toLowerCase() !== 'someone';
  return (named ? 'updated by ' + x.by + ' on ' : 'updated ') + dayShort(x.at);
}

export function compose(data, nowMs, opts) {
  const s = summarize(data, nowMs, opts);
  const range = dayShort(s.from + DAY_MS) + ' – ' + dayShort(s.to);
  const subject = s.quiet ? 'Beam · a quiet week in the hub (' + range + ')' : 'Beam · our week in the hub (' + range + ')';

  const did = [];
  if (s.meetings.length) did.push(plural(s.meetings.length, 'meeting') + ' logged');
  if (s.files.length) did.push(plural(s.files.length, 'file') + ' added to the Library');
  if (s.posts.length) did.push(plural(s.posts.length, 'post') + ' on the board');
  if (s.moves) did.push(plural(s.moves, 'roadmap update'));
  if (s.features.length) did.push(plural(s.features.length, 'new thing') + ' in the hub');
  const intro = did.length ? 'This week: ' + joinAnd(did) + '.' : 'A quiet week in the hub. Here is where things stand.';

  // ----- HTML -----
  const P = 'margin:0;font-family:' + FONT + ';';
  function section(label, inner) {
    return '<tr><td style="padding:28px 28px 0;">'
      + '<div style="' + P + 'font-size:11px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:' + C.faint + ';padding-bottom:9px;border-bottom:1px solid ' + C.hair + ';">' + esc(label) + '</div>'
      + inner + '</td></tr>';
  }
  function block(inner) { return '<div style="padding:13px 0;border-bottom:1px solid ' + C.hair + ';">' + inner + '</div>'; }
  function title(t, aside) {
    return '<div style="' + P + 'font-size:15px;line-height:1.4;font-weight:600;color:' + C.ink + ';">' + esc(t)
      + (aside ? ' <span style="font-weight:400;font-size:13px;color:' + C.faint + ';">&middot; ' + esc(aside) + '</span>' : '') + '</div>';
  }
  function para(t, color) { return '<div style="' + P + 'font-size:14px;line-height:1.55;color:' + (color || C.muted) + ';margin-top:5px;">' + t + '</div>'; }
  function small(label) { return '<div style="' + P + 'font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:' + C.faint + ';margin-top:11px;">' + esc(label) + '</div>'; }
  function bullets(rows) {
    return '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:4px;">' + rows.map(function (r) {
      return '<tr><td valign="top" style="' + P + 'font-size:14px;line-height:1.55;color:' + C.faint + ';padding:1px 8px 1px 0;">&bull;</td><td style="' + P + 'font-size:14px;line-height:1.55;color:' + C.ink + ';padding:1px 0;">' + r + '</td></tr>';
    }).join('') + '</table>';
  }
  function more(n, where) { return n > 0 ? para('+ ' + n + ' more on ' + where, C.faint) : ''; }
  function stat(n, label, last) {
    return '<td align="center" width="25%" style="padding:14px 4px;' + (last ? '' : 'border-right:1px solid ' + C.line + ';') + '">'
      + '<div style="' + P + 'font-size:26px;line-height:1.1;font-weight:300;color:' + (n ? C.accent : C.faint) + ';">' + esc(n) + '</div>'
      + '<div style="' + P + 'font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:' + C.faint + ';margin-top:4px;">' + esc(label) + '</div></td>';
  }

  let body = '';

  // Where we stand: always shown, because it is the answer to "how are we doing".
  if (s.steps.length) {
    body += section('Where we stand', s.steps.map(function (x) {
      const st = STATUS[x.status];
      const who = [x.owner, x.moved ? movedBy(x) : ''].filter(Boolean).join(' · ');
      return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid ' + C.hair + ';"><tr>'
        + '<td style="padding:13px 10px 13px 0;">'
        + '<div style="' + P + 'font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:' + C.faint + ';">' + esc(x.stage) + '</div>'
        + '<div style="' + P + 'font-size:15px;line-height:1.4;font-weight:600;color:' + C.ink + ';margin-top:2px;">' + esc(x.title) + '</div>'
        + (who ? '<div style="' + P + 'font-size:13px;color:' + C.muted + ';margin-top:2px;">' + esc(who) + '</div>' : '')
        + '</td><td align="right" valign="middle" style="padding:13px 0;white-space:nowrap;">'
        + '<span style="' + P + 'display:inline-block;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:' + st[1] + ';border:1px solid ' + st[1] + ';border-radius:999px;padding:4px 11px;">' + esc(st[0]) + '</span>'
        + '</td></tr></table>';
    }).join(''));
  }

  if (s.meetings.length) {
    const shown = s.meetings.slice(0, 5);
    body += section('Meetings logged', shown.map(function (m) {
      let h = title(m.title || 'Meeting', meetingDay(m));
      if (m.disc) h += para(esc(clip(m.disc, 320)));
      const dec = Array.isArray(m.decisions) ? m.decisions.filter(Boolean) : [];
      if (dec.length) h += small('Decisions') + bullets(dec.slice(0, 5).map(function (x) { return esc(clip(x, 200)); })) + (dec.length > 5 ? para('+ ' + (dec.length - 5) + ' more', C.faint) : '');
      const acts = Array.isArray(m.actionItems) ? m.actionItems.filter(function (a) { return a && a.item; }) : [];
      if (acts.length) h += small('Action items') + bullets(acts.slice(0, 8).map(function (a) { return '<b style="font-weight:600;">' + esc(a.owner || 'Unassigned') + '</b> &mdash; ' + esc(clip(a.item, 200)); })) + (acts.length > 8 ? para('+ ' + (acts.length - 8) + ' more', C.faint) : '');
      if (m.prog) h += small('Progress') + para(esc(clip(m.prog, 320)), C.ink);
      return block(h);
    }).join('') + more(s.meetings.length - shown.length, 'Meeting Minutes'));
  }

  if (s.files.length) {
    const shown = s.files.slice(0, 12);
    body += section('New in the Library', shown.map(function (f) { return block(title(f.name || 'Untitled file', 'added ' + dayShort(f.t))); }).join('')
      + more(s.files.length - shown.length, 'Our Library')
      + para(plural(s.totalFiles, 'file') + ' in the Library in all.', C.faint));
  }

  if (s.posts.length) {
    const shown = s.posts.slice(0, 8);
    body += section('On the board', shown.map(function (p) {
      return block('<div style="' + P + 'font-size:14px;line-height:1.55;color:' + C.ink + ';"><b style="font-weight:600;">' + esc(p.by || 'someone') + '</b> <span style="color:' + C.faint + ';">&middot; ' + esc(dayShort(p.t)) + '</span><br>' + esc(clip(p.text, 280)) + '</div>');
    }).join('') + more(s.posts.length - shown.length, 'Our RoadMap'));
  }

  if (s.features.length) {
    body += section('New in the hub', s.features.map(function (e) {
      return block(title(e.title) + (e.what ? para(esc(e.what)) : '') + (e.suggestedBy ? para('Suggested by ' + esc(e.suggestedBy), C.faint) : ''));
    }).join(''));
  }

  const sug = [];
  if (s.open) sug.push(plural(s.open, 'suggestion') + ' open in the queue on Our RoadMap');
  if (s.built) sug.push(s.built + ' built this week');
  if (s.declined) sug.push(s.declined + ' passed on');
  if (sug.length) body += section('Suggestions', para(esc(joinAnd(sug)) + '.', C.ink));

  const preheader = clip(intro, 140);
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light only"><title>' + esc(subject) + '</title></head>'
    + '<body bgcolor="' + C.paper + '" style="margin:0;padding:0;background-color:' + C.paper + ';">'
    + '<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">' + esc(preheader) + '</div>'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="' + C.paper + '" style="background-color:' + C.paper + ';"><tr><td align="center" style="padding:24px 12px;">'
    + '<table role="presentation" width="600" cellpadding="0" cellspacing="0" bgcolor="' + C.surface + '" style="width:100%;max-width:600px;background-color:' + C.surface + ';border:1px solid ' + C.line + ';border-radius:12px;">'
    + '<tr><td bgcolor="' + C.ink + '" style="background-color:' + C.ink + ';padding:20px 28px;border-radius:11px 11px 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
    + '<td style="' + P + 'font-size:15px;letter-spacing:.24em;color:#ffffff;">BEAM</td>'
    + '<td align="right" style="' + P + 'font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#9aa6b2;">The hub &middot; weekly</td>'
    + '</tr></table></td></tr>'
    + '<tr><td style="padding:28px 28px 0;">'
    + '<div style="' + P + 'font-size:25px;line-height:1.25;font-weight:300;color:' + C.ink + ';">Our week in the hub</div>'
    + '<div style="' + P + 'font-size:13px;color:' + C.faint + ';margin-top:6px;">' + esc(range) + '</div>'
    + '<div style="' + P + 'font-size:15px;line-height:1.55;color:' + C.ink + ';margin-top:14px;">' + esc(intro) + '</div>'
    + '</td></tr>'
    + '<tr><td style="padding:20px 28px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' + C.line + ';border-radius:10px;"><tr>'
    + stat(s.meetings.length, s.meetings.length === 1 ? 'Meeting' : 'Meetings')
    + stat(s.filesKnown ? s.files.length : '–', s.files.length === 1 ? 'New file' : 'New files')
    + stat(s.posts.length, s.posts.length === 1 ? 'Board post' : 'Board posts')
    + stat(s.moves, s.moves === 1 ? 'Roadmap update' : 'Roadmap updates', true)
    + '</tr></table></td></tr>'
    + body
    + '<tr><td style="padding:28px 28px 0;">' + mailButton('Open the hub', SITE + '/guide.html') + '</td></tr>'
    + '<tr><td style="padding:24px 28px 28px;"><div style="' + P + 'font-size:12px;line-height:1.6;color:' + C.faint + ';">You are getting this because you are one of the three of us. It goes out ' + esc(SCHEDULE_TEXT.replace('Sundays', 'every Sunday')) + '. Want something in the hub changed? Use <b style="font-weight:600;color:' + C.muted + ';">Suggest a change</b> at the bottom of any page.</div></td></tr>'
    + '</table></td></tr></table></body></html>';

  // ----- plain text (the same content, for mail apps that prefer it) -----
  const T = [];
  T.push('BEAM · OUR WEEK IN THE HUB', range, '', intro);
  if (s.steps.length) {
    T.push('', 'WHERE WE STAND');
    s.steps.forEach(function (x) { T.push('- [' + x.stage + '] ' + x.title + (x.owner ? ' (' + x.owner + ')' : '') + ': ' + STATUS[x.status][0] + (x.moved ? ', ' + movedBy(x) : '')); });
  }
  if (s.meetings.length) {
    T.push('', 'MEETINGS LOGGED');
    s.meetings.slice(0, 5).forEach(function (m) {
      T.push('- ' + (m.title || 'Meeting') + ' (' + meetingDay(m) + ')');
      if (m.disc) T.push('  ' + clip(m.disc, 320));
      (Array.isArray(m.decisions) ? m.decisions : []).filter(Boolean).slice(0, 5).forEach(function (x) { T.push('  Decision: ' + clip(x, 200)); });
      (Array.isArray(m.actionItems) ? m.actionItems : []).filter(function (a) { return a && a.item; }).slice(0, 8).forEach(function (a) { T.push('  ' + (a.owner || 'Unassigned') + ': ' + clip(a.item, 200)); });
      if (m.prog) T.push('  Progress: ' + clip(m.prog, 320));
    });
    if (s.meetings.length > 5) T.push('  + ' + (s.meetings.length - 5) + ' more on Meeting Minutes');
  }
  if (s.files.length) {
    T.push('', 'NEW IN THE LIBRARY');
    s.files.slice(0, 12).forEach(function (f) { T.push('- ' + (f.name || 'Untitled file') + ' (added ' + dayShort(f.t) + ')'); });
    if (s.files.length > 12) T.push('  + ' + (s.files.length - 12) + ' more');
  }
  if (s.posts.length) {
    T.push('', 'ON THE BOARD');
    s.posts.slice(0, 8).forEach(function (p) { T.push('- ' + (p.by || 'someone') + ' (' + dayShort(p.t) + '): ' + clip(p.text, 280)); });
    if (s.posts.length > 8) T.push('  + ' + (s.posts.length - 8) + ' more');
  }
  if (s.features.length) {
    T.push('', 'NEW IN THE HUB');
    s.features.forEach(function (e) { T.push('- ' + e.title + (e.what ? ': ' + e.what : '') + (e.suggestedBy ? ' (suggested by ' + e.suggestedBy + ')' : '')); });
  }
  if (sug.length) T.push('', 'SUGGESTIONS', joinAnd(sug) + '.');
  T.push('', 'Open the hub: ' + SITE + '/guide.html', '', 'Sent ' + SCHEDULE_TEXT.replace('Sundays', 'every Sunday') + ' to the three of us.');

  return {
    subject: subject, html: html, text: T.join('\n'),
    counts: { meetings: s.meetings.length, files: s.filesKnown ? s.files.length : null, posts: s.posts.length, roadmapUpdates: s.moves, features: s.features.length, openSuggestions: s.open, built: s.built, declined: s.declined, quiet: s.quiet },
  };
}
