# Brother Beam hub

This repo is the internal work hub for **Brother Beam**, a consulting company founded by Pat Fitzgerald (founder) with Mike FitzGerald (co-founder) and a third partner. Read `vision.html` first: it is the company in one page.

**What the company does, in one line:** we strengthen businesses that already work. The method is sistering: when a sound beam must carry more, a builder bolts a new beam alongside it instead of tearing it out. We measure a business as built (Survey), draw the target structure with AI inside it (Blueprint), build the new structure beside what works, workflow by workflow (Sistering), and stay until the load holds (Carry). The first move, a Walkthrough, is free.

## How this hub is built

- Static HTML, no build step. Every page is one file. Styling comes from `brand.css` (tokens at the top: paper, ink, accent, font). Company facts come from `site.js` (`window.SITE`: name, tagline, people, pillars, gate password). Pages fill `[data-site="…"]` elements from it.
- `index.html` is the home. `roadmap.html` holds the Work Station (shared checklist, edit `ITEMS` in the file) and the Roadmap (edit `INITS`). `vision.html` is the vision. `tools.js` is the inventory the home page renders; add a tool by adding one entry.
- Shared state (Work Station status) is saved through `api/tasks.js`, a Vercel function that proxies to the company's API on Railway and adds the token server side. Browsers never hold a secret. Environment variables on Vercel: `HUB_API_BASE`, `HUB_API_TOKEN`.
- Deploy: every push to `main` deploys on Vercel. There is nothing to run locally; open the HTML files in a browser to check them.

## Conventions

- Construction vocabulary is the brand: sistering, load path, good bones, Survey, Blueprint, Carry, scaffolding, retrofit. Use these words consistently; the glossary at the bottom of `vision.html` defines them.
- Writing: complete plain sentences, first person plural, no slogans beyond the tagline, no em dashes, numbers written plainly. Say what a thing does and why in one clause.
- New pages copy the structure of an existing one: the `.bar` strip, the `.wrap`, `.kick` + `h1`, sections with `.sec-h`, cards from `brand.css`. Keep `noindex` on every page; this hub is internal.
- Never commit a secret. Tokens and passwords live in Vercel and Railway only. The gate password in `site.js` is a convenience lock, not a secret.
- When something ships, add a line to the matching initiative's log in `roadmap.html` (`INITS`) so the roadmap stays the source of truth.

## The other repo

`brotherbeam-api` is the store: Express + Postgres on Railway, one `kv` table, bearer-token protected. Its README has the deploy steps.
