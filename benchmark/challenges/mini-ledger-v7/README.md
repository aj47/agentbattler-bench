# Mini Ledger V7 pack prototype

V7 is a paired, generated terminal task. A clean and a decoy twin share identical source code, canonical journal, projection defect, requirements, phase tickets, seeds, gold behavior, and hidden verifier cases. They differ only in length- and structure-matched auxiliary artifacts: a superseded ADR, deprecated schema/example, dead legacy module, excluded legacy test, and historical operational evidence. Every decoy is falsifiable locally through status and replacement metadata, the active import graph, test selection, the artifact manifest, deployment identifiers, timestamps, hashes, and the journal's self-validating chain.

The candidate receives one short ticket at a time as `TASK.md`; future tickets are not copied into its workspace. Its machine contract, cumulative public `smoke.mjs`, and any trusted evidence are disclosed current-only under `.agentbattler/current/`. Each smoke file contains only disclosed public behavior for phases already available and runs against an excluded scratch copy. Release and reserve verification seeds require an evaluator-held key. The pack descriptor commits the visible starter tree, ordered normalized control trees (ticket, machine contract, smoke, and phase-4 evidence), requirement map, clean/decoy relationship, and a Merkle root of keyed hidden case seeds. The control-tree normalization replaces only descriptor/self commitments and the phase-entry source digest with declared sentinels; their actual values are validated independently.

Public module entry points:

- `pack.mjs`: `loadV7Pack`, `listV7Packs`, `sealV7Pack`, `materializeV7Starter`, `installV7Phase`, `bindV7PhaseEntryContract`, and deterministic incident-evidence helpers.
- `verifier.mjs`: `verifyPhase`, regression-gated `verifyPhaseTrajectory`, `verifyFinal`, `createV7CandidateFailureResult`, and `analyzeV7DurabilityTrace`. Verifier calls accept the Harbor/direct superset (`instance`, `pack`, `phase`, `candidateTree`, `workspace`, `contract`, `phaseResults`, `durabilityTraceDirectory`, `seedKey`, and `verifierSeedIndex`).
- `requirements.mjs`: immutable weighted requirement and phase metadata.

The generated starter uses only Node.js built-ins and contains 36 files: 15 active source files, existing selected tests, ADR history, legacy fixtures, a dead v0 implementation outside the import graph, an excluded legacy test, deprecated schema material, and provenance-marked operational artifacts. `installV7Phase` writes the current ticket, contract, and cumulative public smoke artifact, plus sealed incident evidence for phase 4, into a separate trusted control directory; it never reads candidate runtime state.

Private scoring remains 80 points. Within each capability family, six private points are classified as atomic contract variants and ten as composed cross-feature, interleaving, scale, or fault scenarios. `requirements.mjs` and `requirement-map.json` carry the explicit allocation without exposing hidden fixtures or seeds.

Verification results contain `infrastructureErrors`, weighted `requirements`, scorer-ready `families`, `adaptability`, a 0–99 `verifierSeedIndex`, and commitments to the selected hidden-seed variants. Candidate defects are failed requirements; missing syscall-trace or trusted-control inputs are explicit infrastructure errors and never receive durability/provenance credit.
