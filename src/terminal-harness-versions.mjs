export const SEALED_TERMINAL_HARNESS_VERSIONS = Object.freeze({
  'claude-code': '2.1.220',
  'codex-cli': '0.144.0',
  'dotagents-mono': '1.1.9',
  'factory-droid': '0.186.0',
  'pi-coding-agent': '0.80.7',
});

export function terminalHarnessVersion(harness) {
  const version = SEALED_TERMINAL_HARNESS_VERSIONS[harness];
  if (!version) throw new Error(`No sealed terminal runtime version for harness: ${harness ?? 'missing'}`);
  return version;
}

export function bindTerminalHarnessRuntime(agent) {
  const provenance = agent?.provenance;
  if (!provenance || typeof provenance !== 'object') throw new Error('Terminal agent provenance is required');
  const runtimeVersion = terminalHarnessVersion(provenance.harness);
  return {
    ...agent,
    provenance: {
      ...provenance,
      sourceArtifactHarnessVersion: provenance.harnessVersion,
      harnessVersion: runtimeVersion,
    },
  };
}
