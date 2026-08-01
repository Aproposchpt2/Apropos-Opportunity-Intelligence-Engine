const { proxyToSupabase } = require('../lib/supabase-gateway');

exports.handler = async (event) => proxyToSupabase(event, 'command-publisher-discovery-status');
