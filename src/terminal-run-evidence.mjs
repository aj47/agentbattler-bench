import { chmod, copyFile, lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, sha256File } from './provenance.mjs';

const CANDIDATE_SNAPSHOT_SCHEMA = 'agentbattler.terminal-candidate-snapshot.v1';
const FINAL_PUBLIC_SCHEMA = 'agentbattler.terminal-final-public.v1';
const TRACE_ISOLATION_SCHEMA = 'agentbattler.terminal-trace-isolation.v1';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function fileKind(stat) {
  if (stat.isSymbolicLink()) return 'symbolic-link';
  if (stat.isFile()) return 'regular-file';
  if (stat.isDirectory()) return 'directory';
  return 'other';
}

export async function captureTerminalCandidateSnapshot({
  sourcePath,
  runDirectory,
  turn,
  expected = null,
}) {
  invariant(path.isAbsolute(sourcePath), 'Candidate snapshot source path must be absolute');
  invariant(path.isAbsolute(runDirectory), 'Candidate snapshot run directory must be absolute');
  invariant(Number.isSafeInteger(turn) && turn > 0, 'Candidate snapshot turn must be a positive integer');
  const relativeDirectory = path.join('candidate-snapshots', `turn-${String(turn).padStart(2, '0')}`);
  const directory = path.join(runDirectory, relativeDirectory);
  const destination = path.join(directory, 'ledger.mjs');
  await mkdir(directory, { recursive: true, mode: 0o700 });

  let metadata;
  try {
    const sourceStat = await lstat(sourcePath);
    const kind = fileKind(sourceStat);
    if (kind !== 'regular-file') {
      metadata = {
        schemaVersion: CANDIDATE_SNAPSHOT_SCHEMA,
        turn,
        entryPoint: 'ledger.mjs',
        present: true,
        kind,
        archived: false,
      };
    } else {
      await copyFile(sourcePath, destination);
      const mode = sourceStat.mode & 0o777;
      await chmod(destination, mode);
      metadata = {
        schemaVersion: CANDIDATE_SNAPSHOT_SCHEMA,
        turn,
        entryPoint: 'ledger.mjs',
        present: true,
        kind,
        archived: true,
        path: path.join(relativeDirectory, 'ledger.mjs').split(path.sep).join('/'),
        bytes: sourceStat.size,
        sha256: await sha256File(destination),
        mode: mode.toString(8).padStart(4, '0'),
        executable: (mode & 0o111) !== 0,
      };
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    metadata = expected?.archived === false
      ? { ...expected, schemaVersion: CANDIDATE_SNAPSHOT_SCHEMA, turn, entryPoint: 'ledger.mjs', archived: false }
      : {
          schemaVersion: CANDIDATE_SNAPSHOT_SCHEMA,
          turn,
          entryPoint: 'ledger.mjs',
          present: false,
          kind: 'missing',
          archived: false,
        };
  }

  if (expected) {
    for (const field of ['present', 'kind', 'bytes', 'sha256', 'mode', 'executable']) {
      if (expected[field] !== undefined) invariant(metadata[field] === expected[field], `Candidate snapshot ${field} does not match verifier evidence on turn ${turn}`);
    }
  }
  await writeFile(path.join(directory, 'metadata.json'), `${canonicalJson(metadata, { space: 2 })}\n`, { mode: 0o600 });
  return metadata;
}

function failedFinalStages(challenge, diagnostic) {
  return challenge.stages.map((stage) => ({
    id: stage.id,
    passed: false,
    regressions: 1,
    exitCode: 1,
    durationMs: 0,
    diagnostic,
  }));
}

export async function verifyTerminalPublicStage({ workspace, stageId, publicVerifier }) {
  invariant(path.isAbsolute(workspace), 'Public stage workspace must be absolute');
  invariant(typeof stageId === 'string' && stageId.length > 0, 'Public stage ID is required');
  invariant(typeof publicVerifier?.verifyPublicStage === 'function', 'Public stage verifier is unavailable');
  const ledgerPath = path.join(workspace, 'ledger.mjs');
  let sourceStat = null;
  try { sourceStat = await lstat(ledgerPath); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!sourceStat || !sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    return {
      id: stageId,
      passed: false,
      regressions: 1,
      exitCode: 1,
      durationMs: 0,
      diagnostic: !sourceStat ? 'candidate ledger.mjs is missing' : 'candidate ledger.mjs is not a regular file',
    };
  }
  const stage = await publicVerifier.verifyPublicStage({ workspace, ledgerPath, stageId });
  return { ...stage, id: stage.id ?? stage.stageId ?? stageId };
}

export async function verifyTerminalFinalPublic({ workspace, challenge, publicVerifier }) {
  invariant(path.isAbsolute(workspace), 'Final public workspace must be absolute');
  invariant(Array.isArray(challenge?.stages) && challenge.stages.length > 0, 'Final public challenge stages are required');
  invariant(typeof publicVerifier?.verifyPublicStage === 'function', 'Final public verifier is unavailable');
  const ledgerPath = path.join(workspace, 'ledger.mjs');
  let sourceStat = null;
  try { sourceStat = await lstat(ledgerPath); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let stages;
  if (!sourceStat || !sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    stages = failedFinalStages(challenge, !sourceStat ? 'final candidate ledger.mjs is missing' : 'final candidate ledger.mjs is not a regular file');
  } else {
    stages = [];
    for (const definition of challenge.stages) stages.push(await verifyTerminalPublicStage({ workspace, stageId: definition.id, publicVerifier }));
  }
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const visiblePoints = challenge.stages.reduce((total, definition) => (
    total + (stageById.get(definition.id)?.passed === true ? definition.points : 0)
  ), 0);
  return {
    schemaVersion: FINAL_PUBLIC_SCHEMA,
    evaluator: 'all-public-stages-from-final-source-only-candidate',
    stages,
    passed: stages.filter((stage) => stage.passed === true).length,
    total: challenge.stages.length,
    visiblePoints,
    maxVisiblePoints: challenge.scoring.visibleStagePoints,
  };
}

function isToolLike(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const type = String(value.type ?? value.kind ?? '').toLowerCase();
  return /tool|command_execution|file_change/.test(type)
    || typeof value.toolName === 'string'
    || typeof value.tool_name === 'string'
    || typeof value.function_name === 'string'
    || value.toolUse != null
    || value.toolCall != null
    || value.function?.arguments != null
    || (typeof value.name === 'string' && (value.arguments != null || value.input != null));
}

function stringsIn(value, output) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) for (const child of value) stringsIn(child, output);
  else if (value && typeof value === 'object') for (const child of Object.values(value)) stringsIn(child, output);
}

