# Phase 1 — Repair migration without breaking clients

The checked-in `ledger.json` is `agentbattler.ledger.v1`. The existing loader mistakes its missing sequence fields for corruption. Repair transparent migration to `agentbattler.ledger.v2`.

- Preserve every legacy event in array order, assigning contiguous sequences from 1 and `nextSequence = events.length + 1`.
- Preserve exact `id`, `kind`, and JSON `payload` values. Reject duplicate ids, unknown schemas, and malformed values before replacing canonical state.
- Keep these client contracts working: `append --id ID --kind KIND --payload JSON`, `get --id ID`, `query --kind KIND --after-sequence N --limit N`, positional `export PATH`, and positional `import PATH`.
- A successful command emits exactly one JSON value. Invalid input exits non-zero without logical or primary-state mutation.

The current ticket is the complete specification for this phase. Later phase tickets are intentionally unavailable.
