-- WP1 safe rollback artifact
-- Execute only under explicit authorization.
-- Historical evidence is preserved by default; destructive drops are intentionally omitted.

begin;

-- Disable downstream exposure first.
drop view if exists public.aoie_admitted_contract_candidates_v1;
drop view if exists public.admitted_contracts_current;

-- Remove application access while retaining all admission evidence.
revoke all on public.contract_admission_policy_versions, public.contract_admission_evaluations,
  public.contract_evidence_references, public.contract_rejection_ledger,
  public.contract_admission_review_queue, public.admitted_contracts,
  public.contract_admission_events from anon, authenticated;

-- Retire any active policy without deleting it.
update public.contract_admission_policy_versions
set policy_status='RETIRED', updated_at=now()
where policy_status='ACTIVE';

commit;

-- Destructive removal of Zone B/Zone C objects is prohibited in emergency rollback.
-- A separately authorized archival migration would be required after evidence export,
-- dependency verification, and written Alexander approval.
