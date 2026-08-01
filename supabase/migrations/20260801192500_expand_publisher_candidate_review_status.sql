alter table public.publisher_discovery_candidates
  drop constraint if exists publisher_discovery_candidates_review_status_check;

alter table public.publisher_discovery_candidates
  add constraint publisher_discovery_candidates_review_status_check
  check (
    review_status = any (
      array[
        'RESEARCH_REQUIRED'::text,
        'PENDING_REVIEW'::text,
        'APPROVED_ADMITTED'::text,
        'REJECTED'::text,
        'AUTO_APPROVED'::text,
        'EXCEPTION_REVIEW'::text
      ]
    )
  );
