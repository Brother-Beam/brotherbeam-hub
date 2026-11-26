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
  return { ok: true, entry: { id: newId(nowMs), by: by, at: new Date(nowMs).toISOString(), text: text, page: page } };
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
    + '<body style="margin:0;padding:0;background:' + C.paper + ';">'
    + '<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">' + esc(preheader) + '</div>'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="' + C.paper + '" style="background:' + C.paper + ';"><tr><td align="center" style="padding:24px 12px;">'
    + '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:' + C.surface + ';border:1px solid ' + C.line + ';border-radius:12px;">'
    + '<tr><td bgcolor="' + C.ink + '" style="background:' + C.ink + ';padding:20px 28px;border-radius:11px 11px 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
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
    + '<tr><td style="padding:28px 28px 0;"><a href="' + SITE + '/guide.html" style="' + P + 'display:inline-block;background:' + C.ink + ';color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;padding:13px 26px;border-radius:999px;">Open the hub</a></td></tr>'
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
