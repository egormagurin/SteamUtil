// Steam data client: fetches the "Popular Upcoming" list, parses each row,
// normalizes release dates, and caches the result to disk.
//
// Why "Popular Upcoming": Steam orders this list by wishlist activity, so a
// game's rank within it is a free, direct proxy for how wishlisted it is.
// Rank 1 = the single most-wishlisted upcoming game. We capture that rank for
// every game, which lets the calendar answer "how much high-wishlist
// competition releases on each day".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(CACHE_DIR, 'upcoming.json');
const PARTIAL_FILE = path.join(CACHE_DIR, 'upcoming.partial.json');
// How long a partial fetch stays resumable. Beyond this the popularity order
// may have shifted enough that appending later pages would be inconsistent.
const PARTIAL_TTL_MS = 60 * 60 * 1000; // 1h

const SEARCH_URL = 'https://store.steampowered.com/search/results/';
const PAGE_SIZE = 100;          // Steam caps infinite-scroll pages at 100 rows
const THROTTLE_MS = 450;        // delay between pages — Steam rate-limits bursts
const DEFAULT_DEPTH = 2000;     // games to fetch on first load
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h

// Retry/backoff for HTTP 429 (rate limit) and transient 5xx.
const MAX_RETRIES = 6;
const REQUEST_TIMEOUT_MS = 15000;   // abort a stalled request (Steam soft-throttles by stalling)
const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 45000;

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch() with an abort timeout, so a stalled connection can't hang us forever.
// Throws (AbortError) on timeout — callers treat that like a transient error.
async function fetchWithTimeout(url, opts = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function iso(year, monthIdx, day) {
  return `${year}-${pad(monthIdx + 1)}-${pad(day)}`;
}

function monthIndex(name) {
  const key = String(name).slice(0, 3).toLowerCase();
  return key in MONTHS ? MONTHS[key] : -1;
}

// Turn Steam's free-text release string into a date + precision.
// precision: 'day' | 'month' | 'quarter' | 'year' | 'unknown'
export function parseRelease(raw) {
  const s = (raw || '').trim();
  if (!s) return { date: null, precision: 'unknown', raw };

  const low = s.toLowerCase();
  if (
    low.includes('coming soon') ||
    low.includes('to be announced') ||
    low === 'tba' ||
    low.includes('wishlist') ||
    low.includes('when it') ||
    low.includes('available')
  ) {
    return { date: null, precision: 'unknown', raw };
  }

  // Quarter: "Q3 2026"
  let m = s.match(/Q([1-4])\s+(\d{4})/i);
  if (m) {
    const q = +m[1];
    return { date: iso(+m[2], (q - 1) * 3, 1), precision: 'quarter', raw };
  }

  // Day, EU style: "9 Jul, 2026"
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{4})$/);
  if (m) {
    const mo = monthIndex(m[2]);
    if (mo >= 0) return { date: iso(+m[3], mo, +m[1]), precision: 'day', raw };
  }

  // Day, US style: "Jul 9, 2026"
  m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mo = monthIndex(m[1]);
    if (mo >= 0) return { date: iso(+m[3], mo, +m[2]), precision: 'day', raw };
  }

  // Month + year: "Jul 2026" / "July 2026"
  m = s.match(/^([A-Za-z]{3,9})\s+(\d{4})$/);
  if (m) {
    const mo = monthIndex(m[1]);
    if (mo >= 0) return { date: iso(+m[2], mo, 1), precision: 'month', raw };
  }

  // Year only: "2026"
  m = s.match(/^(\d{4})$/);
  if (m) return { date: iso(+m[1], 0, 1), precision: 'year', raw };

  return { date: null, precision: 'unknown', raw };
}

// Pull the individual <a> result rows out of the results_html blob.
function parseRows(html, startRank) {
  const games = [];
  // Each row is a top-level anchor to /app/<id>/...; no nested anchors.
  const rowRe = /<a\s+href="https:\/\/store\.steampowered\.com\/app\/\d+[\s\S]*?<\/a>/g;
  const rows = html.match(rowRe) || [];

  rows.forEach((row, i) => {
    const appidM = row.match(/data-ds-appid="(\d+)"/);
    if (!appidM) return;
    const appid = +appidM[1];

    const titleM = row.match(/<span class="title">([\s\S]*?)<\/span>/);
    const name = titleM ? decodeEntities(titleM[1].trim()) : `App ${appid}`;

    const relM = row.match(/<div class="search_released[^"]*">([\s\S]*?)<\/div>/);
    const releaseRaw = relM ? relM[1].replace(/\s+/g, ' ').trim() : '';
    const { date, precision } = parseRelease(releaseRaw);

    const priceM = row.match(/data-price-final="(\d+)"/);
    const priceCents = priceM ? +priceM[1] : null;

    const tagsM = row.match(/data-ds-tagids="(\[[^\]]*\])"/);
    let tags = [];
    if (tagsM) {
      try { tags = JSON.parse(tagsM[1]); } catch { /* ignore */ }
    }

    games.push({
      appid,
      name,
      releaseRaw,
      releaseDate: date,
      datePrecision: precision,
      priceCents,
      tags,
      rank: startRank + i + 1, // 1-based popularity rank (lower = more wishlisted)
    });
  });

  return games;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&trade;/g, '™')
    .replace(/&reg;/g, '®');
}

