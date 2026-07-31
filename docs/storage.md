# Benchmark storage and publication

AgentBattler separates source code from benchmark evidence.

## Storage roles

- **Hugging Face Dataset:** primary public data surface. It stores normalized JSONL tables, raw generation traces, generated agents, replay inputs, and website data at an immutable dataset commit.
- **GitHub Release:** immutable downloadable copy of the same staging tree. Each official snapshot has one tag-scoped archive, a compact manifest, and `SHA256SUMS`.
- **Git repository:** source code, schemas, tests, and compact `agentbattler.snapshot.v1` pointers only. New raw traces and tournament result bodies do not belong in Git history.
- **Cloudflare Pages:** generated read-only presentation. It is not a database or evidence store.

Neither hosted service is treated as a sole archival guarantee. The snapshot pointer binds both copies by SHA-256 and byte size.

Chess and Mini Ledger have separate latest pointers. [`snapshots/latest.json`](../snapshots/latest.json) names the current chess evidence; `snapshots/latest-terminal.json` is written only after a complete Mini Ledger campaign is uploaded and independently verified. A new terminal release cannot silently replace the chess pointer.

## Snapshot lifecycle

Package the current Codex-plus-Pi harness suite without changing remote state:

```sh
node scripts/package-snapshot.mjs
```

The command validates all three result bundles and their hashes, streams a credential-pattern scan over raw Codex and Pi traces, generates normalized `runs`, `events`, `matches`, and `moves` JSONL tables, builds the website data, and stages one shared publication tree under `.artifacts/publication/`.

Before publication, manually inspect every raw trace. Automated scanning is defense in depth and cannot prove that a trace is safe to disclose.

Authenticate the Hugging Face CLI with a fine-grained token that has write access to the target Dataset repository:

```sh
hf auth login
```

Then publish both copies:

```sh
node scripts/publish-snapshot.mjs
```

The publisher is fail-closed:

1. upload the unpacked Dataset;
2. pin and verify the returned 40-character Hugging Face commit;
3. enable GitHub immutable releases;
4. create a draft Release, attach every asset, then publish it;
5. verify GitHub's asset digest and independently download both copies;
6. write `snapshots/<id>.json` and `snapshots/latest.json` only after every check passes.

Re-running the publisher is safe after a partial upload. Existing Dataset content is committed again if necessary, and an existing Release is verified rather than silently replaced.

## Consumers

Fetch the pinned website dataset:

```sh
node scripts/fetch-snapshot.mjs
```

Fetch the immutable Release archive:

```sh
node scripts/fetch-snapshot.mjs \
  --artifact archive \
  --output .artifacts/cache/latest.tar.gz
```

All downloads are written to a temporary path, checked for exact byte size and SHA-256, then atomically moved into the local cache. Mutable Dataset branches such as `main` are never accepted as evidence references.

## Mini Ledger V5 publication

After the V5 campaign reaches 60 accepted logical runs, finalize the three source revisions and build one path-scrubbed, revision-preserving publication package:

```sh
npm run terminal:campaign:v5:finalize
npm run terminal:campaign:v5:package
```

The package contains the campaign index with host paths removed; exact R2/R3/R4 challenge, schedule, summary, and trace-manifest evidence; all accepted run JSON; credential-scanned semantic traces; compact infrastructure-invalid attempt records; normalized run rows; website data; and checksums. Every accepted run keeps its original source revision, challenge hash, schedule hash, and run key.

Manually review every semantic trace and the generated staging tree, then publish and verify both immutable copies:

```sh
npm run terminal:campaign:v5:publish
```

The publisher writes `snapshots/latest-terminal.json` only after the Hugging Face objects and immutable GitHub Release archive pass byte-size and SHA-256 verification. The website treats the campaign as provisional until that pointer exists.

## Trace safety

Generation traces may contain prompts, command output, filesystem paths, private source, personal data, or credentials. Never publish an entire Codex home or Harbor job blindly. Publish only the declared staging tree after:

- credential-pattern scanning;
- manual review of prompts, tool inputs, tool outputs, and file changes;
- confirmation that no provider authentication or browser/session data is present;
- checksum sealing after redaction.

The exploratory JSONL files contain Codex CLI and Pi event streams. They expose visible messages, tool activity, and file changes; they do not contain private model chain-of-thought. High-volume Pi streaming deltas remain in the raw trace but are intentionally omitted from the compact analytical `events` table.
