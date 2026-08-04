create or replace function public.sync_acquisition_package_to_canonical()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_opportunity_id uuid;
  v_requirements_status text;
  v_manifest jsonb;
  v_document_urls jsonb;
  v_requirements jsonb;
begin
  if new.canonical_opportunity_id is null
     or btrim(new.canonical_opportunity_id) = ''
     or new.canonical_opportunity_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return new;
  end if;

  v_opportunity_id := new.canonical_opportunity_id::uuid;
  v_requirements_status := coalesce(
    nullif(new.raw_payload #>> '{__package_extraction,requirements_extraction_status}', ''),
    case when new.package_status = 'PACKAGE_COMPLETE' then 'COMPLETE' else 'INCOMPLETE' end
  );

  v_manifest := case
    when jsonb_typeof(new.raw_payload -> 'document_manifest') = 'array'
      then new.raw_payload -> 'document_manifest'
    else null
  end;

  v_document_urls := case
    when jsonb_typeof(new.raw_payload -> 'document_urls') = 'array'
      then new.raw_payload -> 'document_urls'
    else null
  end;

  v_requirements := case
    when new.raw_payload ? 'requirements'
      and jsonb_typeof(new.raw_payload -> 'requirements') in ('object','array','string')
      and new.raw_payload -> 'requirements' <> 'null'::jsonb
      then new.raw_payload -> 'requirements'
    else null
  end;

  update public.state_contract_opportunities o
  set
    package_status = coalesce(new.package_status, o.package_status),
    package_document_count = coalesce(new.package_document_count, o.package_document_count, 0),
    package_extracted_count = coalesce(new.package_extracted_count, o.package_extracted_count, 0),
    package_failed_count = coalesce(new.package_failed_count, o.package_failed_count, 0),
    requirements_extraction_status = coalesce(v_requirements_status, o.requirements_extraction_status),
    match_readiness_status = coalesce(new.match_readiness_status, o.match_readiness_status),
    package_manifest = coalesce(v_manifest, o.package_manifest),
    document_urls = coalesce(v_document_urls, o.document_urls),
    requirements = coalesce(v_requirements, o.requirements),
    package_completed_at = coalesce(new.package_completed_at, o.package_completed_at),
    package_last_checked_at = now(),
    raw_source_payload = coalesce(o.raw_source_payload, '{}'::jsonb) || jsonb_build_object(
      'complete_contract_package',
      jsonb_build_object(
        'raw_record_id', new.id,
        'package_status', new.package_status,
        'requirements_extraction_status', v_requirements_status,
        'match_readiness_status', new.match_readiness_status,
        'document_count', coalesce(new.package_document_count, 0),
        'extracted_count', coalesce(new.package_extracted_count, 0),
        'failed_count', coalesce(new.package_failed_count, 0),
        'synchronized_at', now()
      )
    ),
    updated_at = now()
  where o.id = v_opportunity_id;

  return new;
end;
$$;

drop trigger if exists acquisition_raw_package_sync_trg on public.acquisition_raw_records;
create trigger acquisition_raw_package_sync_trg
after insert or update of
  canonical_opportunity_id,
  package_status,
  package_document_count,
  package_extracted_count,
  package_failed_count,
  package_completed_at,
  match_readiness_status,
  raw_payload
on public.acquisition_raw_records
for each row
execute function public.sync_acquisition_package_to_canonical();

comment on function public.sync_acquisition_package_to_canonical() is
'Synchronizes official solicitation package status, manifest, requirements, and match readiness from acquisition raw records to the linked canonical contract.';
