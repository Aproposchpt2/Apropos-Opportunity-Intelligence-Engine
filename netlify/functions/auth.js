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

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/command_verify_dashboard_password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`
      },
      body: JSON.stringify({ p_password: password })
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('Executive auth RPC failed', r.status, detail);
      return response(500, { error: 'Authentication service unavailable' });
    }

    const valid = await r.json().catch(() => false);
    if (valid !== true) return response(401, { error: 'Unauthorized' });
    return response(200, { ok: true, authenticated: true });
  } catch (error) {
    console.error('Executive auth exception', error);
    return response(500, { error: 'Authentication service unavailable' });
  }
};
