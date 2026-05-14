const express = require('express');
const cors = require('cors');
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const pLimit = require('p-limit');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ── 中介層設定 ────────────────────────────────────────
app.use(cors());
app.use(express.json());

// 簡單限流：每個 IP 每分鐘最多 30 次請求
const limiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
app.use(limiter);

// ── 常數設定 ──────────────────────────────────────────
const SERPER_KEY = process.env.SERPER_KEY || 'b4c4bc880dac3f8ffb8e0d23215ea87abca94e7f';

const LINE_PATTERNS = [
  /https?:\/\/lin\.ee\/[A-Za-z0-9_\-]+/g,
  /https?:\/\/line\.me\/R\/ti\/p\/[A-Za-z0-9_\-@%.]+/g,
  /https?:\/\/line\.me\/ti\/p\/[A-Za-z0-9_\-@%.]+/g,
  /https?:\/\/line\.me\/R\/[A-Za-z0-9_\-\/%.]+/g,
  /line\.me\/[A-Za-z0-9_\-\/%.@?=&]+/g,
];

const CHAIN_BLACKLIST = [
  'momo.com', 'pchome.com', 'yahoo.com', 'google.com', 'wikipedia',
  'yelp.com', 'tripadvisor', 'booking.com', 'agoda.com',
  'foodpanda', 'ubereats', 'shopee', 'lazada', '蝦皮',
  '全聯', '家樂福', 'costco', 'ikea', '麥當勞', '肯德基',
  '星巴克', '85度c', 'subway', 'uniqlo', 'zara',
  'blogspot', 'medium.com', '104.com.tw', '1111.com.tw',
  'yourator', 'cakeresume', 'linkedin.com', 'indeed.com',
  'youtube.com', 'line.me/R/home', 'gov.tw',
];

// User-Agent 池（模擬真實瀏覽器）
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
];

function randomUA() {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

// ── Axios 設定（含自動重試）────────────────────────────
const httpClient = axios.create({ timeout: 15000 });
axiosRetry(httpClient, {
  retries: 3,
  retryDelay: (count) => count * 1000,
  retryCondition: (err) =>
    axiosRetry.isNetworkOrIdempotentRequestError(err) ||
    (err.response && err.response.status >= 500),
});

// ── 工具函式 ──────────────────────────────────────────

function extractLineLinks(text) {
  const found = new Set();
  LINE_PATTERNS.forEach(p => {
    const re = new RegExp(p.source, p.flags);
    (text.match(re) || []).forEach(l => {
      let url = l;
      if (!url.startsWith('http')) url = 'https://' + url;
      // 清除常見雜訊後綴
      url = url.replace(/[)\]'">,;]+$/, '');
      found.add(url);
    });
  });
  return [...found];
}

function isChainStore(item) {
  const text = ((item.title || '') + ' ' + (item.snippet || '') + ' ' + (item.link || '')).toLowerCase();
  return CHAIN_BLACKLIST.some(k => text.includes(k.toLowerCase()));
}

function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch (e) { return url; }
}

function extractSocials(url, html) {
  const socials = [];
  if (url.includes('facebook.com') || url.includes('fb.com'))
    socials.push({ type: 'Facebook', url });
  else if (url.includes('instagram.com'))
    socials.push({ type: 'Instagram', url });
  else
    socials.push({ type: '官方網站', url });

  if (html) {
    // Facebook
    const fbMatches = html.match(/https?:\/\/(www\.|m\.)?facebook\.com\/(?!sharer|dialog|share\.php|tr\b|plugins)[A-Za-z0-9._\-]{2,}(?:\/[A-Za-z0-9._\-]*)?/g) || [];
    fbMatches.forEach(fb => {
      if (!socials.find(s => s.url === fb)) socials.push({ type: 'Facebook', url: fb });
    });
    // Instagram
    const igMatches = html.match(/https?:\/\/(www\.)?instagram\.com\/[A-Za-z0-9._]{2,}\/?/g) || [];
    igMatches.forEach(ig => {
      if (!socials.find(s => s.url === ig)) socials.push({ type: 'Instagram', url: ig });
    });
    // LINE（從 href 屬性精確抓）
    const $ = cheerio.load(html);
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (href.includes('lin.ee') || href.includes('line.me')) {
        const ll = extractLineLinks(href);
        ll.forEach(l => {
          if (!socials.find(s => s.url === l && s.type === 'LINE'))
            socials.push({ type: 'LINE', url: l });
        });
      }
    });
  }
  return socials;
}

// ── 頁面爬取（多策略）────────────────────────────────

