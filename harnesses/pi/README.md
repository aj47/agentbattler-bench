# Pi harness image

This image pins Pi Coding Agent 0.80.7 and its transitive dependencies with `package-lock.json` on a digest-pinned Node.js base. It is only the executable layer; credentials are never built into the image.

The suite runner starts the image read-only with all Linux capabilities dropped, no new privileges, a bounded process/memory/CPU budget, and exactly two writable mounts:

- an empty per-generation `/workspace`;
- an ephemeral `/pi-home` containing only a temporary `openai-codex` credential derived from the current Codex ChatGPT login and that run's native session.

Pi extensions, skills, prompt templates, themes, context files, project trust, update checks, and install telemetry are disabled by CLI flags and environment. Provider network access remains enabled because generation uses the ChatGPT subscription-backed `openai-codex` endpoint.
