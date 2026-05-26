// api/enterprises.js
// Lightweight endpoint — returns only enterprise+team list (no full VIN rows).
// Parses only 5 columns from the CSV for speed.
// Has its own in-memory cache separate from data.js.

const VIN_URL = "https://metabase.spyne.ai/public/question/2f5d51f1-8069-4d3d-a8e1-24376d88c930.csv";
const CACHE_TTL = 10 * 60 * 1000;
let _cache = null, _cacheAt = 0, _buildPromise = null;

function splitRow(row) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '"') { if (q && row[i+1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ',' && !q) { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  out.push(cur.trim()); return out;
}

async function _build() {
  const resp = await fetch(VIN_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(90000),
  });
  if (!resp.ok) throw new Error(`CSV ${resp.status}`);

  const text = await resp.text();
  const lines = text.trim().split(/\r?\n/);
  const hdrs = splitRow(lines[0]);

  // Only extract columns we need — skip full row parse
  const iEid      = hdrs.indexOf('enterpriseId');
  const iEntName  = hdrs.indexOf('enterprise_name');
  const iTeamId   = hdrs.indexOf('teamId');
  const iTeamName = hdrs.indexOf('team_name');
  const iVdpUrl   = hdrs.indexOf('vdp_url');

  const entMap = {};

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const vals   = splitRow(line);
    const eid    = (vals[iEid]     || '').trim();
    const eName  = (vals[iEntName] || eid || 'Unknown').trim();
    const tName  = (vals[iTeamName]|| (vals[iTeamId]||'') || 'Unknown').trim();
    const hasVdp = iVdpUrl >= 0 && (vals[iVdpUrl] || '').trim().length > 4;

    if (!entMap[eName]) entMap[eName] = { name: eName, eid, teams: {}, count: 0, vdpCount: 0 };
    entMap[eName].count++;
    if (hasVdp) entMap[eName].vdpCount++;
    if (tName) {
      if (!entMap[eName].teams[tName]) entMap[eName].teams[tName] = { count: 0, vdpCount: 0 };
      entMap[eName].teams[tName].count++;
      if (hasVdp) entMap[eName].teams[tName].vdpCount++;
    }
  }

  const enterprises = Object.values(entMap)
    .sort((a, b) => b.count - a.count)
    .map(e => ({
      name:     e.name,
      eid:      e.eid,
      count:    e.count,
      vdpCount: e.vdpCount,
      teams:    Object.entries(e.teams)
        .sort((a, b) => b[1].count - a[1].count)
        .map(([name, t]) => ({ name, count: t.count, vdpCount: t.vdpCount })),
    }));

  return { enterprises, totalVins: lines.length - 1 };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Cache at CDN edge for 2 min — subsequent requests served instantly from edge
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    if (req.query.force === '1') { _cache = null; _cacheAt = 0; }

    const now = Date.now();
    const isStale = !_cache || (now - _cacheAt >= CACHE_TTL);

    // If we have ANY cached data, return it immediately (even if stale)
    // and refresh in the background so the NEXT request is fast
    if (_cache && isStale && !_buildPromise) {
      _buildPromise = _build()
        .then(data => { _cache = { ...data, cachedAt: new Date().toISOString() }; _cacheAt = Date.now(); })
        .finally(() => { _buildPromise = null; });
      // Return stale data right now — don't wait
      return res.status(200).json({ ..._cache, stale: true });
    }

    if (_cache && !isStale) {
      return res.status(200).json(_cache);
    }

    // No cache at all — must wait (first ever load)
    if (!_buildPromise) {
      _buildPromise = _build()
        .then(data => { _cache = { ...data, cachedAt: new Date().toISOString() }; _cacheAt = Date.now(); return _cache; })
        .finally(() => { _buildPromise = null; });
    }

    const data = await _buildPromise;
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
