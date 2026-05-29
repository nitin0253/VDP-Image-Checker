// api/vdp-image.js
// Extracts the first/hero vehicle image from a dealer VDP page.
// Handles: standard img tags, og:image, JSON-LD, 360 spin viewers,
// lazy-loaded galleries, and JS-embedded image arrays.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { url, vin } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url param' });

  let targetUrl;
  try {
    targetUrl = new URL(url);
    if (!['http:', 'https:'].includes(targetUrl.protocol)) throw new Error('bad protocol');
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // CF_WORKER env var: set to your Cloudflare Worker URL to bypass Vercel network blocks
  // e.g. CF_WORKER=https://lively-glade-8921.nitin-kumar.workers.dev
  const cfWorker = (typeof CF_WORKER !== 'undefined' && CF_WORKER) ? CF_WORKER : (process.env.CF_WORKER || '');

  const strategies = [
    () => fetch(targetUrl.href, { headers: BROWSER_HEADERS(targetUrl), redirect: 'follow', signal: AbortSignal.timeout(15000) }),
    () => fetch(targetUrl.href, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.5', 'Accept-Encoding': 'gzip, deflate, br', 'Connection': 'keep-alive', 'Upgrade-Insecure-Requests': '1', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' },
      redirect: 'follow', signal: AbortSignal.timeout(15000),
    }),
    () => fetch(targetUrl.href, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(15000) }),
    () => fetch(targetUrl.href, { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Referer': targetUrl.origin + '/' }, redirect: 'follow', signal: AbortSignal.timeout(15000) }),
    () => fetch(targetUrl.href, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }, redirect: 'follow', signal: AbortSignal.timeout(15000) }),
    // Strategy 6: Route through Cloudflare Worker (bypasses Vercel network blocks)
    ...(cfWorker ? [() => fetch(cfWorker + '?url=' + encodeURIComponent(targetUrl.href), {
      headers: { 'Accept': 'text/html' },
      signal: AbortSignal.timeout(20000)
    })] : []),
  ];

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let html = null, lastError = null, lastStatus = null;

  for (let si = 0; si < strategies.length; si++) {
    try {
      if (si > 0) await sleep(300);
      const response = await strategies_ref[si]();
      lastStatus = response.status;
      if (response.ok) {
        // Check if we got redirected to homepage (VDP no longer exists)
        const finalUrl = response.url || targetUrl.href;
        const finalPath = new URL(finalUrl).pathname;
        const origPath = targetUrl.pathname;
        // If redirected to root/homepage (path much shorter than original), VDP is gone
        if (finalPath !== origPath && (finalPath === '/' || finalPath === '' || finalPath.split('/').length < origPath.split('/').length - 2)) {
          lastError = 'VDP no longer available (redirected to homepage)';
          lastStatus = 301;
          break;
        }
        html = await response.text();
        // Also check if page content indicates "not found" / "sold" / "no longer available"
        const snippet = html.slice(0, 3000).toLowerCase();
        if (/could not find|no longer available|page not found|vehicle.*sold|this vehicle.*no longer/i.test(snippet)) {
          lastError = 'VDP no longer available (vehicle sold or removed)';
          lastStatus = 410;
          html = null;
          break;
        }
        break;
      }
      lastError = `HTTP ${response.status} (strategy ${si+1}/${strategies_ref.length})`;
      if (response.status === 429) { const ra = parseInt(response.headers.get('retry-after') || '5'); await sleep(Math.min(ra * 1000, 8000)); }
      if (response.status === 404 || response.status === 410) break;
    } catch (e) {
      lastError = `${e.message} (strategy ${si+1})`;
    }
  }

  if (!html) {
    // All strategies failed — try to extract image from page metadata without loading full HTML
    // Some sites 403 on HTML but allow direct image CDN access
    const fallback = await tryDirectImageExtraction(targetUrl.href, lastStatus);
    if (fallback) return res.status(200).json(fallback);

    // Classify the error for better UX
    const errMsg = lastStatus === 403 ? 'VDP site blocks automated access (403)' :
                   lastStatus === 429 ? 'Rate limited by VDP site (429)' :
                   lastStatus === 404 ? 'VDP page not found (404)' :
                   lastError || 'all_strategies_failed';
    return res.status(200).json({ image: null, placeholder: false, error: errMsg, httpStatus: lastStatus });
  }

  let result = extractHeroImage(html, targetUrl.href);

  // VIN validation: if VIN provided and extracted image doesn't contain the VIN,
  // try to find a better image that does contain the VIN in its URL
  if (vin && result.image && !result.image.toLowerCase().includes(vin.toLowerCase())) {
    const vinResult = extractVinImage(html, targetUrl.href, vin);
    if (vinResult) result = vinResult;
  }

  return res.status(200).json(result);
}

