# Work hub

The company's internal hub: home page, Roadmap and Work Station with shared state, and a tools inventory. Built on the same pattern as the GWC hub.

## How it fits together

```
Browser  ->  this site on Vercel (static pages + /api/tasks)  ->  brotherbeam-api on Railway (Express + Postgres)
                                  adds the API token server side          checks the token, stores JSON
```

The browser never holds a secret. The only secret on this side is `HUB_API_TOKEN`, set in Vercel, used by `api/tasks.js`.

## Rename the company

1. `site.js`: name, full name, tagline, what we do, the gate password, the three founders.
2. `brand.css`: the tokens at the top (paper, ink, accent, font).
3. `favicon.svg`: replace with the mark.

Nothing else references the name.

## Deploy, first time

1. **Railway**: deploy `brotherbeam-api` first (its README has the steps). Copy its public URL and the `API_TOKEN` you set there.
2. **Vercel**: Add New Project -> Import `brotherbeam-hub` from GitHub -> Framework preset: Other -> Deploy.
3. Vercel -> Project -> Settings -> Environment Variables: `HUB_API_BASE` = the Railway URL (no trailing slash), `HUB_API_TOKEN` = the token. Redeploy.
4. Open `/roadmap.html`, enter the gate password from `site.js`, change a status, and confirm the bar says "saved for everyone".

After that, every push to `main` deploys automatically.

## Add a tool

Add one entry to `tools.js`. The home page renders it.

## Pages

- `index.html`: home. What we do, most used, how an engagement runs, people, role shelves.
- `roadmap.html`: Work Station (shared checklist, edit `ITEMS` in the file) and Roadmap (edit `INITS`).
- `api/tasks.js`: the proxy to the store.
