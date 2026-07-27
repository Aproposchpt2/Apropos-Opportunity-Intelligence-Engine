export default async () => {
  const response = await fetch('https://judislfknmhofcgzyozc.supabase.co/functions/v1/command-aadp-run', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: Netlify.env.get('SUPABASE_ANON_KEY') ?? '',
      Authorization: `Bearer ${Netlify.env.get('SUPABASE_ANON_KEY') ?? ''}`,
    },
    body: JSON.stringify({ resume_run_id: 'a6976e79-14a9-4da8-bd29-9afcaf60891a' }),
  });
  return new Response(JSON.stringify({ bridge_status: response.status, command_response: await response.text() }), {
    status: response.ok ? 200 : response.status,
    headers: { 'Content-Type': 'application/json' },
  });
};