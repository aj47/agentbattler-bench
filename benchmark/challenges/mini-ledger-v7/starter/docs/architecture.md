# Runtime architecture

`ledger.json` is the canonical primary revision. A compacted ledger points to a checksummed snapshot plus a bounded live event tail; replay joins both into one logical sequence. Batch receipts are part of canonical state. Command handlers live under `src/commands`; validation and hashing are pure domain functions. Writes that replace an artifact use a same-directory temporary file, a file durability barrier, rename, and a directory durability barrier.

The starter intentionally reflects an interrupted migration. Treat operational artifacts according to `data-authority.md`, not by filename recency or a plausible log message.
