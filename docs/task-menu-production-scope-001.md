# APIE Task Menu Production Scope 001

Acquisition Discovery now supports two operator scopes from the Executive Command Center:

- `SINGLE` — one certified publisher.
- `ALL_ELIGIBLE` — every certified publisher in the selected county.

`ALL_ELIGIBLE` does not create one oversized acquisition job. The command layer fans the request out into independent immutable single-publisher command runs. Supabase PostgreSQL remains the durable queue/control plane and GitHub Actions remains the execution plane.

The browser UI does not expose adapter implementation details. Each child run is sealed with its authoritative state, county, and publisher identity before PostgreSQL queue admission.