function BROWSER_HEADERS(targetUrl) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Referer': targetUrl.origin + '/',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  };
}

// ── BRAND LOGO / PLACEHOLDER DETECTION ────────────────────────────
function isBrandLogoOrPlaceholder(url, html) {
  if (!url) return false;
  const u = url.toLowerCase();

  if (/no.?image|no.?photo|coming.?soon|placeholder|default.?vehicle|stock.?photo|generic|unavailable/i.test(u)) return true;
  if (/ccdce9f9|coming.?soon|comingsoon/i.test(u)) return true;
  if (html && /images\s+coming\s+soon/i.test(html)) return true;
  // "Coming Soon" / car cover images
  if (/coming.?soon|car.?cover|vehicle.?cover|under.?cover|unveil|comingsoon/i.test(u)) return true;
  // Check HTML for "COMING SOON" text overlay on image
  if (html && /COMING\s+SOON|coming-soon-image|img-coming-soon/i.test(html)) return true;

  // Logo filename patterns
  if (/\/(logo|logos|icon|favicon|badge|emblem|brand|seal|crest|manufacturer)[^/]*\.(png|jpg|jpeg|webp|svg)/i.test(u)) return true;
  if (/\/logos?\//i.test(u)) return true;

  // OEM brand logo patterns (all major brands)
  const brands = 'genesis|acura|toyota|honda|ford|chevrolet|gmc|dodge|ram|jeep|chrysler|bmw|mercedes|audi|lexus|infiniti|cadillac|buick|lincoln|volvo|subaru|mazda|hyundai|kia|nissan|volkswagen|porsche|jaguar|landrover|maserati|ferrari|lamborghini|bentley|rolls.royce|aston.martin';
  if (new RegExp(`(${brands})[_\\-.]*(logo|badge|emblem|icon|brand|crest|symbol)`, 'i').test(u)) return true;
  if (new RegExp(`/(${brands})\\.(png|jpg|jpeg|webp|svg)`, 'i').test(u)) return true;

  // Genesis-specific
  if (/genesis[_\-.]*(logo|badge|emblem|wings|crest|icon|brand)/i.test(u)) return true;
  if (/genesisof[^/]+\.com.*\/(?:sites|assets|images|wp-content)\/[^?]*(?:logo|brand|badge)/i.test(u)) return true;

  // Acura-specific: the Acura 'A' logo CDN pattern
  if (/acura[^/]*logo|acura[^/]*badge|acura[^/]*emblem/i.test(u)) return true;
  // Acura spinner/360 placeholder image
  if (/360.*spin|spin.*360|spincar|evox|ev0x/i.test(u)) return false; // these are real spin images, NOT placeholders

  // Size signals
  const dimMatch = u.match(/[_\-](\d+)x(\d+)/);
  if (dimMatch) {
    const w = parseInt(dimMatch[1]), h = parseInt(dimMatch[2]);
    if (w === h && w <= 200) return true;
    if (w > 0 && h > 0 && w / h > 4) return true;
  }

  if (/\.(svg|gif|ico)(\?|$)/i.test(u.split('?')[0])) return true;
  return false;
}

// ── VEHICLE IMAGE SCORER ──────────────────────────────────────────
function scoreImageUrl(url) {
  if (!url) return -1;
  const u = url.toLowerCase();
  let score = 0;

  // Strong positive: known vehicle photo CDNs
  if (/vehicle|inventory|photo|listing|vdp|unit|gallery/i.test(u)) score += 30;
  if (/\.(jpg|jpeg|webp|png)(\?|$)/i.test(u)) score += 10;
  if (/pictures\.dealer\.com/i.test(u)) score += 30;
  if (/inv\.assets\.|invimg\.|dealerinspire|dealereprocess|foxdealer|dealermade|dealercarsearch|izmocars|gubagoo/i.test(u)) score += 25;
  if (/dealerfire/i.test(u)) score += 25;
  if (/spyne|media\.spyne/i.test(u)) score += 25;
  if (/s3\.amazonaws\.com|cloudfront\.net/i.test(u)) score += 10;
  if (/imagin\.studio|autoexposure|dealer\.com\/images/i.test(u)) score += 20;
  // 360 spin / spincar images — real vehicle photos
  if (/spincar|360spin|evox|spin\.dealer/i.test(u)) score += 20;
  // Large dimension hints
  if (/[_\-](?:800|900|1000|1024|1200|1280|1400|1600|1920|2000|large|full|hd)/i.test(u)) score += 15;
  if (/w=(?:800|900|1000|1024|1200|1280|1400|1600|1920)/i.test(u)) score += 15;
  if (/width=(?:800|900|1000|1024|1200|1280|1400|1600|1920)/i.test(u)) score += 15;
  // UUID path segments = real photos
  if (/\/[a-f0-9]{8,}-[a-f0-9]{4}/i.test(u)) score += 10;
  // Long hash filename = CDN-stored photo
  if (/\/[a-f0-9]{16,}\.(jpg|jpeg|png|webp)/i.test(u)) score += 15;

  // Negative signals
  if (isBrandLogoOrPlaceholder(u, null)) score -= 200;
  // Coming soon cover images have specific visual patterns in alt text
  if (/coming.?soon|car.?cover/i.test(u)) score -= 200;
  if (/logo|icon|favicon|badge|emblem|sprite|banner|header.?bg/i.test(u)) score -= 50;
  if (/[_\-](16|24|32|48|64)x\d|[wh]=(?:16|24|32|48|64|80|100)(?:[^0-9]|$)/i.test(u)) score -= 40;
  if (/\.(svg|gif|ico)/i.test(u.split('?')[0])) score -= 200;

  return score;
}

// ── DIRECT IMAGE EXTRACTION FALLBACK ─────────────────────────────
// When the VDP page itself is blocked (403), try alternative methods
async function tryDirectImageExtraction(pageUrl, httpStatus) {
  try {
    const u = new URL(pageUrl);

    // Method 1: Try fetching just the OG tags via a lightweight HEAD+tiny GET
    // Some CDNs serve a small metadata-only version
    const metaResp = await fetch(pageUrl, {
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);

    if (metaResp && metaResp.ok) {
      const text = await metaResp.text();
      const og = text.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
               || text.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
      if (og?.[1]) {
        const imgUrl = resolveUrl(og[1], pageUrl);
        if (isRealImage(imgUrl) && !isBrandLogoOrPlaceholder(imgUrl, text)) {
          return { image: imgUrl, source: 'og:image-fb-crawl', placeholder: false };
        }
      }
    }

    // Method 2: Known dealer platform CDN patterns
    // DealerSocket / Dealer.com — images at predictable paths
    // Extract stock number or VIN from URL and try CDN directly
    const vinMatch = pageUrl.match(/[A-HJ-NPR-Z0-9]{17}/i);
    if (vinMatch) {
      const vin = vinMatch[0].toUpperCase();
      // Dealer.com CDN pattern
      const dealerComUrl = `https://pictures.dealer.com/${u.hostname.split('.')[0]}/`;
      // Try spincar CDN which many dealers use
      const spincarUrl = `https://cdn.spincar.com/swiper-exp/${u.hostname}/${vin}/0/`;
      for (const tryUrl of [spincarUrl]) {
        const r = await fetch(tryUrl, { signal: AbortSignal.timeout(5000) }).catch(() => null);
        if (r && r.ok && r.headers.get('content-type')?.includes('image')) {
          return { image: tryUrl, source: 'spincar-direct', placeholder: false };
        }
      }
    }
  } catch {}
  return null;
}

// ── VIN-SPECIFIC IMAGE EXTRACTOR ────────────────────────────────
function extractVinImage(html, pageUrl, vin) {
  const vinLower = vin.toLowerCase();
  const candidates = [];
  let pos = 0;

  // Search for the VIN in the HTML, then find surrounding image URLs
  while (pos < html.length) {
    const vinPos = html.toLowerCase().indexOf(vinLower, pos);
    if (vinPos === -1) break;

    // Look back up to 300 chars for an https:// URL start
    const lookBack = Math.max(0, vinPos - 300);
    const segment = html.slice(lookBack, vinPos + vin.length + 50);
    const httpIdx = segment.lastIndexOf('https://');
    if (httpIdx >= 0) {
      const urlSegment = segment.slice(httpIdx);
      const endIdx = urlSegment.search(/["'\s<>\`]/);
      const u = endIdx > 0 ? urlSegment.slice(0, endIdx) : urlSegment.slice(0, 200);
      const cleaned = u.replace(/[,;)]+$/, '');
      if (isRealImage(cleaned) && !isBrandLogoOrPlaceholder(cleaned, null)) {
        candidates.push({ url: resolveUrl(cleaned, pageUrl), score: scoreImageUrl(cleaned) + 50, source: 'vin-match' });
      }
    }
    pos = vinPos + 1;
  }

  // Also check data-src attributes for VIN
  const dataSrcPat = /data-(?:src|lazy|original)="([^"]+)"/g;
  let m;
  while ((m = dataSrcPat.exec(html)) !== null) {
    if (m[1].toLowerCase().includes(vinLower) && isRealImage(m[1])) {
      candidates.push({ url: resolveUrl(m[1], pageUrl), score: scoreImageUrl(m[1]) + 50, source: 'vin-data-src' });
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return { image: best.url, source: best.source, placeholder: false };
}

// ── MAIN EXTRACTOR ────────────────────────────────────────────────
function extractHeroImage(html, pageUrl) {

  function makeResult(url, source) {
    if (!url || !isRealImage(url)) return null;
    const score = scoreImageUrl(url);
    if (score < 0) return null;
    const ph = isBrandLogoOrPlaceholder(url, html);
    return { image: url, source, placeholder: ph, score };
  }

  // Collect all candidates into a pool, then pick the best non-logo one
  const pool = [];

  // ── 1. og:image ──────────────────────────────────────────────────
  for (const pattern of [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
  ]) {
    const m = html.match(pattern);
    if (m?.[1]) { const r = makeResult(resolveUrl(m[1], pageUrl), 'og:image'); if (r) pool.push(r); }
  }

  // ── 2. twitter:image ─────────────────────────────────────────────
  const tw = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
           || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
  if (tw?.[1]) { const r = makeResult(resolveUrl(tw[1], pageUrl), 'twitter:image'); if (r) pool.push(r); }

  // ── 3. JSON-LD ───────────────────────────────────────────────────
  for (const block of [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]) {
    try {
      const img = findJsonLdImage(JSON.parse(block[1]));
      if (img) { const r = makeResult(resolveUrl(img, pageUrl), 'json-ld'); if (r) pool.push(r); }
    } catch { }
  }

  // ── 4. Inline JS — extract all image URL candidates ───────────────
  const scriptContent = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');
  let m;
  const jsUrlPat = /["'`](https:\/\/[^"'`\s]{10,}\.(jpe?g|png|webp)[^"'`\s]{0,300})["'`]/gi;
  while ((m = jsUrlPat.exec(scriptContent)) !== null) {
    const score = scoreImageUrl(m[1]);
    if (score > 0 && isRealImage(m[1])) pool.push({ url: m[1], score, source: 'js-embed', placeholder: isBrandLogoOrPlaceholder(m[1], null) });
  }

  // ── 5. data-src / lazy load attributes ───────────────────────────
  const dataPat = /data-(?:src|lazy|original|image|photo|url|img|full|zoom|large)=["']([^"']{10,})["']/gi;
  while ((m = dataPat.exec(html)) !== null) {
    const u = resolveUrl(m[1], pageUrl);
    const score = scoreImageUrl(u);
    if (score > 0 && isRealImage(u)) pool.push({ url: u, score, source: 'data-attr', placeholder: isBrandLogoOrPlaceholder(u, null) });
  }

  // ── 6. Gallery/thumbnail <img> tags ───────────────────────────────
  // Specifically look for thumbnail grids (like the Jenkins Acura right panel)
  const galleryPat = /(?:class=["'][^"']*(?:gallery|thumbnail|thumb|carousel|slider|photo.?grid|image.?list|media.?grid)[^"']*["'])[\s\S]{0,6000}?(<img[^>]+>)/gi;
  while ((m = galleryPat.exec(html)) !== null) {
    const src = extractSrc(m[1]);
    if (src) {
      const u = resolveUrl(src, pageUrl);
      const score = scoreImageUrl(u);
      if (score > 0 && isRealImage(u)) pool.push({ url: u, score: score + 10, source: 'gallery-thumb', placeholder: isBrandLogoOrPlaceholder(u, null) });
    }
  }

  // ── 7. VDP / vehicle context container ───────────────────────────
  const vdpPat = /(?:class=["'][^"']*(?:vehicle|inventory|vdp|primary.?image|hero.?image|main.?photo|featured|product.?image)[^"']*["'])[\s\S]{0,4000}?(<img[^>]+>)/gi;
  while ((m = vdpPat.exec(html)) !== null) {
    const src = extractSrc(m[1]);
    if (src) {
      const u = resolveUrl(src, pageUrl);
      const score = scoreImageUrl(u);
      if (score >= 0 && isRealImage(u)) pool.push({ url: u, score: score + 5, source: 'vdp-container', placeholder: isBrandLogoOrPlaceholder(u, null) });
    }
  }

  // ── 8. All <img> tags ─────────────────────────────────────────────
  for (const match of [...html.matchAll(/<img[^>]+>/gi)]) {
    const src = extractSrc(match[0]);
    if (!src) continue;
    const u = resolveUrl(src, pageUrl);
    if (!isRealImage(u)) continue;
    const score = scoreImageUrl(u);
    if (score >= 0) pool.push({ url: u, score, source: 'img-tag', placeholder: isBrandLogoOrPlaceholder(u, null) });
  }

  if (!pool.length) return { image: null, source: null, placeholder: false, error: 'no_image_found' };

  // Sort: real vehicle photos first (non-placeholder), then by score descending
  pool.sort((a, b) => {
    if (a.placeholder !== b.placeholder) return a.placeholder ? 1 : -1;
    return b.score - a.score;
  });

  const best = pool[0];
  return { image: best.url, source: best.source, placeholder: best.placeholder, score: best.score };
}

// ── HELPERS ───────────────────────────────────────────────────────
function extractSrc(tag) {
  // Prefer data-src / data-lazy over src (for lazy-loaded images the real URL is in data-*)
  return tag.match(/\sdata-(?:src|lazy|original|full|zoom)=["']([^"']{10,})["']/i)?.[1]
      || tag.match(/\ssrc=["']([^"']+)["']/i)?.[1]
      || null;
}

function isRealImage(url) {
  if (!url || url.length < 10) return false;
  if (!url.startsWith('http')) return false;
  if (/^data:/i.test(url)) return false;
  if (/\.(css|js|woff|woff2|ttf|eot)(\?|$)/i.test(url)) return false;
  if (/\.(svg|gif|ico)(\?|$)/i.test(url.split('?')[0])) return false;
  return true;
}

function findJsonLdImage(data) {
  if (!data) return null;
  if (Array.isArray(data)) { for (const i of data) { const r = findJsonLdImage(i); if (r) return r; } }
  if (typeof data === 'object') {
    if (data.image) {
      if (typeof data.image === 'string') return data.image;
      if (Array.isArray(data.image) && data.image[0]) return typeof data.image[0] === 'string' ? data.image[0] : data.image[0].url;
      if (typeof data.image === 'object') return data.image.url || null;
    }
    for (const val of Object.values(data)) { if (typeof val === 'object') { const r = findJsonLdImage(val); if (r) return r; } }
  }
  return null;
}

function resolveUrl(src, base) {
  try { return new URL(src, base).href; } catch { return src; }
}
