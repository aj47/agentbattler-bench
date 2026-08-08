# Mini Ledger V7 gold implementation B

This reference was derived independently from the five public phase tickets. It uses a cross-process lease file for serialization, durable same-directory replacement, content-addressed snapshots, lineage-aware recovery, and authenticated pagination boundaries.

`materialize.mjs` can create a fresh reference workspace from a V7 pack:

```sh
node benchmark/challenges/mini-ledger-v7/gold/implementation-b/materialize.mjs /tmp/ledger-gold-b dev-01 decoy
```

Phase 4 deliberately has no executable-source change. After the trusted phase-4 control payload is installed and bound, call `prepareGoldImplementationBPhase({ destination, phase: 4 })` to produce only the declared incident response.
