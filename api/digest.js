// Weekly Sunday email digest for the Beam hub.
//
// Summarizes the past 7 days — new features (What's new), meetings logged,
// documents added to the Library, and roadmap activity — and emails the three
// founders a short "here's our week" summary. Triggered by a Vercel Cron on
// Sunday evening (see vercel.json); can also be run by hand with the secret.
//
// Vercel environment variables (Project -> Settings -> Environment Variables):
//   CRON_SECRET     Vercel adds "Authorization: Bearer <CRON_SECRET>" to cron
//                   calls. We require it, so the endpoint is closed until it is set.
//   RESEND_API_KEY  Resend API key. Without it, the endpoint composes but never sends.
//   DIGEST_FROM     Verified sender, e.g. "Beam <hub@yourdomain.com>".
//   DIGEST_TO       Comma-separated recipients. Kept out of this public repo on purpose.
//   HUB_API_BASE / HUB_API_TOKEN   the same shared store the hub uses.
//   BLOB_READ_WRITE_TOKEN          to count Library files (optional).
//
// Useful by hand (needs the secret):
//   /api/digest?secret=XXX&preview=1   -> renders the email as a web page, sends nothing
//   /api/digest?secret=XXX             -> composes and sends to DIGEST_TO
//   add &days=14 to widen the window.
import { list } from '@vercel/blob';

export const config = { maxDuration: 60 };

const BASE = (process.env.HUB_API_BASE || '').replace(/\/+$/, '');
const TOKEN = process.env.HUB_API_TOKEN || '';
const SITE = 'https://brotherbeam-hub.vercel.app';

function ms(x) { const n = Date.parse(x); return isNaN(n) ? 0 : n; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
function fmtDay(t) { try { return new Date(t).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); } catch (e) { return ''; } }

async function kv(key) {
  if (!BASE || !TOKEN) return null;
  try {
    const r = await fetch(BASE + '/api/kv/' + key, { headers: { accept: 'application/json', authorization: 'Bearer ' + TOKEN } });
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.value) || null;
  } catch (e) { return null; }
}

// Pure: turns the gathered data into { subject, html, counts }. Exported for local tests.
export function compose(data, days) {
  const span = Math.max(1, days || 7);
  const cut = Date.now() - span * 24 * 60 * 60 * 1000;

  const feats = (((data.whatsnew || {}).entries) || []).filter(function (e) { return ms(e.at) >= cut; }).sort(function (a, b) { return ms(b.at) - ms(a.at); });
  const meetings = (((data.meetings || {}).meetings) || []).filter(function (m) { return (ms(m.at) || ms(m.date)) >= cut; }).sort(function (a, b) { return (ms(b.at) || ms(b.date)) - (ms(a.at) || ms(a.date)); });
  const posts = (((data.progress || {}).messages) || []).filter(function (p) { return ms(p.at) >= cut; }).sort(function (a, b) { return ms(b.at) - ms(a.at); });
  const items = ((data.progress || {}).items) || {};
  const moves = Object.keys(items).map(function (k) { return items[k]; }).filter(function (s) { return s && ms(s.at) >= cut; });
  const files = (data.files || []).filter(function (f) { return ms(f.uploadedAt) >= cut; }).sort(function (a, b) { return ms(b.uploadedAt) - ms(a.uploadedAt); });
  const openFb = (((data.feedback || {}).feedback) || []).length;

  const counts = { features: feats.length, meetings: meetings.length, files: files.length, posts: posts.length, moves: moves.length, openSuggestions: openFb };
  const total = feats.length + meetings.length + files.length + posts.length + moves.length;

  const end = Date.now(), start = cut;
  const range = fmtDay(start) + ' – ' + fmtDay(end);
  const subject = total ? ('Beam hub — our week (' + fmtDay(end) + ')') : ('Beam hub — a quiet week (' + fmtDay(end) + ')');

  const C = { ink: '#141B22', muted: '#5A6775', faint: '#98A4B0', line: '#DDE3E9', paper: '#F3F5F7', accent: '#1F5EFF', surface: '#FFFFFF' };
  const sans = 'Jost, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';

  function section(title, inner) {
    return '<tr><td style="padding:22px 28px 0"><p style="margin:0 0 10px;font-size:11px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:' + C.faint + '">' + esc(title) + '</p>' + inner + '</td></tr>';
  }
  function row(main, sub) {
    return '<div style="padding:11px 0;border-bottom:1px solid ' + C.line + '"><div style="font-size:15px;color:' + C.ink + ';font-weight:500">' + main + '</div>' + (sub ? '<div style="font-size:13px;color:' + C.muted + ';margin-top:3px">' + sub + '</div>' : '') + '</div>';
  }

  var body = '';

  if (feats.length) {
    body += section('What’s new', feats.map(function (e) { return row(esc(e.title || 'Update'), esc(e.what || '')); }).join(''));
  }
  if (meetings.length) {
    body += section('Meetings logged', meetings.map(function (m) {
      var d = fmtDay(ms(m.at) || ms(m.date));
      var src = m.source === 'ai' ? ' · from AI notes' : '';
      return row(esc(m.title || 'Meeting') + ' <span style="color:' + C.faint + ';font-weight:400;font-size:13px">' + esc(d) + esc(src) + '</span>', esc((m.disc || '').slice(0, 140)));
    }).join(''));
  }
  if (files.length) {
    body += section('New in the Library', files.map(function (f) {
      var nm = String(f.pathname || '').split('/').pop().replace(/-[a-zA-Z0-9]{10,}(\.[^.]+)?$/, '$1');
      return row(esc(nm || f.pathname), fmtDay(ms(f.uploadedAt)));
    }).join(''));
  }
  if (posts.length || moves.length) {
    var rm = '';
    if (posts.length) rm += posts.slice(0, 6).map(function (p) { return row('<span style="color:' + C.muted + ';font-weight:400;font-size:14px"><b style="color:' + C.ink + ';font-weight:500">' + esc(p.by || 'someone') + '</b> — ' + esc(String(p.text || '').slice(0, 160)) + '</span>', ''); }).join('');
    if (moves.length) rm += row(moves.length + ' roadmap status update' + (moves.length === 1 ? '' : 's'), '');
    body += section('On the RoadMap', rm);
  }

  if (!total) {
    body += '<tr><td style="padding:22px 28px 0"><div style="padding:16px 18px;background:' + C.paper + ';border-radius:8px;font-size:14px;color:' + C.muted + '">Quiet week in the hub — nothing new logged. Jump in when you get a chance: log a meeting, post where we’re at, or drop a file in the Library.</div></td></tr>';
  }

  var openLine = openFb ? ('<p style="margin:16px 0 0;font-size:13px;color:' + C.muted + '">' + openFb + ' suggestion' + (openFb === 1 ? '' : 's') + ' waiting in the queue on Our RoadMap.</p>') : '';

  const html = '<!doctype html><html><body style="margin:0;background:' + C.paper + ';font-family:' + sans + ';-webkit-font-smoothing:antialiased">' +
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0">Your week in the Beam hub — ' + esc(range) + '.</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + C.paper + ';padding:28px 14px"><tr><td align="center">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:' + C.surface + ';border:1px solid ' + C.line + ';border-radius:14px;overflow:hidden">' +
    '<tr><td style="background:' + C.ink + ';padding:22px 28px"><span style="color:#fff;font-size:15px;font-weight:500;letter-spacing:.24em;text-transform:uppercase">BEAM</span><span style="color:rgba(255,255,255,.55);font-size:11px;letter-spacing:.16em;text-transform:uppercase;float:right;padding-top:4px">The hub &middot; weekly</span></td></tr>' +
    '<tr><td style="padding:26px 28px 2px"><h1 style="margin:0;font-size:24px;font-weight:300;color:' + C.ink + '">Our week in the hub</h1><p style="margin:8px 0 0;font-size:13px;color:' + C.faint + '">' + esc(range) + '</p></td></tr>' +
    '<tr><td style="padding:16px 28px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ' + C.line + ';border-radius:10px"><tr>' +
    statCell(feats.length, 'new', C) + statCell(meetings.length, meetings.length === 1 ? 'meeting' : 'meetings', C) + statCell(files.length, files.length === 1 ? 'file' : 'files', C) + statCell(posts.length, posts.length === 1 ? 'post' : 'posts', C) +
    '</tr></table></td></tr>' +
    body +
    '<tr><td style="padding:24px 28px 6px">' + openLine + '<a href="' + SITE + '/guide.html" style="display:inline-block;margin-top:16px;background:' + C.ink + ';color:#fff;text-decoration:none;font-size:13px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;padding:12px 24px;border-radius:999px">Open the hub</a></td></tr>' +
    '<tr><td style="padding:22px 28px 26px"><p style="margin:0;font-size:11px;color:' + C.faint + ';line-height:1.6">You’re getting this because you’re one of the three of us. It goes out every Sunday evening. Want something changed? Use the <b style="color:' + C.muted + ';font-weight:500">Suggest a change</b> box on any page.</p></td></tr>' +
    '</table></td></tr></table></body></html>';

  return { subject: subject, html: html, counts: counts };
}

