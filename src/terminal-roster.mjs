import { SEALED_TERMINAL_HARNESS_VERSIONS, terminalHarnessVersion } from './terminal-harness-versions.mjs';

export const TERMINAL_RUNTIME_ROSTER_SCHEMA = 'agentbattler.terminal-runtime-roster.v1';
export const DEFAULT_TERMINAL_MODELS = Object.freeze([
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
]);
export const DEFAULT_TERMINAL_GENERATIONS = 5;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function uniqueNonEmpty(values, label) {
  invariant(Array.isArray(values) && values.length > 0, `${label} are required`);
  invariant(values.every((value) => typeof value === 'string' && value.length > 0), `${label} must be non-empty strings`);
  invariant(new Set(values).size === values.length, `${label} must be unique`);
  return values;
}

function modelFamilyId(model) {
  const family = model.split('-').at(-1);
  invariant(family && family !== model, `Terminal model needs a family suffix: ${model}`);
  return family;
}

export function createTerminalRuntimeRoster({
  harnesses = Object.keys(SEALED_TERMINAL_HARNESS_VERSIONS),
  models = DEFAULT_TERMINAL_MODELS,
  generationsPerHarnessModel = DEFAULT_TERMINAL_GENERATIONS,
  reasoningEffort = 'high',
} = {}) {
  uniqueNonEmpty(harnesses, 'Terminal harnesses');
  uniqueNonEmpty(models, 'Terminal models');
  invariant(Number.isSafeInteger(generationsPerHarnessModel) && generationsPerHarnessModel > 0, 'generationsPerHarnessModel must be a positive integer');
  invariant(typeof reasoningEffort === 'string' && reasoningEffort.length > 0, 'reasoningEffort is required');
  for (const harness of harnesses) terminalHarnessVersion(harness);

  const agents = harnesses.flatMap((harness) => models.flatMap((model) => {
    const family = modelFamilyId(model);
    return Array.from({ length: generationsPerHarnessModel }, (_, offset) => {
      const generationIndex = offset + 1;
      return {
        id: `runtime-${harness}-${family}-${String(generationIndex).padStart(2, '0')}`,
        displayName: `${harness} ${model} terminal replicate ${generationIndex}`,
        modelFamilyId: family,
        generationIndex,
        role: 'terminal-runtime-replicate',
        provenance: {
          kind: 'terminal-runtime-replicate',
          isFixture: false,
          generatedByHarness: false,
          harness,
          harnessVersion: terminalHarnessVersion(harness),
          modelRequested: model,
          modelFamilyId: family,
          reasoningEffort,
          generationIndex,
          generationSettings: {
            identity: 'fresh-independent-terminal-run',
            sourceArtifact: false,
          },
        },
      };
    });
  }));

  invariant(new Set(agents.map((agent) => agent.id)).size === agents.length, 'Terminal runtime roster IDs must be unique');
  return {
    schemaVersion: TERMINAL_RUNTIME_ROSTER_SCHEMA,
    description: 'Fresh independent terminal runs; no generated chess source artifact is used as run identity.',
    comparison: {
      kind: 'terminal-runtime-roster',
      harnesses: [...harnesses],
      models: [...models],
      generationsPerHarnessModel,
      reasoningEffort,
    },
    agents,
  };
}
