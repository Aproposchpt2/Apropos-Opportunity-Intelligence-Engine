# APiE Expanded Publisher Discovery Implementation

**Implementation ID:** APIE-PSR-EXPANSION-001  
**Taxonomy version:** APIE-PSR-TAXONOMY-2026.08.02-V1  
**Status:** Implemented on protected feature branch; production validation pending  
**Owner:** Apropos Group LLC

## Objective

Expand Publisher Discovery beyond conventional state and local agencies so APiE can identify every qualified organization that publicly issues, administers, or distributes procurement opportunities supported by public authority or public funding.

## Implemented Scope

The discovery universe now covers more than 40 entity classes, including:

- federal, state, county, municipal, regional, district and tribal public buyers;
- towns, villages, boroughs and townships;
- special districts, utilities, transportation, airports, ports, housing, development, healthcare, education and judicial organizations;
- cooperative purchasing organizations;
- public-benefit and government-owned corporations;
- prime contractors and construction/program managers publishing subcontracting or bid-package opportunities;
- nonprofits and other institutions administering publicly funded programs;
- federal, state and local grant recipients purchasing with grant funds; and
- authorized procurement portals and supplemental publishers.

## Publisher Role Classification

Each admitted publisher is classified as one of:

- `DIRECT_PUBLIC_BUYER`
- `DELEGATED_PUBLIC_BUYER`
- `COOPERATIVE_PURCHASING_PUBLISHER`
- `PUBLICLY_FUNDED_PURCHASER`
- `PRIME_SUBCONTRACTING_PUBLISHER`
- `PROGRAM_MANAGER_BID_PUBLISHER`
- `SUPPLEMENTAL_PROCUREMENT_PUBLISHER`

## Opportunity Channel Classification

Each publisher assignment records the opportunity channel:

- `PUBLIC_CONTRACT`
- `PUBLIC_PURCHASE_ORDER`
- `COOPERATIVE_CONTRACT`
- `SUBCONTRACTING_OPPORTUNITY`
- `CONSTRUCTION_BID_PACKAGE`
- `GRANT_FUNDED_PURCHASE`
- `PUBLICLY_FUNDED_PROGRAM_PURCHASE`

## Data Preservation

Expanded classification is stored in existing JSON-compatible fields to avoid an unsafe production database migration:

- `publisher_registry.configuration`
- `publisher_assignments.search_parameters`
- `publisher_discovery_runs.governance`
- `publisher_discovery_runs.evidence`
- command-run execution evidence

Existing publisher and assignment records remain compatible.

## Admission Controls

A discovered candidate is automatically admitted only when:

1. at least one official source is supplied;
2. official-source verification is explicitly true;
3. the acquisition method is supported; and
4. a usable search or procurement endpoint exists.

Incomplete candidates remain isolated for exception review. The implementation does not fabricate API availability, procurement authority, funding basis, or missing endpoints.

## Files

- `netlify/functions/_shared/publisher-discovery-taxonomy.js`
- `netlify/functions/command-publisher-discovery-worker-background.js`
- `tests/publisher-discovery-taxonomy.test.mjs`

## Validation Required Before Production Acceptance

- Run the Node test suite.
- Deploy a branch preview.
- Execute controlled Publisher Discovery missions for Nevada, California and Arizona.
- Confirm traditional and nontraditional candidates are classified correctly.
- Confirm existing acquisition handoff remains operational.
- Confirm no unsupported database columns are written.
- Review exception isolation and duplicate handling.
- Obtain Project Owner acceptance before merge or production promotion.
