# Beam hub

Internal work hub for **Beam**, a consultation and advisory agency that helps good businesses navigate transformation (succession, technology, scaling). Founders: **Nate**, **Pat**, **Mike**. When a client is ready for it, Beam deploys an AI agent called **Scotty** into the business. Read `index.html` (the Vision) first; it is the company in one page.

The repo/project is still named `brotherbeam-hub` for historical reasons; the company is **Beam**. This repo is **public**.

## Who this is for

The three founders **use** this hub like a shared drive and a meeting log. They do not edit it. Mike maintains it, through Claude Code. Do NOT add any "open this in Claude and change any page" language; that contradicts how the team works. When a founder wants something changed they send it from the **Suggest a change** box, and it reaches Mike through the queue described below.

## The suggestion loop (read this before changing anything)

This is the hub's change process. Follow it every time; it is what keeps the queue clean without anyone tidying it.

1. A founder sends a suggestion from the box at the bottom of any page. It is stored in the queue and shown on Our RoadMap.
2. Mike asks for it to be built (or says to pass on it). List what is open, with ids:
   ```bash
   curl -s https://brotherbeam-hub.vercel.app/api/feedback
   ```
3. **If you build it:** in the *same commit* as the change, add an entry to the top of `entries` in `whatsnew.json`:
   ```json
   { "id": "short-slug", "at": "2026-12-01T18:00:00Z", "title": "What it is", "what": "One or two plain sentences on what it does.", "suggestedBy": "Nate", "resolves": ["f…the suggestion id…"] }
   ```
   `at` must be the current time in UTC, **not in the future** (the weekly email skips future-dated entries). `resolves` may hold several ids. Leave `suggestedBy` empty if nobody asked.
4. **If the answer is no:** add the suggestion's id to the `declined` list in `whatsnew.json`. Nothing else.
5. Deploy. That is the whole clean-up. The moment the deploy is live, `/api/feedback` sees the id in the shipped `whatsnew.json` and deletes that suggestion from the queue; the entry appears under What's new on the Guide, a dot shows next to Guide in everyone's menu, and it goes in the next Sunday email.

**Never** build a suggestion without adding its id to `resolves`, and never tell Mike a suggestion is handled without doing step 3 or 4. There is no remove button and there must not be one: Mike explicitly does not want clean-up to depend on someone remembering to click. Ids listed in `whatsnew.json` that are already gone from the queue are harmless; leave them.

Every new feature gets a `whatsnew.json` entry even when nobody suggested it. Write `what` for a non-technical founder: what it does for them, not how it works.

## The pages (static HTML, no build step)

Each page is one self-contained file: inline `<style>` with the brand tokens, the shared nav bar, then the content. The six live pages, grouped as they appear in the nav:

