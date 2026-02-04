const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

/* ── Load .env ──────────────────────────────────────────── */
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && v.length) process.env[k.trim()] = v.join('=').trim();
  });
}

/* ── Config ─────────────────────────────────────────────── */
const PORT          = process.env.PORT || 3001;
const TWITTER_KEY   = process.env.TWITTER_API_KEY || '';
const TWITTER_HOST  = 'twitter-api45.p.rapidapi.com';
const CACHE_DIR     = path.join(__dirname, '.cache');
const SCAN_COOLDOWN = 60 * 60 * 1000;        // 1 hour per account (tweet scan)
const LOOP_INTERVAL = 5 * 60 * 1000;         // check for stale tweet scans every 5 min

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

/* ── In-memory state ────────────────────────────────────── */
let memoryFeedCache = null;      // { json, gzipped }
let scanInProgress  = false;
let lastScanDone    = null;      // epoch ms
const scanTimes     = new Map(); // screenname → epoch ms

// TrustMRR primary data
let trustmrrStartups = [];       // array of startup objects
const latestTweets = new Map();  // handle → { summary, date, likes, views, bookmarks, media, tweetUrl }

// Default featured ads (shown when fewer than 3 paid top-zone ads)
const DEFAULT_FEATURED_ADS = [
  {
    id: 'default-mixelsai',
    handle: 'MixelsAI',
    saasName: 'Mixels AI',
    description: 'Turn ideas into stunning pixel art with AI. Built for creators and indie devs.',
    avatar: null,
    mrr: '126',
    url: 'https://trustmrr.com/startup/mixels-ai',
    slug: 'mixels-ai',
    isDefault: true,
  },
];

// Ad slots
const AD_SLOTS_FILE = path.join(CACHE_DIR, 'ad_slots.json');
let adSlots = []; // active ad slots

// Pending ads (payment records awaiting activation)
const PENDING_ADS_FILE = path.join(CACHE_DIR, 'pending_ads.json');
const pendingAds = new Map(); // handle (lowercase) → { handle, saasName, paidAt, sessionId }

// Expired ads archive
const EXPIRED_ADS_FILE = path.join(CACHE_DIR, 'expired_ads.json');
let expiredAds = [];

// Traffic analytics
const SESSIONS_FILE = path.join(CACHE_DIR, 'sessions.json');
let sessions = [];
const recentIPs = new Map(); // IP → timestamp (rate-limit dedup)

function loadExpiredAds() {
  try {
    if (fs.existsSync(EXPIRED_ADS_FILE)) {
      expiredAds = JSON.parse(fs.readFileSync(EXPIRED_ADS_FILE, 'utf8'));
      console.log(`Expired ads loaded: ${expiredAds.length}`);
    }
  } catch (e) { expiredAds = []; }
}

function saveExpiredAds() {
  try {
    fs.writeFileSync(EXPIRED_ADS_FILE, JSON.stringify(expiredAds, null, 2));
  } catch (e) { console.error('Failed to save expired ads:', e.message); }
}

function archiveExpiredAd(ad) {
  expiredAds.push(Object.assign({}, ad, { expiredAt: new Date().toISOString() }));
  // Keep only last 100 expired ads
  if (expiredAds.length > 100) expiredAds = expiredAds.slice(-100);
  saveExpiredAds();
}

function loadPendingAds() {
  try {
    if (fs.existsSync(PENDING_ADS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PENDING_ADS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(data)) pendingAds.set(k, v);
      console.log(`Pending ads loaded: ${pendingAds.size}`);
    }
  } catch (e) { /* skip */ }
}

function savePendingAds() {
  try {
    const o = {};
    for (const [k, v] of pendingAds) o[k] = v;
    fs.writeFileSync(PENDING_ADS_FILE, JSON.stringify(o, null, 2));
  } catch (e) { console.error('Failed to save pending ads:', e.message); }
}

function loadAdSlots() {
  try {
    if (fs.existsSync(AD_SLOTS_FILE)) {
      adSlots = JSON.parse(fs.readFileSync(AD_SLOTS_FILE, 'utf8'));
      console.log(`Ad slots loaded: ${adSlots.length}`);
    }
  } catch (e) { adSlots = []; }
}

function saveAdSlots() {
  try {
    fs.writeFileSync(AD_SLOTS_FILE, JSON.stringify(adSlots, null, 2));
  } catch (e) { console.error('Failed to save ad slots:', e.message); }
}

function cleanupExpiredAds() {
  const now = new Date().toISOString();
  const before = adSlots.length;
  const expired = adSlots.filter(function(a) { return a.expiresAt <= now; });
  if (expired.length > 0) {
    for (var i = 0; i < expired.length; i++) {
      archiveExpiredAd(expired[i]);
      console.log('[ads] Expired ad removed: @' + expired[i].handle + ' (' + expired[i].saasName + ')');
    }
    adSlots = adSlots.filter(function(a) { return a.expiresAt > now; });
    saveAdSlots();
    setMemoryCache();
    console.log('[ads] Cleanup: removed ' + expired.length + ' expired ad(s), ' + adSlots.length + ' remaining');
  }
}

function cleanupStalePendingAds() {
  const staleThreshold = 7 * 24 * 60 * 60 * 1000; // 7 days
  const now = Date.now();
  let removed = 0;
  for (const [key, val] of pendingAds) {
    const paidAt = new Date(val.paidAt).getTime();
    if (now - paidAt > staleThreshold) {
      pendingAds.delete(key);
      removed++;
      console.log('[ads] Stale pending ad removed: @' + val.handle);
    }
  }
  if (removed > 0) {
    savePendingAds();
    console.log('[ads] Removed ' + removed + ' stale pending ad(s)');
  }
}

async function enrichDefaultAds() {
  for (const def of DEFAULT_FEATURED_ADS) {
    if (!def.slug) continue;
    try {
      const html = await fetchUrl('https://trustmrr.com/startup/' + encodeURIComponent(def.slug));
      const rscData = extractNextData(html);
      const revM = rscData.match(/"currentLast30DaysRevenue"\s*:\s*([\d.]+)/);
      if (revM) {
        def.mrr = String(Math.round(parseFloat(revM[1])));
        console.log(`[ads] Enriched ${def.saasName} MRR: $${def.mrr}`);
      }
    } catch (e) { /* skip — keep fallback value */ }
  }
}

function getActiveAds() {
  const now = new Date().toISOString();
  const before = adSlots.length;
  adSlots = adSlots.filter(function(a) { return a.expiresAt > now; });
  if (adSlots.length !== before) saveAdSlots();
  return adSlots;
}

function getAdsForFeed() {
  var active = getActiveAds();
  var top = [], feed = [];
  for (var i = 0; i < active.length; i++) {
    var a = active[i];
    var obj = { id: a.id, handle: a.handle, saasName: a.saasName, description: a.description || '', avatar: a.avatar, mrr: a.mrr, askPrice: a.askPrice, url: a.url, slug: a.slug || null };
    if (a.zone === 'top') top.push(obj);
    else feed.push(obj);
  }

  // Ad rotation: if >3 paid top-zone ads, Fisher-Yates shuffle and pick 3
  var MAX_TOP = 3;
  if (top.length > MAX_TOP) {
    for (var sh = top.length - 1; sh > 0; sh--) {
      var j = Math.floor(Math.random() * (sh + 1));
      var tmp = top[sh]; top[sh] = top[j]; top[j] = tmp;
    }
    top = top.slice(0, MAX_TOP);
    return { top: top, feed: feed };
  }

  // Fill remaining top slots: first with hardcoded defaults (enriched from TrustMRR), then fillers
  var FILLER_LIMIT = MAX_TOP; // fill all 3 featured slots
  var usedHandles = {};
  for (var u = 0; u < top.length; u++) usedHandles[top[u].handle.toLowerCase()] = true;

  for (var d = 0; d < DEFAULT_FEATURED_ADS.length && top.length < FILLER_LIMIT; d++) {
    var def = DEFAULT_FEATURED_ADS[d];
    // Look up live MRR from TrustMRR data (by handle first, then by slug)
    var liveData = trustmrrStartups.find(function(s) {
      return s.handle && s.handle.toLowerCase() === def.handle.toLowerCase();
    });
    if (!liveData && def.slug) {
      liveData = trustmrrStartups.find(function(s) {
        return s.slug && s.slug === def.slug;
      });
    }
    var liveMrr = (liveData && liveData.mrr) ? String(liveData.mrr) : def.mrr;
    usedHandles[def.handle.toLowerCase()] = true;
    top.push({ id: def.id, handle: def.handle, saasName: def.saasName, description: def.description || '', avatar: (liveData && liveData.avatar) || def.avatar, mrr: liveMrr, dailyRevenue: liveData ? liveData.dailyRevenue : 0, growth30d: (liveData && liveData.growth30d) || null, verified: (liveData && liveData.verified) || false, icon: (liveData && liveData.icon) || null, askPrice: '', url: def.url, slug: def.slug, isDefault: true });
  }

  // Always include a for-sale startup if one exists and there's room
  if (top.length < FILLER_LIMIT && trustmrrStartups.length > 0) {
    var forSalePool = trustmrrStartups.filter(function(s) {
      return s.onSale && s.handle && s.slug && !usedHandles[s.handle.toLowerCase()];
    }).sort(function(a, b) { return (b.mrr || 0) - (a.mrr || 0); });
    if (forSalePool.length > 0) {
      var salePick = forSalePool[Math.floor(Math.random() * Math.min(forSalePool.length, 5))];
      usedHandles[salePick.handle.toLowerCase()] = true;
      top.push({
        id: 'forsale-' + salePick.handle.toLowerCase(),
        handle: salePick.handle,
        saasName: salePick.startupName || salePick.name || salePick.handle,
        founderName: salePick.name || null,
        description: salePick.description || '',
        avatar: salePick.avatar || null,
        icon: salePick.icon || null,
        mrr: salePick.mrr ? String(salePick.mrr) : '',
        dailyRevenue: salePick.dailyRevenue || 0,
        growth30d: salePick.growth30d || null,
        verified: salePick.verified || false,
        onSale: true,
        askingPrice: salePick.askingPrice || null,
        askPrice: '',
        url: salePick.slug ? 'https://trustmrr.com/startup/' + salePick.slug : '',
        slug: salePick.slug || null,
        isDefault: true,
      });
    }
  }

  // Fill remaining filler slots with random top-30 startups
  if (top.length < FILLER_LIMIT && trustmrrStartups.length > 0) {
    var sorted = trustmrrStartups.slice().sort(function(a, b) { return (b.mrr || 0) - (a.mrr || 0); });
    var topPool = sorted.slice(0, Math.min(30, sorted.length));
    var available = topPool.filter(function(s) { return s.handle && s.slug && s.description && !usedHandles[s.handle.toLowerCase()]; });
    while (top.length < FILLER_LIMIT && available.length > 0) {
      var pick = available.splice(Math.floor(Math.random() * available.length), 1)[0];
      usedHandles[pick.handle.toLowerCase()] = true;
      top.push({
        id: 'filler-' + pick.handle.toLowerCase(),
        handle: pick.handle,
        saasName: pick.startupName || pick.name || pick.handle,
        founderName: pick.name || null,
        description: pick.description || '',
        avatar: pick.avatar || null,
        icon: pick.icon || null,
        mrr: pick.mrr ? String(pick.mrr) : '',
        dailyRevenue: pick.dailyRevenue || 0,
        growth30d: pick.growth30d || null,
        verified: pick.verified || false,
        onSale: pick.onSale || false,
        askingPrice: pick.askingPrice || null,
        askPrice: '',
        url: pick.slug ? 'https://trustmrr.com/startup/' + pick.slug : '',
        slug: pick.slug || null,
        isDefault: true,
      });
    }
  }
  return { top: top, feed: feed };
}

function buildFeedPayload() {
  const startups = trustmrrStartups
    .filter(s => s.dailyRevenue > 0)
    .map(s => {
      const tweet = latestTweets.get(s.handle.toLowerCase()) || null;
      return { ...s, tweet };
    });
  startups.sort((a, b) => b.dailyRevenue - a.dailyRevenue);

  const totalMRR = startups.reduce((sum, s) => sum + (s.mrr || 0), 0);
  const totalDailyRevenue = Math.round(totalMRR / 30 * 100) / 100;

  return {
    startups,
    totalDailyRevenue,
    totalMRR,
    startupCount: startups.length,
    lastSync: lastScanDone ? new Date(lastScanDone).toISOString() : null,
    scanning: scanInProgress,
  };
}

function setMemoryCache() {
  const payload = buildFeedPayload();
  memoryFeedCache = { base: payload };
}

/* ── PostgreSQL (optional — keeps tweet storage) ────────── */
let pool = null;

async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.log('No DATABASE_URL — file cache only');
    return;
  }
  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    await pool.query('SELECT 1');
    console.log('PostgreSQL connected');
    await ensureSchema();
  } catch (err) {
    console.error('DB init failed:', err.message);
    pool = null;
  }
}

