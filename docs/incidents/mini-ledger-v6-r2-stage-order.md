# Mini Ledger V6 R2 stage-order and command-grammar mismatch

**Affected challenge:** `challenge-42c9cc584e506a64`

**Affected schedule:** `schedule-ffda1350bf70eb57`

**Replacement protocol:** Mini Ledger V6 R3

V6 R2 corrected the Node permission-model durability contract, but live trajectory inspection exposed two remaining evaluator defects:

1. The turn-two prompt assigned `append-batch`, while the inherited V3 batch verifier also invoked `query`. `query` is not assigned until turn three, so a correct incremental turn-two implementation could fail for missing future functionality.
2. The V6 prompt rewrite listed command output shapes but dropped the original exact argument grammar. The migration turn said to implement import without stating that the required form is positional `import PATH`, while the verifier invoked that exact form.

The R2 runner was stopped during its fifth job. Its partial results and complete diagnostic evidence are preserved on the M4 execution host at `results/terminal-mini-ledger-v6-luna-max-invalid-challenge-42c9cc584e506a64`. They are withdrawn and must not be mixed into R3 scoring.

## V6 R3 correction

R3 is a newly sealed challenge and schedule:

- Challenge: `challenge-498f705cf73421aa`
- Schedule: `schedule-a13339408ce247f9`
- Every turn includes the exact signatures for all eleven commands, explicitly identifying `export PATH` and `import PATH` as positional.
- The migration turn repeats the positional import syntax and gives the concrete `import legacy.json` example.
- A V6-only batch verifier checks the V2 primary state, event sequences, `get`, identical-retry behavior, and failed-batch atomicity without invoking `query`.
- V3, V4, and V5 verifier sources remain byte-for-byte unchanged for historical reproducibility.
- Luna-only, `max` reasoning, five harnesses × five runs, source-only verification, Node permission policy, and the one-hour per-turn limit remain unchanged.
