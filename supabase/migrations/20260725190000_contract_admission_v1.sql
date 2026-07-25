-- APIOS Command Center Automation Work Package 1
-- Additive contract-admission control plane. Production activation is separate.

create extension if not exists pgcrypto;

create table if not exists public.contract_admission_policy_versions (
  policy_id uuid primary key default gen_random_uuid(),
  policy_version text not null unique,
  policy_name text not null,
  policy_status text not null check (policy_status in ('DRAFT','APPROVED','ACTIVE','SUPERSEDED','RETIRED')),
  effective_at timestamptz,
  approved_at timestamptz not null,
  approved_by text not null,
  activated_at timestamptz,
  activated_by text,
  superseded_at timestamptz,
  superseded_by_policy_id uuid references public.contract_admission_policy_versions(policy_id),
  mandatory_rules jsonb not null,
  rejection_code_vocabulary jsonb not null,
  evidence_requirements jsonb not null,
  promotion_function_version text not null,
  revocation_function_version text not null,
  policy_fingerprint text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists contract_admission_one_active_policy_idx
  on public.contract_admission_policy_versions ((policy_status)) where policy_status='ACTIVE';

create table if not exists public.contract_admission_evaluations (
  evaluation_id uuid primary key default gen_random_uuid(),
  candidate_opportunity_id uuid not null references public.state_contract_opportunities(id),
  policy_id uuid not null references public.contract_admission_policy_versions(policy_id),
  evaluation_status text not null check (evaluation_status in ('PENDING','EVALUATING','ADMITTED','REJECTED','REVIEW_REQUIRED','SUPERSEDED','REVOKED','ERROR')),
  official_source_status text not null,
  issuer_status text not null,
  lifecycle_status text not null,
  deadline_status text not null,
  contact_status text not null,
  scope_status text not null,
  requirements_status text not null,
  document_status text not null,
  duplicate_status text not null,
  supersession_status text not null,
  qa_status text not null,
  rejection_codes text[] not null default '{}',
  evidence_manifest jsonb not null default '{}'::jsonb,
  source_fingerprint text not null,
  document_fingerprint text not null,
  evaluation_input_fingerprint text not null,
  evaluated_by text not null,
  evaluated_at timestamptz not null default now(),
  review_required boolean not null default false,
  reviewed_by text,
  reviewed_at timestamptz,
  review_decision text,
  notes text,
  correlation_id uuid,
  run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(candidate_opportunity_id,policy_id,source_fingerprint,document_fingerprint,evaluation_input_fingerprint),
  check (evaluation_status <> 'REJECTED' or cardinality(rejection_codes) > 0),
  check (evaluation_status <> 'ADMITTED' or cardinality(rejection_codes) = 0),
  check (evaluation_status <> 'REVIEW_REQUIRED' or review_required)
);

create table if not exists public.contract_evidence_references (
  evidence_reference_id uuid primary key default gen_random_uuid(),
  candidate_opportunity_id uuid not null references public.state_contract_opportunities(id),
  evaluation_id uuid references public.contract_admission_evaluations(evaluation_id),
  evidence_type text not null check (evidence_type in ('OFFICIAL_SOURCE','ISSUING_ORGANIZATION','CONTACT','SCOPE','REQUIREMENT','DOCUMENT_VERSION','DEADLINE','LIFECYCLE','DUPLICATE_REVIEW','SUPERSESSION_REVIEW','QA')),
  source_object_type text not null,
  source_object_id text not null,
  document_id text,
  document_version text,
  source_url text not null,
  source_phrase text,
  page_number integer,
  section_reference text,
  character_start integer,
  character_end integer,
  extraction_method text,
  model_or_ruleset_version text,
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  verification_status text not null check (verification_status in ('VERIFIED','UNVERIFIED','EXTRACTED_UNVERIFIED','CONFLICTING','EXPIRED','NOT_FOUND','REVIEW_REQUIRED')),
  verified_by text,
  extracted_at timestamptz,
  verified_at timestamptz,
  source_fingerprint text not null,
  document_fingerprint text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.contract_rejection_ledger (
  rejection_id uuid primary key default gen_random_uuid(),
  evaluation_id uuid not null references public.contract_admission_evaluations(evaluation_id),
  candidate_opportunity_id uuid not null references public.state_contract_opportunities(id),
  policy_id uuid not null references public.contract_admission_policy_versions(policy_id),
  rejection_codes text[] not null check (cardinality(rejection_codes)>0),
  rejection_summary text,
  evidence_manifest jsonb not null default '{}'::jsonb,
  rejected_by text not null,
  rejected_at timestamptz not null default now(),
  review_status text not null default 'NOT_REQUESTED',
  superseded_by_evaluation_id uuid references public.contract_admission_evaluations(evaluation_id),
  correlation_id uuid,
  run_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.contract_admission_review_queue (
  review_item_id uuid primary key default gen_random_uuid(),
  evaluation_id uuid not null references public.contract_admission_evaluations(evaluation_id),
  candidate_opportunity_id uuid not null references public.state_contract_opportunities(id),
  review_reason_codes text[] not null check (cardinality(review_reason_codes)>0),
  review_priority text not null check (review_priority in ('CRITICAL','HIGH','MEDIUM','LOW')),
  assigned_to text,
  review_status text not null check (review_status in ('OPEN','ASSIGNED','IN_REVIEW','COMPLETED','CANCELLED','SUPERSEDED')),
  evidence_manifest jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  due_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  decision text check (decision is null or decision in ('CONFIRM_ADMISSION','CONFIRM_REJECTION','REQUEST_REEXTRACTION','SUPERSEDED','NO_DECISION')),
  decision_notes text,
  decision_evidence_manifest jsonb
);

create table if not exists public.admitted_contracts (
  admitted_contract_id uuid primary key default gen_random_uuid(),
  candidate_opportunity_id uuid not null references public.state_contract_opportunities(id),
  evaluation_id uuid not null unique references public.contract_admission_evaluations(evaluation_id),
  policy_id uuid not null references public.contract_admission_policy_versions(policy_id),
  admission_status text not null check (admission_status in ('ADMITTED','REVOKED','SUPERSEDED','EXPIRED','CLOSED','CANCELLED','WITHDRAWN')),
  admitted_at timestamptz not null default now(),
  admitted_by text not null,
  current_document_version text not null,
  official_source_evidence_id uuid not null references public.contract_evidence_references(evidence_reference_id),
  contact_evidence_id uuid not null references public.contract_evidence_references(evidence_reference_id),
  scope_evidence_id uuid not null references public.contract_evidence_references(evidence_reference_id),
  requirements_evidence_manifest jsonb not null,
  source_fingerprint text not null,
  document_fingerprint text not null,
  lifecycle_status text not null,
  response_deadline timestamptz not null,
  revoked_at timestamptz,
  revoked_by text,
  revocation_reason_codes text[] not null default '{}',
  superseded_by_admitted_contract_id uuid references public.admitted_contracts(admitted_contract_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (admission_status <> 'ADMITTED' or revoked_at is null),
  check (admission_status <> 'REVOKED' or (revoked_at is not null and cardinality(revocation_reason_codes)>0))
);
create unique index if not exists admitted_contracts_one_active_version_idx
  on public.admitted_contracts(candidate_opportunity_id,document_fingerprint)
  where admission_status='ADMITTED';

create table if not exists public.contract_admission_events (
  event_id uuid primary key default gen_random_uuid(),
  candidate_opportunity_id uuid not null references public.state_contract_opportunities(id),
  evaluation_id uuid references public.contract_admission_evaluations(evaluation_id),
  admitted_contract_id uuid references public.admitted_contracts(admitted_contract_id),
  event_type text not null,
  prior_state jsonb,
  new_state jsonb,
  policy_id uuid references public.contract_admission_policy_versions(policy_id),
  actor_type text not null,
  actor_id text not null,
  reason_codes text[] not null default '{}',
  evidence_manifest jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  correlation_id uuid not null,
  run_id uuid,
  request_fingerprint text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists contract_admission_eval_candidate_idx on public.contract_admission_evaluations(candidate_opportunity_id,evaluated_at desc);
create index if not exists contract_admission_eval_status_idx on public.contract_admission_evaluations(evaluation_status,evaluated_at desc);
create index if not exists contract_evidence_candidate_type_idx on public.contract_evidence_references(candidate_opportunity_id,evidence_type,verification_status);
create index if not exists contract_rejection_candidate_idx on public.contract_rejection_ledger(candidate_opportunity_id,rejected_at desc);
create index if not exists contract_review_status_idx on public.contract_admission_review_queue(review_status,review_priority,created_at);
create index if not exists admitted_contracts_status_idx on public.admitted_contracts(admission_status,response_deadline);
create index if not exists contract_admission_events_candidate_idx on public.contract_admission_events(candidate_opportunity_id,occurred_at desc);

alter table public.contract_admission_policy_versions enable row level security;
alter table public.contract_admission_evaluations enable row level security;
alter table public.contract_evidence_references enable row level security;
alter table public.contract_rejection_ledger enable row level security;
alter table public.contract_admission_review_queue enable row level security;
alter table public.admitted_contracts enable row level security;
alter table public.contract_admission_events enable row level security;

revoke all on public.contract_admission_policy_versions, public.contract_admission_evaluations,
  public.contract_evidence_references, public.contract_rejection_ledger,
  public.contract_admission_review_queue, public.admitted_contracts,
  public.contract_admission_events from anon, authenticated;

create or replace view public.admitted_contracts_current
with (security_invoker=true) as
select a.*, o.title, o.solicitation_number, o.issuing_organization,
       coalesce(o.official_source_url,o.source_url) as official_source_url,
       o.procurement_type, o.state_code,
       o.place_of_performance_county as county,
       o.place_of_performance_city as city,
       o.naics_codes, o.unspsc_codes, o.commodity_codes,
       o.requirements, o.natcorp_contract_dna_status
from public.admitted_contracts a
join public.contract_admission_evaluations e on e.evaluation_id=a.evaluation_id
join public.state_contract_opportunities o on o.id=a.candidate_opportunity_id
where a.admission_status='ADMITTED'
  and a.revoked_at is null
  and lower(a.lifecycle_status)='open'
  and a.response_deadline>now()
  and e.evaluation_status='ADMITTED';

create or replace view public.aoie_admitted_contract_candidates_v1
with (security_invoker=true) as
select * from public.admitted_contracts_current;

insert into public.contract_admission_policy_versions(
  policy_version,policy_name,policy_status,approved_at,approved_by,
  mandatory_rules,rejection_code_vocabulary,evidence_requirements,
  promotion_function_version,revocation_function_version,policy_fingerprint
)
values (
  '1.0','APROPOS Contract Admission Policy','APPROVED',now(),'ALEXANDER',
  jsonb_build_object('contact','VERIFIED','requirements','VERIFIED','scope','VERIFIED','official_source','VERIFIED','lifecycle','OPEN','deadline','FUTURE'),
  to_jsonb(array['MISSING_CONTRACT_CONTACT','MISSING_CONTRACT_REQUIREMENTS','MISSING_SCOPE_OF_WORK','REQUIREMENTS_NOT_EXTRACTABLE','INACCESSIBLE_SOLICITATION_PACKAGE','UNVERIFIED_OFFICIAL_SOURCE','INSUFFICIENT_PROCUREMENT_INFORMATION','CONTACT_NOT_VERIFIABLE','CLOSED_OR_EXPIRED','INVALID_DEADLINE','DUPLICATE_CANDIDATE','SUPERSEDED_VERSION','DOCUMENT_VERSION_UNCERTAIN','ISSUING_ORGANIZATION_UNVERIFIED','QA_POLICY_FAILURE']::text[]),
  jsonb_build_object('required_evidence_types',array['OFFICIAL_SOURCE','CONTACT','SCOPE','REQUIREMENT']),
  '1.0','1.0',encode(digest('APROPOS Contract Admission Policy 1.0','sha256'),'hex')
)
on conflict (policy_version) do nothing;
