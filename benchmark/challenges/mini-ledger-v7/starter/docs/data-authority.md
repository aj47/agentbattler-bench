# Data authority

`var/artifact-manifest.json` is the provenance inventory. Its entry marked `canonical` points to the primary state. Canonical exports, snapshots, and temporary revisions are usable only when their checksums, lineage, and boundaries validate against that primary lineage.

Archive snapshots and worker logs are advisory, even when they are newer or appear operationally convincing. Deployment identifiers, capture timestamps, declared status, acknowledged-id lists, and recorded hashes make their provenance falsifiable without network or host access.
