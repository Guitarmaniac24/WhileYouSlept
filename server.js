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
      created_at TIMESTAMPTZ DEFAULT NOW()
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
      'SELECT id,handle,name,avatar,summary,score,likes,views,bookmarks,date FROM feed_cards ORDER BY created_at DESC'
    );
    return r.rows.length ? r.rows : null;
  } catch (e) { return null; }
}

async function storeFeedCards(cards) {
  if (!pool || !cards.length) return;
  try {
    const ids = [], hs = [], ns = [], avs = [], sums = [];
    const scs = [], lks = [], vws = [], bks = [], dts = [];
    for (const c of cards) {
      ids.push(c.id); hs.push(c.handle); ns.push(c.name);
      avs.push(c.avatar); sums.push(c.summary); scs.push(c.score);
      lks.push(c.likes); vws.push(c.views); bks.push(c.bookmarks);
      dts.push(c.date);
    }
    await pool.query(`
      INSERT INTO feed_cards (id,handle,name,avatar,summary,score,likes,views,bookmarks,date)
      SELECT * FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],
        $6::real[],$7::int[],$8::int[],$9::int[],$10::text[])
      ON CONFLICT (id) DO UPDATE SET
        summary=EXCLUDED.summary, score=EXCLUDED.score,
        likes=EXCLUDED.likes, views=EXCLUDED.views,
        bookmarks=EXCLUDED.bookmarks, date=EXCLUDED.date
    `, [ids, hs, ns, avs, sums, scs, lks, vws, bks, dts]);
  } catch (err) {
    for (const c of cards) {
      try {
        await pool.query(`
          INSERT INTO feed_cards (id,handle,name,avatar,summary,score,likes,views,bookmarks,date)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (id) DO UPDATE SET
            summary=EXCLUDED.summary, score=EXCLUDED.score,
            likes=EXCLUDED.likes, views=EXCLUDED.views,
            bookmarks=EXCLUDED.bookmarks, date=EXCLUDED.date
        `, [c.id, c.handle, c.name, c.avatar, c.summary, c.score, c.likes, c.views, c.bookmarks, c.date]);
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

/* ── Revenue filter ─────────────────────────────────────── */
function isMoneyTweet(text) {
  const hasDollar     = /\$[\d,]+/.test(text);
  const hasRevKW      = /(?:MRR|ARR|revenue|income|profit|margin|sales)/i.test(text);
  const hasMoneyKW    = /(?:made|earned|grossed|netted|bringing in|generating)/i.test(text);
  const hasSold       = /(?:SOLD FOR|ACQUIRED FOR|sold.*\$|acquisition.*\$)/i.test(text);
  const hasCustProof  = /(?:paying customers|paid users|subscribers|new customers|purchases|conversions)/i.test(text) && /\d/.test(text);
  const hasRevNum     = /\d+[KkMm]?\s*(?:MRR|ARR|\/mo|\/month|\/year|revenue)/i.test(text);
  const isAdvice      = /(?:^how to|^why you|^stop |^don't|should you|^the secret|^my advice|^tip:|^thread)/i.test(text);
  const isPromo       = /(?:^check out|^join |^sign up|^use code|^discount|^giveaway)/i.test(text);
  if (isAdvice || isPromo) return false;
  return hasDollar || hasSold || hasCustProof || hasRevNum ||
    (hasRevKW && /\d/.test(text)) || (hasMoneyKW && /\$/.test(text));
}

/* ── FOMO scoring ───────────────────────────────────────── */
function fomoScore(tweet) {
  const text = tweet.text || '';
  if (!isMoneyTweet(text)) return 0;

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

  return Math.round(score * 10) / 10;
}

/* ── OpenAI summarization ───────────────────────────────── */
async function summarizeTweets(tweetsWithAuthors) {
  if (!OPENAI_KEY || !tweetsWithAuthors.length) return tweetsWithAuthors.map(() => null);

  const prompt = tweetsWithAuthors.map((t, i) =>
    `[${i}] @${t.author.screen_name} (${t.author.name}): "${t.text}"`
  ).join('\n\n');

  try {
    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You extract the most FOMO-inducing snippet from tweets by AI builders making real money.

ONLY process tweets that show CONCRETE PROOF of one of these:
1. Revenue numbers (MRR, ARR, monthly income, profit)
2. A sale or acquisition with a price
3. Paying customers / paid user counts
4. Earnings reports or income breakdowns

STRICT RULES:
- Return "SKIP" for anything that is NOT concrete revenue/money proof
- SKIP: opinions, advice, motivational quotes, product launches without revenue, growth without revenue, general statements
- SKIP: investments, fundraising, or spending money (we only care about MAKING money)
- Extract the EXACT words from the tweet that will cause maximum FOMO — the line that makes readers feel they're falling behind
- Return VERBATIM text from the tweet — do NOT rewrite, paraphrase, or add words
- If the tweet is short and already a gut-punch, return the whole thing
- If long, extract only the most devastating sentence or fragment (the one with the numbers)
- Strip @mentions and URLs but keep everything else exactly as written
- Max 200 chars per extract
- Return a JSON array of strings, one per tweet, same order`
        },
        {
          role: 'user',
          content: `Extract the most FOMO-inducing verbatim snippet from each tweet. SKIP anything without real revenue/money proof:\n\n${prompt}\n\nReturn ONLY a JSON array of strings — exact quotes from the tweets.`
        }
      ],
      temperature: 0.4,
      max_tokens: 2000,
    });

    const resp = await httpsReq({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json',
      },
    }, body);

    const content = resp.choices?.[0]?.message?.content || '[]';
    const match = content.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
  } catch (err) {
    console.error('OpenAI error:', err.message);
  }

  return tweetsWithAuthors.map(() => null);
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

    // Summarize only NEW tweets (never re-summarize)
    newTweets.sort((a, b) => b._score - a._score);
    const top = newTweets.slice(0, 50);

    const summaries = [];
    for (let i = 0; i < top.length; i += 10) {
      const batch = top.slice(i, i + 10);
      console.log(`[scan] Summarizing batch ${Math.floor(i / 10) + 1}...`);
      summaries.push(...await summarizeTweets(batch));
    }

    // Build new feed cards
    const newCards = [];
    for (let i = 0; i < top.length; i++) {
      const t = top[i], s = summaries[i];
      if (!s || s === 'SKIP') continue;
      const a = t.author || {};
      newCards.push({
        id: t.tweet_id,
        handle: a.screen_name || '',
        name: a.name || '',
        avatar: (a.avatar || '').replace('_normal', '_bigger'),
        summary: s,
        score: t._score,
        likes: t.favorites || 0,
        views: parseInt(t.views) || 0,
        bookmarks: t.bookmarks || 0,
        date: t.created_at || '',
      });
    }

    // Merge: new cards added, existing preserved. Sort newest first.
    const map = new Map();
    for (const c of existing) map.set(c.id, c);
    for (const c of newCards) map.set(c.id, c);
    const merged = Array.from(map.values());
    merged.sort((a, b) => new Date(b.date) - new Date(a.date));

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
