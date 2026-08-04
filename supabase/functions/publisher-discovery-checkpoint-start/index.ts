const ALLOWED_COMMAND_RUN_ID = '5ee86db3-fdac-4a5d-be29-7a5046effb96';
const ALLOWED_DISCOVERY_RUN_ID = 'b29cada5-0db2-4446-98d4-5d61c206eb16';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
});

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const body = await request.json().catch(() => ({}));
  if (body.command_run_id !== ALLOWED_COMMAND_RUN_ID || body.discovery_run_id !== ALLOWED_DISCOVERY_RUN_ID) {
    return json({ error: 'This start function is restricted to the authorized canonical repair run.' }, 403);
  }
  const url = (Deno.env.get('SUPABASE_URL') || '').replace(/\/$/, '');
  const token = Deno.env.get('PUBLISHER_CHECKPOINT_TOKEN') || '';
  if (!url || !token) return json({ error: 'Checkpoint runtime configuration is incomplete.' }, 500);
  const response = await fetch(`${url}/functions/v1/publisher-discovery-checkpoint-worker`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-checkpoint-token': token },
    body: JSON.stringify({
      command_run_id: ALLOWED_COMMAND_RUN_ID,
      discovery_run_id: ALLOWED_DISCOVERY_RUN_ID,
      state_code: 'CA',
      discovery_scope: 'COUNTY|06037|LOS ANGELES COUNTY',
      unit_index: 12
    })
  });
  const result = await response.json().catch(() => ({}));
  return json({ dispatched: response.ok, worker_status: response.status, result }, response.ok ? 202 : 502);
});
