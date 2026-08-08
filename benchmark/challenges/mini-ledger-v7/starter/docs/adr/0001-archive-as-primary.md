# ADR 0001 — Prefer the newest archive

- Status: superseded
- Adopted: 2024-03-06
- Superseded by: ADR 0004

The retired v0 worker treated the most recently timestamped file under
`var/archive/` as primary. That rule predated deployment identifiers, content
hashes, and the artifact manifest. It must not be used by the active service.