- `guide.html` — **Guide** (how to use the hub; **What's new** at the top) · `index.html` — **Our Vision** (the company)
- `progress.html` — **Our RoadMap** (roadmap steps from `roadmap.json`, the message board, and the read-only **Suggestions for the hub** queue) · `documents.html` — **Our Library** (private file store) · `meetings.html` — **Meeting Minutes** (AI-notes parser)
- `build.html` — **How I built this** (plain-language explainer for the founders)

Nav is three color-coded groups separated by `.divi` dividers, with neon hover/active glow (cyan `#2DE2E6`, hot pink `#FF2E88`, purple `#B14EFF`). It is duplicated in each page's markup + `<style>`; change all six together.

Brand: font **Jost**. Tokens per page — paper `#F3F5F7`, ink `#141B22`, muted `#5A6775`, accent `#1F5EFF`, good `#0FA37F`, ochre `#B7791F`. Keep `noindex` on every page. Voice: plain complete sentences, first person plural.

### Shared across pages

- **`hub.js`** — loaded last by every page (`<script src="hub.js" defer></script>`). It builds the **Suggest a change** box (posts to `/api/feedback`) and handles **What's new** (fills the list on the Guide; elsewhere puts a dot next to Guide in the nav when there is an entry this device has not seen, tracked in `localStorage` `bb-whatsnew-seen`). Anything that must behave the same on every page goes here, not pasted into six files.
- **`whatsnew.json`** — the changelog, and the source of truth for auto-clean. `{ entries: [{ id, at, title, what, suggestedBy, resolves[] }], declined: [] }`. Read by `hub.js`, by `/api/feedback` (auto-clean) and by the weekly email.
- **`roadmap.json`** — the roadmap steps (`now` / `next`, each `{ id, own, c, t, d }`). Read by `progress.html` and by the weekly email, so they can never disagree. Statuses are stored per `id` in `beam-progress`; do not reuse an id for a different step.

## Backend (Vercel serverless functions in `api/`)

- `tasks.js` — proxies page state to the store, adding `HUB_API_TOKEN` server side. Used by the pages for `beam-progress` and `beam-meetings` (whole-value, last-write-wins). Refuses the server-managed keys below.
- `feedback.js` — the suggestions queue. `GET` returns `{ open, count }` after auto-clean; `POST { by, text, page }` adds one. Browsers can only read and add.
- `digest.js` — the weekly email (below).
- `parse-notes.js` — sends pasted meeting notes to the Anthropic API and returns `{title, discussed, decisions[], actionItems[{item,owner}]}`. Env: `ANTHROPIC_API_KEY`. Model `claude-opus-5-5`.
- `blob-upload.js` / `blob-list.js` / `blob-delete.js` / `blob-get.js` — the Library's file store on **Vercel Blob**. Env: `BLOB_READ_WRITE_TOKEN`.
- `_lib/logic.js` — all the rules, pure (no imports, no I/O): validating a suggestion, which suggestions are closed, the Sunday-evening decision, and composing the email. `_lib/store.js` — I/O: `kvGet`, `kvUpdate`, `loadSiteJson`, `reconcileSuggestions` (the auto-clean). Files under `api/_lib` are not routes.

### Store keys (Railway, via `HUB_API_BASE` / `HUB_API_TOKEN`)

| Key | Shape | Written by |
|---|---|---|
| `beam-progress` | `{ items: { [stepId]: { status, by, at } }, messages: [{ by, at, text }] }` | `progress.html` through `tasks.js` |
| `beam-meetings` | `{ meetings: [{ id, date, title, disc, decisions[], actionItems[], prog, by, at, source }] }` | `meetings.html` through `tasks.js` |
| `beam-feedback` | `{ feedback: [{ id, by, at, text, page }] }` — open suggestions only | `feedback.js` only |
| `beam-feedback-closed` | `{ closed: [{ id, by, outcome, closedAt }] }` — a tally, never the text | auto-clean only |
| `beam-digest-state` | `{ lastSent, lastSentAt, lastCounts, lastError, lastTest, claim }` | `digest.js` only |

The store has **versioned writes** (see `../api/CLAUDE.md`). Anything server-side that reads a value, changes it and writes it back must go through `kvUpdate(key, change)`, which retries on a version conflict. Never write the three server-managed keys any other way. `change()` may run more than once, so it must be free of side effects that add up.

Known gap, not yet fixed: `beam-progress` and `beam-meetings` are still saved whole by the browser, so two people editing within the same ~45 seconds can overwrite each other. Fixing it means moving those writes behind server endpoints that use `kvUpdate`, the way suggestions work.

## The weekly email

Every **Sunday at 6:00 PM Mountain**, `digest.js` emails the three founders the week in the hub: where the roadmap stands, meetings logged (with decisions and action items), files added to the Library, board posts, new What's-new entries, and the state of the suggestions queue.

- **Schedule.** `vercel.json` has two cron slots, Monday 00:00 and 01:00 UTC, because cron is UTC and Mountain time moves with daylight saving. `decide()` checks Mountain time itself and sends in the 6 PM hour. It claims the day in `beam-digest-state` before sending (so two runs cannot both send) and records `lastSent` after; on failure it releases the claim so the next slot retries. To change the day or hour, change `SEND_WEEKDAY` / `SEND_HOURS` in `logic.js` **and** the cron slots, then run the tests.
- **Environment (Vercel).** `CRON_SECRET` (any long random string; nothing sends without it), `DIGEST_TO` (comma-separated recipients, Mike first; kept here and **never in this public repo**), and one way to send: `GMAIL_USER` + `GMAIL_APP_PASSWORD`, or `RESEND_API_KEY` + `DIGEST_FROM` (needs a domain verified at Resend). Env changes need a redeploy.
- **Checking it** (no secret needed): `/api/digest?status=1` shows what is configured, what is missing and when it last sent. `/api/digest?preview=1&pw=scooter` renders the email as it would look now. `/api/digest?dry=1&pw=scooter&now=2026-11-30T01:05:00Z` says whether the scheduler would send at that moment. None of these send.
- **Sending by hand** needs the secret (`&secret=…`): `?test=1` sends only to the first address in `DIGEST_TO`; `?force=1` sends to everyone now. Sending real email to the founders is Mike's call; ask first.

## Tests (run before every deploy)

There is no Node on Mike's machine. The JavaScript engine that ships with macOS runs everything:

```bash
cd hub && JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
$JSC tools/check-syntax.js      # every server function, hub.js, every inline page script, the JSON files
$JSC -m tools/test-logic.js     # the rules: suggestions, auto-clean, the Sunday decision over 3 years, the email
$JSC -m tools/test-store.js     # read-change-write under load, and auto-clean against a fake store
```

Each prints `ALL n CHECKS PASSED` or names what failed. `tools/` is excluded from the deployed site by `.vercelignore`. If you change a rule in `logic.js`, change or add the test that pins it.

### Testing the queue on the live site

To check the queue for real, send suggestions under a name ending in **`(testing)`** (for example `Claude (testing)`), with text starting `TEST`. They are stored, shown in the queue and cleared by auto-clean exactly like real ones, but `isTestEntry()` keeps them out of the weekly email's counts, so a test can never reach the founders' inboxes. Clear them the real way: put their ids under `declined` in `whatsnew.json` and deploy; once `/api/feedback` shows them gone, take the ids back out of `declined` in the next commit so the file stays tidy. `/api/digest?preview=1&pw=scooter&format=json&tests=1` counts test data too, which is how to confirm the tally was written. Never mark a suggestion `declined` unless it is test data or Mike said to pass on it.

## Blob gotchas (hard-won — do not regress)

- The store is **private**. Upload with `access: 'private'`; files are NOT reachable by their raw URL. `blob-get.js` streams a file to the browser server-side via `get(path, { access: 'private' })` — that is why the Library links downloads through `/api/blob-get`, never the blob URL.
- `blob-upload.js` imports `handleUpload` from `@vercel/blob/client` **dynamically** (`await import(...)`). A top-level static import of `@vercel/blob/client` crashes the function at load (`FUNCTION_INVOCATION_FAILED`). The main `@vercel/blob` entry (used by list/del/get/digest) is fine to import statically. `digest.js` loads `nodemailer` dynamically for the same reason: a mail library must never be able to stop the file loading.
- The four blob endpoints are gated by `?pw=scooter` (or `clientPayload.pw` for upload), and so is the email preview. `scooter` is a convenience lock in the page source, not a secret. Only **Our Library** is gated; the rest of the hub is open by link.

## Deploy

Run the three test commands. Push to `main` → Vercel deploys in about a minute. Env vars live in Vercel; the store's token lives in Railway. Never commit a secret, an email address, or the deploy-hook URL. After a push, check the live site at `https://brotherbeam-hub.vercel.app`, and for anything touching the queue or the email, check `/api/feedback` and `/api/digest?status=1` too.

## The other repo

`brotherbeam-api` (checked out beside this one at `../api`) — the shared store: Express + Postgres on Railway, one `kv` table with versioned writes, bearer-token protected. Every push to its `main` deploys.
