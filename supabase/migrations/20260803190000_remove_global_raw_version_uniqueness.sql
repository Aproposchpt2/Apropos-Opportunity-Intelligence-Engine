drop index if exists public.acquisition_raw_records_version_identity_unique_idx;

create index if not exists acquisition_raw_records_version_identity_lookup_idx
on public.acquisition_raw_records (
  publisher_id,
  source_record_id,
  content_fingerprint,
  version_detected_at desc
);
