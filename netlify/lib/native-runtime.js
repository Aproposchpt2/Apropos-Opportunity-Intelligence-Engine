const { createHash, timingSafeEqual } = require('node:crypto');

function env(name) {
  try {
    if (globalThis.Netlify?.env?.get) return globalThis.Netlify.env.get(name) || '';
  } catch {}
  return process.env[name] || '';
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

function header(event, name) {
  const headers = event?.headers || {};
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
}

function parseBody(event) {
  try { return event?.body ? JSON.parse(event.body) : {}; }
  catch { return {}; }
}

function requireDashboardAuth(event) {
  const supplied = header(event, 'x-dashboard-password');
  const storedHash = env('EXECUTIVE_AUTH_HASH');
  if (!supplied || !/^[0-9a-f]{64}$/i.test(storedHash)) return false;
  const suppliedDigest = createHash('sha256').update(supplied, 'utf8').digest();
  const expectedDigest = Buffer.from(storedHash, 'hex');
  return suppliedDigest.length === expectedDigest.length && timingSafeEqual(suppliedDigest, expectedDigest);
}

async function db(path, init = {}) {
  const url = env('SUPABASE_URL').replace(/\/$/, '');
  const key = env('SUPABASE_SERVICE_KEY');
  if (!url || !key) throw new Error('Supabase database runtime configuration incomplete');
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers || {})
    },
    signal: init.signal || AbortSignal.timeout(25000)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; }
  catch { data = text; }
  if (!res.ok) throw new Error(data?.message || data?.hint || `Database request failed (${res.status})`);
  return data;
}

module.exports = { env, response, header, parseBody, requireDashboardAuth, db };
