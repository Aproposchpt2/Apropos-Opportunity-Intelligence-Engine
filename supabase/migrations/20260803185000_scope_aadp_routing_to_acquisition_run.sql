do $$
declare
  v_definition text;
begin
  select pg_get_functiondef('public.aadp_route_pending_raw_records(integer)'::regprocedure)
    into v_definition;

  v_definition := replace(
    v_definition,
    'aadp_route_pending_raw_records(p_batch_size integer DEFAULT 100)',
    'aadp_route_pending_raw_records(p_batch_size integer DEFAULT 100, p_acquisition_run_id uuid DEFAULT NULL)'
  );

  v_definition := replace(
    v_definition,
    'where ar.processing_status = ''RAW''',
    'where ar.processing_status = ''RAW'' and (p_acquisition_run_id is null or ar.acquisition_run_id = p_acquisition_run_id)'
  );

  execute v_definition;
end;
$$;

comment on function public.aadp_route_pending_raw_records(integer, uuid) is
'Routes only RAW records belonging to the supplied acquisition run when p_acquisition_run_id is provided. NATCORP qualification V3.';