function toolPayloads(value) {
  const payloads = [];
  const seen = new Set();
  const visit = (child) => {
    if (!child || typeof child !== 'object' || seen.has(child)) return;
    seen.add(child);
    if (isToolLike(child)) {
      const values = [];
      for (const candidate of [
        child.input,
        child.arguments,
        child.args,
        child.command,
        child.path,
        child.file_path,
        child.toolUse,
        child.toolCall,
        child.function?.arguments,
      ]) stringsIn(candidate, values);
      if (values.length > 0) payloads.push({
        tool: child.name ?? child.toolName ?? child.tool_name ?? child.function_name ?? child.function?.name ?? child.type ?? child.toolUse?.name ?? child.toolCall?.name ?? 'unknown',
        text: values.join('\n'),
      });
    }
    for (const nested of Array.isArray(child) ? child : Object.values(child)) visit(nested);
  };
  visit(value);
  return payloads;
}

export class TerminalTraceIsolationError extends Error {
  constructor(message, evidence) {
    super(message);
    this.name = 'TerminalTraceIsolationError';
    this.code = 'TRACE_ISOLATION_VIOLATION';
    this.evidence = evidence;
  }
}

function regexEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizedToolText(value, workspace) {
  let normalized = value.replaceAll('\\', '/').toLowerCase();
  if (!workspace) return normalized;
  const allowed = path.resolve(workspace).replaceAll('\\', '/').toLowerCase().replace(/\/+$/, '');
  normalized = normalized.replace(new RegExp(`${regexEscape(allowed)}(?=/|$)`, 'g'), '<workspace>');
  return normalized;
}

