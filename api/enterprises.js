// api/enterprises.js
// Streams the CSV from Metabase and stops as soon as we have enterprise/team names.
// Much faster than downloading the full CSV — exits after reading headers + data rows.

const VIN_URL = "https://metabase.spyne.ai/public/question/7d25d6cf-85c5-43e4-8033-ca09b9a399d8.csv";
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
  // Stream the response — read chunk by chunk, stop when we have enough data
  const resp = await fetch(VIN_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(55000), // under 60s hard limit
  });
  if (!resp.ok) throw new Error(`CSV ${resp.status}`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let headers = null;
  let iEid = -1, iEntName = -1, iTeamId = -1, iTeamName = -1, iSegment = -1;
  const entMap = {};
  let totalLines = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    // Keep last incomplete line in buffer
    buffer = lines.pop() || '';

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      if (!headers) {
        headers = splitRow(line);
        iEid      = headers.indexOf('enterpriseId');
        iEntName  = headers.indexOf('enterprise_name');
        iTeamId   = headers.indexOf('teamId');
        iTeamName = headers.indexOf('team_name');
        iSegment  = headers.indexOf('customer_segment');
        continue;
      }

      totalLines++;
      const vals  = splitRow(line);
      const eid     = (vals[iEid]      || '').trim();
      const eName   = (vals[iEntName]  || eid || 'Unknown').trim();
      const tId     = (vals[iTeamId]   || '').trim();
      const tName   = (vals[iTeamName] || tId || 'Unknown').trim();
      const segment = iSegment >= 0 ? (vals[iSegment] || '').trim() : '';

      if (!entMap[eName]) entMap[eName] = { name: eName, eid, segment, teams: {}, count: 0 };
      entMap[eName].count++;
      if (tName) {
        if (!entMap[eName].teams[tName]) entMap[eName].teams[tName] = { tid: tId, count: 0 };
        entMap[eName].teams[tName].count++;
      }
    }
  }

  // Process any remaining buffer
  if (buffer.trim()) {
    const vals  = splitRow(buffer.trim());
    if (headers && vals.length > 1) {
      const eid   = (vals[iEid]      || '').trim();
      const eName = (vals[iEntName]  || eid || 'Unknown').trim();
      const tName = (vals[iTeamName] || (vals[iTeamId] || '') || 'Unknown').trim();
      const segment = iSegment >= 0 ? (vals[iSegment] || '').trim() : '';
      if (eName) {
        if (!entMap[eName]) entMap[eName] = { name: eName, eid, segment, teams: {}, count: 0 };
        entMap[eName].count++;
        
        if (tName) {
          if (!entMap[eName].teams[tName]) entMap[eName].teams[tName] = { count: 0 };
          entMap[eName].teams[tName].count++;
          
        }
        totalLines++;
      }
    }
  }

  const enterprises = Object.values(entMap)
    .sort((a, b) => b.count - a.count)
    .map(e => ({
      name:    e.name,
      eid:     e.eid,
      segment: e.segment,
      count:   e.count,
      teams:   Object.entries(e.teams)
        .sort((a, b) => b[1].count - a[1].count)
        .map(([name, t]) => ({ name, tid: t.tid, count: t.count })),
    }));

  return { enterprises, totalVins: totalLines };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    if (req.query.force === '1') { _cache = null; _cacheAt = 0; }

    const now = Date.now();
    const isStale = !_cache || (now - _cacheAt >= CACHE_TTL);

    // Serve stale immediately, refresh in background
    if (_cache && isStale && !_buildPromise) {
      _buildPromise = _build()
        .then(data => { _cache = { ...data, cachedAt: new Date().toISOString() }; _cacheAt = Date.now(); })
        .finally(() => { _buildPromise = null; });
      return res.status(200).json({ ..._cache, stale: true });
    }

    if (_cache && !isStale) {
      return res.status(200).json(_cache);
    }

    // No cache — must wait for first load
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
