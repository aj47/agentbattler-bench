function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function familyIdForAgent(agentId) {
  return agentId.replace(/-\d+$/, '');
}

function scoreForGame(game, agentId) {
  if (game.final.outcome === '1/2-1/2') return 0.5;
  if (game.final.outcome === 'void') return 0;
  const wonAsWhite = game.final.outcome === '1-0' && game.agents.w.id === agentId;
  const wonAsBlack = game.final.outcome === '0-1' && game.agents.b.id === agentId;
  return wonAsWhite || wonAsBlack ? 1 : 0;
}

function outcomeForFamily(game, familyId) {
  if (game.final.outcome === '1/2-1/2') return 'draw';
  if (game.final.outcome === 'void') return 'void';
  const winner = game.final.outcome === '1-0' ? game.agents.w : game.agents.b;
  return winner.provenance.modelFamilyId === familyId ? 'win' : 'loss';
}

function failedAgentId(game) {
  const color = game.final.failure?.color;
  return color === 'w' || color === 'b' ? game.agents[color].id : null;
}

export function summarizeModelFamilies({ families, agents, games }) {
  const agentsByFamily = new Map();
  for (const agent of agents) {
    const familyId = familyIdForAgent(agent.id);
    const bucket = agentsByFamily.get(familyId) ?? [];
    bucket.push(agent);
    agentsByFamily.set(familyId, bucket);
  }

  const summaries = families.map((family) => {
    const artifacts = (agentsByFamily.get(family.id) ?? [])
      .map((agent) => ({
        id: agent.id,
        displayName: agent.displayName,
        games: agent.standing.games,
        wins: agent.standing.wins,
        draws: agent.standing.draws,
        losses: agent.standing.losses,
        points: agent.standing.points,
        scorePct: round((agent.standing.points / agent.standing.games) * 100),
        elo: agent.standing.elo,
        totalTokens: agent.generation.totalTokens,
        durationMs: agent.generation.durationMs,
        toolCalls: agent.generation.toolCalls,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));

    const familyGames = games.filter((game) => (
      game.agents.w.provenance.modelFamilyId === family.id
      || game.agents.b.provenance.modelFamilyId === family.id
    ));
    const outcomes = familyGames.map((game) => outcomeForFamily(game, family.id));
    const wins = outcomes.filter((outcome) => outcome === 'win').length;
    const draws = outcomes.filter((outcome) => outcome === 'draw').length;
    const losses = outcomes.filter((outcome) => outcome === 'loss').length;
    const voids = outcomes.filter((outcome) => outcome === 'void').length;
    const points = wins + (draws * 0.5);
    const artifactScores = artifacts.map((artifact) => artifact.scorePct);
    const failures = familyGames.filter((game) => {
      const agentId = failedAgentId(game);
      return agentId && familyIdForAgent(agentId) === family.id;
    });

    const pairwise = families
      .filter((opponent) => opponent.id !== family.id)
      .map((opponent) => {
        const pairGames = familyGames.filter((game) => {
          const familyIds = new Set([
            game.agents.w.provenance.modelFamilyId,
            game.agents.b.provenance.modelFamilyId,
          ]);
          return familyIds.has(family.id) && familyIds.has(opponent.id);
        });
        const pairOutcomes = pairGames.map((game) => outcomeForFamily(game, family.id));
        const pairWins = pairOutcomes.filter((outcome) => outcome === 'win').length;
        const pairDraws = pairOutcomes.filter((outcome) => outcome === 'draw').length;
        const pairLosses = pairOutcomes.filter((outcome) => outcome === 'loss').length;
        return {
          opponentId: opponent.id,
          opponentName: opponent.displayName,
          games: pairGames.length,
          wins: pairWins,
          draws: pairDraws,
          losses: pairLosses,
          points: pairWins + (pairDraws * 0.5),
        };
      });

    return {
      id: family.id,
      displayName: family.displayName,
      model: family.model,
      rank: 0,
      artifacts,
      games: familyGames.length,
      wins,
      draws,
      losses,
      voids,
      points,
      scorePct: round((points / familyGames.length) * 100),
      artifactScore: {
        minimum: Math.min(...artifactScores),
        median: round(median(artifactScores)),
        maximum: Math.max(...artifactScores),
      },
      generation: {
        totalTokens: artifacts.reduce((sum, artifact) => sum + artifact.totalTokens, 0),
        medianTokens: round(median(artifacts.map((artifact) => artifact.totalTokens)), 0),
        totalDurationMs: artifacts.reduce((sum, artifact) => sum + artifact.durationMs, 0),
        medianDurationMs: round(median(artifacts.map((artifact) => artifact.durationMs)), 0),
        toolCalls: artifacts.reduce((sum, artifact) => sum + artifact.toolCalls, 0),
      },
      reliability: {
        failures: failures.length,
        timeouts: failures.filter((game) => game.final.failure?.status === 'timeout').length,
        illegalMoves: failures.filter((game) => game.final.failure?.status === 'illegal').length,
      },
      pairwise,
    };
  });

  summaries.sort((left, right) => (
    right.scorePct - left.scorePct
    || right.points - left.points
    || left.displayName.localeCompare(right.displayName)
  ));
  summaries.forEach((summary, index) => { summary.rank = index + 1; });
  return summaries;
}
