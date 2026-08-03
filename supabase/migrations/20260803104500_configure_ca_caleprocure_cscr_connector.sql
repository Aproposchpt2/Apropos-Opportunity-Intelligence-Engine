update public.publisher_registry
set configuration = coalesce(configuration,'{}'::jsonb) || jsonb_build_object(
  'connector_key','CA_CALEPROCURE_CSCR',
  'connector_version','1.0.0',
  'execution_scope','SINGLE_PUBLISHER',
  'engineering_priority','TIER_1',
  'validation_method','PUBLISHER_REPORTED_TOTAL',
  'count_reconciliation_required',true,
  'detail_extraction_required',true,
  'qualification_ruleset','NATCORP-CONTRACT-QUALIFICATION-V3'
), access_status='READY', updated_at=now()
where id='0cf29ac8-f55b-4b46-ac2f-93d75694a318';

update public.publisher_assignments
set search_parameters = coalesce(search_parameters,'{}'::jsonb) || jsonb_build_object(
  'connector_key','CA_CALEPROCURE_CSCR',
  'execution_scope','SINGLE_PUBLISHER',
  'event_status','POSTED',
  'detail_extraction_required',true
), qualification_ruleset_version='NATCORP-CONTRACT-QUALIFICATION-V3', status='READY', updated_at=now()
where publisher_id='0cf29ac8-f55b-4b46-ac2f-93d75694a318';

insert into public.connector_acceptance_registry
  (publisher_id,connector_key,connector_version,acceptance_status,acceptance_evidence,created_at,updated_at)
select '0cf29ac8-f55b-4b46-ac2f-93d75694a318'::uuid,'CA_CALEPROCURE_CSCR','1.0.0','TESTING',
  jsonb_build_object('publisher','State of California — California State Contracts Register (CSCR) / Cal eProcure','stage','CONNECTOR_DEPLOYED_AWAITING_ENGINEERING_TEST'),now(),now()
where not exists (select 1 from public.connector_acceptance_registry where connector_key='CA_CALEPROCURE_CSCR');
