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

**Owed once email is flowing.** As of 2026-11-26 the delivery task had not yet been confirmed running, so the hub deliberately does not describe any email yet (nothing on the site should claim something that is not happening). Once Mike has received a real alert through the Claude task: add `whatsnew.json` entries for the Sunday summary and for the alerts, add a line about both to the Guide ("Asking for a change to the hub" and "Good to know"), and add a card to "The pieces" in `build.html`.

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

- `board.js` — the RoadMap page's state. `GET` returns `{ items, messages }`; `POST { action: 'post', by, text }` adds a board post; `POST { action: 'status', id, status, by }` sets one roadmap step's status (the id must exist in `roadmap.json`).
- `meetings.js` — the meeting log. `GET` returns `{ meetings }`; `POST { action: 'add', meeting }` appends one (the server assigns its `id` and `at`); `POST { action: 'remove', id }` takes one out.
- `feedback.js` — the suggestions queue. `GET` returns `{ open, count }` after auto-clean; `POST { by, text, page }` adds one. Browsers can only read and add.
- `outbox.js` — the email the hub has ready, for the scheduled Claude task to collect and send (see "Email" below).

No page ever sends a whole stored value back. Every page sends one small action, the endpoint applies it with `kvUpdate()` to whatever is stored at that moment, and replies with the up-to-date value, which the page then shows. That is what makes it safe for the three of them to use the hub at the same time. There is deliberately no generic "save this key" endpoint any more (the old `api/tasks.js` was removed): do not add one, and do not make a page keep state that it later writes back.
- `digest.js` — the weekly email (below).
- `parse-notes.js` — sends pasted meeting notes to the Anthropic API and returns `{title, discussed, decisions[], actionItems[{item,owner}]}`. Env: `ANTHROPIC_API_KEY`. Model `claude-opus-5-5`.
- `blob-upload.js` / `blob-list.js` / `blob-delete.js` / `blob-get.js` — the Library's file store on **Vercel Blob**. Env: `BLOB_READ_WRITE_TOKEN`. Listing is also how a new upload is noticed.
- `_lib/logic.js` — all the rules, pure (no imports, no I/O): validating a suggestion, which suggestions are closed, which ones still need an alert, the board and meeting actions, the Sunday-evening decision, and composing both emails. `_lib/store.js` — I/O: `kvGet`, `kvUpdate`, `loadSiteJson`, `reconcileSuggestions` (the auto-clean). `_lib/alerts.js` — notices new posts, statuses, meetings and files. `_lib/week.js` — gathers what the weekly summary is built from. `_lib/mail.js` — sending, used only if the hub is ever given its own sender. Files under `api/_lib` are not routes.

### Store keys (Railway, via `HUB_API_BASE` / `HUB_API_TOKEN`)

| Key | Shape | Written by |
|---|---|---|
| `beam-progress` | `{ items: { [stepId]: { status, by, at } }, messages: [{ by, at, text }] }` | `board.js` only |
| `beam-meetings` | `{ meetings: [{ id, date, title, disc, decisions[], actionItems[], prog, by, at, source }] }` | `meetings.js` only |
| `beam-feedback` | `{ feedback: [{ id, by, at, text, page, mailed?, mailClaim? }] }` — open suggestions only. `mailed` (when its alert went out, or `'skip'`) and `mailClaim` are private; `publicEntry()` strips them before anything reaches a browser | `feedback.js` only |
| `beam-feedback-closed` | `{ closed: [{ id, by, outcome, closedAt }] }` — a tally, never the text | auto-clean only |
| `beam-digest-state` | `{ lastSent, lastSentAt, lastVia, lastCounts, lastError, lastTest, claim }` | `digest.js` and `outbox.js` |
| `beam-alert-state` | `{ seen: { posts, statuses, meetings, files }, claim: { [kind]: time }, sent: [times] }` | `_lib/alerts.js` and `outbox.js` |
| `beam-progress-sandbox`, `beam-meetings-sandbox` | same shapes as the real two | `board.js` / `meetings.js` with `?sandbox=1` (test data only) |

