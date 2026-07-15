import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';

import {
  applyUciMove,
  generateLegalMoves,
  isLegalUciMove,
  parseFen,
  terminalStatus,
  toFen,
} from './chess.mjs';
import { canonicalJsonSha256, sha256 } from './provenance.mjs';

export const MAX_AGENT_BYTES = 50 * 1024;
const UCI_ONLY = /^[a-h][1-8][a-h][1-8][qrbn]?\n?$/;

export class AgentValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AgentValidationError';
    this.code = code;
  }
}

/** Validate and identify one dependency-free JavaScript agent file. */
export async function validateAgent(agentPath) {
  if (typeof agentPath !== 'string' || path.extname(agentPath) !== '.js') {
    throw new AgentValidationError('not_js', 'Agent must be exactly one .js file');
  }
  let info;
  try {
    info = await stat(agentPath);
  } catch (error) {
    throw new AgentValidationError('unreadable', `Cannot read agent file: ${error.message}`);
  }
  if (!info.isFile()) throw new AgentValidationError('not_file', 'Agent path must be a regular file');
  if (info.size > MAX_AGENT_BYTES) {
    throw new AgentValidationError('too_large', `Agent exceeds ${MAX_AGENT_BYTES} UTF-8 bytes`);
  }
  let bytes;
  try {
    bytes = await readFile(agentPath);
  } catch (error) {
    throw new AgentValidationError('unreadable', `Cannot read agent file: ${error.message}`);
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AgentValidationError('invalid_utf8', 'Agent must contain valid UTF-8');
  }
  const resolvedPath = await realpath(agentPath);
  return {
    fileName: path.basename(resolvedPath),
    path: resolvedPath,
    sizeBytes: bytes.length,
    sourceSha256: sha256(bytes),
  };
}

function permissionFlag(nodePath = process.execPath) {
  if (nodePath !== process.execPath) return null;
  if (process.allowedNodeEnvironmentFlags?.has('--permission')) return '--permission';
  if (process.allowedNodeEnvironmentFlags?.has('--experimental-permission')) return '--experimental-permission';
  return null;
}

export function permissionModelAvailable(nodePath = process.execPath) {
  return permissionFlag(nodePath) !== null
    && process.allowedNodeEnvironmentFlags?.has('--allow-net');
}

function executionResult(fields) {
  return {
    status: fields.status,
    failureClass: fields.failureClass ?? null,
    input: fields.input,
    stdout: fields.stdout ?? '',
    stderr: fields.stderr ?? '',
    move: fields.move ?? null,
    exitCode: fields.exitCode ?? null,
    signal: fields.signal ?? null,
    runtimeMs: Math.round(fields.runtimeMs * 1000) / 1000,
    detail: fields.detail ?? null,
  };
}

/**
 * Execute one move in a fresh, permission-confined Node process. The child has
 * no network, child-process, worker, or filesystem access except reading its
 * own source. Set unsafeWithoutPermissions only for an explicitly untrusted,
 * externally sandboxed environment.
 */
export async function runAgentMove({
  agentPath,
  fen,
  timeoutMs = 1_000,
  nodePath = process.execPath,
  maxOutputBytes = 64 * 1024,
  unsafeWithoutPermissions = false,
}) {
  const started = performance.now();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
  if (!permissionModelAvailable(nodePath) && !unsafeWithoutPermissions) {
    return executionResult({
      status: 'infrastructure_failure',
      failureClass: 'infrastructure',
      input: fen,
      runtimeMs: performance.now() - started,
      detail: 'Node permission model with network enforcement is unavailable; refusing unsandboxed execution',
    });
  }

  let isolatedCwd;
  try {
    const resolvedAgent = await realpath(agentPath);
    isolatedCwd = await mkdtemp(path.join(os.tmpdir(), 'agentbattler-'));
    const flag = permissionFlag(nodePath);
    const permissionArgs = flag
      ? [flag, `--allow-fs-read=${resolvedAgent}`]
      : [];
    const args = [...permissionArgs, resolvedAgent];

    return await new Promise((resolve) => {
      let child;
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let timedOut = false;
      let outputExceeded = false;
      let settled = false;

      const finish = (fields) => {
        if (settled) return;
        settled = true;
        resolve(executionResult({
          input: fen,
          stdout: stdout.toString('utf8'),
          stderr: stderr.toString('utf8'),
          runtimeMs: performance.now() - started,
          ...fields,
        }));
      };

      try {
        child = spawn(nodePath, args, {
          cwd: isolatedCwd,
          env: { LANG: 'C', LC_ALL: 'C', PATH: path.dirname(nodePath) },
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (error) {
        finish({ status: 'infrastructure_failure', failureClass: 'infrastructure', detail: error.message });
        return;
      }

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      timer.unref?.();

      const collect = (current, chunk) => {
        if (current.length + chunk.length > maxOutputBytes) {
          outputExceeded = true;
          child.kill('SIGKILL');
          return current;
        }
        return Buffer.concat([current, chunk]);
      };
      child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk); });
      child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk); });
      child.on('error', (error) => {
        clearTimeout(timer);
        finish({ status: 'infrastructure_failure', failureClass: 'infrastructure', detail: error.message });
      });
      child.on('close', (exitCode, signal) => {
        clearTimeout(timer);
        if (timedOut) {
          finish({ status: 'timeout', failureClass: 'agent', exitCode, signal });
        } else if (outputExceeded) {
          finish({ status: 'malformed', failureClass: 'agent', exitCode, signal, detail: 'output_limit_exceeded' });
        } else if (exitCode !== 0 || signal) {
          finish({ status: 'crash', failureClass: 'agent', exitCode, signal });
        } else {
          const output = stdout.toString('utf8');
          const valid = UCI_ONLY.test(output);
          finish({
            status: valid ? 'ok' : 'malformed',
            failureClass: valid ? null : 'agent',
            move: valid ? output.replace(/\n$/, '') : null,
            exitCode,
            signal,
            detail: valid ? null : 'stdout_must_be_exactly_one_uci_move',
          });
        }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(fen, 'utf8');
    });
  } catch (error) {
    return executionResult({
      status: 'infrastructure_failure',
      failureClass: 'infrastructure',
      input: fen,
      runtimeMs: performance.now() - started,
      detail: error.message,
    });
  } finally {
    if (isolatedCwd) await rm(isolatedCwd, { recursive: true, force: true });
  }
}

