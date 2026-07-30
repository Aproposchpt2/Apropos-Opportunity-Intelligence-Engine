const { verifyDashboard, response } = require('../lib/supabase-gateway');
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return response(200, { ok: true });
  if (event.httpMethod !== 'POST') return response(405, { error: 'Method not allowed' });
  const auth = await verifyDashboard(event);
  if (!auth.ok) return response(auth.status || 401, { error: auth.error || 'Unauthorized' });
  return response(200, {
    ok: true,
    providers: {
      openai: { configured: Boolean(process.env.OPENAI_API_KEY) },
      anthropic: { configured: Boolean(process.env.ANTHROPIC_API_KEY) },
      supabase: { configured: Boolean(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)) }
    }
  });
};