export function assertTerminalTraceIsolation({ trace, repositoryRoot = null, workspace = null, turn = null }) {
  const resolvedRepositoryRoot = repositoryRoot ? path.resolve(repositoryRoot) : null;
  const markers = [
    'benchmark/challenges',
    'public-verifier.mjs',
    'holdout-verifier.mjs',
    'candidate-process.mjs',
    'run-stage.mjs',
    '.codex/auth.json',
    '.claude/.credentials.json',
    '.factory/settings.json',
    '.agents/',
    'tokens-chatgpt.json',
    ...(resolvedRepositoryRoot ? [resolvedRepositoryRoot] : []),
  ];
  const payloads = toolPayloads(trace);
  const violations = [];
  for (const payload of payloads) {
    const normalized = normalizedToolText(payload.text, workspace);
    for (const marker of markers) {
      if (!normalized.includes(marker.replaceAll('\\', '/').toLowerCase())) continue;
      violations.push({ tool: String(payload.tool), marker: marker === resolvedRepositoryRoot ? '<benchmark-repository-root>' : marker });
    }
    if (/(^|[;&|()\s])(curl|wget|nc|ncat|netcat|telnet|ftp|sftp|ssh|scp|rsync)(?=\s|$)|https?:\/\/|\/dev\/(?:tcp|udp)\/|\b(?:fetch|xmlhttprequest|websocket)\s*\(|\b(?:import|require)\s*\(?\s*['"](?:node:)?(?:http|https|net|tls|dns|dgram)['"]/i.test(payload.text)) {
      violations.push({ tool: String(payload.tool), marker: '<network-capable-tool-input>' });
    }
    if (/(^|[;&|()\s])printenv(?=\s|$)|(^|[;&()\s])env\s*(?:$|[|;&])|\/proc\/(?:self|\d+)\/environ|\bprocess\.env\b|\bdeno\.env\b|\bos\.environ\b|\bgetenv\s*\(|(?:^|[\s"'=])(?:~(?=\/|\s|$)|\$HOME(?:\/|\b)|\$\{HOME\}|\$(?:\{)?[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)[A-Z0-9_]*(?:\})?)/i.test(payload.text)) {
      violations.push({ tool: String(payload.tool), marker: '<environment-enumeration>' });
    }
  }
  const evidence = {
    schemaVersion: TRACE_ISOLATION_SCHEMA,
    turn,
    checkedToolPayloads: payloads.length,
    forbiddenMarkers: markers.length,
    passed: violations.length === 0,
    violations,
  };
  if (violations.length > 0) {
    throw new TerminalTraceIsolationError(`Turn ${turn ?? 'unknown'} violated the sealed trace-isolation policy`, evidence);
  }
  return evidence;
}

export function terminalTurnCompletion({
  nativeReason = null,
  timedOut = false,
  iterationLimitReached = false,
  providerError = false,
} = {}) {
  const normalized = typeof nativeReason === 'string' && nativeReason.trim()
    ? nativeReason.trim().toLowerCase().replace(/[\s-]+/g, '_')
    : null;
  let stopReason = 'completed';
  if (timedOut) stopReason = 'time_limit';
  else if (providerError || normalized === 'error' || normalized === 'failed') stopReason = 'provider_error';
  else if (iterationLimitReached || /max(?:imum)?_iterations?|iteration_limit/.test(normalized ?? '')) stopReason = 'iteration_limit';
  else if (normalized && !['completed', 'complete', 'success', 'stop', 'end_turn'].includes(normalized)) stopReason = normalized;
  return {
    stopReason,
    nativeReason: normalized,
    completedNormally: stopReason === 'completed',
  };
}