// Fetch one page, retrying on rate-limit (429) and transient 5xx with
// exponential backoff. `onRetry(waitMs, status, attempt)` lets callers show a
// "rate limited, waiting…" message instead of a frozen progress bar.
async function fetchPage(start, onRetry) {
  const params = new URLSearchParams({
    query: '',
    start: String(start),
    count: String(PAGE_SIZE),
    filter: 'popularcomingsoon',
    category1: '998',   // Games only (excludes DLC/software/soundtracks)
    infinite: '1',
    cc: 'us',           // force USD pricing
    l: 'english',       // force English release-date text for stable parsing
  });
  const url = `${SEARCH_URL}?${params.toString()}`;
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'en-US,en;q=0.9',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: 'https://store.steampowered.com/search/?filter=popularcomingsoon',
  };

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchWithTimeout(url, { headers });
    } catch (err) {
      // network blip or timeout — treat like a transient error
      if (attempt >= MAX_RETRIES) throw err;
      await backoff(attempt, null, onRetry, 0, err.message);
      continue;
    }

    if (res.ok) return res.json();

    const transient = res.status === 429 || res.status >= 500;
    if (!transient || attempt >= MAX_RETRIES) {
      throw new Error(`Steam search HTTP ${res.status} at start=${start}` +
        (attempt ? ` after ${attempt} retries` : ''));
    }
    const retryAfter = parseInt(res.headers.get('retry-after'), 10);
    await backoff(attempt, Number.isFinite(retryAfter) ? retryAfter : null, onRetry, res.status, null);
  }
}

async function backoff(attempt, retryAfterSec, onRetry, status, note) {
  const base = retryAfterSec != null
    ? retryAfterSec * 1000
    : Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  const waitMs = base + Math.floor((attempt * 137) % 500); // small fixed jitter
  if (onRetry) onRetry(waitMs, status, attempt, note);
  await sleep(waitMs);
}

// Fetch up to `depth` upcoming games, in popularity order.
// opts:
//   onProgress(loaded, total)               — after each page
//   onRetry(waitMs, status, attempt)        — during rate-limit backoff
//   onPage({games, nextStart, totalAvailable}) — after each page, for persistence
//   resume {games, nextStart, totalAvailable}  — continue a previous partial fetch
// If the fetch throws partway, every page fetched so far has already been handed
// to onPage, so the caller can persist it and resume next time.
export async function fetchUpcoming(depth = DEFAULT_DEPTH, opts = {}) {
  const { onProgress, onRetry, onPage, resume } = opts;
  const all = resume?.games ? resume.games.slice() : [];
  let totalAvailable = resume?.totalAvailable ?? null;
  let start = resume?.nextStart ?? 0;
  let exhausted = false;

  while (all.length < depth && !exhausted) {
    const json = await fetchPage(start, onRetry);
    if (totalAvailable === null) totalAvailable = json.total_count ?? null;

    const html = (json.results_html || '').replace(/\\\//g, '/');
    const games = parseRows(html, start);
    if (games.length === 0) { exhausted = true; break; } // Steam ran out of rows

    all.push(...games);
    start += PAGE_SIZE;
    if (onProgress) onProgress(all.length, Math.min(depth, totalAvailable ?? depth));
    if (onPage) onPage({ games: all.slice(), nextStart: start, totalAvailable });

    if (all.length < depth) await sleep(THROTTLE_MS);
  }

  return {
    fetchedAt: new Date().toISOString(),
    depthRequested: depth,
    totalAvailable,
    count: all.length,
    games: all,
    complete: true,   // reached target depth or exhausted the list cleanly
    exhausted,
  };
}

// ---- Follower counts (wishlist proxy) ---------------------------------------
// Steam doesn't publish wishlist counts, but a game's community-group member
// count (its "followers") is public and correlates with wishlists. It's exposed
// as XML at /games/<appid>/memberslistxml. One request returns the full count.

const COMMUNITY_BASE = 'https://steamcommunity.com/games';
const FOLLOWER_THROTTLE_MS = 300;
const FOLLOWER_TIMEOUT_MS = 8000;
const FOLLOWER_MAX_RETRIES = 1; // best-effort: fail fast (Steam caps ~60 requests/IP/window)

// Returns the follower count for an appid, or null if it has no group / fails.
// Deliberately gives up quickly: enrichment is best-effort and must keep moving.
export async function fetchFollowers(appid, onRetry) {
  const url = `${COMMUNITY_BASE}/${appid}/memberslistxml/?xml=1`;
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    Accept: 'text/xml,application/xml,*/*',
  };
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchWithTimeout(url, { headers }, FOLLOWER_TIMEOUT_MS);
    } catch {
      if (attempt >= FOLLOWER_MAX_RETRIES) return null; // timeout/network — give up
      await sleep(1000 * (attempt + 1));
      continue;
    }
    if (res.ok) {
      const xml = await res.text();
      const m = xml.match(/<memberCount>(\d+)<\/memberCount>/);
      return m ? parseInt(m[1], 10) : null;
    }
    const transient = res.status === 429 || res.status >= 500;
    if (!transient || attempt >= FOLLOWER_MAX_RETRIES) return null;
    const ra = parseInt(res.headers.get('retry-after'), 10);
    const wait = Number.isFinite(ra) ? ra * 1000 : 1500 * (attempt + 1);
    if (onRetry) onRetry(wait, res.status, attempt, 'followers');
    await sleep(wait);
  }
}

