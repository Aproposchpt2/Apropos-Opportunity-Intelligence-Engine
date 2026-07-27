export default async () => {
  const supabaseUrl = Netlify.env.get('SUPABASE_URL');
  const anonKey = Netlify.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anonKey) {
    return new Response(JSON.stringify({ error: 'missing_server_configuration' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const idempotencyKey = 'PDAS-VAR-TUCSON-20260726-190000';
  const response = await fetch(`${supabaseUrl}/functions/v1/command-aadp-run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
    },
    body: JSON.stringify({
      assignment_id: '968c2533-6c66-4c73-8c52-049d61804e8f',
      idempotency_key: idempotencyKey,
    }),
  });

  const body = await response.text();
  return new Response(JSON.stringify({
    bridge_status: response.status,
    idempotency_key: idempotencyKey,
    command_response: body,
  }), {
    status: response.ok ? 200 : response.status,
    headers: { 'Content-Type': 'application/json' },
  });
};
