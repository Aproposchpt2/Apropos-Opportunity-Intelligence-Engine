# AOIE DECISION LOG

This file records approved project decisions. Newer written entries supersede older conflicting entries.

## D-001 — AOIE is the shared intelligence core

**Status:** Approved  
**Decision:** The Apropos Opportunity Intelligence Engine is the shared intelligence layer beneath NGCC, NVGovCC, CalGovCC, and future state portals. The portals are specialized delivery channels, not independent matching architectures.

## D-002 — Federal and state matching are architecturally distinct

**Status:** Approved  
**Decision:** Federal matching remains anchored in SAM.gov entity information, UEI, CAGE, NAICS, certifications, and federal opportunity data. State/local matching must use structured business capabilities, services, products, UNSPSC enrichment, semantic translation, geography, licenses, certifications, and capacity.

## D-003 — UNSPSC is a signal, not the entire profile

**Status:** Approved  
**Decision:** UNSPSC mappings improve retrieval and classification but do not define the business. AOIE must understand the business first, then generate and validate relevant UNSPSC candidates.

## D-004 — Keywords are derived evidence

**Status:** Approved  
**Decision:** Keywords remain useful for retrieval and evidence, but a keyword list is not the authoritative business profile. Keywords and synonyms should be generated from the Business Capability Graph.

## D-005 — Plain-language intake

**Status:** Approved  
**Decision:** Business owners should describe services, products, markets, licenses, equipment, geography, experience, and capacity in normal language. The engine performs the procurement-language translation.

## D-006 — Explainability is mandatory

**Status:** Approved  
**Decision:** Every ranked match must explain why it matched, which evidence supports it, which requirements are uncertain or unmet, and what next action is recommended. A score without an explanation is not an acceptable production output.

## D-007 — Fit Score and Confidence are separate

**Status:** Approved  
**Decision:** AOIE should report alignment separately from evidence confidence. High fit with incomplete source data may have moderate confidence; moderate fit supported by complete evidence may have high confidence.

## D-008 — Hard constraints precede ranking

**Status:** Approved  
**Decision:** Closed status, confirmed geography mismatch, mandatory license failure, mandatory certification failure, explicit exclusions, and confirmed scale mismatch must be addressed before soft ranking. Unknown information must not be treated as confirmed failure.

## D-009 — Free-access commercial model

**Status:** Approved  
**Decision:** Business profile creation, discovery, matching, dashboards, Analyze Fit, and Executive Opportunity Assessments are free. Contract Proposal Development is the professional service and primary upsell. Subscription and trial gates must not be reintroduced without written owner authorization.

## D-010 — Shared homepage messaging is locked

**Status:** Approved  
**Decision:** The approved homepage and hero messaging shared across the Government Contract Centers is considered locked. Matching-engine work must not casually redesign or rewrite approved public presentation.

## D-011 — Preserve approved interfaces

**Status:** Approved  
**Decision:** When a narrowly scoped content or logic change is authorized, do not redesign an approved dashboard or report. Preserve validated UX unless redesign is explicitly approved.

## D-012 — Source provenance is required

**Status:** Approved  
**Decision:** Every canonical opportunity and extracted requirement must retain the official source, source identity, capture time, parser/model version, and raw record or document reference where legally and operationally appropriate.

## D-013 — No fabricated procurement facts

**Status:** Approved  
**Decision:** AOIE must distinguish explicit source facts, business-supplied facts, normalized mappings, and model inferences. Missing values must remain unknown rather than being invented.

## D-014 — Fragmented source coverage is a core product responsibility

**Status:** Approved  
**Decision:** NVGovCC and CalGovCC must not treat a statewide portal as complete coverage. Source registries must account for state departments, counties, cities, municipalities, school districts, universities, transit agencies, water districts, utilities, and special districts.

## D-015 — Controlled learning only

**Status:** Approved  
**Decision:** User behavior may improve personalized ranking, but it must not silently overwrite authoritative capabilities or eligibility. Preference signals must remain separable, auditable, correctable, and resettable.

## D-016 — Validation before replacement

**Status:** Approved  
**Decision:** Existing production matching behavior remains in place until replacement AOIE logic passes controlled Validation and Acceptance testing. New matching logic should be developed on protected branches or behind feature flags.

## D-017 — GitHub is institutional memory

**Status:** Approved  
**Decision:** Conversation memory is not the authoritative project record. Architecture, requirements, decisions, tests, evidence, and handoff status must be maintained in version-controlled source-of-truth documentation.

## D-018 — Initial implementation sequence

**Status:** Approved  
**Decision:** Begin with baseline validation of NVGovCC and CalGovCC, inventory the existing profiles, data sources, schemas, and match logic, then approve the shared Business Capability Graph and Canonical Opportunity Record before implementing the hybrid matcher.

## D-019 — Development-stage accelerated integration

**Status:** Approved  
**Decision:** APiE and the Executive Command Center are currently in active development and the Executive Command Center is an owner-operated internal dashboard intended for use by the Project Owner. During this development stage, approved architectural, discovery, workflow, data-model, automation, and operator-interface improvements should be integrated proactively rather than deferred solely to preserve immature behavior. Development-stage changes may be merged after focused repository validation, rollback protection, and confirmation that they do not corrupt authoritative data, expose credentials, fabricate procurement facts, or remove essential provenance. Full production-grade release ceremony remains required before external users, institutional partners, or customer data are introduced.

**Operating effect:** D-019 refines D-011 and D-016 for the current development lifecycle. Protected branches, tests, backups, migration discipline, and validation remain required, but preserving an immature internal interface is not a reason to block beneficial integration.
