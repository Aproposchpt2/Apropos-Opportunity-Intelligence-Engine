create or replace function public.apie_registry_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at:=now(); return new; end;
$$;

drop trigger if exists county_expansion_profiles_touch on public.county_expansion_profiles;
create trigger county_expansion_profiles_touch before update on public.county_expansion_profiles for each row execute function public.apie_registry_touch_updated_at();
drop trigger if exists procurement_platform_registry_touch on public.procurement_platform_registry;
create trigger procurement_platform_registry_touch before update on public.procurement_platform_registry for each row execute function public.apie_registry_touch_updated_at();
drop trigger if exists procurement_connector_registry_touch on public.procurement_connector_registry;
create trigger procurement_connector_registry_touch before update on public.procurement_connector_registry for each row execute function public.apie_registry_touch_updated_at();

create or replace function public.apie_cfg_bool(p_cfg jsonb,p_key text)
returns boolean language sql immutable as $$
  select case when jsonb_typeof(p_cfg->p_key)='boolean' then (p_cfg->>p_key)::boolean else null end
$$;

create or replace function public.apie_sync_discovery_geography()
returns trigger language plpgsql security definer set search_path=public as $$
declare parts text[]; profile_id uuid; canonical_name text; canonical_fips text;
begin
  if new.discovery_scope like 'COUNTY|%' then
    parts:=string_to_array(new.discovery_scope,'|');
    new.county_fips:=coalesce(nullif(new.county_fips,''),nullif(parts[2],''));
    new.county_name:=coalesce(nullif(new.county_name,''),nullif(parts[3],''));
  end if;
  if new.state_code is not null and new.county_name is not null then
    select id,county_name,county_fips into profile_id,canonical_name,canonical_fips
      from public.county_expansion_profiles
      where state_code=new.state_code and county_key=lower(btrim(new.county_name)) limit 1;
    new.county_name:=coalesce(canonical_name,new.county_name);
    new.county_fips:=coalesce(new.county_fips,canonical_fips);
    new.county_expansion_profile_id:=profile_id;
  end if;
  return new;
end;
$$;
drop trigger if exists publisher_discovery_runs_sync_geography on public.publisher_discovery_runs;
create trigger publisher_discovery_runs_sync_geography before insert or update of discovery_scope,county_name,county_fips on public.publisher_discovery_runs for each row execute function public.apie_sync_discovery_geography();

create or replace function public.apie_sync_candidate_geography()
returns trigger language plpgsql security definer set search_path=public as $$
declare run_county text; run_fips text;
begin
  select county_name,county_fips into run_county,run_fips from public.publisher_discovery_runs where id=new.discovery_run_id;
  new.county_name:=coalesce(new.county_name,run_county);
  new.county_fips:=coalesce(new.county_fips,run_fips);
  new.access_class:=coalesce(new.access_class,case when new.registration_required then 'CLASS_C' when upper(coalesce(new.acquisition_method,'')) in ('API','DOCUMENT_FEED') then 'CLASS_A' when upper(coalesce(new.acquisition_method,''))='PUBLIC_PORTAL' then 'CLASS_B' else 'UNKNOWN' end);
  new.machine_to_machine_supported:=coalesce(new.machine_to_machine_supported,case when new.access_class='CLASS_A' then true when new.access_class in ('CLASS_B','CLASS_C','CLASS_D') then false end);
  new.connector_strategy:=coalesce(new.connector_strategy,case new.access_class when 'CLASS_A' then 'DIRECT_NETLIFY_CONNECTOR' when 'CLASS_B' then 'STATEFUL_SESSION_OR_HEADLESS_BROWSER' when 'CLASS_C' then 'AUTHORIZED_ACCOUNT_INTEGRATION_OR_OFFICIAL_FEED' when 'CLASS_D' then 'PUBLISHER_OR_PLATFORM_AGREEMENT' else 'ENGINEERING_REVIEW_REQUIRED' end);
  new.engineering_complexity:=coalesce(new.engineering_complexity,case new.access_class when 'CLASS_A' then 'LOW' when 'CLASS_B' then 'HIGH' when 'CLASS_C' then 'HIGH' when 'CLASS_D' then 'VERY_HIGH' else 'UNKNOWN' end);
  return new;
end;
$$;
drop trigger if exists publisher_discovery_candidates_sync_geography on public.publisher_discovery_candidates;
create trigger publisher_discovery_candidates_sync_geography before insert or update of discovery_run_id,county_name,county_fips,acquisition_method,registration_required,access_class on public.publisher_discovery_candidates for each row execute function public.apie_sync_candidate_geography();

