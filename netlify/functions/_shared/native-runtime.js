import { createHash, timingSafeEqual } from 'node:crypto';

export function env(name) {
  try {
    if (globalThis.Netlify?.env?.get) return globalThis.Netlify.env.get(name) || '';
  } catch {}
  return process.env[name] || '';
}

export function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

function canonicalNetlifyHost() {
  for (const value of [env('DEPLOY_PRIME_URL'), env('DEPLOY_URL'), env('URL')]) {
    const raw = String(value || '').trim();
    if (!raw) continue;
    try {
      return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).host;
    } catch {}
  }
  return '';
}

export function header(event, name) {
  const normalizedName = String(name || '').toLowerCase();
  if (normalizedName === 'host') {
    const canonical = canonicalNetlifyHost();
    if (canonical) return canonical;
  }
  const headers = event?.headers || {};
  return headers[name] || headers[normalizedName] || headers[String(name || '').toUpperCase()] || '';
}

export function parseBody(event) {
  try { return event?.body ? JSON.parse(event.body) : {}; }
  catch { return {}; }
}

export function requireDashboardAuth(event) {
  const supplied = header(event, 'x-dashboard-password');
  const storedHash = env('EXECUTIVE_AUTH_HASH');
  if (!supplied || !/^[0-9a-f]{64}$/i.test(storedHash)) return false;
  const suppliedDigest = createHash('sha256').update(supplied, 'utf8').digest();
  const expectedDigest = Buffer.from(storedHash, 'hex');
  return suppliedDigest.length === expectedDigest.length && timingSafeEqual(suppliedDigest, expectedDigest);
}

function databaseCredentials() {
  const url = String(env('SUPABASE_URL') || '').trim().replace(/\/$/, '');
  const key = String(env('SUPABASE_SERVICE_KEY') || env('SUPABASE_SERVICE_ROLE_KEY') || '').trim();
  if (!url || !key) throw new Error('Supabase database runtime configuration incomplete');
  return { url, key };
}

function serviceHeaders(key, overrides = {}) {
  const headers = { apikey: key };
  if (!key.startsWith('sb_secret_') && !key.startsWith('sb_publishable_')) {
    headers.Authorization = `Bearer ${key}`;
  }
  return { ...headers, ...overrides };
}

function databaseHeaders(key, overrides = {}) {
  return serviceHeaders(key, {
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
    ...overrides
  });
}

export async function db(path, init = {}) {
  const { url, key } = databaseCredentials();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const res = await fetch(`${url}/rest/v1/${path}`, {
      ...init,
      headers: databaseHeaders(key, init.headers || {}),
      signal: init.signal || controller.signal
    });

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; }
    catch { data = text; }

    if (!res.ok) {
      const detail = typeof data === 'object' && data
        ? data.message || data.hint || data.details || data.error
        : String(data || '');
      const error = new Error(detail || `Database request failed (${res.status})`);
      error.status = res.status;
      error.code = typeof data === 'object' && data ? data.code || null : null;
      throw error;
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function encodeStoragePath(path) {
  return String(path || '').split('/').map(segment => encodeURIComponent(segment)).join('/');
}

export async function storageUpload(bucket, objectPath, bytes, contentType = 'application/octet-stream', upsert = true) {
  const { url, key } = databaseCredentials();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const res = await fetch(`${url}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeStoragePath(objectPath)}`, {
      method: 'POST',
      headers: serviceHeaders(key, {
        'Content-Type': contentType || 'application/octet-stream',
        'x-upsert': upsert ? 'true' : 'false'
      }),
      body: bytes,
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try {
        const parsed = text ? JSON.parse(text) : null;
        detail = parsed?.message || parsed?.error || parsed?.statusCode || text;
      } catch {}
      const error = new Error(detail || `Storage upload failed (${res.status})`);
      error.status = res.status;
      throw error;
    }
    try { return text ? JSON.parse(text) : { ok: true }; }
    catch { return { ok: true, response: text }; }
  } finally {
    clearTimeout(timeout);
  }
}
