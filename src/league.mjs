import { canonicalJsonSha256 } from './provenance.mjs';

export const BATTLE_PROTOCOL_SCHEMA = 'agentbattler.battle-protocol.v1';
export const COMBO_SCHEMA = 'agentbattler.combo.v1';
export const SEASON_SCHEMA = 'agentbattler.season.v1';
export const SCHEDULE_SCHEMA = 'agentbattler.league-schedule.v1';

export const DEFAULT_TIERS = Object.freeze([
  Object.freeze({ id: 'challenger', order: 1, displayName: 'Challenger' }),
  Object.freeze({ id: 'contender', order: 2, displayName: 'Contender' }),
  Object.freeze({ id: 'elite', order: 3, displayName: 'Elite' }),
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sealedIdentity(prefix, descriptor) {
  const sha256 = canonicalJsonSha256(descriptor);
  return { ...descriptor, [`${prefix}Sha256`]: sha256, [`${prefix}Id`]: `${prefix}-${sha256.slice(0, 16)}` };
}

export function createBattleProtocol({
  nodeVersion = 'v26.3.0',
  timeoutMs = 1_000,
  maxOutputBytes = 64 * 1024,
  permissionModel = 'node-permission-no-network',
  adjudication = 'agentbattler-chess-v1',
} = {}) {
  invariant(typeof nodeVersion === 'string' && /^v\d+\.\d+\.\d+$/.test(nodeVersion), 'Protocol requires an exact Node version');
  invariant(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'Protocol timeoutMs must be a positive integer');
  invariant(Number.isSafeInteger(maxOutputBytes) && maxOutputBytes > 0, 'Protocol maxOutputBytes must be a positive integer');
  return sealedIdentity('protocol', {
    schemaVersion: BATTLE_PROTOCOL_SCHEMA,
    kind: 'agentbattler.chess-battle-protocol',
    gameSchemaVersion: 1,
    runtime: { engine: 'node', version: nodeVersion, permissionModel },
    limits: { timeoutMs, maxOutputBytes },
    adjudication,
  });
}

export function comboForAgent(agent) {
  invariant(agent && typeof agent.id === 'string', 'Agent identity is required');
  const provenance = agent.provenance ?? {};
  const descriptor = {
    schemaVersion: COMBO_SCHEMA,
    kind: 'agentbattler.agent-combo',
    task: {
      sha256: provenance.taskSha256 ?? provenance.promptSha256 ?? null,
    },
    harness: {
      id: provenance.harness ?? provenance.kind ?? 'unknown',
      version: provenance.harnessVersion ?? null,
    },
    model: {
      id: provenance.modelRequested ?? agent.modelFamilyId ?? provenance.modelFamilyId ?? agent.id,
      reasoningEffort: provenance.reasoningEffort ?? null,
    },
    generationSettings: provenance.generationSettings ?? {},
  };
  return sealedIdentity('combo', descriptor);
}

export function groupAgentsByCombo(agents) {
  const groups = new Map();
  for (const agent of agents) {
    const combo = comboForAgent(agent);
    const bucket = groups.get(combo.comboId) ?? { combo, agents: [] };
    bucket.agents.push(agent);
    groups.set(combo.comboId, bucket);
  }
  for (const group of groups.values()) {
    group.agents.sort((left, right) => (
      (left.generationIndex ?? left.provenance?.generationIndex ?? Number.MAX_SAFE_INTEGER)
      - (right.generationIndex ?? right.provenance?.generationIndex ?? Number.MAX_SAFE_INTEGER)
      || left.id.localeCompare(right.id)
    ));
  }
  return groups;
}

export function createSeason({ suiteId, suiteSha256, protocol, evidenceLane = 'exploratory' }) {
  invariant(typeof suiteId === 'string' && suiteId.length > 0, 'Season suiteId is required');
  invariant(typeof suiteSha256 === 'string' && /^[0-9a-f]{64}$/.test(suiteSha256), 'Season suiteSha256 is required');
  validateBattleProtocol(protocol);
  return sealedIdentity('season', {
    schemaVersion: SEASON_SCHEMA,
    kind: 'agentbattler.league-season',
    suite: { id: suiteId, sha256: suiteSha256 },
    protocol: { id: protocol.protocolId, sha256: protocol.protocolSha256 },
    evidenceLane,
  });
}

export function validateSeason(season) {
  invariant(season?.schemaVersion === SEASON_SCHEMA, 'Unsupported season schema');
  const { seasonId, seasonSha256, ...descriptor } = season;
  const actual = canonicalJsonSha256(descriptor);
  invariant(seasonSha256 === actual, 'Season hash mismatch');
  invariant(seasonId === `season-${actual.slice(0, 16)}`, 'Season ID mismatch');
  return season;
}

export function validateBattleProtocol(protocol) {
  invariant(protocol?.schemaVersion === BATTLE_PROTOCOL_SCHEMA, 'Unsupported battle protocol schema');
  const { protocolId, protocolSha256, ...descriptor } = protocol;
  const actual = canonicalJsonSha256(descriptor);
  invariant(protocolSha256 === actual, 'Battle protocol hash mismatch');
  invariant(protocolId === `protocol-${actual.slice(0, 16)}`, 'Battle protocol ID mismatch');
  return protocol;
}

export function gameSpecification({ white, black, position, seed, protocol }) {
  validateBattleProtocol(protocol);
  for (const [color, agent] of [['white', white], ['black', black]]) {
    invariant(typeof agent?.id === 'string' && agent.id.length > 0, `${color} agent ID is required`);
    invariant(/^[0-9a-f]{64}$/.test(agent.sourceSha256 ?? ''), `${color} sourceSha256 is required`);
  }
  const initialFen = position?.initialFen ?? position?.fen;
  const gameSeed = seed ?? position?.seed ?? position?.seeds?.[0];
  invariant(typeof initialFen === 'string' && initialFen.length > 0, 'Game initialFen is required');
  invariant(Number.isSafeInteger(gameSeed), 'Game seed must be a safe integer');
  invariant(Number.isSafeInteger(position?.maxPlies) && position.maxPlies > 0, 'Game maxPlies must be a positive integer');
  const spec = {
    schemaVersion: 'agentbattler.game-spec.v1',
    protocol: { id: protocol.protocolId, sha256: protocol.protocolSha256 },
    white: { id: white.id, sourceSha256: white.sourceSha256 },
    black: { id: black.id, sourceSha256: black.sourceSha256 },
    position: { id: position.id ?? null, initialFen, seed: gameSeed, maxPlies: position.maxPlies },
  };
  return { ...spec, gameKey: canonicalJsonSha256(spec) };
}

export function gameSpecificationFromRecord(game, protocol) {
  return gameSpecification({
    white: game.agents?.w,
    black: game.agents?.b,
    position: game.position,
    seed: game.position?.seed,
    protocol,
  });
}

function artifactPairings(entrant, opponent, rotation) {
  invariant(entrant.agents.length > 0 && opponent.agents.length > 0, 'Combo groups must contain artifacts');
  return entrant.agents.map((agent, index) => [
    agent,
    opponent.agents[(index + rotation) % opponent.agents.length],
  ]);
}

function sealSchedule(schedule) {
  const scheduleSha256 = canonicalJsonSha256(schedule);
  return { ...schedule, scheduleSha256, scheduleId: `schedule-${scheduleSha256.slice(0, 16)}` };
}

export function createPlacementSchedule({
  agents,
  entrantComboId,
  anchorComboIds = [],
  targetComboIds = [],
  positions,
  season,
  protocol,
  tierId = 'challenger',
  rotations = 1,
}) {
  validateBattleProtocol(protocol);
  validateSeason(season);
  invariant(season.protocol?.sha256 === protocol.protocolSha256, 'Season and schedule protocols differ');
  invariant(DEFAULT_TIERS.some((tier) => tier.id === tierId), `Unsupported tier: ${tierId}`);
  invariant(Number.isSafeInteger(rotations) && rotations > 0, 'rotations must be a positive integer');
  invariant(Array.isArray(positions) && positions.length > 0, 'Placement schedule requires positions');
  const groups = groupAgentsByCombo(agents);
  const entrant = groups.get(entrantComboId);
  invariant(entrant, `Unknown entrant combo: ${entrantComboId}`);
  const phases = [
    ['anchor', [...new Set(anchorComboIds)].sort()],
    ['targeted', [...new Set(targetComboIds)].sort()],
  ];
  const allOpponents = phases.flatMap(([, ids]) => ids);
  invariant(allOpponents.length > 0, 'Placement schedule requires at least one anchor or targeted opponent');
  invariant(new Set(allOpponents).size === allOpponents.length, 'A combo cannot be both an anchor and a targeted opponent');
  invariant(!allOpponents.includes(entrantComboId), 'Entrant cannot play itself');

  const jobs = [];
  const seen = new Set();
  for (const [phase, opponentIds] of phases) {
    for (const opponentComboId of opponentIds) {
      const opponent = groups.get(opponentComboId);
      invariant(opponent, `Unknown opponent combo: ${opponentComboId}`);
      invariant(rotations <= opponent.agents.length, `rotations exceed available artifacts for ${opponentComboId}`);
      for (let rotation = 0; rotation < rotations; rotation += 1) {
        for (const [entrantAgent, opponentAgent] of artifactPairings(entrant, opponent, rotation)) {
          for (const position of positions) {
            for (const seed of position.seeds) {
              for (const [white, black] of [[entrantAgent, opponentAgent], [opponentAgent, entrantAgent]]) {
                const specification = gameSpecification({ white, black, position, seed, protocol });
                invariant(!seen.has(specification.gameKey), `Duplicate scheduled game: ${specification.gameKey}`);
                seen.add(specification.gameKey);
                jobs.push({
                  gameKey: specification.gameKey,
                  phase,
                  rotation,
                  entrantComboId,
                  opponentComboId,
                  whiteAgentId: white.id,
                  blackAgentId: black.id,
                  positionId: position.id,
                  seed,
                  specification,
                });
              }
            }
          }
        }
      }
    }
  }

  return sealSchedule({
    schemaVersion: SCHEDULE_SCHEMA,
    kind: 'agentbattler.placement-and-targeted-schedule',
    season,
    protocol,
    placement: {
      entrantComboId,
      tierId,
      anchorComboIds: phases[0][1],
      targetComboIds: phases[1][1],
      rotations,
    },
    jobs,
    totals: {
      artifacts: entrant.agents.length,
      opponents: allOpponents.length,
      games: jobs.length,
    },
  });
}

export function validateSchedule(schedule) {
  invariant(schedule?.schemaVersion === SCHEDULE_SCHEMA, 'Unsupported schedule schema');
  const { scheduleId, scheduleSha256, ...unsigned } = schedule;
  const actual = canonicalJsonSha256(unsigned);
  invariant(scheduleSha256 === actual, 'Schedule hash mismatch');
  invariant(scheduleId === `schedule-${actual.slice(0, 16)}`, 'Schedule ID mismatch');
  validateBattleProtocol(schedule.protocol);
  validateSeason(schedule.season);
  invariant(schedule.season.protocol?.sha256 === schedule.protocol.protocolSha256, 'Schedule season and protocol differ');
  invariant(Array.isArray(schedule.jobs) && schedule.jobs.length > 0, 'Schedule has no games');
  const keys = new Set();
  for (const job of schedule.jobs) {
    const { gameKey, ...spec } = job.specification;
    invariant(gameKey === canonicalJsonSha256(spec), `Invalid game key in schedule: ${gameKey}`);
    invariant(job.gameKey === gameKey, `Schedule job key mismatch: ${job.gameKey}`);
    invariant(!keys.has(gameKey), `Duplicate schedule job: ${gameKey}`);
    keys.add(gameKey);
  }
  return schedule;
}
