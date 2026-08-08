# Phase 4 — Resolve the data-loss report from evidence

Investigate `.agentbattler/current/incident-evidence.json` and write the response path named by `.agentbattler/current/task-contract.json`. The supplied incident record asks whether committed events were lost; classify it from the evidence because only validated lineage and hashes are authoritative.

- Produce one JSON response with `schema: "agentbattler.ledger.incident-response.v1"`, `conclusion`, `canonicalEventCount`, `canonicalHeadSha256`, `executableSourceSha256`, and `evidenceIds`. `evidenceIds` must contain every supplied evidence record id exactly once in ascending string order.
- Conclude `no-canonical-data-loss` only if the supplied canonical primary and receipt lineage prove all acknowledged ids remain present and the contrary snapshot/log evidence is non-authoritative.
- The phase-entry executable source tree is already correct. Do not modify `package.json` or any regular file under `bin/`, `src/`, or `config/`; their combined hash must remain exactly the committed value in `.agentbattler/current/task-contract.json`.

The current ticket is the complete specification for this phase. Later phase tickets are intentionally unavailable.