The store has **versioned writes** (see `../api/CLAUDE.md`). Every write to every key goes through `kvUpdate(key, change)`, which reads, applies the change, writes with the version it read, and retries on a conflict. Never write a key any other way. `change()` may run more than once, so it must be free of side effects that add up.

Nothing is ever dropped to make room. Each value has to fit the store's 200 KB limit (`STORE_LIMIT` in `logic.js` stops at 190,000 characters); when a board post or a meeting would not fit, it is refused with a message telling them to ask Mike. That is a long way off (hundreds of ordinary posts, well over a hundred meetings), but when it comes the fix is to move older entries to an archive key, not to raise the limit or trim silently.

What the pages keep in `localStorage` (`bb-progress-local`, `bb-meetings-local`) is only the last copy the server sent, shown if the server cannot be reached. It is never used to save.

## Email: written by the hub, delivered by Claude

**The decision (Mike, 2026-11-26): no email password is stored at Vercel.** He was offered the hub sending its own email with a Gmail app password and said no. Do not suggest it again unless he raises it. Email is therefore delivered by a scheduled Claude task on Mike's Mac, through the Gmail connection he already has in Claude.

The split of work is deliberate: **the hub decides and writes; Claude only collects and sends.** Every rule (what is news, who it is from, what the email says, when the weekly summary is due) lives in `logic.js` and is tested. The scheduled task contains no rules, only "collect, send, report".

What gets emailed:

| What | To | When it is ready |
|---|---|---|
| A suggestion from the box on any page | Mike | as soon as it is sent |
| A board post, a roadmap status change, a meeting logged, a file uploaded to the Library | Mike | as soon as it happens |
| The weekly summary | all three | from Sunday 6 PM Mountain until Wednesday 6 PM, written as of Sunday 6 PM |

Mike is not emailed about his own posts, status changes, meetings or uploads. "His own" means the name typed starts with Mike or Michael (`ADMIN_NAMES` in Vercel changes the list). The Library page sends the remembered name in an `x-hub-by` header after its own upload, which is how an upload gets an owner.

**The outbox, `/api/outbox`** (needs `?pw=scooter`):
- `GET` returns `{ mail: [{ key, to, subject, text, html? }] }`: everything ready right now. `to` is a role, `mike` or `everyone`, never an address. `html` is left out when it is over 12 KB (the weekly summary), because whoever delivers has to hand the body to the mail tool; the plain text goes instead.
- Collecting **claims** each email for a few minutes so two collectors cannot both send it. `POST { sent: [keys] }` records it for good. If the collector never reports back, the claim lapses and the email is offered again: nothing is lost, at worst something goes twice.
- `GET ...&dry=1` shows what is waiting and changes nothing. Add `&now=2026-11-30T01:30:00Z` to see what would be waiting at another moment (for example a Sunday evening).

**The scheduled task** lives on Mike's Mac, not in this repo: `~/.claude/scheduled-tasks/` (the `mcp__scheduled-tasks__*` tools list and edit it). Its prompt holds the three email addresses, which is why they never need to be in this public repo or in Vercel. It only runs while the Claude app is open; anything that became ready while it was closed is delivered at the next run, which is exactly what the claim-and-catch-up design is for. If Mike reports missing or duplicate email, check the task's run history first, then `/api/outbox?pw=scooter&dry=1`.

How "news" is tracked: suggestions carry private marks (`mailed`, `mailClaim`) in `beam-feedback`; everything else uses one small value, `beam-alert-state`, holding per kind the time of the newest item Mike has been told about. The first time a kind is looked at it starts from a minute before, so nothing that was already in the hub is ever sent as a backlog.

**If the hub is ever given a way to send by itself** (it has not been): `_lib/mail.js` can send through Gmail (`DIGEST_TO` + `GMAIL_APP_PASSWORD`) or Resend (`RESEND_API_KEY` + `DIGEST_FROM`). With either set, the same endpoints send each alert at the moment it happens (`_lib/alerts.js`, `feedback.js`) and `digest.js` sends the weekly summary on the Sunday cron in `vercel.json`; the outbox then has nothing left to hand over, so the two routes cannot double-send. Without them those code paths do nothing except keep the "told up to" marks moving, and `/api/digest?status=1` reports `ready: false`. That is the expected state, not a fault.

