# Brother Beam: handoff

Everything a new Claude Code session needs to pick this up. Written Oct 25, 2026 by the session that built the baseline. Read it top to bottom once, then work from "What is next."

## The company

- **Name:** Brother Beam. Chosen Oct 25, 2026. Homage to architecture and to rebuilding what already works.
- **Tagline:** We strengthen businesses that already work.
- **The method, sistering:** when a sound beam has to carry more than it was built for, a builder bolts a new beam alongside it instead of tearing it out. We keep what carries the business and build the new structure, AI included, beside it, one workflow at a time. Nothing that works comes out.
- **What we sell:** business architecture consulting with AI implementation for business transformation.
- **Three practice lines:** Survey (measure the business as built: capabilities, processes, systems, data, decisions, money; find the load paths and the leaks), Sister (bolt AI and new technology beside the workflows that carry the load), Carry (run the change with the operating system we use ourselves: roadmap, Work Station, weekly cadence, measurement).
- **The engagement, five moves:** 0 Walkthrough (free, one hour with the owner), 1 Survey (2 to 4 weeks), 2 Blueprint (1 to 2 weeks), 3 Sistering (by workflow), 4 Carry (90 days). A number at the start, the same number at the end.
- **Who it is for:** profitable, owner-led businesses whose market moved. Not startups, not turnarounds, not AI for the press release, not anyone who wants us to run it forever.
- **Why us:** market first, technology second; we keep the beam; we are operators who have run the buildings; we leave the operating system behind.
- **Principles:** keep the beam; measure or it did not happen; one workflow at a time; train the people who stay; plain words; we use what we sell.
- **Year one:** months 1 to 3 the company is standing (entity, agreement, offer, this hub, three Walkthroughs); months 4 to 8 three paid Surveys with Blueprints, at least one into Sistering; months 9 to 12 one full Carry measured, a client hub template, next clients from the first.
- **Construction vocabulary, used consistently:** sistering, load path, good bones, Survey, Blueprint, Carry, scaffolding (us, temporary by design), retrofit.

## The people

- **Pat Fitzgerald, founder.** Mike's brother. Mortgage industry background; business transformation by matching market dynamics to new technology; now doing the same at TaylorMade. His thesis is the company's pitch.
- **Mike FitzGerald, co-founder.** Physician, runs Grossman Wellness Center, built its operating hub by hand with AI inside the daily work. He is the one talking to Claude.
- **A third partner, a friend.** Name and role not yet given. Placeholder in site.js.

## What exists

