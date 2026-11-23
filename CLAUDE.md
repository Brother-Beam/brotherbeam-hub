# Beam hub

Internal work hub for **Beam**, a consultation and advisory agency that helps good businesses navigate transformation (succession, technology, scaling). Founders: **Nate**, **Pat**, **Mike**. When a client is ready for it, Beam deploys an AI agent called **Scotty** into the business. Read `index.html` (the Vision) first; it is the company in one page.

The repo/project is still named `brotherbeam-hub` for historical reasons; the company is **Beam**.

## Who this is for

The three founders **use** this hub like a shared drive and a meeting log. They do not edit it — Mike maintains it. Do NOT add any "open this in Claude and change any page" language; that contradicts how the team works.

## The pages (static HTML, no build step)

Each page is one self-contained file: inline `<style>` with the brand tokens, the shared nav bar, then the content. The six live pages, grouped as they appear in the nav:

- `guide.html` — **Guide** (how to use the hub) · `index.html` — **Our Vision** (the company)
- `progress.html` — **Our RoadMap** (roadmap + message board) · `documents.html` — **Our Library** (private file store) · `meetings.html` — **Meeting Minutes** (AI-notes parser)
- `build.html` — **How I built this** (plain-language explainer for the founders)

Nav is three color-coded groups separated by `.divi` dividers, with neon hover/active glow (cyan `#2DE2E6`, hot pink `#FF2E88`, purple `#B14EFF`). It is duplicated in each page's markup + `<style>`; change all six together (see `scratchpad` scripts or edit in place).

Brand: font **Jost**. Tokens per page — paper `#F3F5F7`, ink `#141B22`, muted `#5A6775`, accent `#1F5EFF`, good `#0FA37F`, ochre `#B7791F`. Keep `noindex` on every page. Voice: plain complete sentences, first person plural.

## Backend (Vercel serverless functions in `api/`)

- `tasks.js` — proxies shared state to the Railway kv store, adding `HUB_API_TOKEN` server side. Keys: `beam-progress`, `beam-meetings`. Env: `HUB_API_BASE`, `HUB_API_TOKEN`.
- `parse-notes.js` — sends pasted meeting notes to the Anthropic API and returns `{title, discussed, decisions[], actionItems[{item,owner}]}`. Env: `ANTHROPIC_API_KEY`. Model `claude-opus-5-5`.
- `blob-upload.js` / `blob-list.js` / `blob-delete.js` / `blob-get.js` — the Library's file store on **Vercel Blob**. Env: `BLOB_READ_WRITE_TOKEN`.

### Blob gotchas (hard-won — do not regress)

- The store is **private**. Upload with `access: 'private'`; files are NOT reachable by their raw URL. `blob-get.js` streams a file to the browser server-side via `get(path, { access: 'private' })` — that is why the Library links downloads through `/api/blob-get`, never the blob URL.
- `blob-upload.js` imports `handleUpload` from `@vercel/blob/client` **dynamically** (`await import(...)`). A top-level static import of `@vercel/blob/client` crashes the function at load (`FUNCTION_INVOCATION_FAILED`). The main `@vercel/blob` entry (used by list/del/get) is fine to import statically.
- The four blob endpoints are gated by `?pw=beam` (or `clientPayload.pw` for upload). `beam` is a convenience lock in the page source, not a secret. Only **Our Library** is gated; the rest of the hub is open.

## Deploy

Push to `main` → Vercel auto-deploys. Env vars live in Vercel; the Railway token lives in Railway. Never commit a secret or the deploy-hook URL (this repo is public). After a push, give Vercel ~1 min, then check the live site at `https://brotherbeam-hub.vercel.app`.

## The other repo

`brotherbeam-api` — the shared store: Express + Postgres on Railway, one `kv` table, bearer-token protected.
