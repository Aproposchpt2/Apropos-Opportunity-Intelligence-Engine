revoke execute on function public.command_create_mission(text,text,text,text,jsonb) from public, anon, authenticated;
revoke execute on function public.command_authorize_mission(uuid) from public, anon, authenticated;
revoke execute on function public.command_bind_mission_run(uuid,uuid) from public, anon, authenticated;

grant execute on function public.command_create_mission(text,text,text,text,jsonb) to service_role;
grant execute on function public.command_authorize_mission(uuid) to service_role;
grant execute on function public.command_bind_mission_run(uuid,uuid) to service_role;
