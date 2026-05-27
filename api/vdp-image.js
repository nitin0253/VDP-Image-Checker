// api/vdp-image.js

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url param' });

  let targetUrl;
  try {
    targetUrl = new URL(url);
    if (!['http:', 'https:'].includes(targetUrl.protocol)) throw new Error('bad protocol');
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // Try multiple fetch strategies in order
  const strategies = [
    () => fetch(targetUrl.href, {
      headers: BROWSER_HEADERS(targetUrl),
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    }),
    () => fetch(targetUrl.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    }),
    () => fetch(targetUrl.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    }),
    () => fetch(targetUrl.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': targetUrl.origin + '/',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    }),
    () => fetch(targetUrl.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    }),
  ];

  let html = null;
  let lastError = null;
  let lastStatus = null;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (let si = 0; si < strategies.length; si++) {
    try {
      // Small gap between strategies to avoid hammering
      if (si > 0) await sleep(300);
      const response = await strategies[si]();
      lastStatus = response.status;
      if (response.ok) {
        html = await response.text();
        break;
      }
      lastError = `HTTP ${response.status} (strategy ${si+1}/${strategies.length})`;
      // 429 rate limit — wait longer before next attempt
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '5');
        await sleep(Math.min(retryAfter * 1000, 8000));
      }
      // 404/410 — page doesn't exist, no point retrying
      if (response.status === 404 || response.status === 410) break;
    } catch (e) {
      lastError = `${e.message} (strategy ${si+1})`;
    }
  }

  if (!html) {
    return res.status(200).json({
      image: null,
      placeholder: false,
      error: lastError || 'all_strategies_failed',
      httpStatus: lastStatus,
    });
  }

  const result = extractHeroImage(html, targetUrl.href);
  return res.status(200).json(result);
}

// ── BROWSER HEADERS ───────────────────────────────────────────────
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