create or replace function public.apie_sync_publisher_platform()
returns trigger language plpgsql security definer set search_path=public as $$
declare
  cfg jsonb:=coalesce(new.configuration,'{}'::jsonb);
  p_name text; p_vendor text; c_key text; a_class text; c_strategy text; complexity text;
  p_id uuid; c_id uuid; canonical_name text; canonical_fips text;
begin
  new.county_name:=coalesce(nullif(btrim(new.county_name),''),nullif(btrim(cfg->>'county_name'),''));
  new.county_fips:=coalesce(nullif(btrim(new.county_fips),''),nullif(btrim(cfg->>'county_fips'),''));
  if new.state_code is not null and new.county_name is not null then
    select county_name,county_fips into canonical_name,canonical_fips from public.county_expansion_profiles
      where state_code=new.state_code and county_key=lower(btrim(new.county_name)) limit 1;
    new.county_name:=coalesce(canonical_name,new.county_name);
    new.county_fips:=coalesce(new.county_fips,canonical_fips);
  end if;

  a_class:=upper(coalesce(nullif(new.access_class,''),nullif(cfg->>'access_class',''),nullif(cfg->>'platform_access_class','')));
  if a_class not in ('CLASS_A','CLASS_B','CLASS_C','CLASS_D','UNKNOWN') then a_class:=null; end if;
  if a_class is null then
    a_class:=case
      when coalesce(public.apie_cfg_bool(cfg,'authentication_required'),false) or coalesce(public.apie_cfg_bool(cfg,'login_required'),false) then 'CLASS_C'
      when coalesce(public.apie_cfg_bool(cfg,'stateful_session_required'),false) or coalesce(public.apie_cfg_bool(cfg,'javascript_required'),false) or coalesce(public.apie_cfg_bool(cfg,'browser_automation_required'),false) then 'CLASS_B'
      when coalesce(public.apie_cfg_bool(cfg,'public_api_available'),false) or coalesce(public.apie_cfg_bool(cfg,'rss_available'),false) or coalesce(public.apie_cfg_bool(cfg,'csv_available'),false) or coalesce(public.apie_cfg_bool(cfg,'json_available'),false) or coalesce(public.apie_cfg_bool(cfg,'xml_available'),false) or coalesce(public.apie_cfg_bool(cfg,'open_data_available'),false) or upper(coalesce(new.acquisition_method,'')) in ('API','DOCUMENT_FEED') then 'CLASS_A'
      when upper(coalesce(new.acquisition_method,''))='PUBLIC_PORTAL' then 'CLASS_B' else 'UNKNOWN' end;
  end if;
  new.access_class:=a_class;
  new.machine_to_machine_supported:=coalesce(new.machine_to_machine_supported,public.apie_cfg_bool(cfg,'machine_to_machine_supported'),case when a_class='CLASS_A' then true when a_class in ('CLASS_B','CLASS_C','CLASS_D') then false else null end);
  c_strategy:=upper(coalesce(nullif(new.connector_strategy,''),nullif(cfg->>'connector_strategy',''),nullif(cfg->>'recommended_connector_strategy','')));
  if c_strategy is null then c_strategy:=case a_class when 'CLASS_A' then 'DIRECT_NETLIFY_CONNECTOR' when 'CLASS_B' then 'STATEFUL_SESSION_OR_HEADLESS_BROWSER' when 'CLASS_C' then 'AUTHORIZED_ACCOUNT_INTEGRATION_OR_OFFICIAL_FEED' when 'CLASS_D' then 'PUBLISHER_OR_PLATFORM_AGREEMENT' else 'ENGINEERING_REVIEW_REQUIRED' end; end if;
  new.connector_strategy:=c_strategy;
  complexity:=upper(coalesce(nullif(new.engineering_complexity,''),nullif(cfg->>'engineering_complexity','')));
  if complexity not in ('LOW','MODERATE','HIGH','VERY_HIGH','UNKNOWN') then complexity:=case a_class when 'CLASS_A' then 'LOW' when 'CLASS_B' then 'HIGH' when 'CLASS_C' then 'HIGH' when 'CLASS_D' then 'VERY_HIGH' else 'UNKNOWN' end; end if;
  new.engineering_complexity:=complexity;
  if new.reuse_score is null and coalesce(cfg->>'reuse_score','') ~ '^[0-9]+([.][0-9]+)?$' then new.reuse_score:=least(100,(cfg->>'reuse_score')::numeric); end if;
  if new.connector_roi_score is null and coalesce(cfg->>'connector_roi_score','') ~ '^[0-9]+([.][0-9]+)?$' then new.connector_roi_score:=least(100,(cfg->>'connector_roi_score')::numeric); end if;

  p_name:=coalesce(nullif(btrim(cfg->>'procurement_platform'),''),nullif(btrim(cfg->>'platform_name'),''));
  p_vendor:=coalesce(nullif(btrim(cfg->>'technology_vendor'),''),nullif(btrim(cfg->>'platform_vendor'),''));
  c_key:=nullif(btrim(cfg->>'connector_key'),'');
  if p_name is not null then
    insert into public.procurement_platform_registry(platform_name,platform_vendor,access_class,machine_to_machine_supported,public_api_available,api_documentation_url,rss_available,csv_available,json_available,xml_available,open_data_available,registration_required,login_required,stateful_session_required,javascript_required,browser_automation_required,document_access_method,pagination_method,detail_resolution_method,authentication_model,anti_automation_indicators,recommended_connector_strategy,connector_key,connector_version,connector_status,certification_status,engineering_complexity,reuse_score,connector_roi_score,last_verified_at,verification_evidence)
    values(p_name,p_vendor,a_class,new.machine_to_machine_supported,coalesce(public.apie_cfg_bool(cfg,'public_api_available'),false),nullif(cfg->>'api_documentation_url',''),coalesce(public.apie_cfg_bool(cfg,'rss_available'),false),coalesce(public.apie_cfg_bool(cfg,'csv_available'),false),coalesce(public.apie_cfg_bool(cfg,'json_available'),false),coalesce(public.apie_cfg_bool(cfg,'xml_available'),false),coalesce(public.apie_cfg_bool(cfg,'open_data_available'),false),public.apie_cfg_bool(cfg,'registration_required'),coalesce(public.apie_cfg_bool(cfg,'login_required'),public.apie_cfg_bool(cfg,'authentication_required')),public.apie_cfg_bool(cfg,'stateful_session_required'),public.apie_cfg_bool(cfg,'javascript_required'),public.apie_cfg_bool(cfg,'browser_automation_required'),nullif(cfg->>'document_access_method',''),nullif(cfg->>'pagination_method',''),nullif(cfg->>'detail_resolution_method',''),nullif(cfg->>'authentication_model',''),case when jsonb_typeof(cfg->'anti_automation_indicators')='array' then cfg->'anti_automation_indicators' else '[]'::jsonb end,c_strategy,c_key,nullif(cfg->>'connector_version',''),case when c_key is null then 'UNASSIGNED' else 'REGISTERED' end,upper(coalesce(nullif(cfg->>'certification_status',''),'DEVELOPMENT')),complexity,new.reuse_score,new.connector_roi_score,new.last_verified_at,jsonb_build_object('publisher_id',new.id,'publisher_name',new.publisher_name))
    on conflict(platform_key) do update set access_class=excluded.access_class,machine_to_machine_supported=coalesce(excluded.machine_to_machine_supported,procurement_platform_registry.machine_to_machine_supported),recommended_connector_strategy=excluded.recommended_connector_strategy,connector_key=coalesce(excluded.connector_key,procurement_platform_registry.connector_key),connector_version=coalesce(excluded.connector_version,procurement_platform_registry.connector_version),connector_status=excluded.connector_status,certification_status=excluded.certification_status,engineering_complexity=excluded.engineering_complexity,reuse_score=coalesce(excluded.reuse_score,procurement_platform_registry.reuse_score),connector_roi_score=coalesce(excluded.connector_roi_score,procurement_platform_registry.connector_roi_score),last_verified_at=coalesce(excluded.last_verified_at,procurement_platform_registry.last_verified_at),verification_evidence=procurement_platform_registry.verification_evidence||excluded.verification_evidence,updated_at=now()
    returning id into p_id;
    new.platform_id:=p_id;
  end if;
  if c_key is not null then
    insert into public.procurement_connector_registry(connector_key,connector_name,platform_id,connector_version,connector_class,runtime,implementation_path,supports_search,supports_pagination,supports_detail_resolution,supports_requirements,supports_contacts,supports_attachments,supports_qualification,supports_deduplication,supports_reconciliation,supports_verification,authentication_model,certification_status,engineering_status,last_verified_at,known_limitations)
    values(c_key,coalesce(nullif(cfg->>'connector_name',''),c_key),p_id,nullif(cfg->>'connector_version',''),a_class,coalesce(nullif(cfg->>'runtime',''),'NETLIFY_FUNCTION'),nullif(cfg->>'implementation_path',''),true,coalesce(public.apie_cfg_bool(cfg,'supports_pagination'),false),coalesce(public.apie_cfg_bool(cfg,'supports_detail_resolution'),public.apie_cfg_bool(cfg,'detail_extraction_required'),false),coalesce(public.apie_cfg_bool(cfg,'supports_requirements'),false),coalesce(public.apie_cfg_bool(cfg,'supports_contacts'),false),coalesce(public.apie_cfg_bool(cfg,'supports_attachments'),false),coalesce(public.apie_cfg_bool(cfg,'supports_qualification'),false),coalesce(public.apie_cfg_bool(cfg,'supports_deduplication'),false),coalesce(public.apie_cfg_bool(cfg,'supports_reconciliation'),public.apie_cfg_bool(cfg,'count_reconciliation_required'),false),true,nullif(cfg->>'authentication_model',''),upper(coalesce(nullif(cfg->>'certification_status',''),'DEVELOPMENT')),case when upper(coalesce(cfg->>'certification_status','DEVELOPMENT')) in ('CERTIFIED','PRODUCTION') then 'ACCEPTED' else 'TESTING' end,new.last_verified_at,case when jsonb_typeof(cfg->'known_limitations')='array' then cfg->'known_limitations' else '[]'::jsonb end)
    on conflict(connector_key) do update set platform_id=coalesce(excluded.platform_id,procurement_connector_registry.platform_id),connector_version=coalesce(excluded.connector_version,procurement_connector_registry.connector_version),connector_class=excluded.connector_class,implementation_path=coalesce(excluded.implementation_path,procurement_connector_registry.implementation_path),supports_search=true,supports_pagination=procurement_connector_registry.supports_pagination or excluded.supports_pagination,supports_detail_resolution=procurement_connector_registry.supports_detail_resolution or excluded.supports_detail_resolution,supports_requirements=procurement_connector_registry.supports_requirements or excluded.supports_requirements,supports_contacts=procurement_connector_registry.supports_contacts or excluded.supports_contacts,supports_attachments=procurement_connector_registry.supports_attachments or excluded.supports_attachments,supports_reconciliation=procurement_connector_registry.supports_reconciliation or excluded.supports_reconciliation,supports_verification=true,certification_status=excluded.certification_status,engineering_status=excluded.engineering_status,last_verified_at=coalesce(excluded.last_verified_at,procurement_connector_registry.last_verified_at),known_limitations=case when excluded.known_limitations='[]'::jsonb then procurement_connector_registry.known_limitations else excluded.known_limitations end,updated_at=now()
    returning id into c_id;
    new.connector_registry_id:=c_id;
  end if;
  new.configuration:=cfg||jsonb_strip_nulls(jsonb_build_object('county_name',new.county_name,'county_fips',new.county_fips,'access_class',a_class,'platform_access_class',a_class,'machine_to_machine_supported',new.machine_to_machine_supported,'connector_strategy',c_strategy,'recommended_connector_strategy',c_strategy,'engineering_complexity',complexity,'reuse_score',new.reuse_score,'connector_roi_score',new.connector_roi_score));
  return new;
