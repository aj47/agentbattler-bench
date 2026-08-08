import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { hashV7ExecutableTree } from '../benchmark/challenges/mini-ledger-v7/pack.mjs';
import {
  assertTerminalV7HarborTaskImageReferences,
  bindTerminalV7HarborTaskImageReferences,
  TERMINAL_V7_HARBOR_UNBOUND_IMAGE_ID,
  terminalV7HarborTaskImageReferences,
  terminalV7HarborTaskImageSources,
  terminalV7HarborTaskTreeIdentity,
} from '../src/terminal-v7-harbor-images.mjs';
import { assertTerminalV7HarborTaskExecutionImages } from '../scripts/verify-terminal-v7-results.mjs';

import {
  buildHarborTerminalV7Tasks,
  TERMINAL_V7_HARBOR_AGENT_TIMEOUT_SECONDS,
} from '../scripts/build-harbor-terminal-v7.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const TICKET_ROOT = path.join(REPO_ROOT, 'benchmark', 'challenges', 'mini-ledger-v7', 'tickets');
const CONTROL_PREFIX = 'AGENTBATTLER_V7_CONTROL_V1 ';
const execFileAsync = promisify(execFile);

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function filesUnder(root, relative = '') {
  const found = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) found.push(...await filesUnder(root, child));
    else found.push(child);
  }
  return found.sort();
}

