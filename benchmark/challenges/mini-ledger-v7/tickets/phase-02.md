# Phase 2 — Make ingestion and pagination replay-safe

Add `append-batch --file PATH --idempotency-key KEY` and opaque-cursor pagination without regressing phase 1.

- Validate a batch's complete JSON event array before one atomic commit. An identical key-and-bytes retry succeeds explicitly without mutation; the same key with different bytes fails without mutation.
- `query --kind KIND --cursor TOKEN --limit N` returns `{ "items": [...], "nextCursor": TOKEN_OR_NULL }` in ascending sequence order. Omit `--cursor` for the first page.
- Continuation tokens must be opaque strings, bind the query kind and a fixed lineage/history boundary, resume without gaps or duplicates, and reject malformed, tampered, or cross-kind reuse. A valid token continues against that fixed boundary after later appends and after compaction, so it neither admits post-boundary events nor loses pre-boundary events.
- `--limit` accepts canonical strictly positive integers only. Earlier `--after-sequence` queries remain backward compatible.

The current ticket is the complete specification for this phase. Later phase tickets are intentionally unavailable.
