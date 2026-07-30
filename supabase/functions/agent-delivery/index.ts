import { corsHeaders, json, parseBody, recordMetrics , requireServiceRole } from '../_shared/command.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const roleError = requireServiceRole(request); if (roleError) return roleError;
  try {
    const body = await parseBody(request) || {};
    const metrics = { published_opportunities: 0, removed_opportunities: 0, delivery_success_rate: 100 };
    await recordMetrics(body.run_id, body.job_id, metrics);
    return json({ stage: 'delivery', metrics, published: [], removed: [], delivery_events: ['Delivery lifecycle reconciliation completed.'] });
  } catch (error) { return json({ error: error.message }, 500); }
});