Also useful: `/api/digest?preview=1&pw=scooter` renders the weekly summary as it would look right now (the designed HTML version), and `&format=text` shows the plain-text version that is actually delivered.

## Tests (run before every deploy)

There is no Node on Mike's machine. The JavaScript engine that ships with macOS runs everything:

```bash
cd hub && JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
$JSC tools/check-syntax.js      # every server function, hub.js, every inline page script, the JSON files
$JSC -m tools/test-logic.js     # the rules: suggestions, auto-clean, the Sunday decision over 3 years, the email
$JSC -m tools/test-store.js     # read-change-write under load, and auto-clean against a fake store
```

Each prints `ALL n CHECKS PASSED` or names what failed. `tools/` is excluded from the deployed site by `.vercelignore`. If you change a rule in `logic.js`, change or add the test that pins it.

### Testing the board and the meeting log on the live site

Board posts cannot be deleted and meetings are the company's record, so never test with the real ones. Both endpoints and both pages have a sandbox: add `?sandbox=1` (`/api/board?sandbox=1`, `/api/meetings?sandbox=1`, `progress.html?sandbox=1`, `meetings.html?sandbox=1`). Everything then reads and writes separate keys, the page shows a red "Sandbox" bar, and `POST { action: 'reset' }` empties the sandbox when you are done (it is refused outside the sandbox). The sandbox runs the same code against the same store, so it proves the real thing.

### Testing the queue on the live site

To check the queue for real, send suggestions under a name ending in **`(testing)`** (for example `Claude (testing)`), with text starting `TEST`, and **add `"quiet": true` to the POST body** so they are never emailed to Mike (only test data may be quiet; without it a test suggestion lands in the outbox marked `[Test]` and the Claude task will send it to him, which is the right way to check one alert end to end with his say-so). They are stored, shown in the queue and cleared by auto-clean exactly like real ones, but `isTestEntry()` keeps them out of the weekly email's counts, so a test can never reach the founders' inboxes. Clear them the real way: put their ids under `declined` in `whatsnew.json` and deploy; once `/api/feedback` shows them gone, take the ids back out of `declined` in the next commit so the file stays tidy. `/api/digest?preview=1&pw=scooter&format=json&tests=1` counts test data too, which is how to confirm the tally was written. Never mark a suggestion `declined` unless it is test data or Mike said to pass on it.

## Blob gotchas (hard-won — do not regress)

- The store is **private**. Upload with `access: 'private'`; files are NOT reachable by their raw URL. `blob-get.js` streams a file to the browser server-side via `get(path, { access: 'private' })` — that is why the Library links downloads through `/api/blob-get`, never the blob URL.
- `blob-upload.js` imports `handleUpload` from `@vercel/blob/client` **dynamically** (`await import(...)`). A top-level static import of `@vercel/blob/client` crashes the function at load (`FUNCTION_INVOCATION_FAILED`). The main `@vercel/blob` entry (used by list/del/get/digest) is fine to import statically. `digest.js` loads `nodemailer` dynamically for the same reason: a mail library must never be able to stop the file loading.
- The four blob endpoints are gated by `?pw=scooter` (or `clientPayload.pw` for upload), and so is the email preview. `scooter` is a convenience lock in the page source, not a secret. Only **Our Library** is gated; the rest of the hub is open by link.

## Deploy

Run the three test commands. Push to `main` → Vercel deploys in about a minute. Env vars live in Vercel; the store's token lives in Railway. Never commit a secret, an email address, or the deploy-hook URL. After a push, check the live site at `https://brotherbeam-hub.vercel.app`, and for anything touching saved data or the email, check `/api/board`, `/api/meetings`, `/api/feedback` and `/api/digest?status=1` too.

## The other repo

`brotherbeam-api` (checked out beside this one at `../api`) — the shared store: Express + Postgres on Railway, one `kv` table with versioned writes, bearer-token protected. Every push to its `main` deploys.
