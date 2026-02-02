const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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
const OPENAI_KEY    = process.env.OPENAI_API_KEY;
const CACHE_DIR     = path.join(__dirname, '.cache');
const SCAN_COOLDOWN = 60 * 60 * 1000;   // 1 hour per account
const LOOP_INTERVAL = 5 * 60 * 1000;    // check for stale accounts every 5 min

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

/* ── In-memory state ────────────────────────────────────── */
let memoryFeedCache = null;      // { cards, timestamp, json, gzipped }
let scanInProgress  = false;
let lastScanDone    = null;      // epoch ms
const scanTimes     = new Map(); // screenname → epoch ms

function setMemoryCache(cards) {
  const payload = {
    cards,
    timestamp: Date.now(),
    lastScan: lastScanDone,
    scanning: scanInProgress,
  };
  const json = JSON.stringify(payload);
  memoryFeedCache = { cards, timestamp: Date.now(), json, gzipped: zlib.gzipSync(json) };
}

/* ── PostgreSQL (optional — falls back to file cache) ──── */
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
    CREATE TABLE IF NOT EXISTS feed_cards (
      id TEXT PRIMARY KEY,
      handle TEXT,
      name TEXT,
      avatar TEXT,
      summary TEXT,
      score REAL,
      likes INT DEFAULT 0,
      views INT DEFAULT 0,
      bookmarks INT DEFAULT 0,
      date TEXT,
      media TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Add media column to existing tables
  await pool.query(`ALTER TABLE feed_cards ADD COLUMN IF NOT EXISTS media TEXT`).catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scan_state (
      screenname TEXT PRIMARY KEY,
      last_tweet_id TEXT,
      last_scanned_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tweets_sn ON tweets(screenname)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_fc_date ON feed_cards(created_at DESC)`);
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

async function getFeedCardsFromDb() {
  if (!pool) return null;
  try {
    const r = await pool.query(
      'SELECT id,handle,name,avatar,summary,score,likes,views,bookmarks,date,media FROM feed_cards ORDER BY created_at DESC'
    );
    if (!r.rows.length) return null;
    return r.rows.map(row => ({
      ...row,
      media: row.media ? JSON.parse(row.media) : null,
    }));
  } catch (e) { return null; }
}

async function storeFeedCards(cards) {
  if (!pool || !cards.length) return;
  try {
    const ids = [], hs = [], ns = [], avs = [], sums = [];
    const scs = [], lks = [], vws = [], bks = [], dts = [], mds = [];
    for (const c of cards) {
      ids.push(c.id); hs.push(c.handle); ns.push(c.name);
      avs.push(c.avatar); sums.push(c.summary); scs.push(c.score);
      lks.push(c.likes); vws.push(c.views); bks.push(c.bookmarks);
      dts.push(c.date); mds.push(c.media ? JSON.stringify(c.media) : null);
    }
    await pool.query(`
      INSERT INTO feed_cards (id,handle,name,avatar,summary,score,likes,views,bookmarks,date,media)
      SELECT * FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],
        $6::real[],$7::int[],$8::int[],$9::int[],$10::text[],$11::text[])
      ON CONFLICT (id) DO UPDATE SET
        summary=EXCLUDED.summary, score=EXCLUDED.score,
        likes=EXCLUDED.likes, views=EXCLUDED.views,
        bookmarks=EXCLUDED.bookmarks, date=EXCLUDED.date,
        media=EXCLUDED.media
    `, [ids, hs, ns, avs, sums, scs, lks, vws, bks, dts, mds]);
  } catch (err) {
    for (const c of cards) {
      try {
        await pool.query(`
          INSERT INTO feed_cards (id,handle,name,avatar,summary,score,likes,views,bookmarks,date,media)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT (id) DO UPDATE SET
            summary=EXCLUDED.summary, score=EXCLUDED.score,
            likes=EXCLUDED.likes, views=EXCLUDED.views,
            bookmarks=EXCLUDED.bookmarks, date=EXCLUDED.date,
            media=EXCLUDED.media
        `, [c.id, c.handle, c.name, c.avatar, c.summary, c.score, c.likes, c.views, c.bookmarks, c.date,
            c.media ? JSON.stringify(c.media) : null]);
      } catch (e) { /* skip */ }
    }
  }
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
      if (f === 'feed.json' || f === 'scan_times.json') continue;
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

/* ── Accounts ───────────────────────────────────────────── */
const ACCOUNTS = [
  // ── OG indie hackers & SaaS builders ─────────────────
  'levelsio','marc_louvion','tdinh_me','dannypostmaa','mckaywrigley',
  'bentossell','shpigford','thesamparr','dvassallo','nathanbarry',
  'gregisenberg','ShaanVP','arvidkahl','thepatwalls','csallen',
  'marckohlbrugge','noahkagan','robwalling','hnshah','randfish',
  'yongfook','tibo_maker','damengchen','ajlkn','dagorenouf',
  'jakobgreenfeld','kiwicopple','panphora','PierreDeWulf','Insharamin',
  'yannick_veys','SimonHoiberg','stephsmithio','dru_riley','monicalent',
  'thisiskp_','mubashariqbal','brian_lovin','mijustin','coreyhainesco',
  'jasonlk','nathanlatka','danmartell','steli','Pauline_Cx',
  'MarieMartens','petecodes','alexwestco','TaraReed_','chddaniel',
  'johnrushx','yoheinakajima','JimRaptis','mattiapomelli','pjrvs',
  'tylermking','lunchbag','MattCowlin',
  'rileybrown_ai','florinpop1705','pbteja1998','sobedominik','czue',
  'qayyumrajan','louispereira','NotechAna','saasmakermac','dylan_hey',
  'DmytroKrasun','helloitsolly','itsjustamar','philostar','ankit_saas',
  'code_rams','phuctm97','nico_jeannen','jasonleowsg','JhumanJ',
  'pie6k','daniel_nguyenx','PaulYacoubian','_rchase_','SlamingDev',
  'mikestrives','MatthewBerman','patio11','dharmesh','lennysan',
  'swyx','karpathy',
  // ── High-revenue builders ($1M+ ARR / exits) ────────
  'RetentionAdam',   // Retention.com $22M ARR, RB2B $5M ARR
  'GuillaumeMbh',    // Lemlist/Lempire $28M ARR bootstrapped
  'adamwathan',      // Tailwind CSS, Tailwind UI $2M+ launch
  'jayhoovy',        // Stan Store $33M ARR
  'brettfromdj',     // DesignJoy $1M+ ARR solo designer
  'thejustinwelsh',  // $10M solopreneur, 89% margins
  'wagslane',        // Boot.dev $10M ARR bootstrapped
  'Patticus',        // ProfitWell, sold for $200M+
  'asmartbear',      // WP Engine founder
  'getajobmike',     // Sidekiq $7M/yr solo SaaS
  'steveschoger',    // Refactoring UI $2.5M+ revenue
  'chris_orlob',     // Grew Gong to $7B, now pclub.io
  'JamesonCamp',     // Sold company for $30M+
  // ── Mid-revenue builders ($10K-$100K MRR) ───────────
  'samuelrdt',       // 3 SaaS products at $35K MRR
  'SamyDindane',     // Hypefury $70K+ MRR
  'euboid',          // Senja co-founder $83K+ MRR
  'jackfriks',       // PostBridge $18K/month
  'CameronTrew',     // Kleo $62K MRR, Mentions $20K MRR
  'KateBour',        // $400K/yr solo business
  'connorshowler',   // $3M+ profit, 8+ yrs digital
  'vishalkumar',     // OneUp $1M+/year
  'DavisBaer',       // OneUp co-founder
  // ── Build in public / micro-SaaS ────────────────────
  'noahwbragg',      // Sold Potion for $300K
  'thelifeofrishi',  // Pika screenshot tool
  'gouthamjay8',     // Famewall, sold Mailboat
  'maoxai_',         // AI app to $4K MRR in 100 days
  'courtkland',      // Indie Hackers founder (sold to Stripe)
  'rameerez',        // Indie hacker builder
  'DanKoe',          // Solopreneur, courses & community
  'patflynn',        // Smart Passive Income, transparent reports
  'maxprilutskiy',   // Notionlytics
];

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
  const gz = (req.headers['accept-encoding'] || '').includes('gzip');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=120');
  if (gz) {
    res.setHeader('Content-Encoding', 'gzip');
    res.writeHead(200);
    res.end(memoryFeedCache.gzipped);
  } else {
    res.writeHead(200);
    res.end(memoryFeedCache.json);
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

/* ── HTTPS helper ───────────────────────────────────────── */
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
/*  1. Monthly MRR / revenue update (with screenshot)
 *  2. Sold / acquired company + price
 *  3. SaaS monthly earnings report
 *  Everything else is rejected.
 */
function isMoneyTweet(text, hasMedia) {
  if (!text) return false;

  // ── Hard rejections ──────────────────────────────────
  // Goals, intentions, hypotheticals
  const isNoise = /(?:my goal|hoping to|want to (?:hit|make|reach)|aiming for|planning to|going to (?:make|hit|reach)|trying to (?:reach|hit|get)|dream of|would love to|working towards|plan is to|aspir|by (?:end of|year end|next year|EOY)|get (?:my |this |the |it )?(?:.*?)to \$)/i.test(text);
  if (isNoise) return false;
  // Advice, threads, lessons, reflections, motivational musings
  const isAdvice = /(?:^how to|^why you|^stop |^don't|should you|^the secret|^my advice|^tip:|^thread|^lesson|\d+\s+(?:biggest|best|top|key|important)\s+(?:lessons?|tips?|things?|ways?|steps?|rules?)|\d+\s+ways\s+I|should have (?:done|started|built)|I learned to|sure-shot way|sure.?fire way|best way to find|find your next|thought .* problems would go away)/i.test(text);
  if (isAdvice) return false;
  const isPromo = /(?:^check out|^join |^sign up|^use code|^discount|^giveaway|FOR SALE|APP FOR SALE|selling (?:my |the |this ))/i.test(text);
  if (isPromo) return false;
  // Spending / paying money, not making it
  const isSpending = /(?:i pay|pay (?:for|to )|paying (?:for|~?\$)|spend(?:ing)?|cost (?:me|us)|bought|purchased|invested in|raised \$|fundrais|hiring|salary|struggling|might not spend)/i.test(text);
  if (isSpending) return false;
  // Hypotheticals, third party, quoting prices, questions about buying
  const isThirdParty = /(?:can buy|could buy|you can|you'll|imagine|if you|if i (?:wanted|could|just)|i could probably|for only|priced at|worth \$|valued at|starting at|costs? \$|cheap|expensive|why would|how would|what if|anyone (?:here )?(?:buying|selling|looking))/i.test(text);
  if (isThirdParty) return false;
  // Generic observations about others' numbers, not the poster's own
  const isCommentary = /(?:might not|wouldn't|won't|doesn't seem|not (?:possible|appealing)|end up doing)/i.test(text);
  if (isCommentary) return false;
  // RT about someone else's revenue — not the poster's own achievement
  const isRT = /^RT @/i.test(text);
  if (isRT) return false;
  // VC/finance commentary about other companies (not the poster's own product)
  const isFinanceCommentary = /(?:series [A-F]|tender offer|valuation (?:increase|decrease|drop)|IPO|cap table|fundrais|due diligence|term sheet|pre.?money|post.?money|runway|burn rate)/i.test(text);
  if (isFinanceCommentary) return false;

  // ── Category 1: MRR/ARR update (their own, with $ amount) ──
  // e.g. "$22k MRR", "hit $100k ARR", "our MRR is $50k", "$8m ARR"
  const isMrrUpdate = /(?:\$[\d,.]+[KkMm]?\s*(?:MRR|ARR)|\b(?:MRR|ARR)\s*(?::|is|hit|at|of|reached|crossed|passed)?\s*\$[\d,.]+)/i.test(text);

  // ── Category 2: Sold / acquired company ──
  // e.g. "sold my company for $2m", "acquired for $500k", "sold two startups for $8m"
  const isSold = /(?:sold (?:my |the |our |a )?(?:company|startup|saas|app|business|product)|acquired for|acquisition.*\$|exit(?:ed)? (?:for|at) \$|\bsold\b.*(?:startup|company|saas).*\$)/i.test(text);

  // ── Category 3: Monthly SaaS earnings (their own) ──
  // e.g. "made $150k this month", "$50k/mo", "did $30k in January", "revenue hit $100k"
  const isMonthlySaas = (
    // "$X/mo" or "$X/month" or "$X this month" or "$X in [month name]" or "$X last month"
    /\$[\d,.]+[KkMm]?\s*(?:\/mo(?:nth)?|this month|last month|per month)/i.test(text) ||
    // "made/earned/did/generated $X" — first person earnings
    /(?:^|\b)(?:i |we |I've |we've )?(?:made|earned|did|generated|grossed|netted|cleared|brought in|pulling in)\s+(?:~?\$[\d,.]+[KkMm]?|\$[\d,.]+[KkMm]?)/i.test(text) ||
    // "revenue [hit/reached/crossed/at] $X"
    /\brevenue\b.*\$[\d,.]+/i.test(text) ||
    // "in the last 30 days i made"
    /(?:last|this|past)\s+(?:\d+\s+)?(?:days?|month|months|week)\s.*(?:made|earned|did|generated|revenue)\s.*\$/i.test(text) ||
    // "[month name] revenue/income: $X" or "[month name] was $X"
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
  // Bonus for having a screenshot (proof)
  if (hasMedia) score += 5;

  return Math.round(score * 10) / 10;
}

/* ── Clean tweet text for display ──────────────────────── */
function cleanTweetText(text) {
  if (!text) return '';
  return text
    .replace(/https?:\/\/t\.co\/\S+/g, '')   // strip t.co links
    .replace(/&amp;/g, '&')                   // decode HTML entities from Twitter
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')              // collapse excessive newlines
    .trim();
}

/* ── Extract money snippet from tweet ──────────────────── */
function extractMoneySnippet(text) {
  if (!text) return '';
  // Short tweets — use as-is
  if (text.length <= 200) return text;

  // Split into lines, then further split long lines into sentences
  const raw = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const parts = [];
  for (const line of raw) {
    if (line.length <= 200) {
      parts.push(line);
    } else {
      // Split long paragraphs into sentences
      const sentences = line.split(/(?<=[.!?])\s+/);
      for (const s of sentences) parts.push(s.trim());
    }
  }

  // Score each part for money content
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

  // Grab lines with money signals
  const money = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  if (!money.length) return text.slice(0, 200).trim();

  // Take top money lines, cap each line at 200 chars, total at 280
  let snippet = money[0].text.slice(0, 200);
  for (let i = 1; i < money.length; i++) {
    const next = money[i].text.slice(0, 200);
    const combined = snippet + '\n' + next;
    if (combined.length > 280) break;
    snippet = combined;
  }

  return snippet.trim();
}

/* ── Background scan (runs independently of user requests) ─ */
async function backgroundScan() {
  if (scanInProgress) return;
  scanInProgress = true;
  if (memoryFeedCache) setMemoryCache(memoryFeedCache.cards);

  try {
    // Load current feed
    const existing = memoryFeedCache?.cards || await getFeedCardsFromDb() || cacheGet('feed') || [];
    const existingIds = new Set(existing.map(c => c.id));

    // Ensure memory cache is warm
    if (!memoryFeedCache && existing.length) setMemoryCache(existing);

    // Find accounts due for a scan (not scanned in the last hour)
    const stale = ACCOUNTS.filter(a => {
      const last = scanTimes.get(a) || 0;
      return Date.now() - last >= SCAN_COOLDOWN;
    });

    if (!stale.length) {
      console.log('[scan] All accounts scanned recently, nothing to do');
      scanInProgress = false;
      if (memoryFeedCache) setMemoryCache(memoryFeedCache.cards);
      return;
    }

    console.log(`[scan] ${stale.length}/${ACCOUNTS.length} accounts due for refresh`);

    const newTweets = [];
    let errors = 0;
    let scanned = 0;

    for (const account of stale) {
      scanned++;
      try {
        const data = await fetchTimeline(account);
        if (data && data.timeline) {
          const known = await getKnownTweetIds(account);
          let found = 0;

          for (const tweet of data.timeline) {
            // Skip replies — only original posts
            if (tweet.reply_to) continue;
            // Skip tweets already in DB or already in feed — never re-process
            if (known.has(tweet.tweet_id) || existingIds.has(tweet.tweet_id)) continue;
            const score = fomoScore(tweet);
            if (score > 0) { newTweets.push({ ...tweet, _score: score }); found++; }
          }

          // Store ALL timeline tweets in DB (dedup by tweet_id)
          if (data.timeline.length) {
            await storeTweets(data.timeline, account);
            await updateScanState(account, data.timeline[0].tweet_id);
          }

          if (found > 0) console.log(`  [${scanned}/${stale.length}] @${account}: ${found} new`);
        } else {
          console.log(`  [${scanned}/${stale.length}] @${account}: no data`);
        }
        scanTimes.set(account, Date.now());
      } catch (e) {
        console.log(`  [${scanned}/${stale.length}] @${account}: ${e.message}`);
        errors++;
      }

      // Rate-limit delay when we hit the actual API (cache age < 2s means fresh fetch)
      if (cacheAge(`tweets_${account}`) < 2000) {
        await new Promise(r => setTimeout(r, 400));
      }
    }

    saveScanTimes();
    console.log(`[scan] Found ${newTweets.length} new money tweets (${errors} errors)`);

    if (!newTweets.length) {
      lastScanDone = Date.now();
      scanInProgress = false;
      if (memoryFeedCache) setMemoryCache(memoryFeedCache.cards);
      return;
    }

    // Use actual tweet text (no AI rewriting — every word shown is from the real post)
    newTweets.sort((a, b) => b._score - a._score);
    const top = newTweets.slice(0, 50);

    // Build new feed cards
    const newCards = [];
    for (let i = 0; i < top.length; i++) {
      const t = top[i];
      const cleaned = cleanTweetText(t.text || '');
      const text = extractMoneySnippet(cleaned);
      if (!text) continue;
      const a = t.author || {};

      // Extract media (photos + video thumbnails)
      const tweetMedia = [];
      if (t.media) {
        if (t.media.photo) {
          for (const p of t.media.photo) {
            if (p.media_url_https) tweetMedia.push({ type: 'photo', url: p.media_url_https });
          }
        }
        if (t.media.video) {
          for (const v of t.media.video) {
            const mp4s = (v.variants || [])
              .filter(x => x.content_type === 'video/mp4')
              .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
            tweetMedia.push({
              type: 'video',
              thumb: v.media_url_https || '',
              url: mp4s.length ? mp4s[0].url : null,
            });
          }
        }
      }

      newCards.push({
        id: t.tweet_id,
        handle: a.screen_name || '',
        name: a.name || '',
        avatar: (a.avatar || '').replace('_normal', '_bigger'),
        summary: text,
        score: t._score,
        likes: t.favorites || 0,
        views: parseInt(t.views) || 0,
        bookmarks: t.bookmarks || 0,
        date: t.created_at || '',
        media: tweetMedia.length ? tweetMedia : null,
      });
    }

    // Merge: new cards added, existing preserved. Sort newest first.
    const map = new Map();
    for (const c of existing) map.set(c.id, c);
    for (const c of newCards) map.set(c.id, c);
    let merged = Array.from(map.values());
    merged.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Deduplicate: if same handle has near-identical cards, keep only newest
    const byHandle = new Map();
    for (const c of merged) {
      if (!byHandle.has(c.handle)) byHandle.set(c.handle, []);
      byHandle.get(c.handle).push(c);
    }
    const deduped = [];
    for (const [handle, cards] of byHandle) {
      // Sort by date descending so newest cards are "kept" first
      cards.sort((a, b) => new Date(b.date) - new Date(a.date));
      const kept = [];
      for (const card of cards) {
        // Extract dollar figures to compare similarity
        const nums = (card.summary.match(/\$[\d,.]+[KkMm]?/g) || []).sort().join('|');
        // Extract "DAY X" or "Day X" pattern for series detection
        const dayMatch = card.summary.match(/\bDAY\s+(\d+)\b/i);
        const dayTag = dayMatch ? 'DAY_SERIES' : null;
        const isDupe = kept.some(k => {
          const kNums = (k.summary.match(/\$[\d,.]+[KkMm]?/g) || []).sort().join('|');
          // Same dollar figures = duplicate
          if (nums && nums === kNums) return true;
          // Same "DAY X" series from same handle = keep only newest
          if (dayTag) {
            const kDay = k.summary.match(/\bDAY\s+(\d+)\b/i);
            if (kDay) return true;
          }
          return false;
        });
        if (!isDupe) kept.push(card);
      }
      deduped.push(...kept);
    }
    merged = deduped.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Persist everywhere
    await storeFeedCards(merged);
    cacheSet('feed', merged);
    lastScanDone = Date.now();
    setMemoryCache(merged);
    console.log(`[scan] Feed updated: ${merged.length} total (+${newCards.length} new)\n`);

  } catch (e) {
    console.error('[scan] Error:', e.message);
  } finally {
    scanInProgress = false;
    if (memoryFeedCache) setMemoryCache(memoryFeedCache.cards);
  }
}

/* ── HTTP server ────────────────────────────────────────── */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Health check
  if (url.pathname === '/health') {
    return sendJson(req, res, 200, {
      status: 'ok',
      cards: memoryFeedCache?.cards?.length || 0,
      scanning: scanInProgress,
    });
  }

  // Checkout — redirect to Stripe with handle
  if (url.pathname === '/api/checkout') {
    const handle = (url.searchParams.get('handle') || '').replace(/^@/, '').trim();
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
    const dest = `${stripeLink}${sep}client_reference_id=${encodeURIComponent(handle)}`;
    res.writeHead(302, { Location: dest });
    return res.end();
  }

  // Feed API — READ-ONLY: serves from cache, never triggers a scan
  if (url.pathname === '/api/feed') {
    // 1. Memory cache (sub-ms)
    if (sendCachedFeed(req, res)) return;

    // 2. Try DB
    const db = await getFeedCardsFromDb();
    if (db && db.length) {
      setMemoryCache(db);
      return sendCachedFeed(req, res);
    }

    // 3. Try file
    const file = cacheGet('feed');
    if (file && file.length) {
      setMemoryCache(file);
      return sendCachedFeed(req, res);
    }

    // 4. Nothing yet — first deploy, scan in progress
    return sendJson(req, res, 200, {
      cards: [],
      timestamp: Date.now(),
      lastScan: null,
      scanning: scanInProgress,
    });
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

  // Restore scan times from file + DB
  loadScanTimes();
  await warmScanTimesFromDb();

  // Warm memory cache from DB or file (instant feed for first visitor)
  const db = await getFeedCardsFromDb();
  const file = cacheGet('feed');
  if (db && db.length) {
    setMemoryCache(db);
    console.log(`Cache warmed from DB: ${db.length} cards`);
  } else if (file && file.length) {
    setMemoryCache(file);
    console.log(`Cache warmed from file: ${file.length} cards`);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`WhileYouWereSleeping.lol → http://localhost:${PORT}`);
    console.log(`Tracking ${ACCOUNTS.length} accounts\n`);

    // Run first scan immediately
    backgroundScan();

    // Then check for stale accounts every 5 minutes
    setInterval(backgroundScan, LOOP_INTERVAL);
  });
}

start();