// Enrich the top `topN` games (by their array order = popularity rank) with a
// `.followers` field, in place. Failures are skipped, not fatal.
// Steam soft-throttles by stalling connections, so requests are run with a small
// concurrency pool — stalls overlap instead of stacking up, keeping wall-clock
// reasonable without hammering the endpoint.
export async function enrichFollowers(
  games,
  topN,
  { onProgress, onRetry, concurrency = 2, throttleMs = FOLLOWER_THROTTLE_MS } = {},
) {
  const targets = games.slice(0, Math.min(topN, games.length));
  let next = 0;
  let done = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= targets.length) break;
      const followers = await fetchFollowers(targets[i].appid, onRetry);
      if (followers != null) targets[i].followers = followers;
      done += 1;
      if (onProgress) onProgress(done, targets.length);
      await sleep(throttleMs); // pacing to stay under Steam's per-IP rate limit
    }
  }

  const pool = Math.max(1, Math.min(concurrency, targets.length));
  await Promise.all(Array.from({ length: pool }, () => worker()));
  return games;
}

// ---- Tag dictionary ---------------------------------------------------------
// Game rows carry numeric tag IDs only; this maps id -> human name so the Tag
// Explorer can group by genre. One request returns all ~430 store tags.
export async function fetchTagDictionary() {
  try {
    const res = await fetchWithTimeout(
      'https://store.steampowered.com/tagdata/populartags/english',
      { headers: { 'User-Agent': 'SteamUtil/0.1', Accept: 'application/json' } },
    );
    if (!res.ok) return {};
    const arr = await res.json();
    const map = {};
    for (const t of arr) if (t && t.tagid != null) map[t.tagid] = t.name;
    return map;
  } catch {
    return {};
  }
}

export function readCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function writeCache(data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf8');
}

export function isFresh(cache) {
  if (!cache?.fetchedAt) return false;
  return Date.now() - new Date(cache.fetchedAt).getTime() < CACHE_TTL_MS;
}

// ---- Partial (resumable) fetch state ----------------------------------------

export function readPartial() {
  try {
    return JSON.parse(fs.readFileSync(PARTIAL_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export function writePartial(state) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const payload = { ...state, count: state.games?.length ?? 0, updatedAt: new Date().toISOString() };
  fs.writeFileSync(PARTIAL_FILE, JSON.stringify(payload), 'utf8');
}

export function clearPartial() {
  try { fs.unlinkSync(PARTIAL_FILE); } catch { /* already gone */ }
}

// Decide whether (and from where) to resume an interrupted fetch.
// Returns a resume object for fetchUpcoming, or null to start fresh.
export function getResumeState(depth) {
  const p = readPartial();
  if (!p?.games?.length || !p.nextStart) return null;
  // Too old to safely append more pages to.
  if (!p.updatedAt || Date.now() - new Date(p.updatedAt).getTime() > PARTIAL_TTL_MS) return null;
  return {
    games: p.games,
    nextStart: p.nextStart,
    totalAvailable: p.totalAvailable ?? null,
    depthRequested: p.depthRequested ?? depth,
  };
}

// Get dataset: serve fresh cache unless forced, otherwise fetch + cache.
export async function getDataset({ depth = DEFAULT_DEPTH, refresh = false } = {}) {
  const cache = readCache();
  if (!refresh && isFresh(cache) && cache.count >= Math.min(depth, cache.totalAvailable ?? depth)) {
    return { ...cache, fromCache: true };
  }
  const data = await fetchUpcoming(depth);
  writeCache(data);
  return { ...data, fromCache: false };
}
