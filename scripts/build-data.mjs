// Build-time data fetch for the static (GitHub Pages) deployment.
// Runs in CI: pulls upcoming games from Steam and writes them to
// public/data/upcoming.json, which the static frontend loads directly.
// Set DEPTH to control how many of the most-wishlisted games to include.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchUpcoming, enrichFollowers } from '../src/steam.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'public', 'data');
const OUT_FILE = path.join(OUT_DIR, 'upcoming.json');

const depth = Math.min(Math.max(parseInt(process.env.DEPTH, 10) || 3000, 100), 20000);
const followersTop = Math.min(Math.max(parseInt(process.env.FOLLOWERS_TOP, 10) || 300, 0), 5000);
const concurrency = Math.min(Math.max(parseInt(process.env.FOLLOWERS_CONCURRENCY, 10) || 2, 1), 12);
const throttleMs = Math.min(Math.max(parseInt(process.env.FOLLOWERS_THROTTLE, 10) || 300, 0), 5000);

console.log(`Fetching up to ${depth.toLocaleString()} upcoming games from Steam…`);

const data = await fetchUpcoming(depth, {
  onProgress: (loaded, total) => {
    if (loaded % 500 === 0 || loaded >= total) console.log(`  ${loaded} / ${total}`);
  },
  onRetry: (waitMs, status, attempt) => {
    console.warn(`  rate-limited (HTTP ${status ?? 'net'}), waiting ${Math.round(waitMs / 1000)}s (retry ${attempt + 1})`);
  },
});

if (followersTop > 0) {
  console.log(`Enriching top ${followersTop.toLocaleString()} games with follower counts…`);
  let enriched = 0;
  await enrichFollowers(data.games, followersTop, {
    concurrency,
    throttleMs,
    onProgress: (done, total) => {
      if (done % 25 === 0 || done >= total) console.log(`  followers ${done} / ${total}`);
    },
  });
  enriched = data.games.filter((g) => g.followers != null).length;
  data.followersTop = followersTop;
  data.followersEnriched = enriched;
  console.log(`  got follower counts for ${enriched} games`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(data));

console.log(`Wrote ${data.count.toLocaleString()} games to ${OUT_FILE} ` +
  `(${data.exhausted ? 'exhausted Steam list' : 'reached target depth'}; ` +
  `${data.totalAvailable?.toLocaleString() ?? '?'} total upcoming on Steam).`);
