-- APIOS Command Center Automation Work Package 1
-- Checkpoint 4R delivery identity constraint/index compatibility correction.
-- Additive preflight migration ordered immediately before runtime hardening.
-- Production activation remains separate.

-- Fail closed if existing rows already violate the replacement null-safe
-- delivery identity. No rows are deleted or merged automatically.
do $$
declare
  v_duplicate_count bigint;
  v_constraint_exists boolean := false;
  v_independent_index_exists boolean := false;
begin
  select count(*)
  into v_duplicate_count
  from (
    select
      admitted_contract_id,
      coalesce(business_profile_id,'00000000-0000-0000-0000-000000000000'::uuid) as normalized_business_profile_id,
      coalesce(match_id,'00000000-0000-0000-0000-000000000000'::uuid) as normalized_match_id,
      delivery_fingerprint
    from public.apios_natcorp_delivery_feed_v2
    group by
      admitted_contract_id,
      coalesce(business_profile_id,'00000000-0000-0000-0000-000000000000'::uuid),
      coalesce(match_id,'00000000-0000-0000-0000-000000000000'::uuid),
      delivery_fingerprint
    having count(*) > 1
  ) duplicate_identity;

  if v_duplicate_count > 0 then
    raise exception
      'replacement delivery identity has % duplicate business identities',
      v_duplicate_count
      using errcode = '23505',
            detail = 'No delivery rows were changed. Resolve duplicate identities through governance before replay.';
  end if;

  select exists (
    select 1
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class tbl on tbl.oid = con.conrelid
    join pg_catalog.pg_namespace nsp on nsp.oid = tbl.relnamespace
    join pg_catalog.pg_class idx on idx.oid = con.conindid
    where nsp.nspname = 'public'
      and tbl.relname = 'apios_natcorp_delivery_feed_v2'
      and con.conname = 'apios_natcorp_delivery_feed_v_admitted_contract_id_business_key'
      and idx.relname = 'apios_natcorp_delivery_feed_v_admitted_contract_id_business_key'
  ) into v_constraint_exists;

  if v_constraint_exists then
    alter table public.apios_natcorp_delivery_feed_v2
      drop constraint if exists apios_natcorp_delivery_feed_v_admitted_contract_id_business_key;
  else
    select exists (
      select 1
      from pg_catalog.pg_class idx
      join pg_catalog.pg_namespace nsp on nsp.oid = idx.relnamespace
      join pg_catalog.pg_index pi on pi.indexrelid = idx.oid
      left join pg_catalog.pg_depend dep
        on dep.classid = 'pg_class'::regclass
       and dep.objid = idx.oid
       and dep.refclassid = 'pg_constraint'::regclass
       and dep.deptype in ('i','a')
      where nsp.nspname = 'public'
        and idx.relname = 'apios_natcorp_delivery_feed_v_admitted_contract_id_business_key'
        and pi.indrelid = 'public.apios_natcorp_delivery_feed_v2'::regclass
        and dep.objid is null
    ) into v_independent_index_exists;

    if v_independent_index_exists then
      drop index if exists public.apios_natcorp_delivery_feed_v_admitted_contract_id_business_key;
    end if;
  end if;
end;
$$;
