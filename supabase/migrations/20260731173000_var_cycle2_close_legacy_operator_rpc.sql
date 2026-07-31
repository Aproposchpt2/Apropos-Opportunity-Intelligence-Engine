-- APIOS VAR Cycle 2 final hardening
-- The active Executive Command Center authorizes operators through the
-- password-protected server control plane. No browser/runtime code requires
-- direct authenticated execution of command_is_operator().
--
-- Close the final authenticated SECURITY DEFINER exposure identified by the
-- post-remediation Supabase security advisor.

revoke execute on function public.command_is_operator() from public, anon, authenticated;
grant execute on function public.command_is_operator() to service_role;

do $$
begin
  if has_function_privilege('anon', 'public.command_is_operator()'::regprocedure, 'EXECUTE')
     or has_function_privilege('authenticated', 'public.command_is_operator()'::regprocedure, 'EXECUTE') then
    raise exception 'VAR legacy operator helper boundary failed';
  end if;
  if not has_function_privilege('service_role', 'public.command_is_operator()'::regprocedure, 'EXECUTE') then
    raise exception 'VAR service-role execution missing for command_is_operator()';
  end if;
end $$;
