// Parses pasted AI meeting notes into a consistent structure (a summary,
// decisions made, and action items with owners) via the Anthropic API.
// Node function, zero-dependency (global fetch), to keep the Vercel build
// simple. Needs ANTHROPIC_API_KEY in the environment. Open (no password).

const SYSTEM = [
  'You extract a structured record from meeting notes for a small advisory firm called Brother Beam.',
  'Its three founders are Nate, Pat, and Mike.',
  'You are given raw notes or an AI notetaker transcript/summary of one meeting.',
  'Return ONLY a JSON object, with no prose and no code fences, in exactly this shape:',
  '{',
  '  "title": string,            // a 2 to 6 word title for the meeting',
  '  "discussed": string,        // 2 to 4 plain sentences on what was covered',
  '  "decisions": string[],      // each decision the group actually made',
  '  "actionItems": [ { "item": string, "owner": string } ]  // each next action and who owns it',
  '}',
  'Owner must be one of: Nate, Pat, Mike, All, or Unassigned. Use All when it is shared and Unassigned when the notes do not say.',
  'Only include decisions and action items that the notes actually support. Do not invent anything. If a field has nothing, use an empty array or an empty string.',
  'Write in plain, complete sentences. No em dashes.',
].join('\n');

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  const key = process.env.ANTHROPIC_API_KEY || '';
  if (!key) { res.status(503).json({ error: 'parser not configured: set ANTHROPIC_API_KEY on Vercel' }); return; }
  const body = (req.body && typeof req.body === 'object') ? req.body : (function () { try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; } })();
  const notes = String(body.notes || '').trim();
  if (!notes) { res.status(400).json({ error: 'no notes' }); return; }
  if (notes.length > 120000) { res.status(413).json({ error: 'notes too long; trim them a little' }); return; }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-opus-5-5',
        max_tokens: 2000,
        output_config: { effort: 'low' },
        system: SYSTEM,
        messages: [{ role: 'user', content: notes }],
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      res.status(502).json({ error: 'the parser could not be reached', detail: String(t).slice(0, 300) });
      return;
    }
    const data = await r.json();
    if (data.stop_reason === 'refusal') { res.status(422).json({ error: 'the parser declined these notes' }); return; }
    const text = (data.content || []).filter(function (b) { return b && b.type === 'text'; }).map(function (b) { return b.text || ''; }).join('').trim();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) {} }
    }
    if (!parsed || typeof parsed !== 'object') { res.status(502).json({ error: 'could not read the parsed result' }); return; }

    const okOwner = { nate: 'Nate', pat: 'Pat', mike: 'Mike', all: 'All', unassigned: 'Unassigned' };
    const out = {
      title: String(parsed.title || 'Meeting').slice(0, 120),
      discussed: String(parsed.discussed || ''),
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions.map(String).filter(Boolean).slice(0, 40) : [],
      actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems.map(function (a) {
        a = a || {};
        var owner = okOwner[String(a.owner || '').trim().toLowerCase()] || (a.owner ? String(a.owner) : 'Unassigned');
        return { item: String(a.item || a.text || '').trim(), owner: owner };
      }).filter(function (a) { return a.item; }).slice(0, 60) : [],
    };
    res.status(200).json(out);
  } catch (e) {
    res.status(502).json({ error: 'parser unreachable', detail: String((e && e.message) || e) });
  }
}
