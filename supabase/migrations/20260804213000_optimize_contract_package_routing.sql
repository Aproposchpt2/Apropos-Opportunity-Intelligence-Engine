create index if not exists acquisition_raw_records_package_route_idx
  on public.acquisition_raw_records (acquisition_run_id, processing_status, retrieval_timestamp, id)
  where processing_status = 'RAW';

create index if not exists state_contract_opportunities_source_fingerprint_idx
  on public.state_contract_opportunities (source_fingerprint)
  where source_fingerprint is not null;
