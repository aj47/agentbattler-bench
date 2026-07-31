# Mini Ledger V5-R4 DotAgents/Luna generation 5 recovery

On July 31, 2026, the composite V5 campaign reached 59 of 60 accepted logical identities.
The sole unresolved identity was DotAgents 1.1.9 with GPT-5.6 Luna, generation 5. Its three
scored-attempt slots all ended as infrastructure-invalid and therefore produced no score:

1. attempt one lost the upstream response stream at turn 6;
2. attempt two lost the upstream response stream at turn 11; and
3. attempt three reached turn 15, but the response did not complete before the sealed
   30-minute per-turn timeout.

The task, verifier, model, reasoning level, adapter, cache policy, and 30-minute turn limit
remain unchanged. Accepted evidence remains immutable. After reviewing the three traces, the
operator explicitly authorized one additional recovery attempt solely to obtain a valid scored
run. The campaign index records the published three-attempt ceiling, the authorized four-attempt
ceiling, and the recovery reason. The fourth attempt remains eligible only if it completes under
the original sealed protocol; another infrastructure failure remains unscored and blocks strict
campaign completion.
