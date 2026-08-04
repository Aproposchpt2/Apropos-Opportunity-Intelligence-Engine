create or replace function public.apie_publisher_classification_defaults()
returns trigger language plpgsql as $$
declare cfg jsonb:=coalesce(new.configuration,'{}'::jsonb); a text; e text;
begin
  a:=upper(coalesce(nullif(new.access_class,''),nullif(cfg->>'access_class',''),nullif(cfg->>'platform_access_class','')));
  if a is null or a not in ('CLASS_A','CLASS_B','CLASS_C','CLASS_D','UNKNOWN') then
    a:=case
      when coalesce(public.apie_cfg_bool(cfg,'authentication_required'),false) or coalesce(public.apie_cfg_bool(cfg,'login_required'),false) then 'CLASS_C'
      when coalesce(public.apie_cfg_bool(cfg,'stateful_session_required'),false) or coalesce(public.apie_cfg_bool(cfg,'javascript_required'),false) or coalesce(public.apie_cfg_bool(cfg,'browser_automation_required'),false) then 'CLASS_B'
      when upper(coalesce(new.acquisition_method,'')) in ('API','DOCUMENT_FEED') then 'CLASS_A'
      when upper(coalesce(new.acquisition_method,''))='PUBLIC_PORTAL' then 'CLASS_B'
      else 'UNKNOWN' end;
  end if;
  e:=upper(coalesce(nullif(new.engineering_complexity,''),nullif(cfg->>'engineering_complexity','')));
  if e is null or e not in ('LOW','MODERATE','HIGH','VERY_HIGH','UNKNOWN') then
    e:=case a when 'CLASS_A' then 'LOW' when 'CLASS_B' then 'HIGH' when 'CLASS_C' then 'HIGH' when 'CLASS_D' then 'VERY_HIGH' else 'UNKNOWN' end;
  end if;
  new.access_class:=a;
  new.engineering_complexity:=e;
  return new;
end;
$$;
drop trigger if exists publisher_registry_00_classification_defaults on public.publisher_registry;
create trigger publisher_registry_00_classification_defaults
before insert or update of configuration,acquisition_method,access_class,engineering_complexity
on public.publisher_registry for each row execute function public.apie_publisher_classification_defaults();

create or replace function public.apie_platform_classification_defaults()
returns trigger language plpgsql as $$
begin
  new.access_class:=coalesce(new.access_class,'UNKNOWN');
  new.engineering_complexity:=coalesce(new.engineering_complexity,'UNKNOWN');
  return new;
end;
$$;
drop trigger if exists procurement_platform_registry_00_defaults on public.procurement_platform_registry;
create trigger procurement_platform_registry_00_defaults
before insert or update on public.procurement_platform_registry
for each row execute function public.apie_platform_classification_defaults();
