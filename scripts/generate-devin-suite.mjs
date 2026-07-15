#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { isLegalUciMove, parseFen } from '../src/chess.mjs';
import {
  buildDevinCliArgs,
  buildIsolatedDevinConfig,
  DEVIN_HARNESS_NAME,
  DEVIN_PERMISSION_MODE,
  modelSlug,
  parseDevinExport,
  parseDevinVersion,
  publicDevinCommand,
  requireDevinAuthentication,
} from '../src/devin-harness.mjs';
import { canonicalJson, sha256, sha256File } from '../src/provenance.mjs';
import { runAgentMove, validateAgent } from '../src/runner.mjs';
import { sanitizePublicTrace } from '../src/trace-sanitizer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_PATH = path.join(ROOT, 'benchmark/challenges/chess-agent-v1.md');
const POSITIONS_PATH = path.join(ROOT, 'benchmark/positions/v2.json');
const AGENTS_DIR = process.env.AGENTBATTLER_AGENTS_DIR
  ? path.resolve(process.env.AGENTBATTLER_AGENTS_DIR)
  : path.join(ROOT, 'agents/devin-suite');
const RESULT_ROOT = process.env.AGENTBATTLER_RESULT_ROOT
  ? path.resolve(process.env.AGENTBATTLER_RESULT_ROOT)
  : path.join(ROOT, 'results/devin-suite');
const GENERATIONS_DIR = path.join(RESULT_ROOT, 'generations');
const HOST_CREDENTIALS = path.join(os.homedir(), '.local/share/devin/credentials.toml');
const HOST_CONFIG = path.join(os.homedir(), '.config/devin/config.json');
const RESUME = process.env.AGENTBATTLER_RESUME === '1';
const GENERATIONS_PER_MODEL = Number.parseInt(process.env.AGENTBATTLER_GENERATIONS_PER_MODEL ?? '5', 10);
if (!Number.isSafeInteger(GENERATIONS_PER_MODEL) || GENERATIONS_PER_MODEL < 1) {
  throw new Error('AGENTBATTLER_GENERATIONS_PER_MODEL must be a positive integer');
}

const DEFAULT_MODEL = process.env.AGENTBATTLER_DEVIN_MODEL?.trim() || 'swe-1-6-fast';
const MODEL_LIST = (process.env.AGENTBATTLER_DEVIN_MODELS ?? DEFAULT_MODEL)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
if (MODEL_LIST.length === 0) throw new Error('AGENTBATTLER_DEVIN_MODELS selected no models');

const MODEL_FAMILIES = MODEL_LIST.map((model) => {
  const id = modelSlug(model);
  return { id, model, displayName: `Devin / ${model}` };
});

const MODELS = Array.from({ length: GENERATIONS_PER_MODEL }, (_, index) => MODEL_FAMILIES.map((family) => ({
  ...family,
  id: `devin-${family.id}-${String(index + 1).padStart(2, '0')}`,
  displayName: `${family.displayName} #${index + 1}`,
  modelFamilyId: family.id,
  generationIndex: index + 1,
}))).flat();

const CHILD_ENV_ALLOWLIST = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'SHELL', 'NO_COLOR', 'HOME'];

function baseChildEnv(overrides = {}) {
  const inherited = Object.fromEntries(CHILD_ENV_ALLOWLIST.flatMap((key) => (
    typeof process.env[key] === 'string' ? [[key, process.env[key]]] : []
  )));
  return { ...inherited, ...overrides };
}

