import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readCache,
  isFresh,
  fetchUpcoming,
  enrichFollowers,
  writeCache,
  readPartial,
  writePartial,
  clearPartial,
  getResumeState,
} from './src/steam.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ---- Background refresh job -------------------------------------------------
// Fetching thousands of games takes a while, so we run it in the background
// and let the frontend poll /api/status for a progress bar.
const job = {
  running: false,
  phase: null,    // 'games' | 'followers'
  loaded: 0,
  total: 0,
  startedAt: null,
  error: null,
  notice: null,
  resumedFrom: 0, // offset we resumed an interrupted fetch from (0 = fresh)
};

async function startRefresh(depth, followersTop = 150) {
  if (job.running) return;

  // If a previous fetch was interrupted recently, continue from where it
  // stopped instead of re-downloading everything.
  const resume = getResumeState(depth);
  job.running = true;
  job.phase = 'games';
  job.resumedFrom = resume ? resume.nextStart : 0;
  job.loaded = resume ? resume.games.length : 0;
  job.total = depth;
  job.error = null;
  job.notice = resume ? `Resuming previous fetch from #${resume.nextStart.toLocaleString()}…` : null;
  job.startedAt = new Date().toISOString();

  try {
    const data = await fetchUpcoming(depth, {
      resume,
      onProgress: (loaded, total) => {
        job.loaded = loaded;
        job.total = total;
        job.notice = null; // cleared once a page succeeds
      },
      onRetry: (waitMs, status, attempt) => {
        job.notice = `Steam rate-limited us (HTTP ${status ?? 'net'}). ` +
          `Waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 1}…`;
        console.warn(job.notice);
      },
      // Persist progress after every page so an interruption is never wasted.
      onPage: (state) => writePartial({ ...state, depthRequested: depth }),
    });

    // Phase 2: enrich the top games with follower counts (wishlist proxy).
    if (followersTop > 0) {
      job.phase = 'followers';
      job.loaded = 0;
      job.total = Math.min(followersTop, data.games.length);
      await enrichFollowers(data.games, followersTop, {
        onProgress: (done, total) => { job.loaded = done; job.total = total; },
        onRetry: (waitMs, status, attempt) => {
          job.notice = `Community rate-limited us (HTTP ${status ?? 'net'}). ` +
            `Waiting ${Math.round(waitMs / 1000)}s (retry ${attempt + 1})…`;
        },
      });
      data.followersTop = followersTop;
      data.followersEnriched = data.games.filter((g) => g.followers != null).length;
    }

    writeCache(data);
    clearPartial(); // full fetch succeeded — partial no longer needed
  } catch (err) {
    job.error = err.message;
    console.error('Refresh failed (partial progress saved for resume):', err.message);
  } finally {
    job.running = false;
    job.phase = null;
  }
}

// ---- API --------------------------------------------------------------------

// Current cached dataset (does not trigger a fetch). Falls back to in-progress
// partial data if there's no complete cache yet, so an interrupted first fetch
// still renders something.
app.get('/api/data', (req, res) => {
  const cache = readCache();
  if (cache) {
    return res.json({ ...cache, fresh: isFresh(cache), partial: false });
  }
  const partial = readPartial();
  if (partial?.games?.length) {
    return res.json({
      ...partial,
      fetchedAt: partial.updatedAt ?? null,
      count: partial.games.length,
      fresh: false,
      partial: true,
    });
  }
  res.status(404).json({ error: 'no-data', message: 'No data yet. Trigger /api/refresh.' });
});

// Kick off a background refresh.
app.post('/api/refresh', (req, res) => {
  const depth = Math.min(Math.max(parseInt(req.query.depth, 10) || 2000, 100), 20000);
  const followers = req.query.followers != null
    ? Math.min(Math.max(parseInt(req.query.followers, 10) || 0, 0), 5000)
    : 150;
  startRefresh(depth, followers);
  res.json({ started: true, depth, followers, running: job.running });
});

// Progress for the refresh job.
app.get('/api/status', (req, res) => {
  const cache = readCache();
  const partial = cache ? null : readPartial();
  res.json({
    running: job.running,
    phase: job.phase,
    loaded: job.loaded,
    total: job.total,
    error: job.error,
    notice: job.notice,
    resumedFrom: job.resumedFrom,
    startedAt: job.startedAt,
    hasData: !!cache || !!partial?.games?.length,
    fetchedAt: cache?.fetchedAt ?? null,
    count: cache?.count ?? partial?.games?.length ?? 0,
    totalAvailable: cache?.totalAvailable ?? partial?.totalAvailable ?? null,
    fresh: cache ? isFresh(cache) : false,
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`\n  Steam Utilities running:  http://localhost:${PORT}\n`);
  // Warm the cache on boot if empty, so the first visit has data.
  const cache = readCache();
  if (!cache) {
    console.log('  No cache found — fetching initial dataset in background...');
    startRefresh(2000);
  } else {
    console.log(`  Cache: ${cache.count} games (fetched ${cache.fetchedAt})`);
  }
});
