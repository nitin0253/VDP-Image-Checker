// api/image-proxy.js
// Fetches an image server-side and returns it, bypassing browser CORS restrictions.
// The frontend loads: /api/image-proxy?url=<encoded_image_url>
// The browser can then draw it to canvas and read pixels without CORS issues.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  let target;
  try {
    target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('bad protocol');
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const response = await fetch(target.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': target.origin + '/',
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return res.status(response.status).json({ error: `Upstream ${response.status}` });

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const buffer = await response.arrayBuffer();

    // Cache aggressively — images don't change
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.status(200).send(Buffer.from(buffer));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