function runProcess(command, args, { cwd = ROOT, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({
      exitCode,
      stdoutText: Buffer.concat(stdout).toString('utf8'),
      stderrText: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

async function optionalSha256(file) {
  try {
    return await sha256File(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function snapshotHostState() {
  return {
    credentials: await optionalSha256(HOST_CREDENTIALS),
    config: await optionalSha256(HOST_CONFIG),
  };
}

function compareHostState(before, after) {
  return {
    credentialsUnchanged: before.credentials === after.credentials,
    configUnchanged: before.config === after.config,
  };
}

async function resolveDevinBinary() {
  const which = await runProcess(process.platform === 'win32' ? 'where' : 'which', ['devin']);
  if (which.exitCode !== 0) throw new Error('`devin` is not on PATH; install Devin CLI first');
  return which.stdoutText.trim().split(/\r?\n/)[0];
}

async function resolveDevinVersion() {
  const version = await runProcess('devin', ['--version']);
  if (version.exitCode !== 0) {
    throw new Error(`devin --version failed: ${version.stderrText || version.stdoutText}`);
  }
  return parseDevinVersion(`${version.stdoutText}\n${version.stderrText}`);
}

async function requireAuth() {
  const status = await runProcess('devin', ['auth', 'status']);
  return requireDevinAuthentication(status);
}

async function probeAgent(agentPath, positions) {
  const probes = [];
  for (const position of positions) {
    const attempt = await runAgentMove({ agentPath, fen: position.fen });
    probes.push({
      positionId: position.id,
      status: attempt.status,
      move: attempt.move,
      legal: attempt.status === 'ok' && isLegalUciMove(parseFen(position.fen), attempt.move),
      runtimeMs: attempt.runtimeMs,
      detail: attempt.detail,
    });
  }
  return probes;
}

async function prepareIsolatedHomes(tempRoot, model) {
  const configHome = path.join(tempRoot, 'xdg-config');
  const dataHome = path.join(tempRoot, 'xdg-data');
  const cacheHome = path.join(tempRoot, 'xdg-cache');
  const devinConfigDir = path.join(configHome, 'devin');
  const devinDataDir = path.join(dataHome, 'devin');
  await Promise.all([
    mkdir(devinConfigDir, { recursive: true }),
    mkdir(devinDataDir, { recursive: true }),
    mkdir(cacheHome, { recursive: true }),
  ]);

  const configPath = path.join(devinConfigDir, 'config.json');
  await writeFile(configPath, `${canonicalJson(buildIsolatedDevinConfig({ model }), { space: 2 })}\n`);

  try {
    await access(HOST_CREDENTIALS);
  } catch {
    throw new Error(`Missing Devin credentials at ${HOST_CREDENTIALS}; run \`devin auth login\``);
  }
  const credentialTarget = path.join(devinDataDir, 'credentials.toml');
  await copyFile(HOST_CREDENTIALS, credentialTarget);
  await chmod(credentialTarget, 0o600);

  return {
    configHome,
    dataHome,
    cacheHome,
    configPath,
    credentialTarget,
    env: baseChildEnv({
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      XDG_CACHE_HOME: cacheHome,
      // Keep real HOME so OS user identity remains, but force config/data to ephemeral trees.
      DEVIN_PERMISSION_MODE,
    }),
  };
}

async function generateOne(entry, promptPath, promptSha256, positions, harnessVersion, authentication) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `agentbattler-${entry.id}-`));
  const workspace = path.join(tempRoot, 'workspace');
  const generationDir = path.join(GENERATIONS_DIR, entry.id);
  await Promise.all([workspace, generationDir].map((directory) => mkdir(directory, { recursive: true })));
  const isolation = await prepareIsolatedHomes(tempRoot, entry.model);
  // Prompt is mounted read-only via absolute --prompt-file outside the workspace.
  // Copy a local prompt mirror into generation evidence only (not into workspace).
  const emptyWorkspaceEntries = await readdir(workspace);
  const exportPath = path.join(generationDir, 'devin-export.json');
  const stdoutPath = path.join(generationDir, 'devin-stdout.txt');
  const stderrPath = path.join(generationDir, 'devin-stderr.txt');
  const args = buildDevinCliArgs({
    model: entry.model,
    promptFile: promptPath,
    configPath: isolation.configPath,
    exportPath,
    permissionMode: DEVIN_PERMISSION_MODE,
  });

  try {
    const started = Date.now();
    const run = await runProcess('devin', args, { cwd: workspace, env: isolation.env });
    const durationMs = Date.now() - started;
    const scrubContext = { homeDirectory: os.homedir(), username: os.userInfo().username };
    const sanitizedStdout = sanitizePublicTrace(run.stdoutText, scrubContext);
    const sanitizedStderr = sanitizePublicTrace(run.stderrText, scrubContext);
    await Promise.all([
      writeFile(stdoutPath, sanitizedStdout.content),
      writeFile(stderrPath, sanitizedStderr.content),
    ]);

    let exportRaw = '';
    try {
      exportRaw = await readFile(exportPath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const sanitizedExport = sanitizePublicTrace(exportRaw, scrubContext);
    await writeFile(exportPath, sanitizedExport.content);
    if (run.exitCode !== 0) {
      throw new Error(`${entry.id} exited ${run.exitCode}; see ${stderrPath}`);
    }

    const workspaceEntries = (await readdir(workspace, { withFileTypes: true }))
      .map((item) => ({
        name: item.name,
        type: item.isFile() ? 'file' : item.isDirectory() ? 'directory' : 'other',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    // Ignore Devin session bookkeeping directories if they appear; only agent.js may be a file.
    const fileEntries = workspaceEntries.filter((entry) => entry.type === 'file');
    if (fileEntries.length !== 1 || fileEntries[0].name !== 'agent.js') {
      throw new Error(
        `${entry.id} left unexpected workspace files: ${fileEntries.map(({ name }) => name).join(', ') || '(none)'}`
        + `; full entries: ${workspaceEntries.map(({ name, type }) => `${name} (${type})`).join(', ') || '(none)'}`,
      );
    }
    const sourcePath = path.join(workspace, 'agent.js');
    const identity = await validateAgent(sourcePath);
    const targetPath = path.join(AGENTS_DIR, `${entry.id}.js`);
    await copyFile(sourcePath, targetPath);
    const probes = await probeAgent(targetPath, positions);
    // Generation succeeds only when the artifact exists and is contract-valid.
    // Legality probe failures are recorded in metadata; they do not abort the
    // suite, because model quality is the experimental variable being measured.
    const telemetry = parseDevinExport(sanitizedExport.content);

    const configHomeEntries = (await readdir(path.join(isolation.configHome, 'devin'))).sort();
    const dataHomeEntries = (await readdir(path.join(isolation.dataHome, 'devin'))).sort();
    const metadata = {
      schemaVersion: 'agentbattler.devin-generation-metadata.v1',
      run: {
        modelRequested: entry.model,
        modelFamilyId: entry.modelFamilyId,
        generationIndex: entry.generationIndex,
        harness: DEVIN_HARNESS_NAME,
        harnessVersion,
        permissionMode: DEVIN_PERMISSION_MODE,
        sessionId: telemetry.sessionId,
        runCount: 1,
        durationMs,
        exitCode: run.exitCode,
        command: publicDevinCommand(args, {
          workspace,
          configHome: isolation.configHome,
          dataHome: isolation.dataHome,
          promptFile: promptPath,
        }),
        isolation: {
          mechanism: 'ephemeral-xdg-homes',
          emptyWorkspaceAtStart: emptyWorkspaceEntries.length === 0,
          finalWorkspaceEntries: workspaceEntries,
          onlyAgentFileCreated: fileEntries.length === 1 && fileEntries[0].name === 'agent.js',
          hostHomeMounted: false,
          hostConfigNotMounted: true,
          credentialCopiedIntoEphemeralDataHome: true,
          hostConfigContentsNotCopied: true,
          mcpServersConfigured: 0,
          hooksConfigured: 0,
          foreignToolConfigImportsDisabled: true,
          skillsDirectoryPresentInEphemeralConfig: false,
          permissionMode: DEVIN_PERMISSION_MODE,
          configHomeEntriesAfterRun: configHomeEntries,
          dataHomeEntriesAfterRun: dataHomeEntries,
        },
      },
      telemetry: {
        format: telemetry.format,
        eventCount: telemetry.eventCount,
        eventTypes: telemetry.eventTypes,
        turnCount: telemetry.turnCount,
        toolCallCount: telemetry.toolCallCount,
        toolCallBreakdown: telemetry.toolCallBreakdown,
        mcpCallCount: telemetry.mcpCallCount,
        inputTokens: telemetry.inputTokens,
        cachedInputTokens: telemetry.cachedInputTokens,
        outputTokens: telemetry.outputTokens,
        totalTokens: telemetry.totalTokens,
        exportModel: telemetry.model,
      },
      authentication: {
        ...authentication,
        hostCredentialMutated: false,
      },
      sanitization: {
        strategy: 'literal-host-identity-redaction',
        placeholders: ['<redacted-home>', '<redacted-user>'],
        stdout: sanitizedStdout.replacements,
        stderr: sanitizedStderr.replacements,
        export: sanitizedExport.replacements,
        totalReplacements:
          sanitizedStdout.totalReplacements
          + sanitizedStderr.totalReplacements
          + sanitizedExport.totalReplacements,
      },
      export: {
        path: `results/devin-suite/generations/${entry.id}/devin-export.json`,
        sha256: sha256(sanitizedExport.content),
        sizeBytes: Buffer.byteLength(sanitizedExport.content),
      },
      prompt: { path: 'benchmark/challenges/chess-agent-v1.md', sha256: promptSha256 },
      agent: {
        path: `agents/devin-suite/${entry.id}.js`,
        sizeBytes: identity.sizeBytes,
        sha256: identity.sourceSha256,
      },
      probes,
      probeSummary: {
        passed: probes.filter((probe) => probe.legal).length,
        total: probes.length,
        allPassed: probes.every((probe) => probe.legal),
      },
    };
    await writeFile(path.join(generationDir, 'metadata.json'), `${canonicalJson(metadata, { space: 2 })}\n`);
    return { entry, metadata };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function existingGeneration(entry) {
  if (!RESUME) return null;
  const generationDir = path.join(GENERATIONS_DIR, entry.id);
  const metadataPath = path.join(generationDir, 'metadata.json');
  const sourcePath = path.join(AGENTS_DIR, `${entry.id}.js`);
  try {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    await Promise.all([
      access(path.join(generationDir, 'devin-export.json')),
      access(path.join(generationDir, 'devin-stderr.txt')),
      access(sourcePath),
    ]);
    const identity = await validateAgent(sourcePath);
    if (metadata.run?.modelRequested !== entry.model || metadata.run?.generationIndex !== entry.generationIndex) {
      throw new Error(`Resume metadata identity mismatch for ${entry.id}`);
    }
    if (identity.sourceSha256 !== metadata.agent?.sha256) {
      throw new Error(`Resume evidence failed integrity checks for ${entry.id}`);
    }
    return { entry, metadata };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function main() {
  const hostStateBefore = await snapshotHostState();
  const [authentication, harnessVersion, prompt, positionsDocument] = await Promise.all([
    requireAuth(),
    resolveDevinVersion(),
    readFile(PROMPT_PATH, 'utf8'),
    readFile(POSITIONS_PATH, 'utf8').then(JSON.parse),
  ]);
  await resolveDevinBinary();
  // Ensure credentials exist before spending model turns.
  await stat(HOST_CREDENTIALS);

  const promptSha256 = sha256(prompt);
  await mkdir(AGENTS_DIR, { recursive: true });
  if (!RESUME) await rm(GENERATIONS_DIR, { recursive: true, force: true });
  await mkdir(GENERATIONS_DIR, { recursive: true });

  const generated = [];
  for (const entry of MODELS) {
    const existing = await existingGeneration(entry);
    if (existing) {
      console.log(`Reusing verified ${entry.id} (${entry.model}) from the interrupted suite.`);
      generated.push(existing);
      continue;
    }
    console.log(`Generating ${entry.id} (${entry.model}) with Devin CLI ${harnessVersion}...`);
    generated.push(await generateOne(
      entry,
      PROMPT_PATH,
      promptSha256,
      positionsDocument.positions,
      harnessVersion,
      authentication,
    ));
  }

  const manifest = {
    schemaVersion: 'agentbattler.agent-manifest.v1',
    manifestId: `devin-suite-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    description: `${GENERATIONS_PER_MODEL} independent Devin CLI generation(s) per selected model from one fixed prompt in ephemeral XDG homes.`,
    comparison: {
      kind: 'harness-generation',
      harness: DEVIN_HARNESS_NAME,
      harnessVersion,
      provider: 'devin',
      permissionMode: DEVIN_PERMISSION_MODE,
      generationsPerModel: GENERATIONS_PER_MODEL,
      prompt: 'benchmark/challenges/chess-agent-v1.md',
      promptSha256,
      models: MODEL_LIST,
    },
    agents: generated.map(({ entry, metadata }) => ({
      id: entry.id,
      displayName: entry.displayName,
      modelFamilyId: entry.modelFamilyId,
      generationIndex: entry.generationIndex,
      role: 'model-challenger',
      source: metadata.agent.path,
      sourceSha256: metadata.agent.sha256,
      provenance: {
        kind: 'devin-cli-generated',
        isFixture: false,
        generatedByHarness: true,
        harness: DEVIN_HARNESS_NAME,
        harnessVersion,
        provider: 'devin',
        modelRequested: entry.model,
        modelFamilyId: entry.modelFamilyId,
        generationIndex: entry.generationIndex,
        permissionMode: DEVIN_PERMISSION_MODE,
        prompt: 'benchmark/challenges/chess-agent-v1.md',
        promptSha256,
        generationMetadata: `results/devin-suite/generations/${entry.id}/metadata.json`,
      },
    })),
  };
  await writeFile(path.join(AGENTS_DIR, 'manifest.json'), `${canonicalJson(manifest, { space: 2 })}\n`);

  const hostStateAfter = await snapshotHostState();
  const hostState = compareHostState(hostStateBefore, hostStateAfter);
  const suiteMetadata = {
    schemaVersion: 'agentbattler.devin-generation-suite.v1',
    generatedAt: new Date().toISOString(),
    generationsPerModel: GENERATIONS_PER_MODEL,
    families: MODEL_FAMILIES,
    generationOrder: MODELS.map(({ id }) => id),
    models: MODELS.map(({ id, model, modelFamilyId, generationIndex }) => ({
      id, model, modelFamilyId, generationIndex,
    })),
    harness: { name: DEVIN_HARNESS_NAME, version: harnessVersion },
    permissionMode: DEVIN_PERMISSION_MODE,
    authentication,
    promptSha256,
    isolation: {
      mechanism: 'ephemeral-xdg-homes',
      hostHomeMounted: false,
      hostState,
      allHostStateUnchanged: Object.values(hostState).every(Boolean),
    },
    totals: {
      runs: generated.length,
      durationMs: generated.reduce((sum, item) => sum + item.metadata.run.durationMs, 0),
      turns: generated.reduce((sum, item) => sum + (item.metadata.telemetry.turnCount ?? 0), 0),
      toolCalls: generated.reduce((sum, item) => sum + (item.metadata.telemetry.toolCallCount ?? 0), 0),
      mcpCalls: generated.reduce((sum, item) => sum + (item.metadata.telemetry.mcpCallCount ?? 0), 0),
      tokens: generated.reduce((sum, item) => sum + (item.metadata.telemetry.totalTokens ?? 0), 0),
      probesPassed: generated.reduce((sum, item) => sum + item.metadata.probeSummary.passed, 0),
      probesTotal: generated.reduce((sum, item) => sum + item.metadata.probeSummary.total, 0),
    },
  };
  await writeFile(path.join(RESULT_ROOT, 'generation-suite.json'), `${canonicalJson(suiteMetadata, { space: 2 })}\n`);

  if (!suiteMetadata.isolation.allHostStateUnchanged) {
    console.warn('Warning: host Devin config or credentials hash changed during generation (suite still recorded).');
  }
  for (const { entry, metadata } of generated) {
    console.log(
      `${entry.id}: ${metadata.agent.sizeBytes} bytes, `
      + `${metadata.probeSummary.passed}/${metadata.probeSummary.total} probes, `
      + `${metadata.telemetry.totalTokens ?? 'n/a'} tokens, `
      + `${metadata.run.durationMs} ms`,
    );
  }
  console.log(`Host Devin state unchanged: ${suiteMetadata.isolation.allHostStateUnchanged}`);
  console.log(`Manifest: ${path.join(AGENTS_DIR, 'manifest.json')}`);
}

main().catch((error) => {
  console.error(`AgentBattler Devin generation: ${error.message}`);
  process.exitCode = 1;
});