async function ensureSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tweets (
      tweet_id TEXT PRIMARY KEY,
      screenname TEXT NOT NULL,
      text TEXT,
      favorites INT DEFAULT 0,
      views TEXT,
      bookmarks INT DEFAULT 0,
      retweets INT DEFAULT 0,
      reply_to TEXT,
      created_at TEXT,
      author_name TEXT,
      author_screen_name TEXT,
      author_avatar TEXT,
      raw_json JSONB,
      inserted_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scan_state (
      screenname TEXT PRIMARY KEY,
      last_tweet_id TEXT,
      last_scanned_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tweets_sn ON tweets(screenname)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_snapshots (
      snapshot_date DATE PRIMARY KEY,
      total_daily_revenue NUMERIC(12, 2) NOT NULL,
      total_mrr NUMERIC(12, 2) NOT NULL,
      startup_count INT NOT NULL DEFAULT 0,
      top_earners JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('Schema ready');
}

/* ── DB helpers ─────────────────────────────────────────── */
async function getKnownTweetIds(screenname) {
  if (!pool) return new Set();
  try {
    const r = await pool.query('SELECT tweet_id FROM tweets WHERE screenname=$1', [screenname]);
    return new Set(r.rows.map(x => x.tweet_id));
  } catch (e) { return new Set(); }
}

async function storeTweets(tweets, screenname) {
  if (!pool || !tweets.length) return;
  try {
    const ids = [], sns = [], txts = [], favs = [], vws = [], bks = [], rts = [], rps = [];
    const cas = [], ans = [], asns = [], aas = [], rjs = [];
    for (const t of tweets) {
      const a = t.author || {};
      ids.push(t.tweet_id); sns.push(screenname); txts.push(t.text || '');
      favs.push(t.favorites || 0); vws.push(String(t.views || '0'));
      bks.push(t.bookmarks || 0); rts.push(t.retweets || 0);
      rps.push(t.reply_to || null); cas.push(t.created_at || null);
      ans.push(a.name || ''); asns.push(a.screen_name || '');
      aas.push(a.avatar || ''); rjs.push(JSON.stringify(t));
    }
    await pool.query(`
      INSERT INTO tweets (tweet_id,screenname,text,favorites,views,bookmarks,retweets,
        reply_to,created_at,author_name,author_screen_name,author_avatar,raw_json)
      SELECT * FROM unnest($1::text[],$2::text[],$3::text[],$4::int[],$5::text[],
        $6::int[],$7::int[],$8::text[],$9::text[],$10::text[],$11::text[],$12::text[],$13::jsonb[])
      ON CONFLICT (tweet_id) DO NOTHING
    `, [ids, sns, txts, favs, vws, bks, rts, rps, cas, ans, asns, aas, rjs]);
  } catch (err) {
    for (const t of tweets) {
      try {
        const a = t.author || {};
        await pool.query(`
          INSERT INTO tweets (tweet_id,screenname,text,favorites,views,bookmarks,retweets,
            reply_to,created_at,author_name,author_screen_name,author_avatar,raw_json)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          ON CONFLICT (tweet_id) DO NOTHING
        `, [t.tweet_id, screenname, t.text, t.favorites || 0, String(t.views || '0'),
            t.bookmarks || 0, t.retweets || 0, t.reply_to || null, t.created_at || null,
            (a.name || ''), (a.screen_name || ''), (a.avatar || ''), JSON.stringify(t)]);
      } catch (e) { /* skip */ }
    }
  }
}

async function updateScanState(screenname, lastTweetId) {
  if (!pool) return;
  try {
    await pool.query(`
      INSERT INTO scan_state (screenname, last_tweet_id, last_scanned_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (screenname) DO UPDATE SET last_tweet_id=$2, last_scanned_at=NOW()
    `, [screenname, lastTweetId]);
  } catch (e) { /* skip */ }
}

/* ── Daily snapshot helpers ─────────────────────────────── */
const DAILY_HISTORY_FILE = path.join(CACHE_DIR, 'daily_history.json');

function getTodayET() {
  const d = new Date();
  const parts = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
  return parts;
}

function loadDailyHistory() {
  try {
    if (fs.existsSync(DAILY_HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(DAILY_HISTORY_FILE, 'utf8'));
    }
  } catch (e) { /* skip */ }
  return [];
}

function saveSnapshotToFile(snapshot) {
  try {
    const history = loadDailyHistory();
    const idx = history.findIndex(h => h.date === snapshot.date);
    if (idx >= 0) {
      history[idx] = snapshot;
    } else {
      history.push(snapshot);
    }
    history.sort((a, b) => b.date.localeCompare(a.date));
    const trimmed = history.slice(0, 30);
    fs.writeFileSync(DAILY_HISTORY_FILE, JSON.stringify(trimmed, null, 2));
  } catch (e) { console.error('Failed to save daily snapshot file:', e.message); }
}

async function saveDailySnapshot() {
  try {
    const active = trustmrrStartups.filter(s => s.dailyRevenue > 0);
    if (!active.length) return;

    const totalDailyRevenue = Math.round(active.reduce((sum, s) => sum + s.dailyRevenue, 0) * 100) / 100;
    const totalMRR = Math.round(active.reduce((sum, s) => sum + s.mrr, 0) * 100) / 100;
    const startupCount = active.length;

    const sorted = active.slice().sort((a, b) => b.dailyRevenue - a.dailyRevenue);
    const topEarners = sorted.slice(0, 5).map(s => ({
      handle: s.handle,
      name: s.startupName || s.name,
      dailyRevenue: s.dailyRevenue,
      mrr: s.mrr,
    }));

    const dateStr = getTodayET();
    const snapshot = {
      date: dateStr,
      totalDailyRevenue,
      totalMRR,
      startupCount,
      topEarners,
    };

    // Persist to PostgreSQL
    if (pool) {
      try {
        await pool.query(`
          INSERT INTO daily_snapshots (snapshot_date, total_daily_revenue, total_mrr, startup_count, top_earners)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (snapshot_date) DO UPDATE SET
            total_daily_revenue = EXCLUDED.total_daily_revenue,
            total_mrr = EXCLUDED.total_mrr,
            startup_count = EXCLUDED.startup_count,
            top_earners = EXCLUDED.top_earners
        `, [dateStr, totalDailyRevenue, totalMRR, startupCount, JSON.stringify(topEarners)]);
      } catch (e) { console.error('Failed to save daily snapshot to DB:', e.message); }
    }

    // Always persist to file
    saveSnapshotToFile(snapshot);
    console.log(`[snapshot] Saved daily snapshot for ${dateStr}: $${totalDailyRevenue} daily, ${startupCount} startups`);
  } catch (e) { console.error('saveDailySnapshot failed:', e.message); }
}

async function getDailyHistory(days) {
  days = Math.min(Math.max(days || 7, 1), 30);
  const todayET = getTodayET();

  // Try PostgreSQL first
  if (pool) {
    try {
      const r = await pool.query(
        `SELECT snapshot_date, total_daily_revenue, total_mrr, startup_count, top_earners
         FROM daily_snapshots
         WHERE snapshot_date < $1
         ORDER BY snapshot_date DESC
         LIMIT $2`,
        [todayET, days]
      );
      if (r.rows.length) {
        return r.rows.map(row => ({
          date: row.snapshot_date instanceof Date
            ? row.snapshot_date.toISOString().slice(0, 10)
            : String(row.snapshot_date).slice(0, 10),
          totalDailyRevenue: parseFloat(row.total_daily_revenue),
          totalMRR: parseFloat(row.total_mrr),
          startupCount: row.startup_count,
          topEarners: row.top_earners || [],
        }));
      }
    } catch (e) { /* fall through to file */ }
  }

  // File fallback
  const history = loadDailyHistory();
  return history.filter(h => h.date < todayET).slice(0, days);
}

/* ── File cache ─────────────────────────────────────────── */
function cacheGet(name) {
  const p = path.join(CACHE_DIR, `${name}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function cacheSet(name, data) {
  try { fs.writeFileSync(path.join(CACHE_DIR, `${name}.json`), JSON.stringify(data)); } catch (e) { /* skip */ }
}

function cacheAge(name) {
  const p = path.join(CACHE_DIR, `${name}.json`);
  if (!fs.existsSync(p)) return Infinity;
  try { return Date.now() - fs.statSync(p).mtimeMs; } catch (e) { return Infinity; }
}

function pruneCache() {
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (!f.endsWith('.json')) continue;
      if (f === 'trustmrr_data.json' || f === 'scan_times.json' || f === 'ad_slots.json' || f === 'pending_ads.json' || f === 'daily_history.json' || f === 'expired_ads.json' || f === 'sessions.json') continue;
      const full = path.join(CACHE_DIR, f);
      try {
        if (Date.now() - fs.statSync(full).mtimeMs > 2 * SCAN_COOLDOWN) fs.unlinkSync(full);
      } catch (e) { /* skip */ }
    }
  } catch (e) { /* skip */ }
}

pruneCache();

/* ── Scan time persistence (survives restarts) ──────────── */
function loadScanTimes() {
  const d = cacheGet('scan_times');
  if (d) for (const [k, v] of Object.entries(d)) scanTimes.set(k, v);
}

function saveScanTimes() {
  const o = {};
  for (const [k, v] of scanTimes) o[k] = v;
  cacheSet('scan_times', o);
}

async function warmScanTimesFromDb() {
  if (!pool) return;
  try {
    const r = await pool.query('SELECT screenname, last_scanned_at FROM scan_state');
    for (const row of r.rows) {
      const t = new Date(row.last_scanned_at).getTime();
      if (!scanTimes.has(row.screenname) || t > scanTimes.get(row.screenname)) {
        scanTimes.set(row.screenname, t);
      }
    }
    console.log(`Scan state loaded for ${r.rows.length} accounts`);
  } catch (e) { /* skip */ }
}

/* ── Traffic session helpers ────────────────────────────── */
function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      console.log(`Sessions loaded: ${sessions.length}`);
    }
  } catch (e) { sessions = []; }
}

function saveSessions() {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions));
  } catch (e) { console.error('Failed to save sessions:', e.message); }
}

function cleanupOldSessions() {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const before = sessions.length;
  sessions = sessions.filter(function(s) {
    return new Date(s.createdAt).getTime() > cutoff;
  });
  if (sessions.length !== before) {
    console.log('[traffic] Cleaned up ' + (before - sessions.length) + ' old sessions');
    saveSessions();
  }
}

function inferSource(referrer) {
  if (!referrer) return 'direct';
  try {
    var host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, '');
  } catch (e) { return 'direct'; }
  var map = {
    'google.com': 'google', 'google.co.uk': 'google', 'google.ca': 'google', 'google.com.au': 'google',
    'google.de': 'google', 'google.fr': 'google', 'google.es': 'google', 'google.it': 'google',
    'google.co.jp': 'google', 'google.com.br': 'google', 'google.co.in': 'google',
    'bing.com': 'bing', 'duckduckgo.com': 'duckduckgo', 'yahoo.com': 'yahoo',
    'search.yahoo.com': 'yahoo', 'yandex.ru': 'yandex', 'yandex.com': 'yandex',
    'baidu.com': 'baidu', 'ecosia.org': 'ecosia', 'brave.com': 'brave search',
    'twitter.com': 'twitter', 'x.com': 'twitter', 't.co': 'twitter',
    'facebook.com': 'facebook', 'fb.com': 'facebook', 'l.facebook.com': 'facebook',
    'instagram.com': 'instagram', 'l.instagram.com': 'instagram',
    'linkedin.com': 'linkedin', 'lnkd.in': 'linkedin',
    'reddit.com': 'reddit', 'old.reddit.com': 'reddit',
    'news.ycombinator.com': 'hackernews', 'hn.algolia.com': 'hackernews',
    'producthunt.com': 'producthunt',
    'github.com': 'github', 'gist.github.com': 'github',
    'medium.com': 'medium',
    'dev.to': 'dev.to', 'hashnode.com': 'hashnode', 'hashnode.dev': 'hashnode',
    'youtube.com': 'youtube', 'youtu.be': 'youtube',
    'tiktok.com': 'tiktok',
    'pinterest.com': 'pinterest',
    'threads.net': 'threads', 'mastodon.social': 'mastodon',
    'bsky.app': 'bluesky',
    'chat.openai.com': 'chatgpt', 'chatgpt.com': 'chatgpt',
    'claude.ai': 'claude', 'perplexity.ai': 'perplexity',
    'gemini.google.com': 'gemini',
    'substack.com': 'substack',
    'trustmrr.com': 'trustmrr',
    'slack.com': 'slack', 'discord.com': 'discord', 'discord.gg': 'discord',
    'notion.so': 'notion', 'notion.site': 'notion',
    'whatsapp.com': 'whatsapp', 'web.whatsapp.com': 'whatsapp',
    'telegram.org': 'telegram', 't.me': 'telegram',
  };
  if (map[host]) return map[host];
  // Check partial matches (subdomains)
  for (var key in map) {
    if (host.endsWith('.' + key)) return map[key];
  }
  return host;
}

function parseUA(ua) {
  if (!ua) return { device: 'unknown', browser: 'unknown', os: 'unknown' };
  // Device
  var device = 'desktop';
  if (/tablet|ipad/i.test(ua)) device = 'tablet';
  else if (/mobile|iphone|android.*mobile|windows phone/i.test(ua)) device = 'mobile';
  // Browser
  var browser = 'other';
  if (/edg\//i.test(ua)) browser = 'edge';
  else if (/opr\/|opera/i.test(ua)) browser = 'opera';
  else if (/chrome|crios/i.test(ua)) browser = 'chrome';
  else if (/firefox|fxios/i.test(ua)) browser = 'firefox';
  else if (/safari/i.test(ua) && !/chrome/i.test(ua)) browser = 'safari';
  else if (/msie|trident/i.test(ua)) browser = 'ie';
  // OS
  var os = 'other';
  if (/windows/i.test(ua)) os = 'windows';
  else if (/macintosh|mac os/i.test(ua)) os = 'macos';
  else if (/linux/i.test(ua) && !/android/i.test(ua)) os = 'linux';
  else if (/android/i.test(ua)) os = 'android';
  else if (/iphone|ipad|ipod/i.test(ua)) os = 'ios';
  else if (/cros/i.test(ua)) os = 'chromeos';
  return { device: device, browser: browser, os: os };
}

function hashIP(ip) {
  return crypto.createHash('sha256').update(ip || '').digest('hex').slice(0, 16);
}

function geoLookup(ip) {
  return new Promise(function(resolve) {
    if (!ip || ip === '127.0.0.1' || ip === '::1') return resolve({ country: 'Local', city: '' });
    var timer = setTimeout(function() { resolve({ country: 'Unknown', city: '' }); }, 2000);
    try {
      http.get('http://ip-api.com/json/' + encodeURIComponent(ip) + '?fields=country,city', function(resp) {
        var data = '';
        resp.on('data', function(c) { data += c; });
        resp.on('end', function() {
          clearTimeout(timer);
          try {
            var j = JSON.parse(data);
            resolve({ country: j.country || 'Unknown', city: j.city || '' });
          } catch (e) { resolve({ country: 'Unknown', city: '' }); }
        });
      }).on('error', function() {
        clearTimeout(timer);
        resolve({ country: 'Unknown', city: '' });
      });
    } catch (e) {
      clearTimeout(timer);
      resolve({ country: 'Unknown', city: '' });
    }
  });
}

function getClientIP(req) {
  var xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

/* ── Response helpers ───────────────────────────────────── */
function sendJson(req, res, code, obj) {
  const json = JSON.stringify(obj);
  const gz = (req.headers['accept-encoding'] || '').includes('gzip');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (gz && json.length > 512) {
    res.setHeader('Content-Encoding', 'gzip');
    res.writeHead(code);
    zlib.gzip(json, (e, buf) => res.end(e ? json : buf));
  } else {
    res.writeHead(code);
    res.end(json);
  }
}

function sendCachedFeed(req, res) {
  if (!memoryFeedCache) return false;
  // Merge fresh ads per-request for rotation
  const payload = Object.assign({}, memoryFeedCache.base, { ads: getAdsForFeed() });
  const json = JSON.stringify(payload);
  const gz = (req.headers['accept-encoding'] || '').includes('gzip');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
  if (gz) {
    res.setHeader('Content-Encoding', 'gzip');
    res.writeHead(200);
    zlib.gzip(json, (e, buf) => res.end(e ? json : buf));
  } else {
    res.writeHead(200);
    res.end(json);
  }
  return true;
}

/* ── Static file cache ──────────────────────────────────── */
const staticCache = new Map();

function preloadStatic() {
  const mimes = {
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript',
    '.css': 'text/css', '.json': 'application/json',
    '.png': 'image/png', '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  };
  for (const file of ['index.html']) {
    const full = path.join(__dirname, file);
    if (!fs.existsSync(full)) continue;
    const content = fs.readFileSync(full);
    const ext = path.extname(file);
    const entry = { content, gzipped: zlib.gzipSync(content), mime: mimes[ext] || 'text/plain' };
    staticCache.set('/' + file, entry);
    if (file === 'index.html') staticCache.set('/', entry);
  }
}

/* ── HTTPS helpers ──────────────────────────────────────── */
function httpsReq(opts, body) {
  return new Promise((resolve, reject) => {
    const r = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error('Bad JSON: ' + d.slice(0, 200))); }
      });
    });
    r.on('error', reject);
    r.setTimeout(30000, () => { r.destroy(); reject(new Error('Timeout')); });
    if (body) r.write(body);
    r.end();
  });
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'WhileYouSlept/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve, reject);
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/* ── Stripe webhook signature verification ─────────────── */
function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = {};
  for (const item of sigHeader.split(',')) {
    const [k, v] = item.split('=');
    if (k && v) parts[k.trim()] = v.trim();
  }
  const timestamp = parts.t;
  const sig = parts.v1;
  if (!timestamp || !sig) return false;
  // Reject timestamps older than 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) return false;
  const expected = crypto.createHmac('sha256', secret)
    .update(timestamp + '.' + payload)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch (e) { return false; }
}

/* ── Stripe API fallback: verify payment via API ────────── */
async function verifyStripePayment(handle, saasName) {
  const sk = process.env.STRIPE_SECRET_KEY || '';
  if (!sk) return null;
  try {
    // Try composite ref first (handle|saasName), then bare handle
    const refs = saasName ? [`${handle}|${saasName}`, handle] : [handle];
    for (const ref of refs) {
      const qs = `client_reference_id=${encodeURIComponent(ref)}&status=complete&limit=1`;
      const data = await httpsReq({
        hostname: 'api.stripe.com',
        path: `/v1/checkout/sessions?${qs}`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${sk}` },
      });
      if (data && data.data && data.data.length > 0) {
        console.log(`[stripe] API fallback found session for ref="${ref}"`);
        return data.data[0];
      }
    }
  } catch (e) {
    console.error('[stripe] API fallback error:', e.message);
  }
  return null;
}

