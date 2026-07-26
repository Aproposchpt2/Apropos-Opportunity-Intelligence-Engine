# Command Center Automation Work Package 1

**Document ID:** APIOS-CC-WP1-001-CP3-IMPLEMENTATION-PLAN  
**Status:** Checkpoint 3 branch development  
**Branch:** `implementation/mandatory-contract-admission-v1`

## Mission

Implement a non-bypassable contract-admission boundary between the canonical procurement candidate repository and all downstream matching, delivery, analysis, and executive-reporting systems.

## Authoritative data-zone decision

- **Zone A — Candidate repository:** `public.state_contract_opportunities`
- **Zone B — Admission control:** policy, evaluations, evidence references, rejection ledger, review queue, and immutable admission events
- **Zone C — Usable contract library:** admitted contracts and admitted-only downstream projections

`public.state_contract_opportunities` remains the canonical acquisition candidate repository. Presence in that table, a legacy release status, or Contract DNA completion does not establish admission.

## Mandatory admission rule

A candidate must be rejected unless authoritative records establish all of the following:

1. Verified official source
2. Verified issuing organization
3. Open lifecycle state
4. Valid future response deadline
5. Verified contract contact or official solicitation-specific question channel
6. Verified identifiable scope
7. Verified substantive contract requirements
8. Sufficient accessible procurement evidence
9. Current document version
10. Duplicate, supersession, and QA checks passed

Contract DNA completion must never substitute for verified evidence.

## Planned implementation objects

### Tables

- `public.contract_admission_policy_versions`
- `public.contract_admission_evaluations`
- `public.contract_rejection_ledger`
- `public.contract_admission_review_queue`
- `public.contract_evidence_references`
- `public.admitted_contracts`
- `public.contract_admission_events`

### Views

- `public.admitted_contracts_current`
- `public.aoie_admitted_contract_candidates_v1`
- `public.apios_natcorp_delivery_feed_v2`

### Privileged functions

- `public.evaluate_contract_candidate`
- `public.promote_candidate_to_admitted_contract`
- `public.revoke_admitted_contract`
- `public.activate_contract_admission_policy`
- `public.resolve_contract_admission_review`
- `public.reconcile_admitted_contract_lifecycle`
- `public.publish_admitted_contract_to_natcorp`
- `public.remove_contract_from_natcorp_delivery`
- `public.get_current_admitted_contract`
- `public.is_contract_currently_admitted`

## Production-compatibility gate

Migration SQL must not be finalized until the implementation captures and verifies:

- The primary-key name and exact data type of `public.state_contract_opportunities`
- Existing PIEE document, extraction, evidence, and version objects
- Existing foreign-key conventions
- Current `apios_*` and `natcorp_*` functions, views, triggers, policies, grants, and scheduled writers
- Current AOIE, NAT-CORP, Analyze Fit, and Command Center read paths
- Current production migration naming and rollback conventions

No inferred database type or guessed foreign key may enter the final migration.

## Security requirements

- No browser-side admission or promotion
- No client-supplied evidence truth values
- No `PUBLIC` execution on privileged functions
- Fixed secure `search_path` for any justified `SECURITY DEFINER` function
- Fully qualified database object references
- RLS on exposed admission objects
- Narrow server-side RPCs
- Immutable event and historical rejection evidence
- Transactional and idempotent promotion and revocation
- Unauthorized attempts recorded without logging credentials or secrets

## Workflow dependency order

1. Acquisition
2. Document registration
3. Document retrieval
4. Evidence extraction
5. Contract intelligence
6. Admission evaluation
7. Promotion or rejection
8. AOIE matching
9. NAT-CORP delivery
10. Analyze Fit
11. Executive reporting

Admission-related stages fail closed for the affected candidate.

## Branch restrictions

This branch must not:

- Apply a production migration
- Activate Policy 1.0 in production
- Re-evaluate, reject, admit, revoke, or delete production candidates
- Change current production AOIE, NAT-CORP, or Analyze Fit behavior
- Modify production RLS, grants, secrets, or environment variables
- Merge to `main` without later authorization

## Required implementation evidence

Checkpoint 3 completion requires:

- Production-compatible additive migrations
- Paired rollback artifacts
- Policy 1.0 seed in non-active state
- Evaluation, promotion, revocation, review, lifecycle, and delivery functions
- Admitted-only views
- AOIE, NAT-CORP, Analyze Fit, and metric reconciliation changes
- SQL, integration, security, idempotency, fail-closed, and rollback tests
- Reconciliation queries
- No production changes
