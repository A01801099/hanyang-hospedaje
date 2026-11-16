// Servidor mínimo y SIN dependencias (Node 18+).
// - Sirve la carpeta /public
// - GET /api/stays?checkin=YYYY-MM-DD&checkout=YYYY-MM-DD&adults=2
//   consulta SerpApi (Google Hotels) en el momento, para que los precios estén al día,
//   y mantiene la API key en el servidor (nunca en el navegador).
// - Sin SERPAPI_KEY responde datos DEMO claramente marcados como ejemplo.

const http = require('http');
const fs = require('fs');
const path = require('path');

// Cargador simple de .env (para no depender de paquetes)
const ENV_PATH = path.join(__dirname, '.env');
let envInfo = `NO existe ${ENV_PATH}`;
try {
  const raw = fs.readFileSync(ENV_PATH, 'utf8');
  envInfo = `leído ${ENV_PATH}`;
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;                       // comentarios
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    // valor = primer "palabra" (sin comillas), así un texto extra después no rompe la llave
    const value = m[2].trim().replace(/^["']/, '').split(/["'\s]/)[0];
    if (!process.env[m[1]]) process.env[m[1]] = value;     // también sustituye variables vacías
  }
} catch { /* sin .env: modo demo */ }

const PORT = Number(process.env.PORT) || 3000;
const KEY = process.env.SERPAPI_KEY || '';
const CURRENCY = process.env.CURRENCY || 'USD';
const RADIUS_KM = Number(process.env.RADIUS_KM) || 6;
const CACHE_MS = 60 * 60 * 1000; // 1 h: protege tu cuota de búsquedas

// Universidad Hanyang (campus Seúl), 222 Wangsimni-ro, Seongdong-gu
const HANYANG = { lat: 37.5575, lng: 127.0455 };

const cache = new Map();

/* ---------- utilidades ---------- */
function km(a, b) {
  const R = 6371, rad = d => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function nightsBetween(ci, co) {
  return Math.round((Date.parse(co) - Date.parse(ci)) / 86400000);
}

const CAPSULE_RE = /capsule|capsul|\bpod\b|pods\b|cabin|sleep ?box|hostel|dormitor|guest ?house|게스트|캡슐/i;

/* ---------- SerpApi ---------- */
async function serp(engine, params) {
  const url = new URL('https://serpapi.com/search.json');
  const extra = engine === 'google_hotels' ? { hl: 'es', gl: 'mx' } : {};
  url.search = new URLSearchParams({
    engine,
    currency: CURRENCY,
    ...extra,
    ...params,
    api_key: KEY,
  }).toString();
  const r = await fetch(url);
  if (!r.ok) throw new Error(`SerpApi ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

function normalize(p, kind, nights, googleUrl) {
  const g = p.gps_coordinates;
  if (!g || typeof g.latitude !== 'number') return null;
  const nightly = p.rate_per_night?.extracted_lowest ?? null;
  const total = p.total_rate?.extracted_lowest ?? (nightly != null ? nightly * nights : null);
  let category = 'hotel';
  if (kind === 'rental') category = 'airbnb';
  else if (kind === 'capsule' || CAPSULE_RE.test(p.name || '')) category = 'capsule';
  const pos = { lat: g.latitude, lng: g.longitude };
  return {
    id: p.property_token || `${p.name}|${g.latitude}|${g.longitude}`,
    name: p.name,
    category,
    lat: pos.lat,
    lng: pos.lng,
    nightly,
    total,
    rating: p.overall_rating ?? null,
    reviews: p.reviews ?? null,
    image: p.images?.[0]?.thumbnail ?? null,
    link: p.link || googleUrl || null,        // sitio del alojamiento u oferta en Google Hotels
    googleUrl: googleUrl || null,             // comparador con todas las ofertas
    sources: Array.isArray(p.prices) ? p.prices.map(x => x.source).filter(Boolean) : [],
    distanceKm: Number(km(HANYANG, pos).toFixed(2)),
  };
}

// Anuncios de Airbnb (motor "airbnb" de SerpApi). El precio viene como total de la estancia.
function normalizeAirbnb(p, nights) {
  const g = p.gps_coordinates;
  if (!g || typeof g.latitude !== 'number') return null;
  const total = p.extracted_price ?? null;
  const pos = { lat: g.latitude, lng: g.longitude };
  return {
    id: `airbnb-${p.listing_id || p.link}`,
    name: p.name || p.title || 'Airbnb',
    category: 'airbnb',
    lat: pos.lat,
    lng: pos.lng,
    nightly: total != null ? Math.round(total / nights) : null,
    total,
    rating: p.rating ?? null,
    reviews: p.reviews ?? null,
    image: p.thumbnail || p.images?.[0] || null,
    link: p.link || null,            // enlace directo al anuncio, con fechas y huéspedes
    googleUrl: null,
    sources: ['Airbnb'],
    distanceKm: Number(km(HANYANG, pos).toFixed(2)),
  };
}

async function liveStays({ checkin, checkout, adults }) {
  const nights = nightsBetween(checkin, checkout);
  const base = { check_in_date: checkin, check_out_date: checkout, adults };
  // Área de búsqueda de Airbnb alrededor de Hanyang (norte,este,sur,oeste)
  const dLat = RADIUS_KM / 111, dLng = RADIUS_KM / (111 * Math.cos((HANYANG.lat * Math.PI) / 180));
  const bounds = [HANYANG.lat + dLat, HANYANG.lng + dLng, HANYANG.lat - dLat, HANYANG.lng - dLng]
    .map(n => n.toFixed(5)).join(',');
  const jobs = [
    { kind: 'hotel',   engine: 'google_hotels', p: { ...base, q: 'hotels near Hanyang University Seoul' } },
    { kind: 'capsule', engine: 'google_hotels', p: { ...base, q: 'capsule hotel near Hanyang University Seoul' } },
    { kind: 'rental',  engine: 'airbnb',        p: { ...base, map_bounds: bounds } },
  ];
  const results = await Promise.allSettled(jobs.map(j => serp(j.engine, j.p)));
  const errors = [];
  const byId = new Map();
  results.forEach((res, i) => {
    if (res.status === 'rejected') { errors.push(`${jobs[i].kind}: ${res.reason.message}`); return; }
    const add = it => { if (it && it.distanceKm <= RADIUS_KM && !byId.has(it.id)) byId.set(it.id, it); };
    if (jobs[i].engine === 'airbnb') {
      for (const p of res.value.organic_results || []) add(normalizeAirbnb(p, nights));
    } else {
      const gUrl = res.value.search_metadata?.google_hotels_url || null;
      for (const p of res.value.properties || []) add(normalize(p, jobs[i].kind, nights, gUrl));
    }
  });
  if (results.every(r => r.status === 'rejected')) throw new Error(errors.join(' | '));
  return { items: [...byId.values()], errors };
}

/* ---------- datos DEMO (NO son reales) ---------- */
function demoStays({ checkin, checkout }) {
  const nights = nightsBetween(checkin, checkout);
  const mk = (n, cat, dLat, dLng, price, rating) => {
    const pos = { lat: HANYANG.lat + dLat, lng: HANYANG.lng + dLng };
    return {
      id: `demo-${cat}-${n}`,
      name: `[DEMO] ${{ hotel: 'Hotel tradicional', capsule: 'Hotel cápsula', airbnb: 'Airbnb' }[cat]} ${n}`,
      category: cat, lat: pos.lat, lng: pos.lng,
      nightly: price, total: price * nights, rating, reviews: 120 + n * 37,
      image: null, link: null, googleUrl: null, sources: [],
      distanceKm: Number(km(HANYANG, pos).toFixed(2)),
    };
  };
  return {
    items: [
      mk(1, 'hotel',   0.0060,  0.0040, 78, 4.2), mk(2, 'hotel',  -0.0090,  0.0120, 95, 4.4),
      mk(3, 'hotel',   0.0130, -0.0100, 112, 4.5), mk(4, 'hotel',  0.0040, -0.0190, 64, 3.9),
      mk(5, 'capsule', 0.0050, -0.0070, 29, 4.3), mk(6, 'capsule', -0.0040, -0.0060, 34, 4.1),
      mk(7, 'capsule', 0.0090,  0.0150, 26, 4.0),
      mk(8, 'airbnb',  0.0020,  0.0070, 58, 4.8), mk(9, 'airbnb', -0.0070, -0.0120, 49, 4.6),
      mk(10, 'airbnb', 0.0110,  0.0030, 66, 4.7), mk(11, 'airbnb', -0.0120,  0.0050, 41, 4.4),
    ],
    errors: [],
  };
}

/* ---------- HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);

  if (u.pathname === '/api/stays') {
    const checkin = u.searchParams.get('checkin') || '';
    const checkout = u.searchParams.get('checkout') || '';
    const adults = Math.min(Math.max(parseInt(u.searchParams.get('adults'), 10) || 2, 1), 6);
    if (!DATE_RE.test(checkin) || !DATE_RE.test(checkout) || nightsBetween(checkin, checkout) < 1)
      return send(res, 400, { error: 'Fechas inválidas (usa YYYY-MM-DD y checkout posterior al checkin).' });

    const nights = nightsBetween(checkin, checkout);
    const ck = `${checkin}|${checkout}|${adults}`;
    const hit = cache.get(ck);
    if (hit && Date.now() - hit.t < CACHE_MS) return send(res, 200, hit.data);

    try {
      const { items, errors } = KEY ? await liveStays({ checkin, checkout, adults }) : demoStays({ checkin, checkout });
      const data = { demo: !KEY, currency: CURRENCY, nights, hanyang: HANYANG, items, errors, fetchedAt: new Date().toISOString() };
      cache.set(ck, { t: Date.now(), data });
      return send(res, 200, data);
    } catch (e) {
      console.error(e);
      return send(res, 502, { error: 'No se pudo consultar la API de precios.', detail: e.message });
    }
  }

  // archivos estáticos
  const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname).replace(/^\/+/, '');
  const file = path.join(__dirname, 'public', rel);
  if (!file.startsWith(path.join(__dirname, 'public') + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'No encontrado', 'text/plain');
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
});

server.listen(PORT, () => {
  console.log(`Sitio en http://localhost:${PORT}  ·  modo: ${KEY ? 'PRECIOS REALES (SerpApi)' : 'DEMO (sin SERPAPI_KEY)'}`);
  console.log(`.env: ${envInfo}`);
  console.log(`SERPAPI_KEY: ${KEY ? `presente (${KEY.length} caracteres)` : 'VACÍA o no definida'} · moneda ${CURRENCY} · radio ${RADIUS_KM} km`);
});