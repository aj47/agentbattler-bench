# Mini Ledger V7 gold implementation A

This is one independent reference implementation for evaluator calibration. It
is not installed in candidate packs and is not available inside model
sandboxes.

Apply the source overlay once, before phase 1:

```sh
node materialize.mjs apply /absolute/path/to/fresh-starter
```

Or materialize the starter and reference overlay together into an empty
destination:

```sh
node materialize.mjs fresh /absolute/path/to/empty-destination dev-01 decoy
```

At phase 4, after the trusted controller has installed and bound the current
phase contract, create only the declared incident response:

```sh
node materialize.mjs phase4 /absolute/path/to/workspace
```

The module also exports `applyGoldImplementationA`,
`materializeFreshGoldImplementationA`, `respondToGoldAPhase4`,
`prepareGoldImplementationAPhase`, `materializeGoldImplementationA`, and
`hashGoldAExecutableTree` for the calibration runner. The one-call fresh
materializer accepts `{ destination, pack }`; the lower-level overlay API
accepts `{ workspace }`. The implementation uses
only Node.js built-ins. Canonical primary commits use `ledger.json.tmp`, a file
sync, atomic rename, and a parent-directory sync. Compaction snapshots are
content-addressed and immutable, so no snapshot referenced by the prior primary
is overwritten before the new primary is durable.