/* ── Resend email after payment ─────────────────────────── */
function sendPaymentEmail(email, handle, saasName) {
  const apiKey = process.env.RESEND_API_KEY || '';
  if (!apiKey || !email) return;
  const siteUrl = process.env.SITE_URL || 'https://whileyouslept.lol';
  const body = JSON.stringify({
    from: 'WhileYouSlept.lol <noreply@whileyouslept.lol>',
    to: [email],
    subject: `Activate your ad for ${saasName || handle} on WhileYouSlept.lol`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:32px 20px;">
<h2 style="margin:0 0 8px;font-size:1.2rem;">Payment confirmed!</h2>
<p style="color:#666;font-size:0.9rem;line-height:1.5;margin:0 0 24px;">Your featured ad slot for <strong>@${handle}</strong>${saasName ? ' (' + saasName + ')' : ''} is ready to activate.</p>
<a href="${siteUrl}/success" style="display:inline-block;background:#16a34a;color:#fff;font-weight:700;font-size:0.9rem;padding:12px 28px;border-radius:8px;text-decoration:none;">Activate Your Ad</a>
<p style="color:#999;font-size:0.75rem;margin-top:24px;">If you didn't make this purchase, you can ignore this email.</p>
</div>`,
  });
  httpsReq({
    hostname: 'api.resend.com',
    path: '/emails',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body).then(() => {
    console.log(`[resend] Email sent to ${email} for @${handle}`);
  }).catch(e => {
    console.error(`[resend] Failed to send email: ${e.message}`);
  });
}

/* ── TrustMRR Data Scraper ──────────────────────────────── */
const TRUSTMRR_DATA_FILE = path.join(CACHE_DIR, 'trustmrr_data.json');

function loadTrustMrrData() {
  try {
    if (fs.existsSync(TRUSTMRR_DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(TRUSTMRR_DATA_FILE, 'utf8'));
      if (data.startups && data.startups.length) {
        trustmrrStartups = data.startups;
        console.log(`TrustMRR data loaded from cache: ${trustmrrStartups.length} startups`);
      }
    }
  } catch (e) { /* skip */ }
}

function saveTrustMrrData(startups) {
  try {
    fs.writeFileSync(TRUSTMRR_DATA_FILE, JSON.stringify({
      startups,
      updated: new Date().toISOString(),
    }));
  } catch (e) { console.error('Failed to save TrustMRR data:', e.message); }
}

// Extract Next.js RSC data chunks from HTML
function extractNextData(html) {
  const chunks = [];
  const re = /self\.__next_f\.push\(\s*\[[\d,]*"([^]*?)"\s*\]\s*\)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      // Unescape the JSON-encoded string
      const decoded = m[1]
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
      chunks.push(decoded);
    } catch (e) { /* skip malformed chunk */ }
  }
  return chunks.join('\n');
}

// Parse dollar amounts from text
function parseDollarAmount(text) {
  if (!text) return 0;
  const m = text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*([KkMm])?/);
  if (!m) return 0;
  let v = parseFloat(m[1].replace(/,/g, ''));
  if (m[2] && /[Kk]/.test(m[2])) v *= 1000;
  if (m[2] && /[Mm]/.test(m[2])) v *= 1000000;
  return v;
}

async function scrapeLeaderboard() {
  const html = await fetchUrl('https://trustmrr.com');
  const rscData = extractNextData(html);

  const startups = [];

  // The RSC data contains a JSON array of startup objects, each starting with "_id".
  // Fields per object: name, slug, icon, xHandle, xFounderName, currentLast30DaysRevenue, etc.
  // Split on object boundaries to isolate each startup.
  const idRe = /\{["\s]*_id["\s]*:\s*"/g;
  let nm;
  const positions = [];
  while ((nm = idRe.exec(rscData)) !== null) {
    positions.push(nm.index);
  }

  const seenSlugs = new Set();
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i];
    const end = i < positions.length - 1 ? positions[i + 1] : Math.min(rscData.length, start + 3000);
    const segment = rscData.substring(start, end);

    // Must have revenue data to be a startup listing
    const revM = segment.match(/"currentLast30DaysRevenue"\s*:\s*([\d.]+)/);
    if (!revM) continue;

    const slugM = segment.match(/"slug"\s*:\s*"([^"]+)"/);
    if (!slugM || seenSlugs.has(slugM[1])) continue;

    const nameM = segment.match(/"name"\s*:\s*"([^"]{1,120})"/);
    const handleM = segment.match(/"xHandle"\s*:\s*"([^"]{1,30})"/);
    const founderM = segment.match(/"xFounderName"\s*:\s*"([^"]{1,80})"/);
    const iconM = segment.match(/"icon"\s*:\s*"([^"]+)"/);
    const growthRaw = segment.match(/"growth30d"\s*:\s*([-\d.]+)/);
    const onSaleM = segment.match(/"onSale"\s*:\s*(true|false)/);
    const askM = segment.match(/"askingPrice"\s*:\s*([\d.]+)/);
    const descM = segment.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);

    seenSlugs.add(slugM[1]);
    startups.push({
      name: nameM ? nameM[1] : slugM[1],
      slug: slugM[1],
      mrr: parseFloat(revM[1]) || 0,
      growth30d: growthRaw ? parseFloat(growthRaw[1]) : null,
      icon: iconM ? iconM[1] : null,
      handle: handleM ? handleM[1] : null,
      founderName: founderM ? founderM[1] : null,
      onSale: onSaleM ? onSaleM[1] === 'true' : false,
      askingPrice: askM ? parseFloat(askM[1]) : null,
      description: descM ? descM[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim().slice(0, 120) : null,
    });
  }

  // Fallback: collect all handles from the full HTML for extra coverage
  const allHandles = [];
  const unavatarRe2 = /unavatar\.io\/x\/([A-Za-z0-9_]{1,15})/g;
  while ((nm = unavatarRe2.exec(html)) !== null) {
    const h = nm[1];
    if (!allHandles.includes(h)) allHandles.push(h);
  }

  console.log(`[trustmrr] Leaderboard: ${startups.length} startups, ${startups.filter(s => s.handle).length} with handles`);
  return { startups, handles: allHandles };
}

async function scrapeOpenPage() {
  const html = await fetchUrl('https://trustmrr.com/open');
  const rscData = extractNextData(html);

  const posts = [];

  // Anchor on "tweetUrl" (unique per post) and find associated fields nearby
  const tweetUrlRe = /"tweetUrl"\s*:\s*"([^"]+)"/g;
  let nm;
  const tweetPositions = [];
  while ((nm = tweetUrlRe.exec(rscData)) !== null) {
    tweetPositions.push({ url: nm[1], pos: nm.index });
  }

  const seenUrls = new Set();
  for (const tweet of tweetPositions) {
    if (seenUrls.has(tweet.url)) continue;
    seenUrls.add(tweet.url);

    const WINDOW = 2000;
    const start = Math.max(0, tweet.pos - WINDOW);
    const end = Math.min(rscData.length, tweet.pos + WINDOW);
    const win = rscData.substring(start, end);

    const usernameM = win.match(/"username"\s*:\s*"([^"]+)"/);
    if (!usernameM) continue;

    const imgM = win.match(/"userProfileImage"\s*:\s*"([^"]+)"/);
    const textM = win.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const likesM = win.match(/"likeCount"\s*:\s*(\d+)/);
    const viewsM = win.match(/"viewCount"\s*:\s*(\d+)/);
    const verifiedM = win.match(/"isVerifiedStartup"\s*:\s*(true|false)/);

    let text = '';
    if (textM) {
      try {
        text = textM[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      } catch (e) {
        text = textM[1];
      }
    }

    posts.push({
      username: usernameM[1],
      avatar: imgM ? imgM[1] : null,
      text,
      tweetUrl: tweet.url,
      likeCount: likesM ? parseInt(likesM[1]) : 0,
      viewCount: viewsM ? parseInt(viewsM[1]) : 0,
      isVerified: verifiedM ? verifiedM[1] === 'true' : false,
      parsedMrr: parseDollarAmount(text),
    });
  }

  // Also extract handles from x.com/handle and twitter.com/handle patterns
  const handleSet = new Set();
  const handlePatterns = [
    /(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,15})(?:[?"'\s/]|$)/g,
  ];
  for (const re of handlePatterns) {
    while ((nm = re.exec(html)) !== null) {
      const h = nm[1];
      if (!['home','explore','search','settings','i','intent','share','hashtag'].includes(h.toLowerCase())) {
        handleSet.add(h);
      }
    }
  }

  console.log(`[trustmrr] Open page: ${posts.length} posts, ${posts.filter(p => p.avatar).length} with avatars`);
  return { posts, extraHandles: Array.from(handleSet) };
}

async function fetchStartupDescription(slug) {
  try {
    const html = await fetchUrl('https://trustmrr.com/startup/' + encodeURIComponent(slug));
    // Look for the description paragraph with TrustMRR's styling
    const match = html.match(/<p[^>]*class="[^"]*text-muted-foreground[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    if (match) {
      return match[1].replace(/<[^>]+>/g, '').trim().slice(0, 120);
    }
    // Fallback: try RSC data on the page
    const rscData = extractNextData(html);
    const descM = rscData.match(/"description"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (descM) {
      return descM[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim().slice(0, 120);
    }
    return null;
  } catch (e) { return null; }
}

async function syncTrustMrrData() {
  try {
    console.log('[trustmrr] Syncing startup data...');

    // Scrape both pages in parallel
    const [leaderboard, openPage] = await Promise.all([
      scrapeLeaderboard().catch(e => { console.error('[trustmrr] Leaderboard scrape failed:', e.message); return { startups: [], handles: [] }; }),
      scrapeOpenPage().catch(e => { console.error('[trustmrr] Open page scrape failed:', e.message); return { posts: [], extraHandles: [] }; }),
    ]);

    // Build lookup maps from open page data
    const openByHandle = new Map(); // lowercase handle → post data
    for (const post of openPage.posts) {
      if (post.username) {
        openByHandle.set(post.username.toLowerCase(), post);
      }
    }

    // Merge: each leaderboard startup now carries its own handle (from proximity extraction)
    const merged = new Map(); // lowercase handle → startup record

    for (const s of leaderboard.startups) {
      const handle = s.handle;
      if (!handle) continue;

      const key = handle.toLowerCase();
      if (merged.has(key)) continue; // first occurrence wins (highest on page = most relevant)

      const openData = openByHandle.get(key);

      merged.set(key, {
        handle,
        name: s.founderName || openData?.username || handle,
        startupName: s.name || null,
        description: s.description || null,
        avatar: openData?.avatar || null,
        mrr: s.mrr || 0,
        dailyRevenue: Math.round((s.mrr || 0) / 30 * 100) / 100,
        growth30d: s.growth30d || null,
        verified: openData?.isVerified || false,
        slug: s.slug || null,
        icon: s.icon || null,
        onSale: s.onSale || false,
        askingPrice: s.askingPrice || null,
        updated: new Date().toISOString(),
      });
    }

    // Add startups from open page that aren't in leaderboard
    for (const post of openPage.posts) {
      if (!post.username) continue;
      const key = post.username.toLowerCase();
      if (merged.has(key)) continue;

      const mrr = post.parsedMrr || 0;
      merged.set(key, {
        handle: post.username,
        name: post.username,
        startupName: null,
        avatar: post.avatar || null,
        mrr,
        dailyRevenue: Math.round(mrr / 30 * 100) / 100,
        growth30d: null,
        verified: post.isVerified || false,
        slug: null,
        icon: null,
        updated: new Date().toISOString(),
      });
    }

    // Add any extra handles from the open page that weren't in posts
    for (const h of openPage.extraHandles) {
      const key = h.toLowerCase();
      if (merged.has(key)) continue;
      merged.set(key, {
        handle: h,
        name: h,
        startupName: null,
        avatar: null,
        mrr: 0,
        dailyRevenue: 0,
        growth30d: null,
        verified: false,
        slug: null,
        icon: null,
        updated: new Date().toISOString(),
      });
    }

    let startups = Array.from(merged.values());

    // Filter out $0 MRR startups at the source
    startups = startups.filter(s => s.mrr > 0);

    // Fetch descriptions for top 30 startups missing them
    if (startups.length > 0) {
      const sorted = startups.slice().sort((a, b) => (b.mrr || 0) - (a.mrr || 0));
      const needDesc = sorted.slice(0, 30).filter(s => !s.description && s.slug);
      if (needDesc.length > 0) {
        console.log(`[trustmrr] Fetching descriptions for ${needDesc.length} top startups...`);
        for (const s of needDesc) {
          const desc = await fetchStartupDescription(s.slug);
          if (desc) s.description = desc;
          // Small delay to avoid hammering TrustMRR
          await new Promise(r => setTimeout(r, 300));
        }
        console.log(`[trustmrr] Descriptions fetched: ${needDesc.filter(s => s.description).length}/${needDesc.length}`);
      }
    }

    if (startups.length > 0) {
      trustmrrStartups = startups;
      saveTrustMrrData(startups);
      setMemoryCache();
      await saveDailySnapshot();
      console.log(`[trustmrr] Synced ${startups.length} startups with revenue data`);
      const totalMRR = startups.reduce((sum, s) => sum + s.mrr, 0);
      console.log(`[trustmrr] Total MRR: $${Math.round(totalMRR).toLocaleString()}`);
    } else {
      console.log('[trustmrr] No startups found, keeping existing cache');
    }
  } catch (e) {
    console.error('[trustmrr] Sync failed:', e.message);
  }
}

/* ── Daily TrustMRR sync scheduling ────────────────────── */
function scheduleNextSync() {
  // Calculate ms until 00:01 AM Eastern Time
  const now = new Date();
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etNow = new Date(etStr);
  const target = new Date(etStr);
  target.setDate(target.getDate() + 1);
  target.setHours(0, 1, 0, 0); // 12:01 AM next day
  const msUntil = target.getTime() - etNow.getTime();
  const minutes = Math.round(msUntil / 60000);
  console.log(`[trustmrr] Next sync scheduled in ${minutes} minutes (12:01 AM ET)`);
  setTimeout(async () => {
    await syncTrustMrrData();
    console.log(`[trustmrr] Daily sync complete: ${trustmrrStartups.length} startups`);
    scheduleNextSync();
  }, msUntil);
}

/* ── Twitter API ────────────────────────────────────────── */
async function fetchTimeline(screenname) {
  if (cacheAge(`tweets_${screenname}`) < SCAN_COOLDOWN) {
    const c = cacheGet(`tweets_${screenname}`);
    if (c) return c;
  }
  const data = await httpsReq({
    hostname: TWITTER_HOST,
    path: `/timeline.php?screenname=${encodeURIComponent(screenname)}`,
    method: 'GET',
    headers: { 'x-rapidapi-key': TWITTER_KEY, 'x-rapidapi-host': TWITTER_HOST },
  });
  if (data && data.timeline) cacheSet(`tweets_${screenname}`, data);
  return data;
}

/* ── Strict filter: ONLY 3 categories ──────────────────── */
function isMoneyTweet(text, hasMedia) {
  if (!text) return false;

  // ── Hard rejections ──────────────────────────────────
  const isNoise = /(?:my goal|hoping to|want to (?:hit|make|reach)|aiming for|planning to|going to (?:make|hit|reach)|trying to (?:reach|hit|get)|dream of|would love to|working towards|plan is to|aspir|by (?:end of|year end|next year|EOY)|get (?:my |this |the |it )?(?:.*?)to \$)/i.test(text);
  if (isNoise) return false;
  const isAdvice = /(?:^how to|^why you|^stop |^don't|should you|^the secret|^my advice|^tip:|^thread|^lesson|\d+\s+(?:biggest|best|top|key|important)\s+(?:lessons?|tips?|things?|ways?|steps?|rules?)|\d+\s+ways\s+I|should have (?:done|started|built)|I learned to|sure-shot way|sure.?fire way|best way to find|find your next|thought .* problems would go away)/i.test(text);
  if (isAdvice) return false;
  const isPromo = /(?:^check out|^join |^sign up|^use code|^discount|^giveaway|FOR SALE|APP FOR SALE|selling (?:my |the |this ))/i.test(text);
  if (isPromo) return false;
  const isSpending = /(?:i pay|pay (?:for|to )|paying (?:for|~?\$)|spend(?:ing)?|cost (?:me|us)|bought|purchased|invested in|raised \$|fundrais|hiring|salary|struggling|might not spend)/i.test(text);
  if (isSpending) return false;
  const isThirdParty = /(?:can buy|could buy|you can|you'll|imagine|if you|if i (?:wanted|could|just)|i could probably|for only|priced at|worth \$|valued at|starting at|costs? \$|cheap|expensive|why would|how would|what if|anyone (?:here )?(?:buying|selling|looking))/i.test(text);
  if (isThirdParty) return false;
  const isCommentary = /(?:might not|wouldn't|won't|doesn't seem|not (?:possible|appealing)|end up doing)/i.test(text);
  if (isCommentary) return false;
  const isRT = /^RT @/i.test(text);
  if (isRT) return false;
  const isFinanceCommentary = /(?:series [A-F]|tender offer|valuation (?:increase|decrease|drop)|IPO|cap table|fundrais|due diligence|term sheet|pre.?money|post.?money|runway|burn rate)/i.test(text);
  if (isFinanceCommentary) return false;

  const isMrrUpdate = /(?:\$[\d,.]+[KkMm]?\s*(?:MRR|ARR)|\b(?:MRR|ARR)\s*(?::|is|hit|at|of|reached|crossed|passed)?\s*\$[\d,.]+)/i.test(text);
  const isSold = /(?:sold (?:my |the |our |a )?(?:company|startup|saas|app|business|product)|acquired for|acquisition.*\$|exit(?:ed)? (?:for|at) \$|\bsold\b.*(?:startup|company|saas).*\$)/i.test(text);
  const isMonthlySaas = (
    /\$[\d,.]+[KkMm]?\s*(?:\/mo(?:nth)?|this month|last month|per month)/i.test(text) ||
    /(?:^|\b)(?:i |we |I've |we've )?(?:made|earned|did|generated|grossed|netted|cleared|brought in|pulling in)\s+(?:~?\$[\d,.]+[KkMm]?|\$[\d,.]+[KkMm]?)/i.test(text) ||
    /\brevenue\b.*\$[\d,.]+/i.test(text) ||
    /(?:last|this|past)\s+(?:\d+\s+)?(?:days?|month|months|week)\s.*(?:made|earned|did|generated|revenue)\s.*\$/i.test(text) ||
    /(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+(?:\d{4}\s+)?(?:revenue|income|was|did|earned|made).*\$/i.test(text)
  );

  return isMrrUpdate || isSold || isMonthlySaas;
}

/* ── FOMO scoring ───────────────────────────────────────── */
function fomoScore(tweet) {
  const text = tweet.text || '';
  const hasMedia = tweet.media && (
    (tweet.media.photo && tweet.media.photo.length > 0) ||
    (tweet.media.video && tweet.media.video.length > 0)
  );
  if (!isMoneyTweet(text, hasMedia)) return 0;

  const favs      = tweet.favorites || 0;
  const views     = parseInt(tweet.views) || 0;
  const bookmarks = tweet.bookmarks || 0;
  const retweets  = tweet.retweets || 0;

  let score = 10;
  score += Math.min(favs / 100, 8);
  score += Math.min(views / 10000, 8);
  score += Math.min(bookmarks / 50, 6);
  score += Math.min(retweets / 20, 4);

  const re = /\$\s*([\d,]+(?:\.\d+)?)\s*([KkMm])?/g;
  let m, maxDollar = 0;
  while ((m = re.exec(text)) !== null) {
    let v = parseFloat(m[1].replace(/,/g, ''));
    if (m[2] && /[Kk]/.test(m[2])) v *= 1000;
    if (m[2] && /[Mm]/.test(m[2])) v *= 1000000;
    if (v > maxDollar) maxDollar = v;
  }

  if (maxDollar >= 1e6)      score += 30;
  else if (maxDollar >= 1e5) score += 20;
  else if (maxDollar >= 5e4) score += 15;
  else if (maxDollar >= 1e4) score += 10;
  else if (maxDollar >= 1e3) score += 5;

  if (/\b(?:SOLD|ACQUIRED|acquisition|exit)\b/i.test(text)) score += 15;
  if (/(?:MRR|ARR)/i.test(text)) score += 5;
  if (hasMedia) score += 5;

  return Math.round(score * 10) / 10;
}

/* ── Clean tweet text for display ──────────────────────── */
function cleanTweetText(text) {
  if (!text) return '';
  return text
    .replace(/https?:\/\/t\.co\/\S+/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ── Extract money snippet from tweet ──────────────────── */
function extractMoneySnippet(text) {
  if (!text) return '';
  if (text.length <= 200) return text;

  const raw = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const parts = [];
  for (const line of raw) {
    if (line.length <= 200) {
      parts.push(line);
    } else {
      const sentences = line.split(/(?<=[.!?])\s+/);
      for (const s of sentences) parts.push(s.trim());
    }
  }

  const scored = parts.map(s => {
    let score = 0;
    if (/\$[\d,]+[KkMm]?/.test(s)) score += 10;
    if (/\d+[KkMm]\s*(?:MRR|ARR|\/mo|\/month|revenue)/i.test(s)) score += 8;
    if (/(?:MRR|ARR|revenue|income|profit|margin)/i.test(s)) score += 5;
    if (/(?:made|earned|grossed|netted|bringing in|generating|sold for|acquired for)/i.test(s)) score += 4;
    if (/(?:paying customers|paid users|subscribers)/i.test(s)) score += 4;
    if (/\d+[KkMm]/.test(s)) score += 2;
    return { text: s, score };
  });

  const money = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  if (!money.length) return text.slice(0, 200).trim();

  let snippet = money[0].text.slice(0, 200);
  for (let i = 1; i < money.length; i++) {
    const next = money[i].text.slice(0, 200);
    const combined = snippet + '\n' + next;
    if (combined.length > 280) break;
    snippet = combined;
  }

  return snippet.trim();
}

/* ── Background scan — scoped to TrustMRR handles only ── */
async function backgroundScan() {
  if (scanInProgress) return;
  if (!TWITTER_KEY) {
    console.log('[scan] No Twitter API key, skipping tweet scan');
    return;
  }

  // Only scan handles that appear in trustmrrStartups
  const handles = trustmrrStartups
    .filter(s => s.handle)
    .map(s => s.handle);

  if (!handles.length) {
    console.log('[scan] No TrustMRR handles to scan for tweets');
    return;
  }

  scanInProgress = true;
  setMemoryCache();

  try {
    // Find accounts due for a scan
    const stale = handles.filter(a => {
      const last = scanTimes.get(a) || 0;
      return Date.now() - last >= SCAN_COOLDOWN;
    });

    if (!stale.length) {
      console.log('[scan] All TrustMRR handles scanned recently');
      scanInProgress = false;
      setMemoryCache();
      return;
    }

    console.log(`[scan] ${stale.length}/${handles.length} handles due for tweet refresh`);

    let errors = 0;
    let scanned = 0;
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    for (const account of stale) {
      scanned++;
      try {
        const data = await fetchTimeline(account);
        if (data && data.timeline) {
          // Find best FOMO tweet from last 7 days
          let bestTweet = null;
          let bestScore = 0;

          for (const tweet of data.timeline) {
            if (tweet.reply_to) continue;
            const tweetDate = new Date(tweet.created_at).getTime();
            if (tweetDate < sevenDaysAgo) continue;

            const score = fomoScore(tweet);
            if (score > bestScore) {
              bestScore = score;
              bestTweet = tweet;
            }
          }

          // Store best tweet in latestTweets map
          if (bestTweet && bestScore > 0) {
            const cleaned = cleanTweetText(bestTweet.text || '');
            const summary = extractMoneySnippet(cleaned);
            const a = bestTweet.author || {};

            // Extract media
            const tweetMedia = [];
            if (bestTweet.media) {
              if (bestTweet.media.photo) {
                for (const p of bestTweet.media.photo) {
                  if (p.media_url_https) tweetMedia.push({ type: 'photo', url: p.media_url_https });
                }
              }
              if (bestTweet.media.video) {
                for (const v of bestTweet.media.video) {
                  const mp4s = (v.variants || [])
                    .filter(x => x.content_type === 'video/mp4')
                    .sort((x, y) => (y.bitrate || 0) - (x.bitrate || 0));
                  tweetMedia.push({
                    type: 'video',
                    thumb: v.media_url_https || '',
                    url: mp4s.length ? mp4s[0].url : null,
                  });
                }
              }
            }

            latestTweets.set(account.toLowerCase(), {
              summary,
              date: bestTweet.created_at || '',
              likes: bestTweet.favorites || 0,
              views: parseInt(bestTweet.views) || 0,
              bookmarks: bestTweet.bookmarks || 0,
              media: tweetMedia.length ? tweetMedia : null,
              tweetUrl: `https://x.com/${a.screen_name || account}/status/${bestTweet.tweet_id}`,
            });
          }

          // Store timeline in DB
          if (data.timeline.length) {
            await storeTweets(data.timeline, account);
            await updateScanState(account, data.timeline[0].tweet_id);
          }
        }
        scanTimes.set(account, Date.now());
      } catch (e) {
        console.log(`  [${scanned}/${stale.length}] @${account}: ${e.message}`);
        errors++;
      }

      if (cacheAge(`tweets_${account}`) < 2000) {
        await new Promise(r => setTimeout(r, 400));
      }
    }

    saveScanTimes();
    lastScanDone = Date.now();
    setMemoryCache();
    console.log(`[scan] Tweet scan done: ${scanned} accounts, ${latestTweets.size} with FOMO tweets (${errors} errors)`);

  } catch (e) {
    console.error('[scan] Error:', e.message);
  } finally {
    scanInProgress = false;
    setMemoryCache();
  }
}

