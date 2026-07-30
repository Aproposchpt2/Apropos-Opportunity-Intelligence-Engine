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

async function proxyToSupabase(event, functionName) {
  if (event.httpMethod === 'OPTIONS') return response(200, { ok: true });
  if (event.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  if (!SUPABASE_URL || !SERVICE_KEY) return response(500, { error: 'Server gateway configuration incomplete' });

  const dashboardPassword = event.headers['x-dashboard-password'] || event.headers['X-Dashboard-Password'] || '';
  if (!dashboardPassword) return response(401, { error: 'Unauthorized' });

  const upstream = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'x-dashboard-password': dashboardPassword
    },
    body: event.body || '{}'
  });

  const text = await upstream.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { body = { raw: text }; }
  return response(upstream.status, body);
}

async function verifyDashboard(event) {
  if (!SUPABASE_URL || !SERVICE_KEY) return { ok: false, status: 500, error: 'Server gateway configuration incomplete' };
  const dashboardPassword = event.headers['x-dashboard-password'] || event.headers['X-Dashboard-Password'] || '';
  if (!dashboardPassword) return { ok: false, status: 401, error: 'Unauthorized' };
  const upstream = await fetch(`${SUPABASE_URL}/functions/v1/command-executive-status`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'x-dashboard-password': dashboardPassword
    },
    body: '{}'
  });
  return upstream.ok ? { ok: true } : { ok: false, status: upstream.status, error: 'Unauthorized' };
}

module.exports = { proxyToSupabase, verifyDashboard, response };
