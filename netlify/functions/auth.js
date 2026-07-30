const crypto = require('node:crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-dashboard-password',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    },
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return response(200, { ok: true });
  if (event.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  if (!SUPABASE_URL || !SERVICE_KEY) return response(500, { error: 'Authentication service configuration incomplete' });

  const password = event.headers['x-dashboard-password'] || event.headers['X-Dashboard-Password'] || '';
  if (!password) return response(401, { error: 'Unauthorized' });

  const r = await fetch(`${SUPABASE_URL}/rest/v1/command_center_auth?id=eq.true&select=password_hash`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Accept: 'application/json'
    }
  });

  if (!r.ok) return response(500, { error: 'Authentication store unavailable' });
  const rows = await r.json().catch(() => []);
  const stored = rows?.[0]?.password_hash || '';
  if (!stored) return response(500, { error: 'Authentication record unavailable' });

  const supplied = crypto.createHash('sha256').update(password, 'utf8').digest('hex');
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(stored, 'utf8');
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!valid) return response(401, { error: 'Unauthorized' });

  return response(200, { ok: true, authenticated: true });
};