async function fetchPageContent(url) {
  const headers = {
    'User-Agent': randomUA(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    'Referer': 'https://www.google.com/',
  };

  // 策略 1：直接請求（後端沒有 CORS 限制）
  try {
    const response = await httpClient.get(url, {
      headers,
      responseType: 'arraybuffer',
      maxRedirects: 5,
      validateStatus: s => s < 400,
    });
    const contentType = response.headers['content-type'] || '';
    let html = '';
    if (contentType.includes('charset=big5') || contentType.includes('charset=gbk')) {
      html = iconv.decode(Buffer.from(response.data), 'big5');
    } else {
      html = iconv.decode(Buffer.from(response.data), 'utf-8');
    }
    if (html.length > 500) return html;
  } catch (e) { /* 繼續嘗試下個策略 */ }

  // 策略 2：用 Google Cache 版本
  try {
    const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
    const response = await httpClient.get(cacheUrl, { headers, timeout: 12000 });
    if (response.data && response.data.length > 500) return response.data;
  } catch (e) { /* 繼續 */ }

  // 策略 3：allorigins（最後手段）
  try {
    const response = await httpClient.get(
      `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
      { timeout: 10000 }
    );
    if (response.data && response.data.contents) return response.data.contents;
  } catch (e) { /* 放棄 */ }

  return '';
}

// ── 深度掃描：同時掃主頁 + 聯絡頁 ───────────────────

async function deepScan(baseUrl) {
  const results = { lineLinks: [], html: '', socials: [] };

  // 同時掃：主頁 + /contact + /about
  const urlsToTry = [baseUrl];
  try {
    const base = new URL(baseUrl);
    if (!baseUrl.includes('facebook.com') && !baseUrl.includes('instagram.com')) {
      urlsToTry.push(base.origin + '/contact');
      urlsToTry.push(base.origin + '/about');
      urlsToTry.push(base.origin + '/contact-us');
      urlsToTry.push(base.origin + '/聯絡我們');
    }
  } catch (e) {}

  const limit = pLimit(3);
  const htmlResults = await Promise.all(
    urlsToTry.map(u => limit(() => fetchPageContent(u).catch(() => '')))
  );

  const combinedHtml = htmlResults.join('\n');
  results.html = combinedHtml;
  results.lineLinks = extractLineLinks(combinedHtml);
  results.socials = extractSocials(baseUrl, combinedHtml);

  return results;
}

// ── Serper 搜尋 ───────────────────────────────────────

async function searchSerper(query, page = 1) {
  const body = { q: query, num: 10, gl: 'tw', hl: 'zh-tw' };
  if (page > 1) body.page = page;
  const r = await axios.post('https://google.serper.dev/search', body, {
    headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
    timeout: 10000,
  });
  return r.data.organic || [];
}

// ── API 端點 ──────────────────────────────────────────

// 健康檢查
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'LINE OA Detector Backend is running' });
});

// 搜尋端點：回傳 Serper 結果（含過濾）
app.post('/api/search', async (req, res) => {
  const { query, pages = 2 } = req.body;
  if (!query) return res.status(400).json({ error: '缺少 query 參數' });

  try {
    let allItems = [];
    const seenDomains = new Set();
    const seenTitles = new Set();
    const seenUrls = new Set();

    for (let pg = 1; pg <= Math.min(pages, 5); pg++) {
      const items = await searchSerper(query, pg);
      for (const item of items) {
        if (!item.link) continue;
        if (isChainStore(item)) continue;
        if (seenUrls.has(item.link)) continue;
        const dom = getDomain(item.link);
        const socialDoms = ['facebook.com', 'm.facebook.com', 'instagram.com'];
        if (!socialDoms.includes(dom) && seenDomains.has(dom)) continue;
        const tk = (item.title || '').trim().replace(/\s/g, '').slice(0, 10);
        if (tk.length > 3 && seenTitles.has(tk)) continue;

        seenUrls.add(item.link);
        seenDomains.add(dom);
        if (tk.length > 3) seenTitles.add(tk);

        // Layer 1：摘要直接命中
        const combined = (item.title || '') + ' ' + (item.snippet || '') + ' ' + (item.link || '');
        const quickLinks = extractLineLinks(combined);

        allItems.push({
          title: item.title || item.link,
          url: item.link,
          snippet: item.snippet || '',
          quickLineLinks: quickLinks,
          needDeepScan: quickLinks.length === 0,
        });
      }
      if (items.length < 10) break;
      if (pg < pages) await new Promise(r => setTimeout(r, 400));
    }

    res.json({ items: allItems, total: allItems.length });
  } catch (e) {
    console.error('Search error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 掃描端點：深度爬取單一 URL
app.post('/api/scan', async (req, res) => {
  const { url, title, snippet } = req.body;
  if (!url) return res.status(400).json({ error: '缺少 url 參數' });

  try {
    const scanResult = await deepScan(url);
    const socials = scanResult.socials.filter(s => s.type !== 'LINE');
    const lineLinks = [
      ...new Set([
        ...scanResult.lineLinks,
        ...scanResult.socials.filter(s => s.type === 'LINE').map(s => s.url),
      ])
    ];

    res.json({
      url,
      title: title || url,
      snippet: snippet || '',
      lineLinks,
      socials,
      hasLine: lineLinks.length > 0,
    });
  } catch (e) {
    console.error('Scan error:', e.message);
    res.status(500).json({ error: e.message, url, hasLine: false });
  }
});

// 批次掃描端點（同時掃多個，最多 10 個）
app.post('/api/scan-batch', async (req, res) => {
  const { items } = req.body;
  if (!items || !Array.isArray(items)) return res.status(400).json({ error: '缺少 items 陣列' });

  const limit = pLimit(4); // 同時 4 個並發
  const results = await Promise.all(
    items.slice(0, 10).map(item =>
      limit(async () => {
        try {
          const scanResult = await deepScan(item.url);
          const socials = scanResult.socials.filter(s => s.type !== 'LINE');
          const lineLinks = [
            ...new Set([
              ...scanResult.lineLinks,
              ...scanResult.socials.filter(s => s.type === 'LINE').map(s => s.url),
            ])
          ];
          return { ...item, lineLinks, socials, hasLine: lineLinks.length > 0 };
        } catch (e) {
          return { ...item, lineLinks: [], socials: [], hasLine: false };
        }
      })
    )
  );

  res.json({ results });
});

app.listen(PORT, () => {
  console.log(`LINE OA Detector Backend running on port ${PORT}`);
});
