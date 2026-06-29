# website-node — Sail Race Tracker (combined static site)

This repository hosts **everything that runs in a browser** for Sail Race Tracker
as a single static site, ready to deploy to **Vercel**:

| Path | What it is | File served |
|------|------------|-------------|
| `/` | Marketing site (home) | `index.html` |
| `/product` | "The Build" page | `product.html` |
| `/story` | Story & press page | `story.html` |
| `/loop` | Full-screen replay loop (studio/TV) | `loop.html` |
| `/viewer` | **Spectator dashboard** (live map + replay) | `viewer/index.html` |
| `/admin` | **Organiser console** (fleet, course, race control) | `admin/index.html` |

The dashboards are pure client-side apps. They talk to the deployed Cloudflare
Worker backend over HTTPS/WSS — there is **no server-side code in this repo** and
no build step. Vercel serves the files exactly as they are.

---

## Repository layout

```
website-node/
├── index.html            # marketing — home
├── product.html          # marketing — the build
├── story.html            # marketing — story & press
├── loop.html             # standalone full-screen replay loop
├── css/styles.css        # marketing styles
├── js/                    # marketing scripts (main.js, tracker-data.js)
├── assets/               # marketing images / audio / logos
│   ├── img/ …
│   └── audio/ …
├── viewer/               # spectator dashboard (served at /viewer)
│   ├── index.html        #   (was dashboards/viewer.html)
│   ├── assets/           #   logos / favicon
│   └── shared/           #   srt-api.js, srt-map.js, srt-theme.css
├── admin/                # organiser console (served at /admin)
│   ├── index.html        #   (was dashboards/admin.html)
│   ├── assets/
│   └── shared/
├── vercel.json           # routing, clean URLs, cache headers
├── .gitignore
└── README.md
```

### Why the dashboards live in their own folders

`viewer/index.html` and `admin/index.html` reference their CSS/JS/logos with
**relative** paths (`shared/srt-api.js`, `assets/logo.svg`). Each dashboard has
its **own copy** of `assets/` and `shared/` inside its folder, so:

- `/viewer` resolves `shared/…` → `/viewer/shared/…` ✅
- `/admin` resolves `shared/…` → `/admin/shared/…` ✅
- The dashboards' `assets/` never collide with the marketing site's `assets/`.

Because each dashboard is `index.html` inside a directory, `/viewer` and `/admin`
already work as clean directory URLs. The `vercel.json` rewrites are belt-and-
braces so the bare paths resolve identically with `cleanUrls` on.

> If you ever update a dashboard, edit the copy under `viewer/` or `admin/`.
> The originals in the project's `dashboards/` folder are the source of truth;
> re-copy `dashboards/{viewer,admin}.html` → `{viewer,admin}/index.html` and
> `dashboards/{assets,shared}` → both folders when you sync.

---

## Backend the dashboards call

By default both dashboards call the live Worker:

```
https://srt-backend.srt-jackharker.workers.dev
```

This is **baked into `shared/srt-api.js`** as `SRT_DEFAULT_BASE` and is a public
URL — it is **not a secret**. The full endpoint + JSON contract is documented at
the top of `viewer/shared/srt-api.js`.

### URL parameters (both dashboards)

| Param | Effect | Status |
|-------|--------|--------|
| `?base=https://my-worker.workers.dev` | Override the backend base URL (point a deploy at staging/prod) | live |
| `?race=3` | Pre-select a race id | live |
| `?mode=live` / `?mode=replay` | Force viewer mode (default: replay if finished, else live) | live (viewer) |
| `?theme=dark` / `?theme=light` | Force theme (default: light brand theme) | live (viewer) |
| `?regatta=<id>` | Select a regatta/event for the **multi-regatta backend** | reserved — see below |

#### Multi-regatta at the URL level

The system is moving from a single global race list to **multiple regattas**
(events), each owning its own set of races. The intended URL shape is:

```
/viewer?regatta=<regattaId>            # show that regatta's races
/viewer?regatta=<regattaId>&race=<id>  # deep-link to one race in a regatta
/admin?regatta=<regattaId>             # organiser scoped to one regatta
```

`?race=` is **already implemented** today. `?regatta=` is **reserved** for the
multi-regatta backend currently being added — the front-ends should read it and
scope their API calls (e.g. `GET /regattas/:id/races`) once the backend exposes
those routes. Until then, omit `?regatta=` and the dashboards behave exactly as
today (single global race list). Combine with `?base=` to point a regatta-aware
build at a staging Worker without touching code.

> No code change was made to enable `?regatta=` in this prep step, deliberately:
> wiring it now (e.g. injecting `/regatta/<id>` into the base path) would break
> the **current** single-regatta Worker. Enable it in `shared/srt-api.js` in the
> same PR that ships the multi-regatta backend routes.

---

## Secrets — what is and isn't in this repo

- **Admin key:** entered at the `/admin` login screen, stored only in the
  browser's `sessionStorage` (cleared when the tab closes). It is **never**
  committed and never appears in any file here. Do not add it to `vercel.json`
  or an env var — the dashboard sends it as a `Bearer` token from the browser.
- **Gateway key:** lives on the Raspberry Pi gateway, not in this repo.
- **Backend base URL:** public, safe to commit (it's in `srt-api.js`).

There are **no environment variables required** to deploy this site.

---

## Deploy: GitHub + Vercel

### 1. Create and push the GitHub repo `website-node`

From this directory (`website-node/`):

```bash
# one-time: initialise git
git init
git add .
git commit -m "Initial commit: combined Sail Race Tracker static site"

# create the repo on GitHub named "website-node", then:
git branch -M main
git remote add origin https://github.com/<your-username>/website-node.git
git push -u origin main
```

(Or with the GitHub CLI: `gh repo create website-node --public --source=. --push`.)

### 2. Import to Vercel

1. Go to https://vercel.com/new
2. **Import** the `website-node` GitHub repo.
3. Configure project:
   - **Framework Preset:** `Other` (it's a plain static site).
   - **Root Directory:** `./` (repo root).
   - **Build Command:** *leave empty* (no build).
   - **Output Directory:** *leave empty / default* (`vercel.json` handles routing;
     Vercel serves the repo root as static files).
   - **Install Command:** *leave empty* (no dependencies).
   - **Environment Variables:** *none required.*
4. Click **Deploy**.

### 3. Verify after deploy

Open these on the Vercel preview/production URL:

- `/` → marketing home loads, nav to `/product` and `/story` works.
- `/loop` → full-screen replay loop.
- `/viewer` → spectator dashboard; the race list loads from the live Worker.
  - check the browser console: no 404s for `shared/srt-api.js`,
    `shared/srt-map.js`, `shared/srt-theme.css`, or `assets/logo*.svg`.
  - try `/viewer?race=1` and `/viewer?theme=dark`.
- `/admin` → organiser console shows the **sign-in gate**. Enter the admin key
  to confirm auth works (the key is not stored in the repo).

### 4. (Optional) custom domain

In Vercel → Project → **Settings → Domains**, add e.g. `sailracetracker.live`
and follow the DNS instructions. The marketing site is the apex (`/`); the
dashboards sit under `/viewer` and `/admin` on the same domain, so the
dashboards' same-origin calls and `?base=` override both keep working.

---

## Local preview

No build needed. From the repo root:

```bash
python3 -m http.server 8080
# http://localhost:8080/            marketing
# http://localhost:8080/viewer/     spectator dashboard
# http://localhost:8080/admin/      organiser console
```

(Locally use the trailing-slash directory URLs — `cleanUrls`/rewrites are a
Vercel feature. On Vercel both `/viewer` and `/viewer/` work.)
