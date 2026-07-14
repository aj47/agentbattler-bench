# Replaying a result

## Locally generated result

From a clean checkout with Node.js 20 or newer:

```sh
npm install
npm test
npm run validate
npm run benchmark
npm run replay -- results/latest/result.json
```

Keep the whole `results/latest/` directory when copying results. `result.json` is the replay entry point, while sibling files may carry logs, checksums, or other evidence emitted by the runner.

## Workflow artifact

After a successful trusted workflow is publicly available:

1. Open that exact GitHub Actions run and download its `agentbattler-replay-<run id>-<attempt>` artifact.
2. Verify the download corresponds to the intended run ID, attempt, and commit recorded in `workflow.json`.
3. From the extracted `replay-bundle` directory, verify every listed file:

   ```sh
   sha256sum --check SHA256SUMS
   ```

4. Check out the recorded commit, then copy or point to the artifact's `results/latest/result.json` and run:

   ```sh
   npm run replay -- /absolute/path/to/replay-bundle/results/latest/result.json
   ```

5. Compare the replayed grades and summary with the recorded result. A mismatch is a replay failure; do not replace the recorded output or describe a newly run game as a replay.

On macOS, `shasum -a 256 -c SHA256SUMS` can be used when GNU `sha256sum` is unavailable.
