#!/usr/bin/env node
import { buildTerminalV7VerifierImage } from '../src/terminal-v7-verifier-container.mjs';

try {
  const image = await buildTerminalV7VerifierImage();
  process.stdout.write(`${JSON.stringify({ ok: true, image: image.image, imageId: image.imageId, sourceSha256: image.sourceSha256 })}\n`);
} catch (error) {
  process.stderr.write(`Mini Ledger V7 verifier image build failed: ${String(error?.message ?? error)}\n`);
  process.exitCode = 1;
}