function statCell(n, label, C) {
  return '<td align="center" style="padding:14px 6px;border-right:1px solid ' + C.line + '"><div style="font-size:26px;font-weight:300;color:' + (n ? C.accent : C.faint) + '">' + n + '</div><div style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:' + C.faint + ';margin-top:2px">' + esc(label) + '</div></td>';
}

async function sendEmail(opts) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: false, reason: 'RESEND_API_KEY not set' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ from: opts.from, to: opts.to, subject: opts.subject, html: opts.html }),
    });
    const text = await r.text();
    return { sent: r.ok, status: r.status, body: text.slice(0, 500) };
  } catch (e) { return { sent: false, reason: String((e && e.message) || e) }; }
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET || '';
  const q = req.query || {};
  const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(q.secret || '');
  if (!secret || provided !== secret) { res.status(401).json({ error: 'unauthorized' }); return; }

  const preview = String(q.preview || '') === '1';
  const days = Math.max(1, Math.min(60, parseInt(q.days, 10) || 7));

  const results = await Promise.all([kv('beam-whatsnew'), kv('beam-progress'), kv('beam-meetings'), kv('beam-feedback')]);
  let files = [];
  try { if (process.env.BLOB_READ_WRITE_TOKEN) { const out = await list(); files = (out && out.blobs) || []; } } catch (e) {}

  const composed = compose({ whatsnew: results[0], progress: results[1], meetings: results[2], feedback: results[3], files: files }, days);

  if (preview) { res.setHeader('content-type', 'text/html; charset=utf-8'); res.status(200).send(composed.html); return; }

  const from = process.env.DIGEST_FROM || 'Beam hub <onboarding@resend.dev>';
  const to = String(process.env.DIGEST_TO || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!to.length) { res.status(200).json({ ok: false, reason: 'DIGEST_TO not set', counts: composed.counts }); return; }

  const sent = await sendEmail({ from: from, to: to, subject: composed.subject, html: composed.html });
  res.status(sent.sent ? 200 : 502).json({ ok: sent.sent, to: to.length, counts: composed.counts, detail: sent });
}
