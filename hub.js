/* Beam hub: the one script every page loads.
 *
 *   1. "Suggest a change"  the box at the bottom of every page. Sends to /api/feedback,
 *                          which adds it to the queue shown on Our RoadMap.
 *   2. "What's new"        reads whatsnew.json. On the Guide it fills the What's new list;
 *                          on every other page it puts a dot next to Guide in the menu
 *                          when there is something this device has not seen yet.
 *
 * Change it here and all six pages get the change. Nothing in here is page-specific.
 */
(function () {
  'use strict';

  var NAME_KEY = 'bb-progress-name';    // the name the RoadMap board already remembers
  var SEEN_KEY = 'bb-whatsnew-seen';    // time (ms) of the newest What's-new entry this device has shown
  var FRESH_MS = 14 * 86400000;         // on a device's first visit, the last two weeks count as new
  var MAX_TEXT = 2000;                  // keep in step with MAX_TEXT in api/_lib/logic.js
  var SHOWN = 5;                        // What's-new entries shown before "show earlier"

  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode: fine */ } }
  function ms(x) { var n = Date.parse(x); return isNaN(n) ? 0 : n; }
  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function pageId() {
    var p = (location.pathname.split('/').pop() || 'index.html').replace(/\.html$/, '');
    return /^[a-z0-9-]{1,40}$/.test(p) ? p : 'index';
  }
  function day(t) { try { return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch (e) { return ''; } }

  var CSS = ''
    + '.fbk-wrap{max-width:760px;margin:0 auto;padding:0 max(18px,env(safe-area-inset-right,0px)) 56px max(18px,env(safe-area-inset-left,0px));font-family:var(--font,sans-serif);}'
    + '.fbk{background:var(--surface,#fff);border:1px solid var(--line,#DDE3E9);border-top:3px solid var(--accent,#1F5EFF);border-radius:8px;box-shadow:var(--shadow,0 10px 30px -18px rgba(20,27,34,.3));padding:18px 20px;}'
    + '.fbk-lab{font-size:10px;font-weight:500;letter-spacing:.2em;text-transform:uppercase;color:var(--faint,#98A4B0);margin:0 0 4px;}'
    + '.fbk-hint{font-size:12.5px;line-height:1.55;color:var(--muted,#5A6775);margin:0 0 13px;}'
    + '.fbk a{color:var(--accent,#1F5EFF);text-decoration:none;}'
    + '.fbk-row{display:flex;gap:10px;align-items:center;margin-bottom:11px;}'
    + '.fbk-name{font:inherit;font-size:13px;padding:8px 11px;border:1px solid var(--line,#DDE3E9);border-radius:6px;width:150px;background:var(--surface,#fff);color:var(--ink,#141B22);}'
    + '.fbk-as{font-size:12px;color:var(--faint,#98A4B0);}'
    + '.fbk-text{display:block;font:inherit;font-size:14px;line-height:1.5;padding:10px 12px;border:1px solid var(--line,#DDE3E9);border-radius:6px;min-height:76px;resize:vertical;width:100%;background:var(--surface,#fff);color:var(--ink,#141B22);}'
    + '.fbk-name:focus,.fbk-text:focus{outline:2px solid var(--accent,#1F5EFF);outline-offset:1px;border-color:transparent;}'
    + '.fbk-foot{display:flex;align-items:center;gap:14px;margin-top:12px;}'
    + '.fbk-go{font:inherit;font-weight:500;letter-spacing:.12em;text-transform:uppercase;font-size:12px;background:var(--ink,#141B22);color:#fff;border:0;border-radius:999px;padding:11px 26px;cursor:pointer;}'
    + '.fbk-go[disabled]{opacity:.55;cursor:default;}'
    + '.fbk-count{font-size:11px;color:var(--faint,#98A4B0);}'
    + '.fbk-count.near{color:var(--warn,#B3382C);}'
    + '.fbk-stat{font-size:12.5px;line-height:1.5;color:var(--good,#0FA37F);margin:10px 0 0;min-height:18px;}'
    + '.fbk-stat.err{color:var(--warn,#B3382C);}'
    + '.nav a .hub-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-left:6px;vertical-align:middle;background:var(--neon,#2DE2E6);box-shadow:0 0 6px var(--neon,#2DE2E6),0 0 12px var(--neon,#2DE2E6);}';

  // ------------------------------------------------------------ Suggest a change
  function suggestBox() {
    if (document.getElementById('fbk-go')) return;
    var here = pageId();
    var sec = document.createElement('section');
    sec.className = 'fbk-wrap';
    sec.setAttribute('aria-label', 'Suggest a change');
    sec.innerHTML = '<div class="fbk">'
      + '<p class="fbk-lab">Suggest a change</p>'
      + '<p class="fbk-hint">See something off, or want something added or changed? Write it here and send. It goes into the queue on '
      + (here === 'progress' ? 'this page' : '<a href="progress.html">Our RoadMap</a>')
      + ', where all three of us can see it, and Mike makes the change. It clears itself from the queue once it is done.</p>'
      + '<div class="fbk-row"><input class="fbk-name" id="fbk-name" maxlength="40" placeholder="your name" autocomplete="given-name" aria-label="Your name" /><span class="fbk-as">sending as</span></div>'
      + '<textarea class="fbk-text" id="fbk-text" maxlength="' + MAX_TEXT + '" placeholder="e.g. On the Vision page, change the tagline to&hellip;" aria-label="What should change"></textarea>'
      + '<div class="fbk-foot"><button class="fbk-go" id="fbk-go" type="button">Send</button><span class="fbk-count" id="fbk-count"></span></div>'
      + '<p class="fbk-stat" id="fbk-stat" role="status" aria-live="polite"></p>'
      + '</div>';
    document.body.appendChild(sec);

    var nameEl = document.getElementById('fbk-name'), textEl = document.getElementById('fbk-text');
    var btn = document.getElementById('fbk-go'), stat = document.getElementById('fbk-stat'), countEl = document.getElementById('fbk-count');
    nameEl.value = get(NAME_KEY) || '';
    nameEl.addEventListener('change', function () { var v = nameEl.value.trim(); if (v) set(NAME_KEY, v); });

    function say(html, isErr) { stat.className = 'fbk-stat' + (isErr ? ' err' : ''); stat.innerHTML = html; }
    function count() {
      var n = textEl.value.length;
      countEl.textContent = n > MAX_TEXT * 0.75 ? n + ' / ' + MAX_TEXT : '';
      countEl.className = 'fbk-count' + (n >= MAX_TEXT ? ' near' : '');
    }
    textEl.addEventListener('input', count);

    function send() {
      if (btn.disabled) return;
      var by = nameEl.value.trim(), text = textEl.value.trim();
      if (!by) { say('Add your name first, so Mike knows who to ask.', true); nameEl.focus(); return; }
      if (!text) { say('Write the change you want first.', true); textEl.focus(); return; }
      set(NAME_KEY, by);
      btn.disabled = true;
      say('Sending&hellip;');
      fetch('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ by: by, text: text, page: here }) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, j: j || {} }; }); })
        .then(function (res) {
          btn.disabled = false;
          if (!res.ok) { say(esc(res.j.error || ('Could not send (error ' + res.status + ').')) + ' Your text is still here.', true); return; }
          textEl.value = ''; count();
          say('Sent. Mike gets an email about it, and it is in the queue ' + (here === 'progress' ? 'above' : 'on <a href="progress.html">Our RoadMap</a>') + '. It clears itself once it is built or we decide to pass.');
          try { window.dispatchEvent(new CustomEvent('hub:suggestion', { detail: res.j.entry || null })); } catch (e) { /* old browser: the queue refreshes on its own */ }
        })
        .catch(function () { btn.disabled = false; say('Could not send. Your text is still here; check your connection and try again.', true); });
    }
    btn.addEventListener('click', send);
    textEl.addEventListener('keydown', function (e) { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); } });
  }

  // ------------------------------------------------------------ What's new
  function whatsNew() {
    var listEl = document.getElementById('wn-list');     // only the Guide has this
    var badge = document.getElementById('wn-badge');
    var guideLink = document.querySelector('.nav a[href="guide.html"]');

    fetch('whatsnew.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        var entries = ((j && Array.isArray(j.entries)) ? j.entries : [])
          .filter(function (e) { return e && e.title && ms(e.at) > 0; })
          .map(function (e) { return { t: ms(e.at), title: e.title, what: e.what || '', by: e.suggestedBy || '' }; })
          .sort(function (a, b) { return b.t - a.t; });
        var baseline = Number(get(SEEN_KEY)) || (Date.now() - FRESH_MS);
        var fresh = entries.filter(function (e) { return e.t > baseline; }).length;

        if (!listEl) {
          if (fresh && guideLink && !guideLink.querySelector('.hub-dot')) {
            var dot = document.createElement('span');
            dot.className = 'hub-dot';
            guideLink.appendChild(dot);
            guideLink.title = fresh === 1 ? '1 new thing in the hub' : fresh + ' new things in the hub';
          }
          return;
        }

        if (!entries.length) { listEl.innerHTML = '<div class="wn-empty">Nothing yet. When something is added to the hub, it shows up here with what it does.</div>'; return; }
        function item(e) {
          var isNew = e.t > baseline;
          return '<div class="wn-item"><div class="wn-h"><span class="wn-t">' + (isNew ? '<span class="wn-dot" title="New since you were last here">●</span> ' : '') + esc(e.title) + '</span>'
            + '<span class="wn-when">' + esc(day(e.t)) + '</span></div>'
            + (e.what ? '<div class="wn-d">' + esc(e.what) + '</div>' : '')
            + (e.by ? '<div class="wn-by">Suggested by ' + esc(e.by) + '</div>' : '')
            + '</div>';
        }
        var html = entries.slice(0, SHOWN).map(item).join('');
        var rest = entries.slice(SHOWN);
        if (rest.length) {
          html += '<div id="wn-rest" hidden>' + rest.map(item).join('') + '</div>'
            + '<button class="wn-more" id="wn-more" type="button">Show ' + rest.length + ' earlier</button>';
        }
        listEl.innerHTML = html;
        var more = document.getElementById('wn-more');
        if (more) more.addEventListener('click', function () { document.getElementById('wn-rest').hidden = false; more.remove(); });
        if (badge) { badge.hidden = !fresh; badge.textContent = fresh ? fresh + ' new' : ''; }
        set(SEEN_KEY, String(entries[0].t));      // this device has now seen everything up to the newest
      })
      .catch(function () { if (listEl) listEl.innerHTML = '<div class="wn-empty">Could not load the updates just now. Reload the page to try again.</div>'; });
  }

  function start() {
    var s = document.createElement('style');
    s.textContent = CSS;
    document.head.appendChild(s);
    suggestBox();
    whatsNew();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