// ── BRAND LOGO / PLACEHOLDER DETECTION ───────────────────────────
// Returns true if this image is a brand logo or OEM placeholder, not a real vehicle photo
function isBrandLogoOrPlaceholder(url, html) {
  if (!url) return false;
  const u = url.toLowerCase();

  // Generic placeholder text patterns in URL
  if (/no.?image|no.?photo|coming.?soon|placeholder|default.?vehicle|stock.?photo|generic|unavailable/i.test(u)) return true;
  // Known placeholder image hashes
  if (/ccdce9f9|coming.soon/i.test(u)) return true;
  // "Images coming soon" text anywhere on page
  if (html && /images\s+coming\s+soon/i.test(html)) return true;

  // ── Brand logo patterns ───────────────────────────────────────
  // OEM logo/badge filenames
  if (/\/(logo|logos|icon|favicon|badge|emblem|brand|seal|crest|manufacturer)[^/]*\.(png|jpg|jpeg|webp|svg)/i.test(u)) return true;
  if (/\/logos?\//i.test(u)) return true;

  // Brand-specific patterns seen in the wild
  // Genesis: "genesis-logo", "genesis_logo", "genesis-badge", paths like /genesis/logo
  if (/genesis[_\-.]*(logo|badge|emblem|wings|crest|icon|brand)/i.test(u)) return true;
  if (/[_\-.]genesis[_\-.]*(logo|badge|wing)/i.test(u)) return true;
  // Genesis dealer sites — logo served from these specific paths
  if (/genesisof[^/]+\.com.*\/(?:sites|assets|images|wp-content)\/[^?]*(?:logo|brand|badge)/i.test(u)) return true;
  // Any image where the path segment is just the brand name + extension (e.g. /genesis.png, /genesis-brand.jpg)
  if (/\/genesis\.(png|jpg|jpeg|webp|svg)/i.test(u)) return true;
  // Other OEM logos
  if (/(toyota|honda|ford|chevrolet|gmc|dodge|ram|jeep|chrysler|bmw|mercedes|audi|lexus|acura|infiniti|cadillac|buick|lincoln|volvo|subaru|mazda|hyundai|kia|nissan|volkswagen|porsche|jaguar|landrover|maserati|ferrari|lamborghini)[_\-.]*(logo|badge|emblem|icon|brand|crest)/i.test(u)) return true;

  // Size signals for small logos (e.g. 200x60, 300x100 — wide+short = likely logo)
  const dimMatch = u.match(/[_\-](\d+)x(\d+)/);
  if (dimMatch) {
    const w = parseInt(dimMatch[1]), h = parseInt(dimMatch[2]);
    // Square tiny images = icons
    if (w === h && w <= 200) return true;
    // Very wide and short = banner/logo
    if (w > 0 && h > 0 && w / h > 4) return true;
  }

  // SVG/GIF are never vehicle photos
  if (/\.(svg|gif|ico)(\?|$)/i.test(u.split('?')[0])) return true;

  return false;
}

// ── LOGO/ICON FILTER ──────────────────────────────────────────────
function isLogoOrIcon(url) {
  if (!url) return false;
  return isBrandLogoOrPlaceholder(url, null);
}

// ── VEHICLE IMAGE SCORER ──────────────────────────────────────────
function scoreImageUrl(url) {
  if (!url) return -1;
  const u = url.toLowerCase();
  let score = 0;

  // Strong positive signals — vehicle photo CDN paths
  if (/vehicle|inventory|photo|car|auto|listing|vdp|unit/i.test(u)) score += 30;
  if (/\.(jpg|jpeg|webp|png)(\?|$)/i.test(u)) score += 10;
  if (/pictures\.dealer\.com/i.test(u)) score += 20;
  if (/dealerfire|dealereprocess|foxdealer|dealermade|dealercarsearch/i.test(u)) score += 20;
  if (/spyne|media\.spyne/i.test(u)) score += 25;
  if (/s3\.amazonaws\.com|cloudfront\.net/i.test(u)) score += 10;
  if (/[_\-](?:800|900|1000|1024|1200|1280|1400|1600|1920|2000|large|full|hd|hi.?res)/i.test(u)) score += 15;
  if (/w=(?:800|900|1000|1024|1200|1280|1400|1600|1920)/i.test(u)) score += 15;
  // Image path has a long hash-like segment = likely a real photo stored by UUID
  if (/\/[a-f0-9]{8,}-[a-f0-9]{4}/i.test(u)) score += 10;

  // Negative signals
  if (isBrandLogoOrPlaceholder(u, null)) score -= 200;
  if (/logo|icon|favicon|badge|emblem|sprite|banner|header.?bg/i.test(u)) score -= 50;
  if (/[_\-](16|24|32|48|64)x\d|[wh]=(?:16|24|32|48|64|80|100)(?:[^0-9]|$)/i.test(u)) score -= 40;
  if (/thumbnail.*logo|logo.*thumbnail/i.test(u)) score -= 60;
  if (/\.(svg|gif|ico)/i.test(u.split('?')[0])) score -= 200;

  return score;
}

// ── MAIN EXTRACTOR ────────────────────────────────────────────────
function extractHeroImage(html, pageUrl) {

  // Helper to check + score + return result
  function makeResult(url, source) {
    if (!url || !isRealImage(url)) return null;
    const score = scoreImageUrl(url);
    if (score < 0) return null;
    const ph = isBrandLogoOrPlaceholder(url, html);
    return { image: url, source, placeholder: ph, score };
  }

  // ── 1. og:image ──────────────────────────────────────────────────
  const ogMatches = [
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i),
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i),
  ].filter(Boolean);
  for (const m of ogMatches) {
    const r = makeResult(resolveUrl(m[1], pageUrl), 'og:image');
    if (r) return r;
  }

  // ── 2. twitter:image ─────────────────────────────────────────────
  const tw = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
           || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
  if (tw?.[1]) {
    const r = makeResult(resolveUrl(tw[1], pageUrl), 'twitter:image');
    if (r) return r;
  }

  // ── 3. JSON-LD ───────────────────────────────────────────────────
  const jsonLdBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of jsonLdBlocks) {
    try {
      const data = JSON.parse(block[1]);
      const img = findJsonLdImage(data);
      if (img) {
        const r = makeResult(resolveUrl(img, pageUrl), 'json-ld');
        if (r) return r;
      }
    } catch { }
  }

  // ── 4. Inline scripts — collect all candidates ───────────────────
  const scriptContent = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1]).join('\n');
  const scriptImgPattern = /["'`](https:\/\/[^"'`\s]{10,}\.(jpe?g|png|webp)[^"'`\s]{0,200})["'`]/gi;
  const candidates = [];
  let m;
  while ((m = scriptImgPattern.exec(scriptContent)) !== null) {
    const u = m[1];
    if (!isRealImage(u)) continue;
    const score = scoreImageUrl(u);
    if (score > 0) candidates.push({ url: u, score, source: 'cdn-js' });
  }

  // ── 5. data-src / data-lazy attributes ───────────────────────────
  const dataAttrPattern = /data-(?:src|lazy|original|image|photo|url|img)=["']([^"']+)["']/gi;
  while ((m = dataAttrPattern.exec(html)) !== null) {
    const u = resolveUrl(m[1], pageUrl);
    if (!isRealImage(u)) continue;
    const score = scoreImageUrl(u);
    if (score > 0) candidates.push({ url: u, score, source: 'data-attr' });
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const ph = isBrandLogoOrPlaceholder(best.url, html);
    return { image: best.url, source: best.source, placeholder: ph, score: best.score };
  }

  // ── 6. vehicle/gallery context <img> ─────────────────────────────
  const vehicleCtx = html.match(
    /(?:class=["'][^"']*(?:vehicle|inventory|gallery|carousel|hero|primary-image|main-image|vdp-photo|slider)[^"']*["'])[\s\S]{0,4000}?(<img[^>]+>)/i
  );
  if (vehicleCtx) {
    const src = extractSrc(vehicleCtx[1]);
    if (src) {
      const r = makeResult(resolveUrl(src, pageUrl), 'gallery-img');
      if (r) return r;
    }
  }

  // ── 7. Best-scored <img> anywhere ────────────────────────────────
  const allImgs = [...html.matchAll(/<img[^>]+>/gi)];
  const imgCandidates = [];
  for (const match of allImgs) {
    const src = extractSrc(match[0]);
    if (!src) continue;
    const u = resolveUrl(src, pageUrl);
    if (!isRealImage(u)) continue;
    const score = scoreImageUrl(u);
    imgCandidates.push({ url: u, score, source: 'img-tag' });
  }
  if (imgCandidates.length > 0) {
    imgCandidates.sort((a, b) => b.score - a.score);
    const best = imgCandidates[0];
    if (best.score >= 0) {
      const ph = isBrandLogoOrPlaceholder(best.url, html);
      return { image: best.url, source: best.source, placeholder: ph };
    }
  }

  return { image: null, source: null, placeholder: false, error: 'no_image_found' };
}

// ── HELPERS ───────────────────────────────────────────────────────
function extractSrc(tag) {
  return tag.match(/\ssrc=["']([^"']+)["']/i)?.[1]
      || tag.match(/\sdata-src=["']([^"']+)["']/i)?.[1]
      || tag.match(/\sdata-lazy=["']([^"']+)["']/i)?.[1]
      || null;
}

function isRealImage(url) {
  if (!url || url.length < 10) return false;
  if (!url.startsWith('http')) return false;
  if (/\.(svg|gif|ico|woff|woff2|ttf|eot|css|js)(\?|$)/i.test(url.split('?')[0])) return false;
  if (/^data:/i.test(url)) return false;
  return true;
}

function findJsonLdImage(data) {
  if (!data) return null;
  if (Array.isArray(data)) {
    for (const item of data) { const r = findJsonLdImage(item); if (r) return r; }
  }
  if (typeof data === 'object') {
    if (data.image) {
      if (typeof data.image === 'string') return data.image;
      if (Array.isArray(data.image) && data.image[0]) return typeof data.image[0] === 'string' ? data.image[0] : data.image[0].url;
      if (typeof data.image === 'object') return data.image.url || null;
    }
    for (const val of Object.values(data)) {
      if (typeof val === 'object') { const r = findJsonLdImage(val); if (r) return r; }
    }
  }
  return null;
}

function resolveUrl(src, base) {
  try { return new URL(src, base).href; } catch { return src; }
}