function agentSpec(spec, color) {
  if (typeof spec === 'string') return { id: `${color}-agent`, path: spec };
  const agentPath = spec?.path ?? (typeof spec?.source === 'string' ? spec.source : null);
  if (!agentPath) throw new TypeError(`${color} agent must provide path or string source`);
  return { ...spec, path: agentPath };
}

function outcomeForWinner(winner) {
  return winner === 'w' ? '1-0' : winner === 'b' ? '0-1' : '1/2-1/2';
}

function finalFromTerminal(terminal) {
  if (terminal.status === 'checkmate') {
    return { outcome: outcomeForWinner(terminal.winner), reason: 'checkmate' };
  }
  if (terminal.status === 'stalemate') return { outcome: '1/2-1/2', reason: 'stalemate' };
  return null;
}

function failedGame(result, outcome, reason, failure) {
  result.final = { outcome, reason, failure };
  return result;
}

function sealResult(result) {
  result.resultSha256 = canonicalJsonSha256(result);
  return result;
}

/**
 * Play a deterministic game. `position` is {id, fen, seed?, maxPlies?}; agent
 * specs are {id, path, ...published identity metadata}. Agent failures forfeit,
 * while grader/infrastructure failures make the game void.
 */
export async function playGame({
  white,
  black,
  position,
  timeoutMs = 1_000,
  maxPlies = position?.maxPlies ?? 200,
  seed = position?.seed ?? position?.seeds?.[0] ?? 0,
  runner = {},
  execution = {},
}) {
  const specs = { w: agentSpec(white, 'white'), b: agentSpec(black, 'black') };
  const result = {
    schemaVersion: 1,
    kind: 'agentbattler.chess-game',
    runner,
    position: { id: position?.id ?? null, initialFen: position?.fen, seed, maxPlies },
    agents: {},
    plies: [],
    final: null,
  };

  for (const [color, spec] of Object.entries(specs)) {
    try {
      const identity = await validateAgent(spec.path);
      if (spec.sourceSha256 && spec.sourceSha256 !== identity.sourceSha256) {
        throw new AgentValidationError('hash_mismatch', `Source hash does not match manifest for ${spec.id}`);
      }
      result.agents[color] = {
        id: spec.id,
        displayName: spec.displayName ?? spec.id,
        role: spec.role ?? null,
        source: spec.source ?? identity.fileName,
        sourceSha256: identity.sourceSha256,
        sizeBytes: identity.sizeBytes,
        provenance: spec.provenance ?? {},
        metadata: spec.metadata ?? {},
      };
    } catch (error) {
      if (!(error instanceof AgentValidationError)) {
        return sealResult(failedGame(result, 'void', 'infrastructure_failure', {
          class: 'infrastructure', detail: error.message,
        }));
      }
      result.agents[color] = { id: spec.id, path: path.resolve(spec.path), validation: { code: error.code, message: error.message } };
      const winner = color === 'w' ? 'b' : 'w';
      return sealResult(failedGame(result, outcomeForWinner(winner), 'validation_failure', {
        class: 'agent', color, status: 'validation', detail: error.code,
      }));
    }
  }

  let state;
  try {
    state = parseFen(position.fen);
  } catch (error) {
    return sealResult(failedGame(result, 'void', 'grader_failure', {
      class: 'grader', detail: error.message,
    }));
  }

  for (let ply = 0; ply < maxPlies; ply += 1) {
    let terminal;
    let fen;
    try {
      terminal = terminalStatus(state);
      const final = finalFromTerminal(terminal);
      if (final) {
        result.final = { ...final, failure: null };
        return sealResult(result);
      }
      fen = toFen(state);
    } catch (error) {
      return sealResult(failedGame(result, 'void', 'grader_failure', { class: 'grader', detail: error.message }));
    }

    const color = state.turn;
    let attempt;
    try {
      attempt = await runAgentMove({
        agentPath: specs[color].path,
        fen,
        timeoutMs,
        ...execution,
      });
    } catch (error) {
      return sealResult(failedGame(result, 'void', 'infrastructure_failure', {
        class: 'infrastructure', color, detail: error.message,
      }));
    }
    const record = { ply: ply + 1, color, agentId: specs[color].id, ...attempt, resultingFen: null };
    result.plies.push(record);

    if (attempt.status !== 'ok') {
      const outcome = attempt.failureClass === 'agent' ? outcomeForWinner(color === 'w' ? 'b' : 'w') : 'void';
      const reason = attempt.failureClass === 'agent' ? `agent_${attempt.status}` : 'infrastructure_failure';
      return sealResult(failedGame(result, outcome, reason, {
        class: attempt.failureClass, color, status: attempt.status, detail: attempt.detail,
      }));
    }

    try {
      if (!isLegalUciMove(state, attempt.move)) {
        record.status = 'illegal';
        record.failureClass = 'agent';
        return sealResult(failedGame(result, outcomeForWinner(color === 'w' ? 'b' : 'w'), 'agent_illegal', {
          class: 'agent', color, status: 'illegal', detail: attempt.move,
        }));
      }
      state = applyUciMove(state, attempt.move);
      record.resultingFen = toFen(state);
      const final = finalFromTerminal(terminalStatus(state));
      if (final) {
        result.final = { ...final, failure: null };
        return sealResult(result);
      }
    } catch (error) {
      return sealResult(failedGame(result, 'void', 'grader_failure', { class: 'grader', detail: error.message }));
    }
  }

  result.final = { outcome: '1/2-1/2', reason: 'max_plies', failure: null };
  return sealResult(result);
}

