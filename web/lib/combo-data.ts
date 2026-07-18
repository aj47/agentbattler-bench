import type { Agent, SiteData } from './types';

export type ComboAgentMetric = {
  id: string;
  displayName: string;
  rank: number;
  scorePct: number;
  wins: number;
  draws: number;
  losses: number;
  games: number;
  turns: number | null;
  tokensPerTurn: number | null;
  durationPerTurnMs: number | null;
  pricePerTurnUsd: number | null;
  totalTokens: number | null;
  totalDurationMs: number | null;
  toolCallsPerTurn: number | null;
  telemetryPublished: boolean;
};

export type ComboRow = {
  id: string;
  harness: string;
  harnessDisplayName: string;
  harnessVersion: string;
  familyId: string;
  familyDisplayName: string;
  model: string;
  tone: 'codex' | 'pi' | 'claude' | 'dotagents';
  scorePct: number;
  wins: number;
  draws: number;
  losses: number;
  games: number;
  gamesPerAgent: number;
  agents: ComboAgentMetric[];
  telemetry: {
    available: boolean;
    availableAgents: number;
    avgTokensPerTurn: number | null;
    avgDurationPerTurnMs: number | null;
    avgPricePerTurnUsd: number | null;
    avgTurnsPerAgent: number | null;
    avgToolCallsPerTurn: number | null;
    totalTokens: number | null;
    totalDurationMs: number | null;
  };
};

type GenerationWithPrice = Agent['generation'] & { priceUsd?: number | null };

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function averagePerTurn(agents: ComboAgentMetric[], field: 'tokensPerTurn' | 'durationPerTurnMs' | 'pricePerTurnUsd' | 'toolCallsPerTurn') {
  const usable = agents.filter((agent) => finite(agent[field]) && finite(agent.turns) && agent.turns > 0);
  if (!usable.length) return null;
  const numerator = usable.reduce((sum, agent) => sum + (agent[field] as number) * (agent.turns as number), 0);
  const denominator = usable.reduce((sum, agent) => sum + (agent.turns as number), 0);
  return denominator ? numerator / denominator : null;
}

function metricForAgent(agent: Agent): ComboAgentMetric {
  const generation = agent.generation as GenerationWithPrice;
  const turns = finite(generation.turns) && generation.turns > 0 ? generation.turns : null;
  const priceUsd = finite(generation.priceUsd) ? generation.priceUsd : null;
  return {
    id: agent.id,
    displayName: agent.displayName,
    rank: agent.standing.rank,
    scorePct: agent.standing.games ? (agent.standing.points / agent.standing.games) * 100 : 0,
    wins: agent.standing.wins,
    draws: agent.standing.draws,
    losses: agent.standing.losses,
    games: agent.standing.games,
    turns,
    tokensPerTurn: turns && finite(generation.totalTokens) ? generation.totalTokens / turns : null,
    durationPerTurnMs: turns && finite(generation.durationMs) ? generation.durationMs / turns : null,
    pricePerTurnUsd: turns && priceUsd !== null ? priceUsd / turns : null,
    totalTokens: finite(generation.totalTokens) ? generation.totalTokens : null,
    totalDurationMs: finite(generation.durationMs) ? generation.durationMs : null,
    toolCallsPerTurn: turns && finite(generation.toolCalls) ? generation.toolCalls / turns : null,
    telemetryPublished: generation.telemetryPublished !== false,
  };
}

function toneForHarness(id: string): ComboRow['tone'] {
  if (id === 'pi-coding-agent') return 'pi';
  if (id === 'claude-code') return 'claude';
  if (id === 'dotagents-mono') return 'dotagents';
  return 'codex';
}

export function buildComboRows(data: SiteData): ComboRow[] {
  const rows: ComboRow[] = [];
  const seen = new Set<string>();

  for (const harness of data.harnesses) {
    const harnessAgents = data.agents.filter((agent) => agent.harness === harness.id);
    const familyIds = new Set([
      ...harness.families.map((family) => family.id),
      ...harnessAgents.map((agent) => agent.familyId),
    ]);

    for (const familyId of familyIds) {
      const agents = harnessAgents
        .filter((agent) => agent.familyId === familyId)
        .map(metricForAgent)
        .sort((left, right) => left.id.localeCompare(right.id));
      if (!agents.length) continue;

      const family = harness.families.find((candidate) => candidate.id === familyId);
      const familyDisplayName = family?.displayName ?? agents[0].displayName.replace(/\s+#\d+$/, '');
      const games = agents.reduce((sum, agent) => sum + agent.games, 0);
      const wins = agents.reduce((sum, agent) => sum + agent.wins, 0);
      const draws = agents.reduce((sum, agent) => sum + agent.draws, 0);
      const losses = agents.reduce((sum, agent) => sum + agent.losses, 0);
      const availableAgents = agents.filter((agent) => agent.tokensPerTurn !== null && agent.durationPerTurnMs !== null).length;
      const totalTokens = agents.every((agent) => agent.totalTokens !== null)
        ? agents.reduce((sum, agent) => sum + (agent.totalTokens ?? 0), 0)
        : null;
      const totalDurationMs = agents.every((agent) => agent.totalDurationMs !== null)
        ? agents.reduce((sum, agent) => sum + (agent.totalDurationMs ?? 0), 0)
        : null;
      const turns = agents.filter((agent) => agent.turns !== null).reduce((sum, agent) => sum + (agent.turns ?? 0), 0);
      const scorePct = games ? ((wins + draws / 2) / games) * 100 : 0;
      const id = `${harness.id}:${familyId}`;
      if (seen.has(id)) continue;
      seen.add(id);

      rows.push({
        id,
        harness: harness.id,
        harnessDisplayName: harness.displayName,
        harnessVersion: harness.harnessVersion,
        familyId,
        familyDisplayName,
        model: family?.model ?? agents[0].displayName.split(' #')[0],
        tone: toneForHarness(harness.id),
        scorePct,
        wins,
        draws,
        losses,
        games,
        gamesPerAgent: Math.round(games / agents.length),
        agents,
        telemetry: {
          available: availableAgents > 0,
          availableAgents,
          avgTokensPerTurn: averagePerTurn(agents, 'tokensPerTurn'),
          avgDurationPerTurnMs: averagePerTurn(agents, 'durationPerTurnMs'),
          avgPricePerTurnUsd: averagePerTurn(agents, 'pricePerTurnUsd'),
          avgTurnsPerAgent: turns ? turns / agents.length : null,
          avgToolCallsPerTurn: averagePerTurn(agents, 'toolCallsPerTurn'),
          totalTokens,
          totalDurationMs,
        },
      });
    }
  }

  return rows;
}
