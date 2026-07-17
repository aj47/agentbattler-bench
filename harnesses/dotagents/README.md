# DotAgents generation harness

This image builds DotAgents from pinned commit `8d4df16140e33083eba5dfae4878f22696afdfe9` (package version `1.1.6`). Build it and run a single Terra generation first:

```sh
npm run dotagents:image
npm run generate:dotagents-suite:smoke
```

The smoke command validates the generated source and records all six legality probes internally. The tournament validator requires a roster of at least two agents, so run it after producing the full suite.

Then generate the full five-generation roster for Terra, Sol, and Luna:

```sh
npm run generate:dotagents-suite
npm run validate:dotagents-suite
npm run build:harness-suite
npm run league:place:dotagents
npm run league:run:dotagents
```

Use `npm run generate:dotagents-suite:resume` after an interrupted full generation. Resume accepts an artifact only when its model, DotAgents commit, source hash, and legality evidence still match.

Each generation runs in a read-only Docker container with dropped capabilities and separate ephemeral home, configuration, and chess workspace mounts. The host OAuth file is copied into the temporary home and removed with it. DotAgents skills and external MCP servers are disabled; only its command and completion runtime tools remain. The remote control port is published on host loopback, and recorded command calls are rejected if they use a network-capable command.

The provider itself requires outbound access to ChatGPT. The command audit prevents ordinary generated shell commands from using the network, but it is not a kernel-level egress firewall.
