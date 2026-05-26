// api/data.js
// Fetches VIN + Enterprise CSVs from Metabase, caches in memory.
// Cache survives within the same serverless instance lifetime.
// Use /api/warm to pre-populate cache on a schedule.

let vinCache = null, entCache = null, lastFetch = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 min — longer TTL means fewer cold fetches
const VIN_URL = "https://metabase.spyne.ai/public/question/2f5d51f1-8069-4d3d-a8e1-24376d88c930.csv";
const ENT_URL = "https://metabase.spyne.ai/public/question/b8f1271c-cc5a-470f-badf-807711f74af4.csv";

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
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = splitRow(lines[0]);
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = splitRow(line), obj = {};
    headers.forEach((h, j) => { obj[h] = (vals[j] ?? '').trim(); });
    return obj;
  });
}
function pick(r, ...names) {
  for (const n of names) { const v = r[n]; if (v != null && String(v).trim()) return String(v).trim(); }
  return '';
}
function hoursAgo(ts, now) {
  if (!ts) return null;
  const d = new Date(ts); if (isNaN(d)) return null;
  const h = (now - d) / 3600000; return h >= 0 ? h : null;
}

// Track in-flight fetch so concurrent requests share one fetch instead of hammering Metabase
let _buildPromise = null;

export async function buildCache(force = false) {
  const now = Date.now();
  const isStale = !vinCache || (now - lastFetch >= CACHE_TTL);

  if (!force && vinCache && isStale && !_buildPromise) {
    // Serve stale, refresh in background
    _buildPromise = _doFetch().finally(() => { _buildPromise = null; });
    return { vinCache, entCache, stale: true };
  }

  if (!force && vinCache && !isStale) {
    return { vinCache, entCache };
  }

  if (_buildPromise) return _buildPromise;
  _buildPromise = _doFetch().finally(() => { _buildPromise = null; });
  return _buildPromise;
}

async function _doFetch() {
  const now = Date.now();
  const [vinResp, entResp] = await Promise.all([
    fetch(VIN_URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(90000) }),
    fetch(ENT_URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) }),
  ]);
  if (!vinResp.ok) throw new Error(`VIN CSV ${vinResp.status}`);
  const rawVin = parseCSV(await vinResp.text());

  const entMap = {};
  if (entResp.ok) {
    const rawEnt = parseCSV(await entResp.text());
    rawEnt.forEach(r => {
      const id = pick(r, 'dt.enterprise_id', 'enterprise_id', 'enterpriseId');
      if (id) {
        entMap[id] = {
          name:    pick(r, 'name', 'enterprise_name'),
          type:    pick(r, 'type'),
          stage:   pick(r, 'stage'),
          website: pick(r, 'website_url'),
          poc:     pick(r, 'poc_id', 'poc'),
          email:   pick(r, 'email_id', 'email', 'poc_email'),
        };
      }
    });
  }

  vinCache = rawVin.map(r => {
    const eid = pick(r, 'enterpriseId');
    const ent = entMap[eid] || {};
    return {
      vin:             pick(r, 'vinName'),
      dealerVinId:     pick(r, 'dealerVinId'),
      eid,
      entName:         ent.name  || pick(r, 'enterprise_name') || eid,
      entType:         ent.type  || '',
      entStage:        ent.stage || '',
      entEmail:        ent.email || '',
      teamId:          pick(r, 'teamId'),
      teamName:        pick(r, 'team_name'),
      customerSegment: pick(r, 'customer_segment'),
      make:            pick(r, 'make'),
      model:           pick(r, 'model'),
      year:            pick(r, 'year'),
      trim:            pick(r, 'trim'),
      stock:           pick(r, 'stockNumber'),
      platform:        pick(r, 'platform'),
      type:            pick(r, 'type') || pick(r, 'platform'),
      status:          pick(r, 'status_overallStatus', 'status'),
      rb:              pick(r, 'reason_bucket'),
      holdReason:      pick(r, 'hold_reason'),
      hasPhotos:       pick(r, 'has_photos'),
      after24:         pick(r, 'after_24_hrs'),
      imgCount:        parseInt(pick(r, 'image_count')) || 0,
      vidCount:        parseInt(pick(r, 'video_count')) || 0,
      outImgs:         parseInt(pick(r, 'output_image_count')) || 0,
      overallScore:    pick(r, 'overall_score'),
      vinScore:        pick(r, 'vin_score'),
      price:           pick(r, 'sellingPrice'),
      thumbnail:       pick(r, 'thumbnail_url'),
      vdpUrl:          pick(r, 'vdp_url'),
      websiteUrl:      pick(r, 'website_listing_url'),
      vinCreation:     pick(r, 'vinCreation'),
      receivedAt:      pick(r, 'receivedAt'),
      sentAt:          pick(r, 'sentAt'),
      hrsVc:           hoursAgo(pick(r, 'vinCreation'), now),
      hrsRecv:         hoursAgo(pick(r, 'receivedAt'), now),
    };
  });

  entCache = Object.entries(entMap).map(([id, e]) => ({ id, ...e }));
  lastFetch = now;
  return { vinCache, entCache };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  try {
    const force = req.query.force === '1';
    if (force) { vinCache = null; entCache = null; lastFetch = 0; }
    const { vinCache: rows, entCache: ents } = await buildCache(force);
    if (req.query.debug === '1') {
      return res.status(200).json({
        totalVins: rows.length, totalEnts: ents.length,
        cachedAt: new Date(lastFetch).toISOString(),
        sampleVin: rows[0], sampleEnt: ents[0],
        uniqueRB:              [...new Set(rows.map(r => r.rb).filter(Boolean))],
        uniqueType:            [...new Set(rows.map(r => r.type).filter(Boolean))],
        uniqueCustomerSegment: [...new Set(rows.map(r => r.customerSegment).filter(Boolean))],
      });
    }
    res.status(200).json({ rows, ents, total: rows.length, lastSynced: new Date(lastFetch).toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
