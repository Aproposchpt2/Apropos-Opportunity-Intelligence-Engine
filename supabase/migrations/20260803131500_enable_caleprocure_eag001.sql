update public.publisher_registry
set configuration = coalesce(configuration,'{}'::jsonb) || jsonb_build_object(
  'connector_key','CA_CALEPROCURE_CSCR',
  'connector_version','1.2.0',
  'certification_status','TESTING',
  'engineering_gate','EAG-001',
  'acquisition_requires_certification',true
), updated_at=now()
where id='0cf29ac8-f55b-4b46-ac2f-93d75694a318';
