# ADR 0004 — Resolve artifacts through provenance

- Status: accepted
- Adopted: 2025-06-12
- Replaces: ADR 0001

The active service resolves authority from `var/artifact-manifest.json`, then
checks the selected artifact's deployment identity and recorded digest. File
recency, an archive name, or an operator hypothesis cannot promote advisory
data to canonical state.