- **GitHub organization:** `Brother-Beam` (github.com/Brother-Beam). Mike (`mikefitz010`) is the owner. Pat and the friend are not invited yet.
- **Repo `Brother-Beam/brotherbeam-hub`, public.** The work hub: `index.html` (home), `vision.html` (the vision, visuals only: nine diagrams), `roadmap.html` (password gate, Work Station shared checklist, Roadmap with initiatives), `tools.js` (inventory the home page renders), `site.js` (one file with the name, tagline, people, pillars, gate password `beam`), `brand.css` (tokens: paper #F3F5F7, ink #141B22, accent #1F5EFF, good #0FA37F, font Manrope), `api/tasks.js` (Vercel function that proxies the shared store and adds the token server side), `CLAUDE.md` (project briefing for any collaborator's Claude), `README.md` (deploy steps).
- **Repo `Brother-Beam/brotherbeam-api`, private.** The shared store: Express 5 + pg, one `kv` table, `GET /` health, `GET/PUT /api/kv/:key` behind `Authorization: Bearer <API_TOKEN>`. `railway.json`, `.env.example`, `CLAUDE.md`, `README.md` with the Railway steps.
- **Live site:** https://brother-beam.github.io/brotherbeam-hub/ (GitHub Pages from `main`; every push goes live in about a minute). The vision: https://brother-beam.github.io/brotherbeam-hub/vision.html. The repo is public because GitHub Pages on a free organization needs that. Vercel makes it private again later.
- **Local folders:** `/Users/michaelfitzgerald/Documents/Claude/Projects/Grossman/NewCo/hub` and `.../NewCo/api`. They sit inside the Grossman projects folder only because that is where the old session could write. Move the whole `NewCo` folder to its own place, for example `/Users/michaelfitzgerald/Documents/Claude/Projects/Brother Beam/`, and open the new Claude Code session there. The git remotes are URLs, so nothing breaks when the folder moves.
- **Not built:** the shared store is not deployed, so the Work Station saves per device for now. No Vercel project. No domain.

## Architecture, in one picture

```
Browser -> static pages (GitHub Pages today, Vercel later) + /api/tasks (Vercel only)
                                                   |
                                   adds HUB_API_TOKEN server side
                                                   v
                           brotherbeam-api on Railway (Express + Postgres, kv table)
```

The browser never holds a secret. The lesson behind this came from a Railway breach that hit Mike's other workspace in Oct 2026: nothing on this service is public-writable, and the token lives only in Vercel and Railway.

## What is next, in order

1. **Invite Pat and the friend** to the Brother-Beam organization (GitHub → organization → People → Invite member, by username). Then each of them can open the repos in their own Claude Code; CLAUDE.md briefs it.
2. **Railway** (Mike stalled here; walk him one screen at a time, and ask what he sees). New workspace named Brother Beam if the plan allows, otherwise a new project in his workspace. New Project → Deploy from GitHub repo → configure the GitHub app for the Brother-Beam organization → `brotherbeam-api`. Add PostgreSQL. On the api service, Variables: `DATABASE_URL` as a reference to the Postgres service (never a pasted string) and `API_TOKEN` from `openssl rand -base64 48` (Mike pastes it; Claude never handles it). Settings → Networking → Generate Domain. Verify `GET /` returns `{"ok":true,"service":"brotherbeam-api"}`.
3. **Vercel.** Import `brotherbeam-hub` (framework: Other). Environment variables `HUB_API_BASE` (the Railway domain, no trailing slash) and `HUB_API_TOKEN` (same value as `API_TOKEN`). Deploy. Open `/roadmap.html`, password `beam`, change a status, confirm "saved for everyone". Then make the GitHub repo private again and turn off GitHub Pages.
4. **Domain.** brotherbeam.com and brotherbeam.co were unregistered on Oct 25, 2026 (also .io). Buy, add to the Vercel project, done.
5. **The six decisions on the vision page.** The client we mean (size, first industries: mortgage and financial services where Pat has the network, consumer products where he is now, healthcare where Mike is); the first offer and its price (Survey, Blueprint, Sistering per workflow or monthly, Carry for 90 days); Pat's time while at TaylorMade; the third chair; equity and entity; the domain.
6. **Then the real work:** the operating model, the offer and pricing page, the proposal desk, the client hub template, the engagement playbook. All listed as "building" in `tools.js`.

## How Mike works with Claude

- He is not a developer. Claude writes all code and deploys it; he clicks in dashboards only when a secret or a payment is involved, and he wants those steps one screen at a time.
- Keep it short. Few words, plain numbers, no em dashes. He rejected prose-heavy pages ("there are way too many words") and asked for visuals ("it needs to only have visuals").
- When writing as him or the company: complete plain sentences, first person, mechanism in one clause, no slogans beyond the tagline, no "not X, it's Y" framing. He rejected an AI-sounding draft with "make this sound like me not AI."
- Naming: he rejected generic consultancy names and wanted an homage to architecture and rebuilding what already works. He named it Brother Beam himself.
- Verify work before reporting it (render the page, curl the live URL). Log shipped work on the roadmap page without being asked.
- Never paste a key, token or password into chat, a file, or a page.

## Useful commands

```bash
# push a change to the hub (goes live on Pages in about a minute)
cd "/path/to/NewCo/hub" && git add -A && git commit -m "..." && git push

# check the live site
curl -s -o /dev/null -w '%{http_code}\n' https://brother-beam.github.io/brotherbeam-hub/vision.html

# invite someone to the organization (owner only)
gh api -X POST orgs/Brother-Beam/invitations -f invitee_id=<their GitHub user id> -f role=direct_member
```
