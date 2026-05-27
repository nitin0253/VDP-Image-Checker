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
    // Strategy 1: Full Chrome browser headers
    () => fetch(targetUrl.href, {
      headers: BROWSER_HEADERS(targetUrl),
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    }),
    // Strategy 2: Different Chrome version + cookies cleared
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
    // Strategy 3: Googlebot
    () => fetch(targetUrl.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    }),
    // Strategy 4: Mobile Safari (bypasses some desktop bot detection)
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
    // Strategy 5: Plain fetch with minimal headers (some sites block over-specified headers)
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

  for (let si = 0; si < strategies.length; si++) {
    try {
      const response = await strategies[si]();
      lastStatus = response.status;
      if (response.ok) {
        html = await response.text();
        break;
      }
      lastError = `HTTP ${response.status} (strategy ${si+1}/${strategies.length})`;
      // 400/403/429 — try next strategy; 404/410 — no point retrying
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

// ── PLACEHOLDER DETECTION ─────────────────────────────────────────
function isPlaceholder(url, html) {
  if (!url) return false;
  if (/no.?image|no.?photo|coming.?soon|placeholder|default.?vehicle|stock.?photo|generic|unavailable/i.test(url)) return true;
  if (/ccdce9f9e428|coming.soon/i.test(url)) return true;
  if (html && /images\s+coming\s+soon/i.test(html)) return true;
  return false;
}

// ── LOGO/ICON FILTER ──────────────────────────────────────────────
// Returns true if the URL looks like a logo, icon, or brand asset rather than a vehicle photo
function isLogoOrIcon(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  // Filename patterns
  if (/\/(logo|icon|favicon|badge|emblem|brand|header|sprite|banner|btn|button|arrow|star|check|seal)[^/]*\.(png|jpg|jpeg|webp|gif)/i.test(u)) return true;
  // Very small images often used as logos in CDN paths
  if (/[_\-](16|24|32|48|64|80|96|100|120|128|150|160|180|200)x\1/i.test(u)) return true; // square thumbnails like 32x32
  // Dealer.com logo paths — logo images have specific hash patterns we can detect by size hint
  // If path has no dimension hints and looks like a single small asset, skip
  if (/\/logos?\//i.test(u)) return true;
  return false;
}

// ── VEHICLE IMAGE SCORER ──────────────────────────────────────────
// Scores a candidate URL — higher = more likely to be a real vehicle photo
function scoreImageUrl(url) {
  if (!url) return -1;
  const u = url.toLowerCase();
  let score = 0;

  // Strong positive signals
  if (/vehicle|inventory|photo|car|auto|listing|vdp|unit/i.test(u)) score += 30;
  if (/\.(jpg|jpeg|webp|png)(\?|$)/i.test(u)) score += 10;
  // CDN domains known to host vehicle photos
  if (/pictures\.dealer\.com/i.test(u)) score += 20;
  if (/dealerfire|dealereprocess|foxdealer|dealermade|dealercarsearch/i.test(u)) score += 20;
  if (/spyne|media\.spyne/i.test(u)) score += 25;
  if (/s3\.amazonaws\.com|cloudfront\.net/i.test(u)) score += 10;
  // Large image hints in URL
  if (/[_\-](?:800|900|1000|1024|1200|1280|1400|1600|1920|2000|large|full|hd|hi.?res)/i.test(u)) score += 15;
  if (/w=(?:800|900|1000|1024|1200|1280|1400|1600|1920)/i.test(u)) score += 15;

  // Negative signals
  if (isLogoOrIcon(u)) score -= 100;
  if (/logo|icon|favicon|badge|emblem|sprite|banner|header.?bg/i.test(u)) score -= 50;
  // Small dimensions in URL
  if (/[_\-](16|24|32|48|64)x\d|[wh]=(?:16|24|32|48|64|80|100)(?:[^0-9]|$)/i.test(u)) score -= 40;
  if (/thumbnail.*logo|logo.*thumbnail/i.test(u)) score -= 60;
  // SVG/GIF never vehicle photos
  if (/\.(svg|gif|ico)/i.test(u.split('?')[0])) score -= 200;

  return score;
}

// ── MAIN EXTRACTOR ────────────────────────────────────────────────
function extractHeroImage(html, pageUrl) {

  // ── 1. og:image ──────────────────────────────────────────────────
  const ogMatches = [
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i),
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i),
  ].filter(Boolean);
  for (const m of ogMatches) {
    const u = resolveUrl(m[1], pageUrl);
    if (isRealImage(u) && scoreImageUrl(u) >= 0) {
      return { image: u, source: 'og:image', placeholder: isPlaceholder(u, html) };
    }
  }

  // ── 2. twitter:image ─────────────────────────────────────────────
  const tw = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
           || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
  if (tw?.[1]) {
    const u = resolveUrl(tw[1], pageUrl);
    if (isRealImage(u) && scoreImageUrl(u) >= 0) {
      return { image: u, source: 'twitter:image', placeholder: isPlaceholder(u, html) };
    }
  }

  // ── 3. JSON-LD ───────────────────────────────────────────────────
  const jsonLdBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of jsonLdBlocks) {
    try {
      const data = JSON.parse(block[1]);
      const img = findJsonLdImage(data);
      if (img) {
        const u = resolveUrl(img, pageUrl);
        if (isRealImage(u) && scoreImageUrl(u) >= 0) {
          return { image: u, source: 'json-ld', placeholder: isPlaceholder(u, html) };
        }
      }
    } catch { }
  }

  // ── 4. Inline JS / script blocks — collect ALL candidate image URLs ──
  const scriptContent = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1]).join('\n');

  // Extract all https image URLs from scripts, score them, pick the best
  const scriptImgPattern = /["'`](https:\/\/[^"'`\s]{10,}\.(jpe?g|png|webp)[^"'`\s]{0,200})["'`]/gi;
  const candidates = [];
  let m;
  while ((m = scriptImgPattern.exec(scriptContent)) !== null) {
    const u = m[1];
    if (!isRealImage(u)) continue;
    const score = scoreImageUrl(u);
    if (score > 0) candidates.push({ url: u, score, source: 'cdn-js' });
  }

  // Also check data-src / data-lazy attributes in HTML
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
    return { image: best.url, source: best.source, placeholder: isPlaceholder(best.url, html) };
  }

  // ── 5. First <img> in vehicle/gallery container ───────────────────
  const vehicleCtx = html.match(
    /(?:class=["'][^"']*(?:vehicle|inventory|gallery|carousel|hero|primary-image|main-image|vdp-photo|slider)[^"']*["'])[\s\S]{0,4000}?(<img[^>]+>)/i
  );
  if (vehicleCtx) {
    const src = extractSrc(vehicleCtx[1]);
    if (src) {
      const u = resolveUrl(src, pageUrl);
      if (isRealImage(u) && scoreImageUrl(u) >= 0) {
        return { image: u, source: 'gallery-img', placeholder: isPlaceholder(u, html) };
      }
    }
  }

  // ── 6. Best-scored <img> anywhere ───────────────────────────────
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
      return { image: best.url, source: best.source, placeholder: isPlaceholder(best.url, html) };
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

function resolveUrl(src, base) {
  if (!src) return src;
  try { return new URL(src, base).href; } catch { return src; }
}

function isRealImage(url) {
  if (!url || url.startsWith('data:') || url.length < 10) return false;
  const clean = url.split('?')[0].toLowerCase();
  if (/\.(svg|gif|ico|css|js|html|woff|ttf|eot|mp4|webm)$/.test(clean)) return false;
  return true;
}

function findJsonLdImage(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.image === 'string') return obj.image;
  if (Array.isArray(obj.image)) return typeof obj.image[0] === 'string' ? obj.image[0] : obj.image[0]?.url;
  if (obj.image?.url) return obj.image.url;
  if (obj.primaryImageOfPage?.url) return obj.primaryImageOfPage.url;
  for (const val of Object.values(obj)) {
    if (typeof val === 'object') {
      const found = findJsonLdImage(val);
      if (found) return found;
    }
  }
  return null;
}
