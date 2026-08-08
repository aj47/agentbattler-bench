import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, canonicalJsonSha256, sha256, sha256File } from './provenance.mjs';

export const TERMINAL_V7_VERIFIER_EVALUATION_ARTIFACT_SCHEMA = 'agentbattler.terminal-v7-verifier-evaluation-artifact.v1';
export const TERMINAL_V7_VERIFIER_EVIDENCE_SCHEMA = 'agentbattler.terminal-v7-verifier-evidence.v1';

const SHA256_RE = /^[0-9a-f]{64}$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function safeRelative(value, label) {
  invariant(typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) && !value.includes('\0'), `${label} path is invalid`);
  const normalized = path.posix.normalize(value.replaceAll(path.sep, '/'));
  invariant(normalized !== '..' && !normalized.startsWith('../'), `${label} path escapes its evidence root`);
  return normalized;
}

function contained(root, relative, label) {
  const normalized = safeRelative(relative, label);
  const resolved = path.resolve(root, ...normalized.split('/'));
  const relation = path.relative(path.resolve(root), resolved);
  invariant(relation && relation !== '..' && !relation.startsWith(`..${path.sep}`) && !path.isAbsolute(relation), `${label} escaped its evidence root`);
  return resolved;
}

async function treeFiles(root, relative = '') {
  const records = [];
  for (const entry of (await readdir(path.join(root, ...relative.split('/').filter(Boolean)), { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relative ? path.posix.join(relative, entry.name) : entry.name;
    const absolute = path.join(root, ...child.split('/'));
    const stat = await lstat(absolute);
    invariant(!stat.isSymbolicLink(), `V7 verifier evidence contains a symlink: ${child}`);
    if (stat.isDirectory()) records.push(...await treeFiles(root, child));
    else {
      invariant(stat.isFile() && stat.nlink === 1, `V7 verifier evidence is not one regular file: ${child}`);
      records.push({ path: child, size: stat.size, sha256: await sha256File(absolute) });
    }
  }
  return records;
}

function artifactRelative(phase) {
  return phase === null ? 'final/result.json' : `phase-${String(phase).padStart(2, '0')}/result.json`;
}

function validateSourceArtifact(source, sourceArtifact, sourceArtifactSha256) {
  const required = ['sealed-linux-container', 'harbor-separate-verifier', 'trusted-final-aggregator'].includes(source);
  if (!required && sourceArtifact === null && sourceArtifactSha256 === null) return null;
  invariant(sourceArtifact && typeof sourceArtifact === 'object' && !Array.isArray(sourceArtifact), 'V7 verifier source artifact is missing');
  invariant(safeRelative(sourceArtifact.path, 'V7 verifier source artifact') === 'source.json', 'V7 verifier source artifact path changed');
  invariant(Number.isSafeInteger(sourceArtifact.sizeBytes) && sourceArtifact.sizeBytes > 0, 'V7 verifier source artifact size is invalid');
  invariant(SHA256_RE.test(sourceArtifact.sha256 ?? '') && sourceArtifactSha256 === sourceArtifact.sha256, 'V7 verifier source-artifact hash is invalid');
  return sourceArtifact;
}

export function sealTerminalV7VerifierEvaluationArtifact({ phase, source, sourceArtifact = null, sourceArtifactSha256 = null, evaluation, boundary } = {}) {
  invariant(phase === null || (Number.isSafeInteger(phase) && phase >= 1 && phase <= 5), 'V7 verifier-evidence phase is invalid');
  invariant(['sealed-linux-container', 'harbor-separate-verifier', 'trusted-candidate-tree-rejection', 'trusted-final-aggregator'].includes(source), 'V7 verifier-evidence source is invalid');
  invariant(evaluation && Array.isArray(evaluation.infrastructureErrors), 'V7 verifier-evidence evaluation is invalid');
  validateSourceArtifact(source, sourceArtifact, sourceArtifactSha256);
  invariant(boundary && typeof boundary === 'object', 'V7 verifier-evidence boundary is missing');
  const unsigned = {
    schemaVersion: TERMINAL_V7_VERIFIER_EVALUATION_ARTIFACT_SCHEMA,
    phase,
    source,
    sourceArtifact,
    sourceArtifactSha256,
    boundary,
    evaluation,
    evaluationSha256: canonicalJsonSha256(evaluation),
  };
  return { ...unsigned, artifactSha256: canonicalJsonSha256(unsigned) };
}

export function validateTerminalV7VerifierEvaluationArtifact(artifact, { phase = undefined } = {}) {
  invariant(artifact?.schemaVersion === TERMINAL_V7_VERIFIER_EVALUATION_ARTIFACT_SCHEMA, 'Unsupported V7 verifier-evaluation artifact schema');
  const { artifactSha256, ...unsigned } = artifact;
  invariant(SHA256_RE.test(artifactSha256 ?? '') && artifactSha256 === canonicalJsonSha256(unsigned), 'V7 verifier-evaluation artifact hash mismatch');
  invariant(artifact.evaluationSha256 === canonicalJsonSha256(artifact.evaluation), 'V7 verifier-evaluation projection hash mismatch');
  validateSourceArtifact(artifact.source, artifact.sourceArtifact ?? null, artifact.sourceArtifactSha256 ?? null);
  if (phase !== undefined) invariant(artifact.phase === phase, 'V7 verifier-evaluation phase changed');
  invariant(artifact.boundary?.modelCommandCapabilities === 'exactly-zero'
    && artifact.boundary?.network === 'denied'
    && artifact.boundary?.candidateFilesystem === 'native-sandbox', 'V7 verifier-evaluation boundary proof is incomplete');
  return artifact;
}

export async function writeTerminalV7VerifierEvaluationArtifact({ runDirectory, phase, source, sourceArtifactBytes = null, sourceArtifactSha256 = null, evaluation, boundary } = {}) {
  invariant(typeof runDirectory === 'string' && path.isAbsolute(runDirectory), 'V7 verifier run directory must be absolute');
  const file = contained(path.join(runDirectory, 'verifier-evidence'), artifactRelative(phase), 'V7 verifier-evaluation artifact');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const bytes = sourceArtifactBytes === null ? null : Buffer.from(sourceArtifactBytes);
  const sourceArtifact = bytes === null ? null : { path: 'source.json', sizeBytes: bytes.length, sha256: sha256(bytes) };
  if (sourceArtifactSha256 !== null) invariant(sourceArtifact?.sha256 === sourceArtifactSha256, 'V7 verifier source bytes differ from their declared hash');
  const artifact = sealTerminalV7VerifierEvaluationArtifact({
    phase,
    source,
    sourceArtifact,
    sourceArtifactSha256: sourceArtifact?.sha256 ?? null,
    evaluation,
    boundary,
  });
  if (bytes !== null) await writeFile(path.join(path.dirname(file), sourceArtifact.path), bytes, { mode: 0o600, flag: 'wx' });
  await writeFile(file, `${canonicalJson(artifact, { space: 2 })}\n`, { mode: 0o600, flag: 'wx' });
  return artifact;
}

async function assertArchivedSourceArtifact(root, resultRelative, artifact) {
  if (artifact.sourceArtifact === null) return null;
  const resultFile = contained(root, resultRelative, 'V7 verifier result artifact');
  const sourceFile = path.join(path.dirname(resultFile), artifact.sourceArtifact.path);
  const stat = await lstat(sourceFile);
  invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === artifact.sourceArtifact.sizeBytes, 'V7 verifier source artifact is not one sealed regular file');
  const bytes = await readFile(sourceFile);
  invariant(sha256(bytes) === artifact.sourceArtifact.sha256, 'V7 verifier source artifact bytes changed');
  return bytes;
}

export async function captureTerminalV7VerifierEvidence({ runDirectory, run } = {}) {
  invariant(typeof runDirectory === 'string' && path.isAbsolute(runDirectory), 'V7 verifier evidence root must be absolute');
  invariant(Array.isArray(run?.phaseResults) && run.phaseResults.length === 5 && run.evaluation, 'V7 completed run has no verifier evaluations');
  const root = path.join(runDirectory, 'verifier-evidence');
  const evaluations = [];
  for (let phase = 1; phase <= 5; phase += 1) {
    const relative = artifactRelative(phase);
    const artifact = validateTerminalV7VerifierEvaluationArtifact(JSON.parse(await readFile(contained(root, relative, 'V7 phase verifier artifact'), 'utf8')), { phase });
    await assertArchivedSourceArtifact(root, relative, artifact);
    invariant(canonicalJson(artifact.evaluation) === canonicalJson(run.phaseResults[phase - 1]), `V7 phase ${phase} run evaluation differs from archived verifier output`);
    evaluations.push({ phase, path: relative, artifactSha256: artifact.artifactSha256, evaluationSha256: artifact.evaluationSha256 });
  }
  const finalRelative = artifactRelative(null);
  const final = validateTerminalV7VerifierEvaluationArtifact(JSON.parse(await readFile(contained(root, finalRelative, 'V7 final verifier artifact'), 'utf8')), { phase: null });
  const finalSource = await assertArchivedSourceArtifact(root, finalRelative, final);
  if (final.source === 'trusted-final-aggregator') {
    invariant(canonicalJson(JSON.parse(finalSource.toString('utf8'))) === canonicalJson(run.phaseResults), 'V7 final verifier source artifact differs from archived phase outputs');
  }
  invariant(canonicalJson(final.evaluation) === canonicalJson(run.evaluation), 'V7 final run evaluation differs from archived verifier output');
  const files = await treeFiles(root);
  invariant(files.length >= 6, 'V7 verifier evidence tree is incomplete');
  const unsigned = {
    schemaVersion: TERMINAL_V7_VERIFIER_EVIDENCE_SCHEMA,
    rootPath: 'verifier-evidence',
    phases: evaluations,
    final: { phase: null, path: finalRelative, artifactSha256: final.artifactSha256, evaluationSha256: final.evaluationSha256 },
    fileCount: files.length,
    files,
    treeSha256: canonicalJsonSha256(files),
  };
  return { ...unsigned, evidenceSha256: canonicalJsonSha256(unsigned) };
}

export async function assertTerminalV7VerifierEvidence({ runDirectory, run } = {}) {
  const expected = await captureTerminalV7VerifierEvidence({ runDirectory, run });
  invariant(run.verifierEvidence?.schemaVersion === TERMINAL_V7_VERIFIER_EVIDENCE_SCHEMA, 'V7 run omitted verifier-evidence commitment');
  invariant(canonicalJson(run.verifierEvidence) === canonicalJson(expected), 'V7 archived verifier evidence differs from the immutable run commitment');
  return expected;
}
