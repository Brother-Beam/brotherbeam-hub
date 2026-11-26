// Syntax-checks every script in the hub before a deploy: the server functions, hub.js,
// the inline <script> blocks in each page, and the two JSON data files. Run from the
// repo root with the JavaScript engine that ships with macOS (there is no Node here):
//
//   cd hub && /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc tools/check-syntax.js
//
// A syntax error in a page script silently breaks that page; one in a server function
// takes the endpoint down. This catches both before they ship.
var bad = 0, checked = 0;
function report(ok, what, err) { checked++; if (!ok) bad++; print((ok ? '  ok    ' : '  FAIL  ') + what + (err ? '   -> ' + err : '')); }

['api/board.js', 'api/meetings.js', 'api/feedback.js', 'api/digest.js', 'api/parse-notes.js', 'api/blob-upload.js', 'api/blob-list.js', 'api/blob-delete.js', 'api/blob-get.js',
 'api/_lib/logic.js', 'api/_lib/store.js', 'tools/test-logic.js', 'tools/test-store.js'].forEach(function (f) {
  try { checkModuleSyntax(readFile(f)); report(true, f); } catch (e) { report(false, f, String(e)); }
});

try { checkSyntax('hub.js'); report(true, 'hub.js'); } catch (e) { report(false, 'hub.js', String(e)); }

['guide.html', 'index.html', 'progress.html', 'documents.html', 'meetings.html', 'build.html'].forEach(function (page) {
  var html = readFile(page), re = /<script([^>]*)>([\s\S]*?)<\/script>/g, m, n = 0;
  while ((m = re.exec(html))) {
    if (/\bsrc=/.test(m[1])) continue;
    n++;
    var isModule = /type="module"/.test(m[1]);
    try {
      if (isModule) checkModuleSyntax(m[2]); else new Function(m[2]);
      report(true, page + ' inline script ' + n + (isModule ? ' (module)' : ''));
    } catch (e) { report(false, page + ' inline script ' + n, String(e)); }
  }
  report(/<script src="hub\.js" defer><\/script>\s*<\/body>/.test(html), page + ' loads hub.js last');
  report((html.match(/<div/g) || []).length === (html.match(/<\/div>/g) || []).length, page + ' divs balanced');
});

['whatsnew.json', 'roadmap.json', 'vercel.json', 'package.json'].forEach(function (f) {
  try { JSON.parse(readFile(f)); report(true, f + ' is valid JSON'); } catch (e) { report(false, f, String(e)); }
});

// The changelog drives auto-clean, so its shape matters as much as its syntax.
try {
  var cl = JSON.parse(readFile('whatsnew.json'));
  var idShape = /^f[a-z0-9]{6,24}$/;
  var problems = [];
  if (!Array.isArray(cl.entries)) problems.push('"entries" must be a list');
  if (!Array.isArray(cl.declined)) problems.push('"declined" must be a list');
  (cl.entries || []).forEach(function (e, i) {
    if (!e.title) problems.push('entry ' + i + ' has no title');
    if (isNaN(Date.parse(e.at))) problems.push('entry ' + i + ' has no valid "at" date');
    if (Date.parse(e.at) > Date.now() + 3600000) problems.push('entry ' + i + ' is dated in the future, so the email would skip it');
    (e.resolves || []).forEach(function (id) { if (!idShape.test(id)) problems.push('entry ' + i + ' resolves "' + id + '", which is not a suggestion id'); });
  });
  (cl.declined || []).forEach(function (id) { if (!idShape.test(id)) problems.push('declined "' + id + '" is not a suggestion id'); });
  report(problems.length === 0, 'whatsnew.json has the shape auto-clean expects', problems.join('; '));
  var rm = JSON.parse(readFile('roadmap.json'));
  var ids = (rm.now || []).concat(rm.next || []).map(function (x) { return x.id; });
  report(ids.length > 0 && ids.every(Boolean) && new Set(ids).size === ids.length, 'roadmap.json steps each have a unique id');
} catch (e) { report(false, 'data file shape', String(e)); }

print('\n' + (bad ? 'FAILED: ' + bad + ' of ' + checked + ' checks failed' : 'ALL ' + checked + ' CHECKS PASSED'));
