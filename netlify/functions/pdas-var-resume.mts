export default async () => {
  const response = await fetch('https://judislfknmhofcgzyozc.supabase.co/functions/v1/command-aadp-run', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: Netlify.env.get('SUPABASE_ANON_KEY') ?? '',
      Authorization: `Bearer ${Netlify.env.get('SUPABASE_ANON_KEY') ?? ''}`,
    },
    body: JSON.stringify({ resume_run_id: 'ce7006fd-4913-4829-98c1-0d9bba25ca52' }),
  });
  return new Response(JSON.stringify({ bridge_status: response.status, command_response: await response.text() }), {
    status: response.ok ? 200 : response.status,
    headers: { 'Content-Type': 'application/json' },
  });
};
