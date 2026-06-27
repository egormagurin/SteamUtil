# Steam Utilities

A growing set of tools for game developers. The first tool is a **Release
Calendar**: every upcoming Steam game plotted by release date, so you can find a
launch day with **fewer games** and **fewer high-wishlist competitors**.

**Live:** <https://egormagurin.github.io/SteamUtil/> (static build, auto-updated daily)

## Run it

```bash
npm install
npm start
```

Then open <http://localhost:3000>. On first launch the server fetches the
upcoming-games list from Steam in the background (a progress bar shows in the
UI) and caches it to `data/upcoming.json`. Subsequent starts load instantly from
that cache.

## How it works

- **Source.** Steam's store search endpoint with `filter=popularcomingsoon`
  (Games category only). This list is ordered by Steam's popularity ranking,
  which is driven by wishlist activity.
- **The wishlist proxy.** Steam does **not** publish exact wishlist counts
  anywhere public. But a game's *rank* in "Popular Upcoming" is a direct
  free proxy: rank #1 is the most-wishlisted upcoming game. We capture that
  rank for every game. A day with several top-ranked releases is a crowded,
  high-wishlist day to avoid.
- **Competition heat.** Each calendar day is colored by an index that weighs
  high-wishlist games (top-N rank, configurable) more heavily than small ones:
  `index = totalGames + highWishlistGames × 4`. Cooler = better.
- **Caching.** Results are cached for 12h. Use **↻ Refresh data** (or pick a
  larger fetch depth) to pull more games or get fresh numbers.
- **Rate limits & resume.** Steam rate-limits bursty requests (HTTP 429). The
  fetcher backs off and retries automatically, and persists progress after every
  page to `data/upcoming.partial.json`. If a fetch is interrupted (rate limit,
  crash, restart), the next refresh **resumes from where it stopped** instead of
  starting over — partial progress is never wasted. Partials older than 1h are
  discarded (the popularity order may have shifted). The last complete dataset
  stays in `data/upcoming.json` and keeps serving the UI until a refresh
  finishes.

## What the numbers mean

- **Exact-date games** appear on the calendar. Steam dates like `Jul 9, 2026`.
- **Coarse dates** (`Q3 2026`, `Jul 2026`, `2026`) can't be placed on a specific
  day, so they're summarized in the sidebar. These still compete.
- A massive spike at **month and quarter boundaries** (e.g. Jun 30, Sep 30) is
  normal — many developers default to end-of-period dates. Mid-month and
  mid-week days are usually far quieter.
- **Fetch depth** controls how many of the most-wishlisted upcoming games are
  pulled (2k / 5k / 10k). Higher depth = more complete long-tail counts for
  dates further out, at the cost of a slower refresh. Steam currently lists
  ~48k upcoming games total.

## Project layout

```
server.js          Express server: API + static hosting + background fetch job
src/steam.js       Steam fetch/parse/cache + release-date normalization
public/            Frontend (no build step): index.html, app.js, style.css
scripts/           build-data.mjs (static data for Pages), serve-static.mjs
.github/workflows/ deploy.yml — builds data + deploys to GitHub Pages
data/              Generated backend cache (gitignored)
```

## Deploying to GitHub Pages

GitHub Pages serves static files only — it can't run the Node backend. So the
published site uses a **static snapshot**: a GitHub Actions job fetches the
Steam data, writes `public/data/upcoming.json`, and deploys `public/` to Pages.
The frontend auto-detects there's no backend and loads that file instead of the
API (the **Refresh** button is disabled and shows "Auto-updated daily").

- **Workflow:** [.github/workflows/deploy.yml](.github/workflows/deploy.yml)
  runs on every push to `main`, **daily at ~06:17 UTC** (refreshing the data),
  and on manual dispatch. It auto-enables Pages on first run.
- **Data size:** controlled by the `DEPTH` env in the workflow (default 3,000).
- **Preview the static build locally:**

  ```bash
  npm run build:data      # writes public/data/upcoming.json (set DEPTH to taste)
  npm run serve:static    # serves public/ with no API at http://localhost:4000
  ```

  (Local `npm start` still runs the full live backend on :3000.)

## API

| Method | Route                  | Purpose                                  |
|--------|------------------------|------------------------------------------|
| GET    | `/api/data`            | Current cached dataset                   |
| POST   | `/api/refresh?depth=N` | Start a background fetch (100–20000)      |
| GET    | `/api/status`          | Fetch progress + cache freshness         |

## Ideas for next tools

- Follower-count enrichment for top games (the best free wishlist correlate).
- Tag Explorer: competition by genre/tag for a given window.
- Per-weekday and per-month historical release-volume trends.
