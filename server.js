const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT          = process.env.PORT || 8000;
const ROOT          = path.join(__dirname, 'public');
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
// Default to a free OpenRouter model; override with LLM_MODEL env var
const LLM_MODEL = process.env.LLM_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';

// ── Helpers ──────────────────────────────────────────────────────────────────

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js'))   return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.css'))  return 'text/css; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

function readBody(req, maxBytes = 32_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > maxBytes) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end',   () => resolve(body));
    req.on('error', reject);
  });
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get(
      { hostname: u.hostname, path: u.pathname + u.search,
        headers: { 'User-Agent': 'WeatherPermitting/1.0' } },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.setTimeout(12_000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
  });
}

function httpsPost(url, payload, extraHeaders) {
  return new Promise((resolve, reject) => {
    const u    = new URL(url);
    const body = JSON.stringify(payload);
    const req  = https.request(
      {
        hostname: u.hostname,
        path:     u.pathname + u.search,
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...extraHeaders,
        },
      },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.setTimeout(35_000, () => { req.destroy(); reject(new Error('LLM request timed out')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Geocoding ────────────────────────────────────────────────────────────────

async function geocodeQuery(query) {
  // 1. Try the full query text against UK — works for plain place names like "Looe"
  const full = await httpsGet(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=gb`
  ).catch(() => null);

  if (full?.body?.length > 0) {
    const r = full.body[0];
    return { lat: parseFloat(r.lat), lon: parseFloat(r.lon), name: r.display_name.split(',')[0].trim() };
  }

  // 2. Try individual capitalised words (skip the first — it's capitalised by sentence convention).
  //    This catches "Going to Fowey for lunch" → tries "Fowey".
  const words = query
    .split(/\s+/)
    .slice(1)
    .filter(w => /^[A-Z][a-z]{2,}/.test(w));

  for (const word of words) {
    const result = await httpsGet(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(word + ', UK')}&format=json&limit=1&countrycodes=gb`
    ).catch(() => null);
    if (result?.body?.length > 0) {
      const r = result.body[0];
      return { lat: parseFloat(r.lat), lon: parseFloat(r.lon), name: r.display_name.split(',')[0].trim() };
    }
  }

  return null; // fall back to caller's current location
}

// ── Weather data ─────────────────────────────────────────────────────────────

async function fetchWeatherData(lat, lon) {
  const params = new URLSearchParams({
    latitude:  String(lat),
    longitude: String(lon),
    current:  'temperature_2m,apparent_temperature,relative_humidity_2m,surface_pressure,' +
              'wind_speed_10m,wind_direction_10m,precipitation,weather_code',
    hourly:   'temperature_2m,precipitation_probability,wind_speed_10m,wind_direction_10m,weather_code',
    forecast_days:      '1',
    temperature_unit:   'celsius',
    wind_speed_unit:    'mph',
    precipitation_unit: 'mm',
    timezone:           'auto',
  });
  const result = await httpsGet(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (result.status !== 200) throw new Error('Weather API failed');
  return result.body;
}

async function fetchMarineData(lat, lon) {
  const params = new URLSearchParams({
    latitude:  String(lat),
    longitude: String(lon),
    current:  'wave_height,wave_direction,wave_period',
    timezone: 'auto',
  });
  const result = await httpsGet(`https://marine-api.open-meteo.com/v1/marine?${params}`);
  if (result.status !== 200) return null;
  return result.body;
}

// ── Prompt building ──────────────────────────────────────────────────────────

const WX_LABEL = {
  0: 'Clear sky',    1: 'Mainly clear',  2: 'Partly cloudy', 3: 'Overcast',
  45: 'Foggy',       48: 'Freezing fog',
  51: 'Light drizzle', 53: 'Drizzle',   55: 'Heavy drizzle',
  61: 'Light rain',  63: 'Rain',         65: 'Heavy rain',
  71: 'Light snow',  73: 'Snow',         75: 'Heavy snow',
  80: 'Light showers', 81: 'Showers',   82: 'Heavy showers',
  95: 'Thunderstorm',
};

function compass(deg) {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
}

function buildPrompt(query, weather, marine, locationName) {
  const c = weather.current;
  const h = weather.hourly;

  // Find the index for the current hour
  const nowHour = new Date().getHours();
  let startIdx = 0;
  for (let i = 0; i < h.time.length; i++) {
    if (parseInt(h.time[i].slice(11, 13), 10) === nowHour) { startIdx = i; break; }
  }

  const hourLines = [];
  for (let i = startIdx; i < Math.min(startIdx + 6, h.time.length); i++) {
    const hh    = parseInt(h.time[i].slice(11, 13), 10);
    const label = hh === 0 ? 'midnight' : hh < 12 ? `${hh}am` : hh === 12 ? '12pm' : `${hh - 12}pm`;
    hourLines.push(
      `  ${label}: ${WX_LABEL[h.weather_code[i]] || 'Unknown'}, ` +
      `${Math.round(h.temperature_2m[i])}°C, ` +
      `${h.precipitation_probability[i]}% rain, ` +
      `${Math.round(h.wind_speed_10m[i])}mph ${compass(h.wind_direction_10m[i])}`
    );
  }

  let ctx = `Location: ${locationName}\n\nCurrent conditions:\n`;
  ctx += `  Temperature: ${Math.round(c.temperature_2m)}°C (feels like ${Math.round(c.apparent_temperature)}°C)\n`;
  ctx += `  ${WX_LABEL[c.weather_code] || 'Unknown'}\n`;
  ctx += `  Wind: ${Math.round(c.wind_speed_10m)}mph ${compass(c.wind_direction_10m)}\n`;
  ctx += `  Humidity: ${c.relative_humidity_2m}%\n`;
  if (c.precipitation > 0) ctx += `  Currently raining: ${c.precipitation}mm\n`;
  ctx += `\nNext 6 hours:\n${hourLines.join('\n')}\n`;

  if (marine?.current?.wave_height != null) {
    const m    = marine.current;
    const desc = m.wave_height < 0.5 ? 'calm' : m.wave_height < 1.0 ? 'slight' :
                 m.wave_height < 2.0 ? 'moderate' : 'rough';
    ctx += `\nSea: ${m.wave_height.toFixed(1)}m waves (${desc}), ` +
           `${Math.round(m.wave_period)}s period, ${compass(m.wave_direction)} swell\n`;
  }

  return `${ctx}\nUser's question: "${query}"`;
}

// ── LLM ──────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  `You are a friendly, practical weather assistant helping people in the UK (often Cornwall) plan their day.
Give short, warm, plain-English advice — like a knowledgeable friend, not a weather report.
- 2–4 sentences maximum
- No technical jargon (no "mb", "isobars", "precipitation probability")
- Tailor advice to their specific activity (beach, walk, drive, lunch out, etc.) if mentioned
- Practical: "grab a waterproof", "should be lovely", "might catch a shower around 3pm"
- Honest about uncertainty when conditions are changeable
- Use British English`;

async function callLLM(userMessage) {
  if (!OPENROUTER_KEY && !ANTHROPIC_KEY) throw new Error('NO_KEY');

  if (OPENROUTER_KEY) {
    const result = await httpsPost(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model:      LLM_MODEL,
        messages:   [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userMessage }],
        max_tokens: 300,
      },
      {
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        'HTTP-Referer': 'https://weather-permitting.app',
        'X-Title':      'Weather Permitting',
      }
    );
    if (result.status >= 400) throw new Error(`LLM error ${result.status}`);
    return result.body.choices[0].message.content.trim();
  }

  // Anthropic fallback
  const result = await httpsPost(
    'https://api.anthropic.com/v1/messages',
    {
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userMessage }],
    },
    { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' }
  );
  if (result.status >= 400) throw new Error(`LLM error ${result.status}`);
  return result.body.content[0].text.trim();
}

// ── Query handler ────────────────────────────────────────────────────────────

async function handleQuery(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: 'Invalid request' });
    return;
  }

  const { query, lat, lon } = body;
  if (typeof query !== 'string' || !query.trim() ||
      typeof lat !== 'number' || typeof lon !== 'number') {
    sendJson(res, 400, { error: 'Missing or invalid fields' });
    return;
  }

  try {
    let targetLat = lat, targetLon = lon, targetName = null;

    const place = await geocodeQuery(query.trim());
    if (place) { targetLat = place.lat; targetLon = place.lon; targetName = place.name; }

    const [weather, marine] = await Promise.all([
      fetchWeatherData(targetLat, targetLon),
      fetchMarineData(targetLat, targetLon).catch(() => null),
    ]);

    const prompt   = buildPrompt(query.trim(), weather, marine, targetName || 'your current location');
    const response = await callLLM(prompt);

    sendJson(res, 200, { response, location: targetName });
  } catch (err) {
    if (err.message === 'NO_KEY') {
      sendJson(res, 503, { error: 'no_key' });
    } else {
      console.error('Query error:', err.message);
      sendJson(res, 500, { error: 'Could not get a response right now. Please try again.' });
    }
  }
}

// ── Static file server ───────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/query') {
    handleQuery(req, res);
    return;
  }

  let pathname;
  try {
    pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  if (pathname === '/') pathname = '/index.html';

  const filePath = path.resolve(ROOT, '.' + pathname);
  if (!filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType(filePath) });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
// Set API keys via environment variables:
//   OPENROUTER_API_KEY  — OpenRouter (supports free models; set LLM_MODEL to override)
//   ANTHROPIC_API_KEY   — Anthropic Claude Haiku (used if no OpenRouter key)
//   LLM_MODEL           — optional model override, e.g. "anthropic/claude-haiku-4-5"
