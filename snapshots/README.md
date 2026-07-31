# Published snapshots

This directory contains only compact, sealed pointers to benchmark evidence stored outside the source repository.

Each `agentbattler.snapshot.v1` manifest pins:

- one immutable Hugging Face Dataset commit containing normalized tables, raw traces, generated artifacts, replay data, and website data;
- one tag-scoped GitHub Release archive made from the same staging tree;
- SHA-256 and byte size for every entry point used by the website or local tooling.

`latest.json` is a byte-for-byte copy of the newest accepted chess snapshot manifest. `latest-terminal.json` independently names the newest accepted Mini Ledger campaign. Publication tooling writes no latest pointer until both external copies have been uploaded and independently verified.