test('V7 Harbor build seals five just-in-time phases without future-ticket disclosure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-harbor-'));
  try {
    const manifest = await buildHarborTerminalV7Tasks({
      pool: 'dev',
      variant: 'decoy',
      instanceIds: ['dev-01'],
      outputRoot: root,
    });
    assert.equal(TERMINAL_V7_HARBOR_AGENT_TIMEOUT_SECONDS, 1500);
    assert.equal(manifest.phaseLimitMs, 1_500_000);
    assert.equal(manifest.tasks.length, 1);
    const [task] = manifest.tasks;
    assert.equal(task.taskPathBase, 'output-root');
    assert.equal(task.taskPath, 'dev-01-decoy');
    assert.match(task.sha256, /^[a-f0-9]{64}$/);
    const taskRoot = path.join(root, task.taskPath);
    const taskToml = await readFile(path.join(taskRoot, 'task.toml'), 'utf8');
    assert.equal((taskToml.match(/\[\[steps\]\]/g) ?? []).length, 5);
    assert.match(taskToml, /agent_time_limit_sec_per_phase = 1500/);
    assert.match(taskToml, /feedback_policy = "self-service-public-only"/);
    assert.match(taskToml, /hidden_pack_merkle_root = "[a-f0-9]{64}"/);
    assert.match(taskToml, /verifier_workspace_policy = "normalized-source-overlay-on-fresh-sealed-starter"/);
    assert.match(taskToml, /durability_evidence_policy = "strace-plus-deterministic-termination-recovery-required"/);
    assert.match(taskToml, /\[agent\]\nnetwork_mode = "public"\ntimeout_sec = 1500\.0/);
    assert.equal((taskToml.match(new RegExp(`^docker_image = ${JSON.stringify(TERMINAL_V7_HARBOR_UNBOUND_IMAGE_ID)}$`, 'gm')) ?? []).length, 2);
    assert.equal((taskToml.match(/\[steps\.agent\]\ntimeout_sec = 1500\.0/g) ?? []).length, 5);

    const tickets = await Promise.all(Array.from({ length: 5 }, (_, index) => (
      readFile(path.join(TICKET_ROOT, `phase-${String(index + 1).padStart(2, '0')}.md`), 'utf8')
    )));
    const stepNames = (await readdir(path.join(taskRoot, 'steps'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map(({ name }) => name)
      .sort();
    assert.equal(stepNames.length, 5);
    for (const [index, stepName] of stepNames.entries()) {
      const instruction = await readFile(path.join(taskRoot, 'steps', stepName, 'instruction.md'), 'utf8');
      const [firstLine, ...promptLines] = instruction.split('\n');
      assert.ok(firstLine.startsWith(CONTROL_PREFIX));
      const controlBytes = Buffer.from(firstLine.slice(CONTROL_PREFIX.length), 'base64');
      const control = JSON.parse(controlBytes);
      assert.equal(control.schemaVersion, 'agentbattler.mini-ledger-v7.phase-control.v1');
      assert.equal(control.phase, index + 1);
      assert.equal(control.ticket, tickets[index]);
      assert.equal(control.ticketSha256, sha256(tickets[index]));
      assert.equal(control.contract.phase, index + 1);
      assert.equal(control.contract.feedbackPolicy, 'self-service-public-only');
      assert.equal(control.contract.packSha256, task.packSha256);
      assert.equal(control.contract.ticketSha256, control.ticketSha256);
      assert.match(control.contract.starterTreeSha256, /^[a-f0-9]{64}$/);
      assert.match(control.contract.phaseDeltaSha256, /^[a-f0-9]{64}$/);
      assert.doesNotMatch(JSON.stringify(control.contract), /PRIVATE|private|weight/i);
      assert.deepEqual(control.contract.normativeArtifacts, [
        '.agentbattler/current/TASK.md',
        '.agentbattler/current/task-contract.json',
        '.agentbattler/current/smoke.mjs',
      ]);
      assert.equal(control.contract.publicSmokePath, '.agentbattler/current/smoke.mjs');
      assert.equal(control.contract.publicSmokeCommand, 'node .agentbattler/current/smoke.mjs');
      assert.equal(control.artifacts[0].path, 'smoke.mjs');
      const smokeBytes = Buffer.from(control.artifacts[0].bytesBase64, 'base64');
      assert.equal(sha256(smokeBytes), control.contract.publicSmokeSha256);
      assert.equal(control.contractSha256, sha256(`${canonicalJson(control.contract)}\n`));
      assert.equal(Object.hasOwn(control, 'phases'), false);
      assert.equal(Object.hasOwn(control.contract, 'phases'), false);
      if (index === 3) {
        assert.equal(control.contract.incidentEvidencePath, '.agentbattler/current/incident-evidence.json');
        assert.equal(control.contract.responsePath, 'incident-response.json');
        assert.equal(control.artifacts.length, 2);
        assert.equal(control.artifacts[1].path, 'incident-evidence.json');
        const evidenceBytes = Buffer.from(control.artifacts[1].bytesBase64, 'base64');
        assert.equal(sha256(evidenceBytes), control.artifacts[1].sha256);
        assert.equal(control.contract.incidentEvidenceSha256, control.artifacts[1].sha256);
        assert.equal(control.contract.executableSourceSha256, null);
        assert.equal(JSON.parse(evidenceBytes).schema, 'agentbattler.ledger.incident-evidence.v1');
      } else {
        assert.equal(control.artifacts.length, 1);
        assert.doesNotMatch(controlBytes.toString('utf8'), /incident-evidence\.json/);
      }
      for (const [otherIndex, futureTicket] of tickets.entries()) {
        if (otherIndex !== index) assert.doesNotMatch(controlBytes.toString('utf8'), new RegExp(futureTicket.split('\n')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }
      const prompt = promptLines.join('\n');
      assert.match(prompt, /hard 25-minute phase limit/);
      assert.match(prompt, /Future tickets, private checks, scoring weights, and verifier sources are intentionally unavailable/);
      assert.doesNotMatch(prompt, /hidden case|gold patch|holdout-verifier/);
      const pythonDecoded = await execFileAsync('python3', [
        '-c',
        'import json,sys; from benchmark.harbor.v7_control import decode_v7_instruction; value,prompt=decode_v7_instruction(open(sys.argv[1]).read()); print(json.dumps({"phase":value["phase"],"artifacts":[item["path"] for item in value["decodedArtifacts"]],"prompt":bool(prompt)}))',
        path.join(taskRoot, 'steps', stepName, 'instruction.md'),
      ], { cwd: REPO_ROOT });
      const decodedSummary = JSON.parse(pythonDecoded.stdout);
      assert.equal(decodedSummary.phase, index + 1);
      assert.deepEqual(decodedSummary.artifacts, index === 3 ? ['smoke.mjs', 'incident-evidence.json'] : ['smoke.mjs']);
      assert.equal(decodedSummary.prompt, true);
    }

    const environmentDockerfile = await readFile(path.join(taskRoot, 'environment', 'Dockerfile'), 'utf8');
    const environmentCompose = await readFile(path.join(taskRoot, 'environment', 'docker-compose.yaml'), 'utf8');
    assert.match(environmentDockerfile, /bubblewrap ca-certificates curl git procps ripgrep socat strace util-linux/);
    assert.match(environmentDockerfile, /org\.agentbattler\.v7\.context-sha256/);
    assert.match(environmentDockerfile, /git clone --depth=1 file:\/\/\/seed \/app/);
    assert.match(environmentDockerfile, /git -C \/app remote remove origin/);
    assert.match(environmentDockerfile, /chown -R 0:0 \/app/);
    assert.match(environmentDockerfile, /chmod 0555 \/app\/\.agentbattler\/current/);
    assert.match(environmentDockerfile, /control-boundary-probe\.sh \/usr\/local\/bin\/agentbattler-v7-control-boundary-probe/);
    assert.match(environmentDockerfile, /executable-hash\.mjs \/usr\/local\/bin\/agentbattler-v7-executable-hash/);
    assert.match(environmentCompose, /cap_drop:\n      - ALL/);
    assert.match(environmentCompose, /cap_add:\n      - CHOWN\n      - SYS_ADMIN\n      - NET_ADMIN/);
    assert.match(environmentCompose, /no-new-privileges:true/);
    assert.match(environmentCompose, /seccomp=unconfined/);
    const controlProbe = await readFile(path.join(taskRoot, 'environment', 'control-boundary-probe.sh'), 'utf8');
    assert.match(controlProbe, /CapEff/);
    assert.match(controlProbe, /source-write-ok/);
    assert.match(controlProbe, /chmod 0644 "\$ticket"/);
    assert.match(controlProbe, /printf 'tamper\\n' > "\$contract"/);
    assert.match(controlProbe, /umount \/app\/\.agentbattler\/current/);
    assert.match(controlProbe, /findmnt -n -o OPTIONS/);

    const hashHelper = path.join(taskRoot, 'environment', 'executable-hash.mjs');
    const starterRoot = path.join(taskRoot, 'environment', 'starter');
    const expectedExecutableHash = await hashV7ExecutableTree(starterRoot);
    const printedHash = await execFileAsync(process.execPath, [hashHelper, '--workspace', starterRoot]);
    assert.equal(printedHash.stdout.trim(), expectedExecutableHash);
    const contractProbe = path.join(root, 'contract-probe.json');
    await writeFile(contractProbe, '{"phase":4}\n');
    await execFileAsync(process.execPath, [hashHelper, '--workspace', starterRoot, '--update-contract', contractProbe]);
    const updatedContract = JSON.parse(await readFile(contractProbe, 'utf8'));
    assert.equal(updatedContract.executableSourceSha256, expectedExecutableHash);
    assert.equal(updatedContract.executableSourceHashAlgorithm, 'sha256-path-null-content-sha256-newline-v1');

    const starterFiles = await filesUnder(path.join(taskRoot, 'environment', 'starter'));
    assert.equal(starterFiles.some((file) => /(?:^|\/)(?:TASK\.md|task-contract\.json|verifier\.mjs)$/.test(file)), false);
    assert.equal(starterFiles.some((file) => file.startsWith('.git/')), false);

    const firstTests = path.join(taskRoot, 'steps', stepNames[0], 'tests');
    const privateVerifierFiles = await filesUnder(firstTests);
    assert.equal(privateVerifierFiles.some((file) => file.includes('/gold/') || file.startsWith('gold/')), false);
    const verifierDockerfile = await readFile(path.join(firstTests, 'Dockerfile'), 'utf8');
    const verifierShell = await readFile(path.join(firstTests, 'test.sh'), 'utf8');
    const verifierCompose = await readFile(path.join(firstTests, 'docker-compose.yaml'), 'utf8');
    const verifierRunner = await readFile(path.join(firstTests, 'run-phase.mjs'), 'utf8');
    await execFileAsync(process.execPath, ['--check', path.join(firstTests, 'run-phase.mjs')]);
    assert.match(verifierDockerfile, /bubblewrap iptables strace/);
    assert.match(verifierDockerfile, /agentbattler-v7-candidate-guard/);
    assert.match(verifierDockerfile, /V7 candidate retained capabilities/);
    assert.match(verifierDockerfile, /find \/tests -type d -exec chmod 0700/);
    assert.match(verifierDockerfile, /find \/tests -type f -exec chmod 0600/);
    assert.match(verifierShell, /iptables -P OUTPUT DROP/);
    assert.match(verifierCompose, /cap_drop:\n      - ALL/);
    assert.match(verifierCompose, /      - SYS_ADMIN/);
    assert.match(verifierCompose, /      - SYS_PTRACE/);
    assert.match(verifierCompose, /seccomp=unconfined/);
    assert.match(verifierShell, /stat -c %a \/tests\/benchmark\/challenges\/mini-ledger-v7\/verifier\.mjs/);
    assert.match(verifierRunner, /captureTerminalCandidateTree/);
    assert.match(verifierRunner, /materializeTerminalV7Candidate/);
    assert.match(verifierRunner, /verifyPhaseTrajectory/);
    assert.match(verifierRunner, /candidateNativeSandboxCommand/);
    assert.match(verifierRunner, /AGENTBATTLER_CANDIDATE_NATIVE_SANDBOX = 'bubblewrap-v1'/);
    assert.match(verifierRunner, /const candidateCapabilityMask = await zeroCapabilityProbe\(\)/);
    assert.match(verifierRunner, /const candidateNativeBoundary = await nativeBoundaryProbe\(\)/);
    assert.doesNotMatch(verifierRunner, /verifyFinal/);
    assert.match(verifierRunner, /hidden-seed-key/);
    assert.match(verifierRunner, /candidate-trees|candidateTree/);
    assert.match(verifierRunner, /phaseFourTrajectoryComparison/);
    assert.match(verifierRunner, /declaredArtifact: declaredArtifacts\[0\] \?\? null/);
    assert.match(verifierRunner, /infrastructureErrors: infrastructureError \? \[infrastructureError\] : \[\]/);
    const sealedPack = JSON.parse(await readFile(path.join(firstTests, 'sealed-pack.json'), 'utf8'));
    assert.equal(sealedPack.instanceId, 'dev-01');
    assert.equal(sealedPack.variant, 'decoy');
    assert.match(sealedPack.hiddenMerkleRoot, /^[a-f0-9]{64}$/);
    assert.match(sealedPack.sealSha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(sealedPack), /seedKey|hiddenSeed|public-development-key/);
    assert.equal((await filesUnder(firstTests)).includes('hidden-seed-key'), false);
    const imageSources = await terminalV7HarborTaskImageSources({ taskRoot });
    assert.match(imageSources.environment.sourceSha256, /^[a-f0-9]{64}$/);
    assert.match(imageSources.verifier.sourceSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(imageSources.environment.sourceSha256, imageSources.verifier.sourceSha256);
    assert.doesNotMatch(taskToml, /docker_image = "agentbattler-v7-harbor-/);
    assert.deepEqual(await terminalV7HarborTaskImageReferences({ taskRoot }), {
      environment: TERMINAL_V7_HARBOR_UNBOUND_IMAGE_ID,
      verifier: TERMINAL_V7_HARBOR_UNBOUND_IMAGE_ID,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('V7 Harbor task binding replaces non-pullable placeholders with exact inspected IDs and strict checks reject tag or ID substitution', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-harbor-image-binding-'));
  try {
    const manifest = await buildHarborTerminalV7Tasks({
      pool: 'dev',
      variant: 'decoy',
      instanceIds: ['dev-01'],
      outputRoot: root,
    });
    const taskRoot = path.join(root, manifest.tasks[0].taskPath);
    const sources = await terminalV7HarborTaskImageSources({ taskRoot });
    const images = {
      environment: { ...sources.environment, imageId: `sha256:${'1'.repeat(64)}` },
      verifier: { ...sources.verifier, imageId: `sha256:${'2'.repeat(64)}` },
    };
    const before = await terminalV7HarborTaskTreeIdentity({ taskRoot });
    const references = await bindTerminalV7HarborTaskImageReferences({ taskRoot, images });
    assert.deepEqual(references, {
      environment: images.environment.imageId,
      verifier: images.verifier.imageId,
    });
    assert.deepEqual(await assertTerminalV7HarborTaskImageReferences({ taskRoot, expected: images }), references);
    const after = await terminalV7HarborTaskTreeIdentity({ taskRoot });
    assert.notEqual(after.sha256, before.sha256);
    assert.equal(after.fileCount, before.fileCount);
    assert.deepEqual(await assertTerminalV7HarborTaskExecutionImages({
      taskRoot,
      expected: images,
      inspectImages: async ({ expected }) => structuredClone(expected),
    }), { taskImageReferences: references, runtimeImages: images });

    const taskFile = path.join(taskRoot, 'task.toml');
    const boundToml = await readFile(taskFile, 'utf8');
    assert.equal((boundToml.match(/^docker_image = "sha256:[a-f0-9]{64}"$/gm) ?? []).length, 2);
    assert.doesNotMatch(boundToml, /docker_image = "agentbattler-v7-harbor-/);

    await writeFile(taskFile, boundToml.replace(images.environment.imageId, images.environment.image));
    let inspections = 0;
    await assert.rejects(assertTerminalV7HarborTaskExecutionImages({
      taskRoot,
      expected: images,
      inspectImages: async () => { inspections += 1; return images; },
    }), /exact sealed image ID/);
    assert.equal(inspections, 0);
    await assert.rejects(bindTerminalV7HarborTaskImageReferences({ taskRoot, images }), /substituted before immutable binding/);

    await writeFile(taskFile, boundToml.replace(images.verifier.imageId, `sha256:${'3'.repeat(64)}`));
    await assert.rejects(assertTerminalV7HarborTaskImageReferences({ taskRoot, expected: images }), /exact sealed image ID/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('V7 release Harbor tasks stay under private result-root control without key metadata', async () => {
  const resultRoot = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-v7-private-'));
  const seedKey = 'release-test-seed-key-000000000001';
  try {
    const manifest = await buildHarborTerminalV7Tasks({
      pool: 'release',
      variant: 'decoy',
      instanceIds: ['release-01'],
      resultRoot,
      seedKey,
    });
    assert.equal(manifest.tasks[0].taskPathBase, 'result-root');
    assert.equal(manifest.tasks[0].taskPath, 'control/harbor-tasks/release-01-decoy');
    assert.doesNotMatch(JSON.stringify(manifest), new RegExp(seedKey));
    const taskRoot = path.join(resultRoot, ...manifest.tasks[0].taskPath.split('/'));
    const seedFile = path.join(taskRoot, 'steps', '01-legacy-migration', 'tests', 'hidden-seed-key');
    assert.equal((await stat(seedFile)).mode & 0o777, 0o600);
    assert.equal((await readFile(seedFile, 'utf8')).trim(), seedKey);
    const serializedManifest = await readFile(path.join(resultRoot, 'control', 'harbor-tasks', 'manifest-release-decoy.json'), 'utf8');
    assert.doesNotMatch(serializedManifest, new RegExp(seedKey));
    await assert.rejects(buildHarborTerminalV7Tasks({
      pool: 'release',
      variant: 'decoy',
      instanceIds: ['release-01'],
      outputRoot: path.join(REPO_ROOT, 'benchmark', 'harbor', 'mini-ledger-v7', 'unsafe-release-test'),
      resultRoot,
      seedKey,
    }), /outside the repository/);
  } finally {
    await rm(resultRoot, { recursive: true, force: true });
  }
});