end;
$$;
drop trigger if exists publisher_registry_sync_platform on public.publisher_registry;
create trigger publisher_registry_sync_platform before insert or update of configuration,county_name,county_fips,acquisition_method,access_class,machine_to_machine_supported,connector_strategy,engineering_complexity,reuse_score,connector_roi_score on public.publisher_registry for each row execute function public.apie_sync_publisher_platform();

create or replace function public.apie_refresh_registry_rollups()
returns trigger language plpgsql security definer set search_path=public as $$
declare s text; c text; p uuid;
begin
  if tg_op='DELETE' then s:=old.state_code; c:=old.county_name; p:=old.platform_id; else s:=new.state_code; c:=new.county_name; p:=new.platform_id; end if;
  if p is not null then update public.procurement_platform_registry set publisher_count=(select count(*) from public.publisher_registry where platform_id=p) where id=p; end if;
  if s is not null and c is not null then
    insert into public.county_expansion_profiles(state_code,county_name,discovery_status) values(s,c,'PUBLISHER_PROFILE_PRESENT') on conflict(state_code,county_key) do nothing;
    update public.county_expansion_profiles x set publishers_discovered=(select count(*) from public.publisher_registry r where r.state_code=x.state_code and lower(btrim(r.county_name))=x.county_key),platforms_identified=(select count(distinct r.platform_id) from public.publisher_registry r where r.state_code=x.state_code and lower(btrim(r.county_name))=x.county_key and r.platform_id is not null),class_a_platforms=(select count(distinct r.platform_id) from public.publisher_registry r where r.state_code=x.state_code and lower(btrim(r.county_name))=x.county_key and r.access_class='CLASS_A') where x.state_code=s and x.county_key=lower(btrim(c));
  end if;
  if tg_op='DELETE' then return old; end if; return new;
end;
$$;
drop trigger if exists publisher_registry_refresh_rollups on public.publisher_registry;
create trigger publisher_registry_refresh_rollups after insert or update or delete on public.publisher_registry for each row execute function public.apie_refresh_registry_rollups();
