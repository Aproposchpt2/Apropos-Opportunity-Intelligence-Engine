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
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-dashboard-password',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    },
    body: JSON.stringify(body)
  };
}

function header(event, name) {
  const headers = event?.headers || {};
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
}

async function proxyToSupabase(event, functionName) {
  try {
    if (event?.httpMethod === 'OPTIONS') return response(200, { ok: true });
    if (event?.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });

    const supabaseUrl = env('SUPABASE_URL');
    const gatewayKey = env('SUPABASE_ANON_KEY');
    if (!supabaseUrl || !gatewayKey) {
      console.error('Netlify gateway configuration incomplete', {
        functionName,
        hasSupabaseUrl: Boolean(supabaseUrl),
        hasAnonKey: Boolean(gatewayKey)
      });
      return response(500, { error: 'Server gateway configuration incomplete', function: functionName });
    }

    const dashboardPassword = header(event, 'x-dashboard-password');
    if (!dashboardPassword) return response(401, { error: 'Unauthorized' });

    let upstream;
    try {
      upstream = await fetch(`${supabaseUrl.replace(/\/$/, '')}/functions/v1/${functionName}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: gatewayKey,
          Authorization: `Bearer ${gatewayKey}`,
          'x-dashboard-password': dashboardPassword
        },
        body: event.body || '{}',
        signal: AbortSignal.timeout(25000)
      });
    } catch (error) {
      console.error('Supabase upstream transport failed', { functionName, error: String(error) });
      return response(502, {
        error: 'Upstream runtime transport failed',
        function: functionName,
        detail: error instanceof Error ? error.message : String(error)
      });
    }

    const text = await upstream.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; }
    catch { body = { raw: text }; }

    if (!upstream.ok) {
      console.error('Supabase upstream returned failure', {
        functionName,
        status: upstream.status,
        body
      });
    }

    return response(upstream.status, body);
  } catch (error) {
    console.error('Netlify gateway unhandled failure', { functionName, error: String(error) });
    return response(500, {
      error: 'Netlify runtime gateway failed',
      function: functionName,
      detail: error instanceof Error ? error.message : String(error)
    });
  }
}

async function verifyDashboard(event) {
  const supabaseUrl = env('SUPABASE_URL');
  const gatewayKey = env('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !gatewayKey) return { ok: false, status: 500, error: 'Server gateway configuration incomplete' };
  const dashboardPassword = header(event, 'x-dashboard-password');
  if (!dashboardPassword) return { ok: false, status: 401, error: 'Unauthorized' };
  try {
    const upstream = await fetch(`${supabaseUrl.replace(/\/$/, '')}/functions/v1/command-executive-status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: gatewayKey,
        Authorization: `Bearer ${gatewayKey}`,
        'x-dashboard-password': dashboardPassword
      },
      body: '{}',
      signal: AbortSignal.timeout(15000)
    });
    return upstream.ok ? { ok: true } : { ok: false, status: upstream.status, error: 'Unauthorized' };
  } catch (error) {
    return { ok: false, status: 502, error: error instanceof Error ? error.message : String(error) };
  }
}

module.exports = { proxyToSupabase, verifyDashboard, response };
