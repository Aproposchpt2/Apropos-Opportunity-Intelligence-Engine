# Publisher Adapter Dispatch 001

This integration establishes Supabase PostgreSQL as the durable control plane for single-publisher acquisition discovery jobs and GitHub Actions as the execution plane.

Controls implemented:

- Immutable SINGLE publisher execution envelope on queue creation.
- Publisher adapter selection from the certified publisher assignment.
- Playwright browser adapter runtime for browser-required public search sources.
- Authoritative mission state normalization before raw persistence.
- Qualification routing restricted to the acquisition run created by the claimed queue job.
- Acceptance guard that fails if more than one publisher is processed.

The design intentionally prevents a retry from broadening a publisher-scoped mission into a statewide acquisition run.
