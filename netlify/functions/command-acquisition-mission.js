const { proxyToSupabase } = require('../lib/supabase-gateway');

// Acquisition Discovery is routed through the governed mission-control
// adapter so Publisher: ALL can be handled by the authoritative runtime.
exports.handler = async (event) => proxyToSupabase(event, 'command-mission-control');
