const { proxyToSupabase } = require('../lib/supabase-gateway');
exports.handler = async (event) => proxyToSupabase(event, 'command-aadp-publisher-candidate-review');