/** Replay recorded moves through the grader and verify all deterministic fields. */
export function replayGame(result) {
  const mismatches = [];
  let state;
  try {
    const { resultSha256, ...unsignedResult } = result;
    const actualResultSha256 = canonicalJsonSha256(unsignedResult);
    if (resultSha256 !== actualResultSha256) {
      mismatches.push({ field: 'resultSha256', expected: resultSha256, actual: actualResultSha256 });
    }
    state = parseFen(result.position.initialFen);
    for (const record of result.plies) {
      const fen = toFen(state);
      if (fen !== record.input) mismatches.push({ ply: record.ply, field: 'input', expected: record.input, actual: fen });
      if (record.status === 'illegal') {
        if (isLegalUciMove(state, record.move)) {
          mismatches.push({ ply: record.ply, field: 'move', expected: 'illegal', actual: record.move });
        }
        break;
      }
      if (record.status !== 'ok') break;
      if (!isLegalUciMove(state, record.move)) {
        mismatches.push({ ply: record.ply, field: 'move', expected: 'legal', actual: record.move });
        break;
      }
      state = applyUciMove(state, record.move);
      const resultingFen = toFen(state);
      if (resultingFen !== record.resultingFen) {
        mismatches.push({ ply: record.ply, field: 'resultingFen', expected: record.resultingFen, actual: resultingFen });
      }
    }
    const last = result.plies.at(-1);
    if (last && last.status !== 'ok') {
      const agentFailure = last.failureClass === 'agent';
      const expectedFinal = agentFailure
        ? {
            outcome: outcomeForWinner(last.color === 'w' ? 'b' : 'w'),
            reason: last.status === 'illegal' ? 'agent_illegal' : `agent_${last.status}`,
            failure: { class: 'agent', color: last.color, status: last.status, detail: last.status === 'illegal' ? last.move : last.detail },
          }
        : {
            outcome: 'void',
            reason: 'infrastructure_failure',
            failure: { class: last.failureClass, color: last.color, status: last.status, detail: last.detail },
          };
      if (canonicalJsonSha256(result.final) !== canonicalJsonSha256(expectedFinal)) {
        mismatches.push({ field: 'final', expected: expectedFinal, actual: result.final });
      }
    }
    const terminal = terminalStatus(state);
    const terminalFinal = finalFromTerminal(terminal);
    if ((!last || last.status === 'ok') && terminalFinal && (result.final.outcome !== terminalFinal.outcome || result.final.reason !== terminalFinal.reason)) {
      mismatches.push({ field: 'final', expected: result.final, actual: terminalFinal });
    } else if ((!last || last.status === 'ok') && !terminalFinal && ['checkmate', 'stalemate'].includes(result.final.reason)) {
      mismatches.push({ field: 'final.reason', expected: result.final.reason, actual: 'ongoing' });
    } else if (result.final.reason === 'max_plies' && result.plies.length !== result.position.maxPlies) {
      mismatches.push({ field: 'plies.length', expected: result.position.maxPlies, actual: result.plies.length });
    }
  } catch (error) {
    return { ok: false, mismatches, failure: { class: 'grader', detail: error.message } };
  }
  return { ok: mismatches.length === 0, mismatches, finalFen: toFen(state) };
}

/** Deterministic color allocation helper for paired games. */
export function pairedGames(agentA, agentB, position) {
  return [
    { white: agentA, black: agentB, position },
    { white: agentB, black: agentA, position },
  ];
}
