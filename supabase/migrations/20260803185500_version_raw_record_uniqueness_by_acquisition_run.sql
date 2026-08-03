alter table public.acquisition_raw_records
  drop constraint if exists acquisition_raw_records_publisher_id_source_record_id_sourc_key;

alter table public.acquisition_raw_records
  add constraint acquisition_raw_records_run_publisher_source_unique
  unique (acquisition_run_id, publisher_id, source_record_id, source_fingerprint);

comment on constraint acquisition_raw_records_run_publisher_source_unique on public.acquisition_raw_records is
'Allows repeat acquisitions to preserve a complete run-specific raw snapshot while preventing duplicates inside the same run.';
