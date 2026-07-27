export default async () => {
  const response = await fetch('https://judislfknmhofcgzyozc.supabase.co/functions/v1/command-aadp-run', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: Netlify.env.get('SUPABASE_ANON_KEY') ?? '',
      Authorization: `Bearer ${Netlify.env.get('SUPABASE_ANON_KEY') ?? ''}`,
    },
    body: JSON.stringify({
      assignment_id: '968c2533-6c66-4c73-8c52-049d61804e8f',
      idempotency_key: 'PDAS-VAR-TUCSON-20260726-203700-V2'
    }),
  });
  return new Response(JSON.stringify({ bridge_status: response.status, command_response: await response.text() }), {
    status: response.ok ? 200 : response.status,
    headers: { 'Content-Type': 'application/json' },
  });
};