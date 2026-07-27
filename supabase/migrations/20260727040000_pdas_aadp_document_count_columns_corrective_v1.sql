alter table public.acquisition_raw_records
  add column if not exists document_manifest_count integer not null default 0,
  add column if not exists addendum_count integer not null default 0,
  add column if not exists amendment_count integer not null default 0,
  add column if not exists public_qa_count integer not null default 0;

comment on column public.acquisition_raw_records.document_manifest_count is
  'Count of public procurement documents identified for the raw source record.';
comment on column public.acquisition_raw_records.addendum_count is
  'Count of public addenda identified for the raw source record.';
comment on column public.acquisition_raw_records.amendment_count is
  'Count of public amendments identified for the raw source record.';
comment on column public.acquisition_raw_records.public_qa_count is
  'Count of public questions-and-answers resources identified for the raw source record.';