/* ── Inline HTML pages ──────────────────────────────────── */
function getSuccessPageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Activate Your Ad — WhileYouSlept.lol</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #fafafa;
    color: #000;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .container {
    max-width: 440px;
    width: 90%;
    background: #fff;
    border-radius: 12px;
    border: 1px solid #eee;
    padding: 36px;
    margin: 40px auto;
  }
  h1 {
    font-family: 'Arial Black', 'Helvetica Neue', Arial, sans-serif;
    font-size: 1.3rem;
    font-weight: 900;
    letter-spacing: -0.5px;
    margin-bottom: 6px;
  }
  .subtitle {
    font-size: 0.8rem;
    font-weight: 500;
    color: #666;
    margin-bottom: 24px;
    line-height: 1.4;
  }
  label {
    display: block;
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #999;
    margin-bottom: 6px;
  }
  input, textarea {
    width: 100%;
    padding: 12px 14px;
    font-size: 0.95rem;
    font-weight: 600;
    font-family: inherit;
    border: 2px solid #e0e0e0;
    border-radius: 8px;
    outline: none;
    margin-bottom: 16px;
    transition: border-color 0.15s;
  }
  input:focus, textarea:focus { border-color: #16a34a; }
  input[readonly] { background: #f9f9f9; color: #666; }
  textarea { resize: vertical; min-height: 60px; }
  .char-count {
    font-size: 0.65rem;
    font-weight: 600;
    color: #bbb;
    text-align: right;
    margin-top: -12px;
    margin-bottom: 16px;
  }
  .char-count.warn { color: #d97706; }
  .char-count.over { color: #dc2626; }
  button {
    width: 100%;
    padding: 14px;
    background: #16a34a;
    color: #fff;
    font-size: 0.85rem;
    font-weight: 700;
    font-family: inherit;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.15s;
  }
  button:hover { background: #15803d; }
  button:disabled { background: #ccc; cursor: not-allowed; }
  .success-msg {
    display: none;
    text-align: center;
    padding: 20px 0;
  }
  .success-msg h2 {
    font-size: 1.1rem;
    font-weight: 800;
    color: #16a34a;
    margin-bottom: 8px;
  }
  .success-msg p {
    font-size: 0.8rem;
    color: #666;
    margin-bottom: 16px;
    line-height: 1.4;
  }
  .success-msg a {
    color: #16a34a;
    font-weight: 700;
    text-decoration: none;
  }
  .success-msg a:hover { text-decoration: underline; }
  .error-msg {
    font-size: 0.75rem;
    font-weight: 600;
    color: #dc2626;
    margin-bottom: 12px;
    display: none;
  }
  .payment-banner {
    background: #dcfce7;
    color: #16a34a;
    font-size: 0.75rem;
    font-weight: 700;
    text-align: center;
    padding: 8px 12px;
    border-radius: 6px;
    margin-bottom: 16px;
  }
  .status-msg {
    font-size: 0.75rem;
    font-weight: 600;
    color: #d97706;
    margin-bottom: 12px;
    display: none;
  }
</style>
</head>
<body>
<div class="container">
  <div id="formSection">
    <div class="payment-banner" id="paymentBanner">Payment confirmed</div>
    <h1>Activate Your Featured Spot</h1>
    <p class="subtitle">Complete your details below to go live on WhileYouSlept.lol</p>

    <label>X Handle</label>
    <input type="text" id="handleField" readonly>

    <label>SaaS Name</label>
    <input type="text" id="saasField" readonly>

    <label>TrustMRR Profile URL</label>
    <input type="text" id="urlField" placeholder="https://trustmrr.com/startup/your-startup">

    <label>Business Description</label>
    <textarea id="descField" maxlength="80" placeholder="What does your SaaS do? (80 chars max)"></textarea>
    <div class="char-count" id="charCount">0 / 80</div>

    <div class="error-msg" id="errorMsg"></div>
    <div class="status-msg" id="statusMsg"></div>
    <button id="activateBtn">Activate My Ad</button>
  </div>

  <div class="success-msg" id="successMsg">
    <h2>You're live!</h2>
    <p>Your featured card is now showing on the homepage. It will run for 7 days.</p>
    <a href="/">Back to WhileYouSlept.lol</a>
  </div>
</div>

<script>
(function() {
  var handle = localStorage.getItem('pendingAdHandle') || '';
  var saas = localStorage.getItem('pendingAdSaas') || '';
  document.getElementById('handleField').value = handle ? '@' + handle : '';
  document.getElementById('saasField').value = saas;

  var descField = document.getElementById('descField');
  var charCount = document.getElementById('charCount');

  descField.addEventListener('input', function() {
    var len = descField.value.length;
    charCount.textContent = len + ' / 80';
    charCount.className = 'char-count' + (len > 70 ? (len > 80 ? ' over' : ' warn') : '');
  });

  function attemptActivation(payload, retries, btn, errorEl, statusEl) {
    fetch('/api/ad/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    .then(function(r) {
      return r.json().then(function(data) { return { status: r.status, data: data }; });
    })
    .then(function(result) {
      if (result.data.ok) {
        document.getElementById('formSection').style.display = 'none';
        document.getElementById('successMsg').style.display = 'block';
        localStorage.removeItem('pendingAdHandle');
        localStorage.removeItem('pendingAdSaas');
        return;
      }
      if (result.status === 402 && retries > 0) {
        statusEl.textContent = 'Waiting for payment confirmation... (' + retries + ' retries left)';
        statusEl.style.display = 'block';
        errorEl.style.display = 'none';
        setTimeout(function() {
          attemptActivation(payload, retries - 1, btn, errorEl, statusEl);
        }, 3000);
        return;
      }
      statusEl.style.display = 'none';
      errorEl.textContent = result.data.error || 'Something went wrong.';
      errorEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Activate My Ad';
    })
    .catch(function() {
      statusEl.style.display = 'none';
      errorEl.textContent = 'Network error. Please try again.';
      errorEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Activate My Ad';
    });
  }

  document.getElementById('activateBtn').addEventListener('click', function() {
    var btn = this;
    var errorEl = document.getElementById('errorMsg');
    var statusEl = document.getElementById('statusMsg');
    errorEl.style.display = 'none';
    statusEl.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Activating...';

    var payload = {
      handle: handle,
      saasName: saas,
      trustmrrUrl: document.getElementById('urlField').value.trim(),
      description: descField.value.slice(0, 80),
    };

    attemptActivation(payload, 5, btn, errorEl, statusEl);
  });
})();
</script>
</body>
</html>`;
}

function getFaqPageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FAQ — WhileYouSlept.lol | SaaS Revenue Tracker, MRR Leaderboard, Startups For Sale</title>
<meta name="description" content="Frequently asked questions about WhileYouSlept.lol — the daily SaaS revenue tracker powered by TrustMRR. Find the highest MRR startups, SaaS businesses for sale, and verified monthly recurring revenue data.">
<meta name="keywords" content="SaaS for sale, highest MRR, TrustMRR, monthly recurring revenue, buy SaaS business, startup revenue, MRR leaderboard, SaaS acquisition, indie hacker revenue, verified MRR">
<meta property="og:title" content="FAQ — WhileYouSlept.lol">
<meta property="og:description" content="Everything you need to know about the daily SaaS revenue tracker. Find startups for sale, verified MRR data, and the highest-earning SaaS businesses.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://whileyouslept.lol/faq">
<link rel="canonical" href="https://whileyouslept.lol/faq">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>💸</text></svg>">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #fafafa;
    color: #000;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    min-height: 100vh;
    padding: 0 20px;
  }
  .page {
    max-width: 720px;
    margin: 0 auto;
    padding: 48px 0 80px;
  }
  h1 {
    font-family: 'Arial Black', 'Helvetica Neue', Arial, sans-serif;
    font-size: 2rem;
    font-weight: 900;
    letter-spacing: -1px;
    text-transform: uppercase;
    margin-bottom: 8px;
  }
  .page-sub {
    font-size: 0.85rem;
    font-weight: 500;
    color: #666;
    margin-bottom: 40px;
    line-height: 1.5;
  }
  .page-sub a { color: #16a34a; font-weight: 700; text-decoration: none; }
  .page-sub a:hover { text-decoration: underline; }
  .faq-item {
    margin-bottom: 32px;
  }
  .faq-item h2 {
    font-size: 1rem;
    font-weight: 800;
    letter-spacing: -0.3px;
    margin-bottom: 8px;
    line-height: 1.3;
  }
  .faq-item p {
    font-size: 0.85rem;
    font-weight: 500;
    color: #444;
    line-height: 1.6;
  }
  .faq-item p a { color: #16a34a; font-weight: 700; text-decoration: none; }
  .faq-item p a:hover { text-decoration: underline; }
  .divider {
    border: none;
    border-top: 1px solid #eee;
    margin: 32px 0;
  }
  .back-link {
    display: inline-block;
    margin-top: 32px;
    font-size: 0.8rem;
    font-weight: 700;
    color: #999;
    text-decoration: none;
  }
  .back-link:hover { color: #000; text-decoration: underline; }
  @media (max-width: 600px) {
    .page { padding: 28px 0 60px; }
    h1 { font-size: 1.5rem; }
    .faq-item h2 { font-size: 0.92rem; }
    .faq-item p { font-size: 0.8rem; }
  }
</style>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What is WhileYouSlept.lol?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "WhileYouSlept.lol is a daily revenue tracker that shows how much money SaaS startups are making every day. It pulls verified MRR (Monthly Recurring Revenue) data from TrustMRR and highlights the latest revenue milestones, acquisitions, and growth numbers shared by founders on X (Twitter)."
      }
    },
    {
      "@type": "Question",
      "name": "What is TrustMRR and how is revenue verified?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "TrustMRR is a platform where SaaS founders verify their monthly recurring revenue by connecting their Stripe or payment processor. WhileYouSlept.lol uses TrustMRR as its data source, so all MRR figures shown on the site are verified, not self-reported."
      }
    },
    {
      "@type": "Question",
      "name": "How do I find SaaS businesses for sale?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Startups listed for sale on TrustMRR are marked with a 'For Sale' badge on WhileYouSlept.lol. You can spot them in the feed and in the featured section at the top of the page. Click through to TrustMRR for details on asking price, verified revenue, and how to make an offer."
      }
    },
    {
      "@type": "Question",
      "name": "Which startups have the highest MRR?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "WhileYouSlept.lol ranks all startups by daily revenue (MRR divided by 30). The top earners appear first in the feed. Cards expand on hover to show monthly MRR, 30-day growth percentage, and verified status. You can also browse the full leaderboard on TrustMRR.com."
      }
    },
    {
      "@type": "Question",
      "name": "What does MRR mean?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "MRR stands for Monthly Recurring Revenue — the predictable income a SaaS business earns every month from subscriptions. It is the most common metric for valuing and comparing subscription-based software businesses. ARR (Annual Recurring Revenue) is MRR multiplied by 12."
      }
    },
    {
      "@type": "Question",
      "name": "How often is the data updated?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Startup revenue data is synced from TrustMRR daily at midnight Eastern Time. Founder tweets are scanned hourly for the latest revenue milestones, acquisition announcements, and growth updates."
      }
    },
    {
      "@type": "Question",
      "name": "Can I buy a SaaS business through this site?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "WhileYouSlept.lol is a discovery tool — it helps you find SaaS businesses for sale with verified revenue. Startups marked 'For Sale' link directly to their TrustMRR profile where you can see the asking price, revenue history, and contact the founder to negotiate a deal."
      }
    },
    {
      "@type": "Question",
      "name": "How can I advertise my SaaS on WhileYouSlept.lol?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Click 'Advertise' in the header or footer to get a featured card at the top of the page for $49/week. Your startup will be shown to hundreds of founders, indie hackers, and SaaS buyers who visit daily. Payment is handled securely through Stripe."
      }
    },
    {
      "@type": "Question",
      "name": "How is this different from other SaaS marketplaces?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Unlike marketplaces like Acquire.com or MicroAcquire, WhileYouSlept.lol is not a marketplace — it is a real-time revenue feed. It combines verified MRR data from TrustMRR with live founder tweets to show what is actually happening in the SaaS world right now. Think of it as a daily scoreboard for SaaS founders."
      }
    },
    {
      "@type": "Question",
      "name": "What SaaS revenue milestones are tracked?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "The feed highlights three types of milestones: MRR/ARR updates (e.g. hitting $10K MRR), SaaS acquisitions and exits (companies sold for a specific amount), and monthly revenue reports shared by founders. Only tweets with real dollar amounts are included — goals, advice, and speculation are filtered out."
      }
    }
  ]
}
</script>
</head>
<body>
<div class="page">
  <h1>Frequently Asked Questions</h1>
  <p class="page-sub">Everything you need to know about <a href="/">WhileYouSlept.lol</a> — the daily SaaS revenue tracker powered by <a href="https://trustmrr.com" target="_blank" rel="noopener">TrustMRR</a>.</p>

  <div class="faq-item">
    <h2>What is WhileYouSlept.lol?</h2>
    <p>WhileYouSlept.lol is a daily revenue tracker that shows how much money SaaS startups are making every day. It pulls verified MRR (Monthly Recurring Revenue) data from <a href="https://trustmrr.com" target="_blank" rel="noopener">TrustMRR</a> and highlights the latest revenue milestones, acquisitions, and growth numbers shared by founders on X (Twitter).</p>
  </div>

  <hr class="divider">

  <div class="faq-item">
    <h2>What is TrustMRR and how is revenue verified?</h2>
    <p>TrustMRR is a platform where SaaS founders verify their monthly recurring revenue by connecting their Stripe or payment processor. WhileYouSlept.lol uses TrustMRR as its data source, so all MRR figures shown on the site are verified — not self-reported.</p>
  </div>

  <hr class="divider">

  <div class="faq-item">
    <h2>How do I find SaaS businesses for sale?</h2>
    <p>Startups listed for sale on TrustMRR are marked with a <strong>"For Sale"</strong> badge on WhileYouSlept.lol. You can spot them in the feed and in the featured section at the top of the page. Click through to TrustMRR for details on asking price, verified revenue, and how to make an offer.</p>
  </div>

  <hr class="divider">

  <div class="faq-item">
    <h2>Which startups have the highest MRR?</h2>
    <p>WhileYouSlept.lol ranks all startups by daily revenue (MRR divided by 30). The top earners appear first in the feed. Cards expand on hover to show monthly MRR, 30-day growth percentage, and verified status. You can also browse the full leaderboard on <a href="https://trustmrr.com" target="_blank" rel="noopener">TrustMRR.com</a>.</p>
  </div>

  <hr class="divider">

  <div class="faq-item">
    <h2>What does MRR mean?</h2>
    <p>MRR stands for Monthly Recurring Revenue — the predictable income a SaaS business earns every month from subscriptions. It is the most common metric for valuing and comparing subscription-based software businesses. ARR (Annual Recurring Revenue) is MRR multiplied by 12.</p>
  </div>

  <hr class="divider">

  <div class="faq-item">
    <h2>How often is the data updated?</h2>
    <p>Startup revenue data is synced from TrustMRR daily at midnight Eastern Time. Founder tweets are scanned hourly for the latest revenue milestones, acquisition announcements, and growth updates.</p>
  </div>

  <hr class="divider">

  <div class="faq-item">
    <h2>Can I buy a SaaS business through this site?</h2>
    <p>WhileYouSlept.lol is a discovery tool — it helps you find SaaS businesses for sale with verified revenue. Startups marked "For Sale" link directly to their TrustMRR profile where you can see the asking price, revenue history, and contact the founder to negotiate a deal.</p>
  </div>

  <hr class="divider">

  <div class="faq-item">
    <h2>How can I advertise my SaaS here?</h2>
    <p>Click <strong>"Advertise"</strong> on the <a href="/">homepage</a> to get a featured card at the top of the page for $49/week. Your startup will be shown to hundreds of founders, indie hackers, and SaaS buyers who visit daily. Payment is handled securely through Stripe.</p>
  </div>

  <hr class="divider">

  <div class="faq-item">
    <h2>How is this different from other SaaS marketplaces?</h2>
    <p>Unlike marketplaces like Acquire.com or MicroAcquire, WhileYouSlept.lol is not a marketplace — it is a real-time revenue feed. It combines verified MRR data from TrustMRR with live founder tweets to show what is actually happening in the SaaS world right now. Think of it as a daily scoreboard for SaaS founders.</p>
  </div>

  <hr class="divider">

  <div class="faq-item">
    <h2>What SaaS revenue milestones are tracked?</h2>
    <p>The feed highlights three types of milestones: MRR/ARR updates (e.g. hitting $10K MRR), SaaS acquisitions and exits (companies sold for a specific amount), and monthly revenue reports shared by founders. Only tweets with real dollar amounts are included — goals, advice, and speculation are filtered out.</p>
  </div>

  <a href="/" class="back-link">&larr; Back to WhileYouSlept.lol</a>
</div>
</body>
</html>`;
}

function getDevLoginHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Login — WhileYouSlept.lol</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #fafafa;
    color: #000;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .login-box {
    background: #fff;
    border: 1px solid #eee;
    border-radius: 12px;
    padding: 36px;
    max-width: 360px;
    width: 90%;
    text-align: center;
  }
  .login-box h1 {
    font-family: 'Arial Black', 'Helvetica Neue', Arial, sans-serif;
    font-size: 1.2rem;
    font-weight: 900;
    letter-spacing: -0.5px;
    margin-bottom: 4px;
  }
  .login-box p {
    font-size: 0.75rem;
    color: #999;
    margin-bottom: 20px;
  }
  .login-box input {
    width: 100%;
    padding: 10px 14px;
    font-size: 0.85rem;
    font-family: inherit;
    border: 1px solid #ddd;
    border-radius: 8px;
    outline: none;
    margin-bottom: 12px;
    transition: border-color 0.15s;
  }
  .login-box input:focus { border-color: #000; }
  .login-box button {
    width: 100%;
    padding: 10px 14px;
    font-size: 0.8rem;
    font-weight: 700;
    font-family: inherit;
    background: #000;
    color: #fff;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.15s;
  }
  .login-box button:hover { background: #222; }
  .error-msg {
    font-size: 0.72rem;
    color: #dc2626;
    margin-top: 10px;
    display: none;
  }
</style>
</head>
<body>
<div class="login-box">
  <h1>Dev Panel</h1>
  <p>Enter password to continue</p>
  <form id="loginForm">
    <input type="password" id="pwd" placeholder="Password" autocomplete="current-password" autofocus>
    <button type="submit">Log in</button>
  </form>
  <div class="error-msg" id="err">Incorrect password</div>
</div>
<script>
document.getElementById('loginForm').addEventListener('submit', function(e) {
  e.preventDefault();
  var pwd = document.getElementById('pwd').value.trim();
  if (!pwd) return;
  // Redirect with secret param — server will validate
  window.location.href = '/dev?secret=' + encodeURIComponent(pwd);
});
// Show error if we came back from a failed attempt (secret was in URL but wrong)
if (window.location.search.includes('secret=')) {
  document.getElementById('err').style.display = 'block';
}
</script>
</body>
</html>`;
}

function getDevDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ad Slots — WhileYouSlept.lol</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #fafafa;
    color: #000;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    min-height: 100vh;
    padding: 40px 20px;
  }
  .container {
    max-width: 960px;
    margin: 0 auto;
  }
  h1 {
    font-family: 'Arial Black', 'Helvetica Neue', Arial, sans-serif;
    font-size: 1.4rem;
    font-weight: 900;
    letter-spacing: -0.5px;
    margin-bottom: 6px;
  }
  .subtitle {
    font-size: 0.8rem;
    color: #666;
    margin-bottom: 24px;
  }
  .summary {
    display: flex;
    gap: 24px;
    margin-bottom: 24px;
    flex-wrap: wrap;
  }
  .summary-stat {
    background: #fff;
    border: 1px solid #eee;
    border-radius: 8px;
    padding: 16px 20px;
    min-width: 120px;
  }
  .summary-stat .val {
    font-size: 1.3rem;
    font-weight: 800;
    letter-spacing: -0.5px;
  }
  .summary-stat .lbl {
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #999;
    margin-top: 2px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    background: #fff;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid #eee;
  }
  th {
    text-align: left;
    padding: 10px 14px;
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: #999;
    background: #fafafa;
    border-bottom: 1px solid #eee;
  }
  td {
    padding: 10px 14px;
    font-size: 0.8rem;
    font-weight: 500;
    border-bottom: 1px solid #f5f5f5;
    vertical-align: top;
  }
  tr:last-child td { border-bottom: none; }
  tr.active td { background: #f0fdf4; }
  tr.expired td { color: #aaa; }
  .badge {
    display: inline-block;
    font-size: 0.6rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .badge.active { background: #dcfce7; color: #16a34a; }
  .badge.expired { background: #f3f4f6; color: #9ca3af; }
  .desc-cell {
    max-width: 180px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.72rem;
    color: #666;
  }
  .back-link {
    display: inline-block;
    margin-top: 20px;
    font-size: 0.75rem;
    font-weight: 600;
    color: #999;
    text-decoration: none;
  }
  .back-link:hover { color: #000; text-decoration: underline; }
  .loading-msg {
    padding: 40px;
    text-align: center;
    font-size: 0.85rem;
    color: #999;
  }
</style>
</head>
<body>
<div class="container">
  <h1>Ad Slots</h1>
  <p class="subtitle">WhileYouSlept.lol — featured ad slots overview</p>

  <div class="summary" id="summary"></div>
  <div id="tableWrap"><div class="loading-msg">Loading...</div></div>
  <a href="/" class="back-link">&larr; Back to homepage</a>
</div>

<script>
(function() {
  fetch('/api/dev/ads')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var slots = data.slots || [];
      var activeCount = slots.filter(function(s) { return s.active; }).length;
      var expiredCount = slots.length - activeCount;
      var revenue = activeCount * 49;

      var summaryEl = document.getElementById('summary');
      summaryEl.innerHTML =
        '<div class="summary-stat"><div class="val">' + slots.length + '</div><div class="lbl">Total Slots</div></div>' +
        '<div class="summary-stat"><div class="val">' + activeCount + '</div><div class="lbl">Active</div></div>' +
        '<div class="summary-stat"><div class="val">' + expiredCount + '</div><div class="lbl">Expired</div></div>' +
        '<div class="summary-stat"><div class="val">$' + revenue + '</div><div class="lbl">Weekly Revenue</div></div>';

      if (!slots.length) {
        document.getElementById('tableWrap').innerHTML = '<div class="loading-msg">No ad slots yet.</div>';
        return;
      }

      var html = '<table><thead><tr>' +
        '<th>SaaS Name</th><th>Handle</th><th>Description</th><th>URL</th><th>Started</th><th>Expires</th><th>Status</th>' +
        '</tr></thead><tbody>';

      for (var i = 0; i < slots.length; i++) {
        var s = slots[i];
        var cls = s.active ? 'active' : 'expired';
        var started = s.startedAt ? new Date(s.startedAt).toLocaleDateString() : '—';
        var expires = s.expiresAt ? new Date(s.expiresAt).toLocaleDateString() : '—';
        var urlDisplay = s.url ? '<a href="' + s.url.replace(/"/g, '&quot;') + '" target="_blank" style="color:#16a34a;text-decoration:none;font-size:0.72rem;">Link</a>' : '—';
        html += '<tr class="' + cls + '">' +
          '<td><strong>' + (s.saasName || '—') + '</strong></td>' +
          '<td>@' + (s.handle || '—') + '</td>' +
          '<td class="desc-cell" title="' + (s.description || '').replace(/"/g, '&quot;') + '">' + (s.description || '—') + '</td>' +
          '<td>' + urlDisplay + '</td>' +
          '<td>' + started + '</td>' +
          '<td>' + expires + '</td>' +
          '<td><span class="badge ' + cls + '">' + (s.active ? 'Active' : 'Expired') + '</span></td>' +
          '</tr>';
      }

      html += '</tbody></table>';
      document.getElementById('tableWrap').innerHTML = html;
    })
    .catch(function() {
      document.getElementById('tableWrap').innerHTML = '<div class="loading-msg">Failed to load data.</div>';
    });
})();
</script>
</body>
</html>`;
}

function getAdminDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Admin — WhileYouSlept.lol</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0a0a0a;
    color: #e0e0e0;
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 13px;
    min-height: 100vh;
    padding: 24px;
  }
  h1 {
    font-size: 1.3rem;
    font-weight: 800;
    letter-spacing: -0.5px;
    color: #fff;
    margin-bottom: 4px;
  }
  .subtitle { color: #666; font-size: 0.75rem; margin-bottom: 20px; }
  .stats-bar {
    display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 24px;
  }
  .stat-box {
    background: #141414; border: 1px solid #222; border-radius: 8px;
    padding: 14px 18px; min-width: 110px;
  }
  .stat-box .val { font-size: 1.4rem; font-weight: 800; color: #fff; }
  .stat-box .lbl { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.5px; color: #666; margin-top: 2px; }
  .section { margin-bottom: 28px; }
  .section h2 {
    font-size: 0.75rem; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.5px; color: #888; margin-bottom: 10px;
    border-bottom: 1px solid #222; padding-bottom: 6px;
  }
  table { width: 100%; border-collapse: collapse; background: #111; border: 1px solid #222; border-radius: 8px; overflow: hidden; }
  th {
    text-align: left; padding: 8px 12px; font-size: 0.6rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.5px; color: #555;
    background: #0d0d0d; border-bottom: 1px solid #222;
  }
  td { padding: 8px 12px; font-size: 0.78rem; border-bottom: 1px solid #1a1a1a; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #1a1a1a; }
  .badge {
    display: inline-block; font-size: 0.55rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.5px;
    padding: 2px 6px; border-radius: 4px;
  }
  .badge.active { background: #052e16; color: #4ade80; }
  .badge.pending { background: #422006; color: #fbbf24; }
  .badge.expired { background: #1a1a1a; color: #666; }
  .btn {
    padding: 4px 10px; font-size: 0.65rem; font-weight: 700;
    font-family: inherit; border: 1px solid #333; border-radius: 4px;
    cursor: pointer; background: #1a1a1a; color: #ccc;
    transition: all 0.15s;
  }
  .btn:hover { background: #222; color: #fff; border-color: #555; }
  .btn.green { border-color: #16a34a; color: #4ade80; }
  .btn.green:hover { background: #052e16; }
  .btn.red { border-color: #991b1b; color: #f87171; }
  .btn.red:hover { background: #1c0a0a; }
  .empty { padding: 20px; text-align: center; color: #444; font-style: italic; }
  .handle { color: #60a5fa; }
  .truncate { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .toast {
    position: fixed; bottom: 24px; right: 24px; background: #16a34a; color: #fff;
    padding: 10px 18px; border-radius: 6px; font-weight: 700; font-size: 0.75rem;
    display: none; z-index: 999;
  }
  .toast.error { background: #991b1b; }
  @media (max-width: 768px) {
    body { padding: 12px; }
    table { font-size: 0.7rem; }
    .stats-bar { gap: 8px; }
    .stat-box { padding: 10px 12px; min-width: 80px; }
  }
</style>
</head>
<body>
<h1>Admin Dashboard</h1>
<p class="subtitle">WhileYouSlept.lol — ad management &nbsp;|&nbsp; <a href="/admin/traffic?secret=` + encodeURIComponent(process.env.ADMIN_SECRET || '') + `" style="color:#60a5fa;text-decoration:none;">Traffic Analytics &rarr;</a></p>

<div class="stats-bar" id="statsBar"></div>

<div class="section">
  <h2>Active Ads</h2>
  <div id="activeTable"><div class="empty">Loading...</div></div>
</div>

<div class="section">
  <h2>Pending Payments</h2>
  <div id="pendingTable"><div class="empty">Loading...</div></div>
</div>

<div class="section">
  <h2>Expired Ads</h2>
  <div id="expiredTable"><div class="empty">Loading...</div></div>
</div>

<div class="toast" id="toast"></div>

<script>
(function() {
  var secret = new URLSearchParams(window.location.search).get('secret') || '';

  function toast(msg, isError) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast' + (isError ? ' error' : '');
    el.style.display = 'block';
    setTimeout(function() { el.style.display = 'none'; }, 3000);
  }

  function apiCall(method, path, body) {
    var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (body) {
      body.secret = secret;
      opts.body = JSON.stringify(body);
    }
    return fetch(path + (method === 'DELETE' ? '?secret=' + encodeURIComponent(secret) : ''), opts)
      .then(function(r) { return r.json(); });
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  }

  function daysLeft(expiresAt) {
    var ms = new Date(expiresAt) - Date.now();
    if (ms <= 0) return 'expired';
    var d = Math.ceil(ms / 86400000);
    return d + 'd left';
  }

  function load() {
    fetch('/api/admin/dashboard?secret=' + encodeURIComponent(secret))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.error) { toast(data.error, true); return; }

        var s = data.stats || {};
        document.getElementById('statsBar').innerHTML =
          '<div class="stat-box"><div class="val">' + (s.activeCount || 0) + '</div><div class="lbl">Active</div></div>' +
          '<div class="stat-box"><div class="val">' + (s.pendingCount || 0) + '</div><div class="lbl">Pending</div></div>' +
          '<div class="stat-box"><div class="val">' + (s.expiredCount || 0) + '</div><div class="lbl">Expired</div></div>' +
          '<div class="stat-box"><div class="val">$' + (s.weeklyRevenue || 0) + '</div><div class="lbl">Weekly Rev</div></div>' +
          '<div class="stat-box"><div class="val">$' + (s.totalRevenue || 0) + '</div><div class="lbl">Total Rev</div></div>' +
          '<div class="stat-box"><div class="val">' + (s.startupCount || 0) + '</div><div class="lbl">Startups</div></div>';

        // Active table
        var active = data.active || [];
        if (!active.length) {
          document.getElementById('activeTable').innerHTML = '<div class="empty">No active ads</div>';
        } else {
          var h = '<table><tr><th>SaaS</th><th>Handle</th><th>Desc</th><th>Started</th><th>Expires</th><th>Status</th><th>Actions</th></tr>';
          for (var i = 0; i < active.length; i++) {
            var a = active[i];
            h += '<tr><td><strong>' + (a.saasName || '—') + '</strong></td>' +
              '<td class="handle">@' + a.handle + '</td>' +
              '<td class="truncate" title="' + (a.description || '').replace(/"/g, '&quot;') + '">' + (a.description || '—') + '</td>' +
              '<td>' + fmtDate(a.startedAt) + '</td>' +
              '<td>' + fmtDate(a.expiresAt) + ' <small>(' + daysLeft(a.expiresAt) + ')</small></td>' +
              '<td><span class="badge active">Active</span></td>' +
              '<td><button class="btn green" onclick="extendAd(\\''+a.id+'\\')">+7d</button> ' +
              '<button class="btn red" onclick="deleteAd(\\''+a.id+'\\')">Delete</button></td></tr>';
          }
          h += '</table>';
          document.getElementById('activeTable').innerHTML = h;
        }

        // Pending table
        var pending = data.pending || [];
        if (!pending.length) {
          document.getElementById('pendingTable').innerHTML = '<div class="empty">No pending payments</div>';
        } else {
          var h2 = '<table><tr><th>Handle</th><th>SaaS</th><th>Paid At</th><th>Email</th><th>Actions</th></tr>';
          for (var j = 0; j < pending.length; j++) {
            var p = pending[j];
            h2 += '<tr><td class="handle">@' + p.handle + '</td>' +
              '<td>' + (p.saasName || '—') + '</td>' +
              '<td>' + fmtDate(p.paidAt) + '</td>' +
              '<td>' + (p.email || '—') + '</td>' +
              '<td><button class="btn green" onclick="activatePending(\\''+p.handle+'\\')">Activate</button> ' +
              '<button class="btn red" onclick="deletePending(\\''+p.handle.toLowerCase()+'\\')">Delete</button></td></tr>';
          }
          h2 += '</table>';
          document.getElementById('pendingTable').innerHTML = h2;
        }

        // Expired table
        var expired = data.expired || [];
        if (!expired.length) {
          document.getElementById('expiredTable').innerHTML = '<div class="empty">No expired ads yet</div>';
        } else {
          var h3 = '<table><tr><th>SaaS</th><th>Handle</th><th>Started</th><th>Expired</th></tr>';
          for (var k = 0; k < expired.length; k++) {
            var e = expired[k];
            h3 += '<tr><td>' + (e.saasName || '—') + '</td>' +
              '<td class="handle">@' + (e.handle || '—') + '</td>' +
              '<td>' + fmtDate(e.startedAt) + '</td>' +
              '<td>' + fmtDate(e.expiredAt || e.expiresAt) + '</td></tr>';
          }
          h3 += '</table>';
          document.getElementById('expiredTable').innerHTML = h3;
        }
      })
      .catch(function(err) { toast('Failed to load: ' + err.message, true); });
  }

  window.extendAd = function(id) {
    apiCall('POST', '/api/admin/ads/extend', { id: id })
      .then(function(r) { if (r.ok) { toast('Extended +7 days'); load(); } else { toast(r.error || 'Failed', true); } })
      .catch(function() { toast('Network error', true); });
  };

  window.deleteAd = function(id) {
    if (!confirm('Delete this ad?')) return;
    fetch('/api/admin/ads/' + id + '?secret=' + encodeURIComponent(secret), { method: 'DELETE' })
      .then(function(r) { return r.json(); })
      .then(function(r) { if (r.ok) { toast('Ad deleted'); load(); } else { toast(r.error || 'Failed', true); } })
      .catch(function() { toast('Network error', true); });
  };

  window.activatePending = function(handle) {
    apiCall('POST', '/api/admin/pending/activate', { handle: handle })
      .then(function(r) { if (r.ok) { toast('Ad activated'); load(); } else { toast(r.error || 'Failed', true); } })
      .catch(function() { toast('Network error', true); });
  };

  window.deletePending = function(handle) {
    if (!confirm('Delete pending ad for @' + handle + '?')) return;
    fetch('/api/admin/pending/' + encodeURIComponent(handle) + '?secret=' + encodeURIComponent(secret), { method: 'DELETE' })
      .then(function(r) { return r.json(); })
      .then(function(r) { if (r.ok) { toast('Pending deleted'); load(); } else { toast(r.error || 'Failed', true); } })
      .catch(function() { toast('Network error', true); });
  };

  load();
})();
</script>
</body>
</html>`;
}

function getTrafficDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Traffic Analytics — WhileYouSlept.lol</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0a0a0a;
    color: #e0e0e0;
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 13px;
    min-height: 100vh;
    padding: 24px;
  }
  h1 {
    font-size: 1.3rem;
    font-weight: 800;
    letter-spacing: -0.5px;
    color: #fff;
    margin-bottom: 4px;
  }
  .subtitle { color: #666; font-size: 0.75rem; margin-bottom: 20px; }
  .subtitle a { color: #60a5fa; text-decoration: none; }
  .subtitle a:hover { text-decoration: underline; }
  .period-bar {
    display: flex; gap: 8px; margin-bottom: 20px;
  }
  .period-btn {
    padding: 4px 12px; font-size: 0.7rem; font-weight: 700;
    font-family: inherit; border: 1px solid #333; border-radius: 4px;
    cursor: pointer; background: #1a1a1a; color: #888;
    transition: all 0.15s;
  }
  .period-btn:hover { background: #222; color: #fff; border-color: #555; }
  .period-btn.active { background: #16a34a; color: #fff; border-color: #16a34a; }
  .stats-bar {
    display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 24px;
  }
  .stat-box {
    background: #141414; border: 1px solid #222; border-radius: 8px;
    padding: 14px 18px; min-width: 110px;
  }
  .stat-box .val { font-size: 1.4rem; font-weight: 800; color: #fff; }
  .stat-box .lbl { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.5px; color: #666; margin-top: 2px; }
  .section { margin-bottom: 28px; }
  .section h2 {
    font-size: 0.75rem; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.5px; color: #888; margin-bottom: 10px;
    border-bottom: 1px solid #222; padding-bottom: 6px;
  }
  table { width: 100%; border-collapse: collapse; background: #111; border: 1px solid #222; border-radius: 8px; overflow: hidden; }
  th {
    text-align: left; padding: 8px 12px; font-size: 0.6rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.5px; color: #555;
    background: #0d0d0d; border-bottom: 1px solid #222;
  }
  td { padding: 8px 12px; font-size: 0.78rem; border-bottom: 1px solid #1a1a1a; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #1a1a1a; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .empty { padding: 20px; text-align: center; color: #444; font-style: italic; }
  @media (max-width: 768px) {
    body { padding: 12px; }
    table { font-size: 0.7rem; }
    .stats-bar { gap: 8px; }
    .stat-box { padding: 10px 12px; min-width: 80px; }
    .grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<h1>Traffic Analytics</h1>
<p class="subtitle">WhileYouSlept.lol — visitor insights &nbsp;|&nbsp; <a href="/admin?secret=` + encodeURIComponent(process.env.ADMIN_SECRET || '') + `">Ad Dashboard &rarr;</a></p>

<div class="period-bar" id="periodBar">
  <button class="period-btn" data-days="1">1d</button>
  <button class="period-btn active" data-days="7">7d</button>
  <button class="period-btn" data-days="14">14d</button>
  <button class="period-btn" data-days="30">30d</button>
</div>

<div class="stats-bar" id="statsBar">
  <div class="stat-box"><div class="val" id="sSessions">-</div><div class="lbl">Sessions</div></div>
  <div class="stat-box"><div class="val" id="sUnique">-</div><div class="lbl">Unique Visitors</div></div>
  <div class="stat-box"><div class="val" id="sBounce">-</div><div class="lbl">Bounce Rate</div></div>
  <div class="stat-box"><div class="val" id="sDuration">-</div><div class="lbl">Avg Duration</div></div>
</div>

<div class="grid">
  <div class="section"><h2>By Source</h2><div id="tSource"><div class="empty">Loading...</div></div></div>
  <div class="section"><h2>By Device</h2><div id="tDevice"><div class="empty">Loading...</div></div></div>
  <div class="section"><h2>By Country</h2><div id="tCountry"><div class="empty">Loading...</div></div></div>
  <div class="section"><h2>By Browser</h2><div id="tBrowser"><div class="empty">Loading...</div></div></div>
</div>

<div class="section"><h2>By Day</h2><div id="tDay"><div class="empty">Loading...</div></div></div>
<div class="section"><h2>Recent Sessions (last 20)</h2><div id="tRecent"><div class="empty">Loading...</div></div></div>

<script>
(function() {
  var secret = new URLSearchParams(window.location.search).get('secret') || '';
  var currentDays = 7;

  function fmtDur(s) {
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60); s = s % 60;
    return m + 'm ' + s + 's';
  }

  function makeTable(headers, rows) {
    if (!rows.length) return '<div class="empty">No data</div>';
    var h = '<table><tr>' + headers.map(function(x) { return '<th>' + x + '</th>'; }).join('') + '</tr>';
    h += rows.map(function(r) {
      return '<tr>' + r.map(function(c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
    }).join('');
    return h + '</table>';
  }

  function load() {
    fetch('/api/admin/traffic?secret=' + encodeURIComponent(secret) + '&days=' + currentDays)
      .then(function(r) { return r.json(); })
      .then(function(d) {
        document.getElementById('sSessions').textContent = d.total;
        document.getElementById('sUnique').textContent = d.unique;
        document.getElementById('sBounce').textContent = d.bounceRate + '%';
        document.getElementById('sDuration').textContent = fmtDur(d.avgDuration);

        document.getElementById('tSource').innerHTML = makeTable(['Source', 'Sessions'],
          d.bySource.map(function(x) { return [x.name, x.count]; }));
        document.getElementById('tDevice').innerHTML = makeTable(['Device', 'Sessions'],
          d.byDevice.map(function(x) { return [x.name, x.count]; }));
        document.getElementById('tCountry').innerHTML = makeTable(['Country', 'Sessions'],
          d.byCountry.map(function(x) { return [x.name, x.count]; }));
        document.getElementById('tBrowser').innerHTML = makeTable(['Browser', 'Sessions'],
          d.byBrowser.map(function(x) { return [x.name, x.count]; }));
        document.getElementById('tDay').innerHTML = makeTable(['Date', 'Sessions'],
          d.byDay.map(function(x) { return [x.date, x.count]; }));

        document.getElementById('tRecent').innerHTML = makeTable(
          ['Time', 'Source', 'Device', 'Country', 'Duration', 'Scroll', 'Bounce'],
          d.recent.map(function(s) {
            var t = new Date(s.createdAt);
            var time = t.toLocaleDateString() + ' ' + t.toLocaleTimeString();
            return [time, s.source, s.device, s.country, fmtDur(s.duration), s.scroll_depth + '%', s.bounce ? 'Yes' : 'No'];
          })
        );
      })
      .catch(function(e) { console.error('Traffic load error:', e); });
  }

  document.getElementById('periodBar').addEventListener('click', function(e) {
    if (e.target.classList.contains('period-btn')) {
      currentDays = parseInt(e.target.dataset.days);
      document.querySelectorAll('.period-btn').forEach(function(b) { b.classList.remove('active'); });
      e.target.classList.add('active');
      load();
    }
  });

  load();
})();
</script>
</body>
</html>`;
}

/* ── HTTP server ────────────────────────────────────────── */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Health check
  if (url.pathname === '/health') {
    return sendJson(req, res, 200, {
      status: 'ok',
      startups: trustmrrStartups.length,
      tweetsLoaded: latestTweets.size,
      scanning: scanInProgress,
    });
  }

  // Checkout — redirect to Stripe with handle
  if (url.pathname === '/api/checkout') {
    const handle = (url.searchParams.get('handle') || '').replace(/^@/, '').trim();
    const saas = (url.searchParams.get('saas') || '').trim();
    if (!handle) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Missing handle');
    }
    const stripeLink = process.env.STRIPE_LINK;
    if (!stripeLink) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('Checkout not configured');
    }
    const sep = stripeLink.includes('?') ? '&' : '?';
    const refId = saas ? `${handle}|${saas}` : handle;
    const dest = `${stripeLink}${sep}client_reference_id=${encodeURIComponent(refId)}`;
    res.writeHead(302, { Location: dest });
    return res.end();
  }

  // Stripe webhook
  if (url.pathname === '/api/stripe/webhook' && req.method === 'POST') {
    let body = '';
    req.on('data', function(c) { body += c; if (body.length > 65536) { req.destroy(); } });
    req.on('end', function() {
      const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
      const sigHeader = req.headers['stripe-signature'] || '';
      if (!STRIPE_WEBHOOK_SECRET || !verifyStripeSignature(body, sigHeader, STRIPE_WEBHOOK_SECRET)) {
        console.log('[stripe] Webhook signature verification failed');
        res.writeHead(400);
        return res.end('Invalid signature');
      }
      try {
        const event = JSON.parse(body);
        if (event.type === 'checkout.session.completed') {
          const session = event.data && event.data.object;
          const refId = session && session.client_reference_id;
          if (refId) {
            const parts = refId.split('|');
            const handle = parts[0].replace(/^@/, '').trim();
            const saasName = parts[1] || '';
            const key = handle.toLowerCase();
            const email = (session.customer_details && session.customer_details.email) || '';
            pendingAds.set(key, {
              handle,
              saasName,
              paidAt: new Date().toISOString(),
              sessionId: session.id || null,
              email: email || null,
            });
            savePendingAds();
            console.log(`[stripe] Payment recorded for @${handle} (${saasName})`);
            sendPaymentEmail(email, handle, saasName);
          }
        }
        res.writeHead(200);
        res.end('ok');
      } catch (e) {
        console.error('[stripe] Webhook parse error:', e.message);
        res.writeHead(400);
        res.end('Invalid JSON');
      }
    });
    return;
  }

  // Feed API — serves TrustMRR startup data + optional tweets
  if (url.pathname === '/api/feed') {
    if (sendCachedFeed(req, res)) return;

    // Nothing cached yet — build fresh
    if (trustmrrStartups.length) {
      setMemoryCache();
      return sendCachedFeed(req, res);
    }

    // No data yet — first sync in progress
    return sendJson(req, res, 200, {
      startups: [],
      ads: getAdsForFeed(),
      totalDailyRevenue: 0,
      totalMRR: 0,
      startupCount: 0,
      lastSync: null,
      scanning: scanInProgress,
    });
  }

  // ── History API ──────────────────────────────────────
  if (url.pathname === '/api/history') {
    const days = Math.min(Math.max(parseInt(url.searchParams.get('days')) || 7, 1), 30);
    try {
      const history = await getDailyHistory(days);
      return sendJson(req, res, 200, { history });
    } catch (e) {
      return sendJson(req, res, 500, { error: 'Failed to load history' });
    }
  }

  // ── Admin ad slot API ─────────────────────────────────
  const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

  if (url.pathname === '/api/admin/ads' && req.method === 'POST') {
    let body = '';
    req.on('data', function(c) { body += c; });
    req.on('end', function() {
      try {
        var d = JSON.parse(body);
        if (!ADMIN_SECRET || d.secret !== ADMIN_SECRET) return sendJson(req, res, 401, { error: 'Unauthorized' });
        if (!d.zone || !d.handle || !d.saasName) return sendJson(req, res, 400, { error: 'Missing required fields' });
        var id = Math.random().toString(36).slice(2, 8);
        var weeks = parseInt(d.weeks) || 1;
        var now = new Date();
        var expires = new Date(now.getTime() + weeks * 7 * 24 * 60 * 60 * 1000);
        var desc = (d.description || '').slice(0, 80);
        var slot = {
          id: id,
          zone: d.zone === 'feed' ? 'feed' : 'top',
          handle: d.handle,
          saasName: d.saasName,
          description: desc,
          avatar: d.avatar || null,
          mrr: d.mrr || '',
          askPrice: d.askPrice || '',
          url: d.url || '',
          slug: d.slug || null,
          startedAt: now.toISOString(),
          expiresAt: expires.toISOString(),
        };
        adSlots.push(slot);
        saveAdSlots();
        setMemoryCache();
        return sendJson(req, res, 200, { ok: true, slot: slot });
      } catch (e) {
        return sendJson(req, res, 400, { error: 'Invalid JSON' });
      }
    });
    return;
  }

  if (url.pathname === '/api/admin/ads' && req.method === 'GET') {
    var secret = url.searchParams.get('secret');
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) return sendJson(req, res, 401, { error: 'Unauthorized' });
    var now = new Date().toISOString();
    var all = adSlots.map(function(a) {
      return Object.assign({}, a, { active: a.expiresAt > now });
    });
    return sendJson(req, res, 200, { slots: all });
  }

  if (url.pathname.startsWith('/api/admin/ads/') && req.method === 'DELETE') {
    var secret = url.searchParams.get('secret');
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) return sendJson(req, res, 401, { error: 'Unauthorized' });
    var adId = url.pathname.split('/').pop();
    var before = adSlots.length;
    adSlots = adSlots.filter(function(a) { return a.id !== adId; });
    if (adSlots.length < before) {
      saveAdSlots();
      setMemoryCache();
      return sendJson(req, res, 200, { ok: true, deleted: adId });
    }
    return sendJson(req, res, 404, { error: 'Not found' });
  }

  // ── Self-service ad activation (gated behind payment) ────
  if (url.pathname === '/api/ad/activate' && req.method === 'POST') {
    let body = '';
    req.on('data', function(c) { body += c; if (body.length > 4096) { req.destroy(); } });
    req.on('end', async function() {
      try {
        var d = JSON.parse(body);
        var handle = (d.handle || '').replace(/^@/, '').trim();
        var saasName = (d.saasName || '').trim();
        var trustmrrUrl = (d.trustmrrUrl || '').trim();
        var description = (d.description || '').slice(0, 80);

        if (!handle) return sendJson(req, res, 400, { error: 'Missing handle' });
        if (!saasName) return sendJson(req, res, 400, { error: 'Missing saasName' });
        if (description.length > 80) return sendJson(req, res, 400, { error: 'Description must be 80 chars or less' });

        // Verify payment exists
        var key = handle.toLowerCase();
        var payment = pendingAds.get(key);

        // Stripe API fallback: if webhook hasn't arrived yet, check Stripe directly
        if (!payment) {
          var session = await verifyStripePayment(handle, saasName);
          if (session) {
            var email = (session.customer_details && session.customer_details.email) || '';
            payment = {
              handle,
              saasName,
              paidAt: new Date().toISOString(),
              sessionId: session.id || null,
              email: email || null,
            };
            pendingAds.set(key, payment);
            savePendingAds();
            console.log(`[stripe] Fallback: created pending ad for @${handle} from API`);
          }
        }

        if (!payment) {
          var checkoutUrl = process.env.STRIPE_LINK || '';
          return sendJson(req, res, 402, {
            error: 'Payment not found. Please complete checkout first.',
            checkoutUrl: checkoutUrl || undefined,
          });
        }

        // Look up startup data from TrustMRR for avatar/MRR
        var startupData = trustmrrStartups.find(function(s) {
          return s.handle && s.handle.toLowerCase() === key;
        });

        var id = Math.random().toString(36).slice(2, 8);
        var now = new Date();
        var expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 1 week

        // Extract slug from trustmrrUrl if provided
        var slug = null;
        if (trustmrrUrl) {
          var slugMatch = trustmrrUrl.match(/trustmrr\.com\/startup\/([^/?#]+)/);
          if (slugMatch) slug = slugMatch[1];
        }

        var slot = {
          id: id,
          zone: 'top',
          handle: handle,
          saasName: saasName,
          description: description,
          avatar: (startupData && startupData.avatar) || null,
          mrr: (startupData && startupData.mrr) ? String(startupData.mrr) : '',
          askPrice: '',
          url: trustmrrUrl || '',
          slug: slug || (startupData && startupData.slug) || null,
          startedAt: now.toISOString(),
          expiresAt: expires.toISOString(),
        };

        adSlots.push(slot);
        saveAdSlots();

        // Remove payment record after successful activation
        pendingAds.delete(key);
        savePendingAds();

        setMemoryCache();
        console.log(`[ads] Activated ad for @${handle} (${saasName}), expires ${expires.toISOString()}`);
        return sendJson(req, res, 200, { ok: true, slot: slot });
      } catch (e) {
        return sendJson(req, res, 400, { error: 'Invalid JSON' });
      }
    });
    return;
  }

  if (url.pathname === '/api/ad/activate' && req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.writeHead(204);
    return res.end();
  }

  // ── Traffic tracking: create session ───────────────────────
  if (url.pathname === '/api/t/session' && req.method === 'POST') {
    let body = '';
    req.on('data', function(c) { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', async function() {
      try {
        var d = JSON.parse(body);
        var vid = (d.visitor_id || '').slice(0, 64);
        var sid = (d.session_id || '').slice(0, 64);
        if (!vid || !sid) return sendJson(req, res, 400, { error: 'Missing visitor_id or session_id' });

        // Rate-limit: 1 session per IP per 5 seconds
        var clientIP = getClientIP(req);
        var ipHash = hashIP(clientIP);
        var now = Date.now();
        var lastSeen = recentIPs.get(ipHash);
        if (lastSeen && now - lastSeen < 5000) {
          return sendJson(req, res, 429, { error: 'Rate limited' });
        }
        recentIPs.set(ipHash, now);
        // Prune old rate-limit entries every 100 inserts
        if (recentIPs.size > 500) {
          for (var [k, v] of recentIPs) {
            if (now - v > 60000) recentIPs.delete(k);
          }
        }

        var ua = parseUA(req.headers['user-agent'] || '');
        var source = d.utm_source || inferSource(d.referrer || req.headers['referer'] || '');
        var geo = await geoLookup(clientIP);

        var session = {
          id: sid,
          visitor_id: vid,
          ip_hash: ipHash,
          source: source,
          medium: (d.utm_medium || '').slice(0, 64) || '',
          campaign: (d.utm_campaign || '').slice(0, 128) || '',
          content: (d.utm_content || '').slice(0, 128) || '',
          term: (d.utm_term || '').slice(0, 128) || '',
          referrer: (d.referrer || '').slice(0, 512),
          landing_page: (d.landing_page || '/').slice(0, 256),
          device: ua.device,
          browser: ua.browser,
          os: ua.os,
          country: geo.country,
          city: geo.city,
          duration: 0,
          scroll_depth: 0,
          bounce: true,
          createdAt: new Date().toISOString(),
        };
        sessions.push(session);
        // Cap sessions array at 10000
        if (sessions.length > 10000) sessions = sessions.slice(-10000);
        return sendJson(req, res, 200, { ok: true });
      } catch (e) {
        return sendJson(req, res, 400, { error: 'Invalid JSON' });
      }
    });
    return;
  }

  // ── Traffic tracking: update engagement ─────────────────────
  if (url.pathname === '/api/t/event' && req.method === 'POST') {
    let body = '';
    req.on('data', function(c) { body += c; if (body.length > 2048) req.destroy(); });
    req.on('end', function() {
      try {
        var d = JSON.parse(body);
        var sid = (d.session_id || '').slice(0, 64);
        if (!sid) return sendJson(req, res, 400, { error: 'Missing session_id' });
        // Find session and update engagement
        for (var i = sessions.length - 1; i >= 0; i--) {
          if (sessions[i].id === sid) {
            var s = sessions[i];
            if (typeof d.duration === 'number' && d.duration > s.duration) s.duration = Math.min(d.duration, 86400);
            if (typeof d.scroll_depth === 'number' && d.scroll_depth > s.scroll_depth) s.scroll_depth = Math.min(d.scroll_depth, 100);
            // Bounce = duration < 30s AND scroll < 25%
            s.bounce = s.duration < 30 && s.scroll_depth < 25;
            break;
          }
        }
        return sendJson(req, res, 200, { ok: true });
      } catch (e) {
        return sendJson(req, res, 400, { error: 'Invalid JSON' });
      }
    });
    return;
  }

  // ── Dev ads API (read-only, no auth) ──────────────────────
  if (url.pathname === '/api/dev/ads' && req.method === 'GET') {
    var now = new Date().toISOString();
    var all = adSlots.map(function(a) {
      return Object.assign({}, a, { active: a.expiresAt > now });
    });
    return sendJson(req, res, 200, { slots: all, total: all.length });
  }

  // ── Success page ──────────────────────────────────────────
  if (url.pathname === '/success') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(getSuccessPageHtml());
  }

  // ── FAQ page ────────────────────────────────────────────────
  if (url.pathname === '/faq') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(getFaqPageHtml());
  }

  // ── Traffic analytics API ────────────────────────────────
  if (url.pathname === '/api/admin/traffic' && req.method === 'GET') {
    var secret = url.searchParams.get('secret');
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) return sendJson(req, res, 401, { error: 'Unauthorized' });
    var days = Math.min(parseInt(url.searchParams.get('days')) || 7, 90);
    var cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    var filtered = sessions.filter(function(s) { return new Date(s.createdAt).getTime() > cutoff; });
    var uniqueVisitors = new Set(filtered.map(function(s) { return s.visitor_id; })).size;
    var bounced = filtered.filter(function(s) { return s.bounce; }).length;
    var bounceRate = filtered.length ? Math.round((bounced / filtered.length) * 100) : 0;
    var totalDuration = 0;
    for (var i = 0; i < filtered.length; i++) totalDuration += filtered[i].duration;
    var avgDuration = filtered.length ? Math.round(totalDuration / filtered.length) : 0;

    // Breakdowns
    function breakdown(arr, key) {
      var m = {};
      for (var i = 0; i < arr.length; i++) {
        var v = arr[i][key] || 'unknown';
        m[v] = (m[v] || 0) + 1;
      }
      return Object.entries(m).sort(function(a, b) { return b[1] - a[1]; }).map(function(e) { return { name: e[0], count: e[1] }; });
    }

    // By day
    var byDay = {};
    for (var i = 0; i < filtered.length; i++) {
      var day = filtered[i].createdAt.slice(0, 10);
      byDay[day] = (byDay[day] || 0) + 1;
    }
    var byDayArr = Object.entries(byDay).sort(function(a, b) { return a[0] > b[0] ? -1 : 1; }).map(function(e) { return { date: e[0], count: e[1] }; });

    var recent = filtered.slice(-20).reverse();

    return sendJson(req, res, 200, {
      days: days,
      total: filtered.length,
      unique: uniqueVisitors,
      bounceRate: bounceRate,
      avgDuration: avgDuration,
      bySource: breakdown(filtered, 'source'),
      byDevice: breakdown(filtered, 'device'),
      byCountry: breakdown(filtered, 'country'),
      byBrowser: breakdown(filtered, 'browser'),
      byDay: byDayArr,
      recent: recent,
    });
  }

  // ── Traffic analytics dashboard ────────────────────────────
  if (url.pathname === '/admin/traffic') {
    var secret = url.searchParams.get('secret');
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      return res.end('Unauthorized');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(getTrafficDashboardHtml());
  }

  // ── Admin dashboard ──────────────────────────────────────
  if (url.pathname === '/admin') {
    var secret = url.searchParams.get('secret');
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      return res.end('Unauthorized');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(getAdminDashboardHtml());
  }

  // ── Dev dashboard ─────────────────────────────────────────
  if (url.pathname === '/dev') {
    var secret = url.searchParams.get('secret');
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
      // No secret or wrong secret → show login page
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(getDevLoginHtml());
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(getDevDashboardHtml());
  }

  // ── Admin dashboard API ─────────────────────────────────
  if (url.pathname === '/api/admin/dashboard' && req.method === 'GET') {
    var secret = url.searchParams.get('secret');
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) return sendJson(req, res, 401, { error: 'Unauthorized' });
    var now = new Date().toISOString();
    var activeSlots = adSlots.filter(function(a) { return a.expiresAt > now; });
    var pendingList = [];
    for (var [pk, pv] of pendingAds) pendingList.push(pv);
    return sendJson(req, res, 200, {
      active: activeSlots.map(function(a) { return Object.assign({}, a, { active: true }); }),
      pending: pendingList,
      expired: expiredAds.slice().reverse().slice(0, 50),
      stats: {
        activeCount: activeSlots.length,
        pendingCount: pendingAds.size,
        expiredCount: expiredAds.length,
        weeklyRevenue: activeSlots.length * 49,
        totalRevenue: (activeSlots.length + expiredAds.length) * 49,
        startupCount: trustmrrStartups.length,
      },
    });
  }

  // ── Extend ad by 7 days ─────────────────────────────────
  if (url.pathname === '/api/admin/ads/extend' && req.method === 'POST') {
    let body = '';
    req.on('data', function(c) { body += c; });
    req.on('end', function() {
      try {
        var d = JSON.parse(body);
        if (!ADMIN_SECRET || d.secret !== ADMIN_SECRET) return sendJson(req, res, 401, { error: 'Unauthorized' });
        var adId = d.id;
        if (!adId) return sendJson(req, res, 400, { error: 'Missing ad id' });
        var slot = adSlots.find(function(a) { return a.id === adId; });
        if (!slot) return sendJson(req, res, 404, { error: 'Ad not found' });
        var newExpiry = new Date(new Date(slot.expiresAt).getTime() + 7 * 24 * 60 * 60 * 1000);
        slot.expiresAt = newExpiry.toISOString();
        saveAdSlots();
        setMemoryCache();
        console.log('[admin] Extended ad @' + slot.handle + ' to ' + slot.expiresAt);
        return sendJson(req, res, 200, { ok: true, slot: slot });
      } catch (e) {
        return sendJson(req, res, 400, { error: 'Invalid JSON' });
      }
    });
    return;
  }

  // ── Manually activate pending ad ────────────────────────
  if (url.pathname === '/api/admin/pending/activate' && req.method === 'POST') {
    let body = '';
    req.on('data', function(c) { body += c; });
    req.on('end', function() {
      try {
        var d = JSON.parse(body);
        if (!ADMIN_SECRET || d.secret !== ADMIN_SECRET) return sendJson(req, res, 401, { error: 'Unauthorized' });
        var handle = (d.handle || '').replace(/^@/, '').trim();
        if (!handle) return sendJson(req, res, 400, { error: 'Missing handle' });
        var key = handle.toLowerCase();
        var payment = pendingAds.get(key);
        if (!payment) return sendJson(req, res, 404, { error: 'Pending ad not found' });
        var saasName = payment.saasName || d.saasName || '';
        var description = (d.description || '').slice(0, 80);
        var trustmrrUrl = d.trustmrrUrl || '';
        var startupData = trustmrrStartups.find(function(s) {
          return s.handle && s.handle.toLowerCase() === key;
        });
        var id = Math.random().toString(36).slice(2, 8);
        var now = new Date();
        var expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        var slug = null;
        if (trustmrrUrl) {
          var slugMatch = trustmrrUrl.match(/trustmrr\.com\/startup\/([^/?#]+)/);
          if (slugMatch) slug = slugMatch[1];
        }
        var slot = {
          id: id, zone: 'top', handle: handle, saasName: saasName,
          description: description,
          avatar: (startupData && startupData.avatar) || null,
          mrr: (startupData && startupData.mrr) ? String(startupData.mrr) : '',
          askPrice: '', url: trustmrrUrl || '',
          slug: slug || (startupData && startupData.slug) || null,
          startedAt: now.toISOString(), expiresAt: expires.toISOString(),
        };
        adSlots.push(slot);
        saveAdSlots();
        pendingAds.delete(key);
        savePendingAds();
        setMemoryCache();
        console.log('[admin] Manually activated ad for @' + handle);
        return sendJson(req, res, 200, { ok: true, slot: slot });
      } catch (e) {
        return sendJson(req, res, 400, { error: 'Invalid JSON' });
      }
    });
    return;
  }

  // ── Delete pending ad ───────────────────────────────────
  if (url.pathname.startsWith('/api/admin/pending/') && req.method === 'DELETE') {
    var secret = url.searchParams.get('secret');
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) return sendJson(req, res, 401, { error: 'Unauthorized' });
    var handleSlug = decodeURIComponent(url.pathname.split('/').pop()).toLowerCase();
    if (pendingAds.has(handleSlug)) {
      pendingAds.delete(handleSlug);
      savePendingAds();
      console.log('[admin] Deleted pending ad: ' + handleSlug);
      return sendJson(req, res, 200, { ok: true, deleted: handleSlug });
    }
    return sendJson(req, res, 404, { error: 'Not found' });
  }

  // Handle OPTIONS for admin endpoints
  if (url.pathname.startsWith('/api/admin/') && req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.writeHead(204);
    return res.end();
  }

  // Static files from memory
  const cached = staticCache.get(url.pathname === '/' ? '/' : url.pathname);
  if (cached) {
    const gz = (req.headers['accept-encoding'] || '').includes('gzip');
    res.setHeader('Content-Type', cached.mime);
    res.setHeader('Cache-Control', 'public, max-age=120');
    if (gz) {
      res.setHeader('Content-Encoding', 'gzip');
      res.writeHead(200);
      return res.end(cached.gzipped);
    }
    res.writeHead(200);
    return res.end(cached.content);
  }

  // Fallback: read from disk
  let fp = url.pathname === '/' ? '/index.html' : url.pathname;
  fp = path.join(__dirname, fp);
  const mimes = {
    '.html': 'text/html; charset=utf-8', '.js': 'application/javascript',
    '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  };
  fs.readFile(fp, (err, content) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': mimes[path.extname(fp)] || 'text/plain' });
    res.end(content);
  });
});

/* ── Start ──────────────────────────────────────────────── */
async function start() {
  await initDb();
  preloadStatic();

  // Load ad slots + pending ads + expired ads + sessions
  loadAdSlots();
  loadPendingAds();
  loadExpiredAds();
  loadSessions();

  // Load TrustMRR data from cache, then sync fresh
  loadTrustMrrData();
  if (trustmrrStartups.length) setMemoryCache();

  // Sync fresh TrustMRR data
  await syncTrustMrrData();

  // Enrich default featured ads with live MRR from TrustMRR
  await enrichDefaultAds();

  // Restore scan times from file + DB
  loadScanTimes();
  await warmScanTimesFromDb();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`WhileYouSlept.lol → http://localhost:${PORT}`);
    console.log(`Tracking ${trustmrrStartups.length} startups from TrustMRR\n`);

    // Run first tweet scan immediately
    backgroundScan();

    // Then check for stale tweet scans every 5 minutes
    setInterval(backgroundScan, LOOP_INTERVAL);

    // Schedule daily TrustMRR sync at 12:01 AM ET
    scheduleNextSync();

    // Proactive cleanup every 5 minutes
    setInterval(function() {
      cleanupExpiredAds();
      cleanupStalePendingAds();
      cleanupOldSessions();
    }, 5 * 60 * 1000);

    // Persist sessions every 2 minutes
    setInterval(saveSessions, 2 * 60 * 1000);
  });
}

start();
